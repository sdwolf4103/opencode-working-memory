/**
 * Two-way filesystem bridge between OpenCode working memory (JSON) and
 * CodeBuddy memory (Markdown topic files with YAML frontmatter).
 *
 * Ownership model:
 * - `opencode-*.md` files are written by OpenCode. CodeBuddy may edit them;
 *   edits are imported back into workspace memory.
 * - CodeBuddy's own `*.md` files are never rewritten. They are indexed in the
 *   OpenCode prompt and, when marked `shared: true`, imported as read-mostly
 *   entries.
 * - `MEMORY.md` is owned by CodeBuddy; the bridge only maintains a marked
 *   block for OpenCode-owned entries.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { atomicWriteJSON, atomicWriteText, readJSON } from "./storage.ts";
import { memoryRoot } from "./paths.ts";
import { loadWorkspaceMemory, updateWorkspaceMemory } from "./workspace-memory.ts";
import { redactCredentials } from "./redaction.ts";
import { LONG_TERM_LIMITS, type LongTermMemoryEntry, type LongTermType, type WorkspaceMemoryStore } from "./types.ts";

export type CodeBuddyMemoryType = "user" | "feedback" | "project" | "reference";

export type CodeBuddyBridgeOptions = {
  enabled?: boolean;
  /** Override for tests or a non-standard CodeBuddy home. */
  homeDir?: string;
  /** Also index/import ~/.codebuddy/memories/global. Off by default: it can contain credentials. */
  includeGlobal?: boolean;
  /** Include filenames/descriptions that look credential-related. Off by default. */
  includeSensitive?: boolean;
  /** Maximum CodeBuddy entries listed in the OpenCode prompt. */
  maxIndexEntries?: number;
  /** Maximum characters spent on the CodeBuddy index prompt. */
  maxIndexChars?: number;
  /** Maximum CodeBuddy-owned files imported as workspace entries. */
  maxImportedShared?: number;
  /** Minimum time between full bridge scans. */
  syncIntervalMs?: number;
};

type ResolvedOptions = {
  enabled: boolean;
  homeDir: string;
  includeGlobal: boolean;
  includeSensitive: boolean;
  maxIndexEntries: number;
  maxIndexChars: number;
  maxImportedShared: number;
  syncIntervalMs: number;
};

type BridgeFile = {
  /** Stable key: `project:<relative path>` or `global:<relative path>`. */
  key: string;
  scope: "project" | "global";
  filePath: string;
  relativePath: string;
  name?: string;
  description?: string;
  type?: CodeBuddyMemoryType;
  shared: boolean;
  opencodeId?: string;
  opencodeType?: string;
  sensitive: boolean;
  body: string;
  mtimeMs: number;
  hash: string;
};

type BridgeStateFile = {
  hash: string;
  mtimeMs: number;
  lastSyncedAt: string;
  opencodeId?: string;
  sharedKey?: string;
};

type BridgeState = {
  version: 1;
  lastSyncAt?: string;
  files: Record<string, BridgeStateFile>;
};

export type CodeBuddyBridgeResult = {
  changed: boolean;
  indexPrompt: string;
  imported: number;
  exported: number;
  projectDir?: string;
};

const START_MARKER = "<!-- opencode-working-memory:start -->";
const END_MARKER = "<!-- opencode-working-memory:end -->";
const METADATA_MARKER = "<!-- opencode:metadata -->";
const SENSITIVE_PATTERN = /password|passwd|pwd|secret|credential|token|api[_-]?key|private[_-]?key|ssh|sudo|root|access|vps/i;
const OPENCODE_FILE_PREFIX = "opencode-";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function resolveOptions(value: boolean | CodeBuddyBridgeOptions | undefined): ResolvedOptions {
  if (value === true) {
    return {
      enabled: true,
      homeDir: join(homedir(), ".codebuddy"),
      includeGlobal: false,
      includeSensitive: false,
      maxIndexEntries: 14,
      maxIndexChars: 1600,
      maxImportedShared: 12,
      syncIntervalMs: 3000,
    };
  }

  if (!value) {
    return {
      enabled: false,
      homeDir: join(homedir(), ".codebuddy"),
      includeGlobal: false,
      includeSensitive: false,
      maxIndexEntries: 14,
      maxIndexChars: 1600,
      maxImportedShared: 12,
      syncIntervalMs: 3000,
    };
  }

  return {
    enabled: value.enabled !== false,
    homeDir: value.homeDir ?? join(homedir(), ".codebuddy"),
    includeGlobal: value.includeGlobal === true,
    includeSensitive: value.includeSensitive === true,
    maxIndexEntries: value.maxIndexEntries ?? 14,
    maxIndexChars: value.maxIndexChars ?? 1600,
    maxImportedShared: value.maxImportedShared ?? 12,
    syncIntervalMs: value.syncIntervalMs ?? 3000,
  };
}

function compressWorkspacePath(path: string): string {
  return resolve(path)
    .replace(/[/\\:]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/-+/g, "-");
}

function projectMemoryDir(workspaceRoot: string, homeDir: string): string {
  const compressed = compressWorkspacePath(workspaceRoot);
  const modern = join(homeDir, "projects", compressed, "memory");
  const legacy = join(homeDir, "memories", compressed);
  if (!existsSync(modern) && existsSync(legacy)) return legacy;
  return modern;
}

function globalMemoryDir(homeDir: string): string {
  return join(homeDir, "memories", "global");
}

function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text.trim() };

  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const keyValue = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(line);
    if (!keyValue) continue;
    const key = keyValue[1];
    let value = (keyValue[2] ?? "").trim();
    if (value.startsWith("\"") && value.endsWith("\"")) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }

  return { data, body: text.slice(match[0].length).trim() };
}

function yamlValue(value: string): string {
  if (/^[A-Za-z0-9\u4e00-\u9fff][^:#\n"'`]*$/.test(value)) return value;
  return JSON.stringify(value);
}

function normalizeType(value: string | undefined): CodeBuddyMemoryType | undefined {
  if (value === "user" || value === "feedback" || value === "project" || value === "reference") return value;
  return undefined;
}

function codeBuddyTypeFor(type: LongTermType): CodeBuddyMemoryType {
  if (type === "feedback") return "feedback";
  if (type === "project" || type === "decision") return "project";
  return "reference";
}

function openCodeTypefrom(type: CodeBuddyMemoryType | undefined, fallback: LongTermType): LongTermType {
  if (type === "feedback" || type === "user") return "feedback";
  if (type === "project") return "project";
  if (type === "reference") return "reference";
  return fallback;
}

function sanitizeFilePart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "memory";
}

function isSensitive(file: Pick<BridgeFile, "relativePath" | "name" | "description">): boolean {
  return SENSITIVE_PATTERN.test(file.relativePath)
    || SENSITIVE_PATTERN.test(file.name ?? "")
    || SENSITIVE_PATTERN.test(file.description ?? "");
}

async function scanMemoryDir(
  dir: string,
  scope: "project" | "global",
  options: ResolvedOptions,
): Promise<BridgeFile[]> {
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return [];
  }

  const files: BridgeFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    if (basename(entry) === "MEMORY.md") continue;

    const filePath = join(dir, entry);
    let stats;
    try {
      stats = await stat(filePath);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;

    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const relativePath = entry.split("\\").join("/");
    const { data, body } = parseFrontmatter(text);
    const file: BridgeFile = {
      key: `${scope}:${relativePath}`,
      scope,
      filePath,
      relativePath,
      name: data.name,
      description: data.description,
      type: normalizeType(data.type),
      shared: data.shared === "true" || relativePath.startsWith("shared/"),
      opencodeId: data.opencode_id,
      opencodeType: data.opencode_type,
      sensitive: false,
      body,
      mtimeMs: stats.mtimeMs,
      hash: sha256(text),
    };
    file.sensitive = isSensitive(file);
    if (file.sensitive && !options.includeSensitive) continue;
    files.push(file);
  }

  return files;
}

async function readState(root: string): Promise<{ path: string; state: BridgeState }> {
  const path = join(await memoryRoot(root), "codebuddy-bridge.json");
  const state = await readJSON<BridgeState>(path, () => ({ version: 1, files: {} }));
  return {
    path,
    state: {
      version: 1,
      lastSyncAt: state.lastSyncAt,
      files: state.files && typeof state.files === "object" ? state.files : {},
    },
  };
}

function renderOpenCodeMemory(entry: LongTermMemoryEntry, options: ResolvedOptions): string {
  const text = options.includeSensitive ? entry.text : redactCredentials(entry.text);
  const rationale = entry.rationale
    ? (options.includeSensitive ? entry.rationale : redactCredentials(entry.rationale))
    : "";
  // Keep index-visible fields redacted even when the body carries raw content:
  // CodeBuddy loads MEMORY.md on every session, while the body is read on demand.
  const indexText = redactCredentials(entry.text);
  const name = `OpenCode: ${indexText.slice(0, 70)}`;
  const description = `[${entry.type}] ${indexText.slice(0, 160)}`;
  const body = [
    text,
    "",
    METADATA_MARKER,
    "> Generated by OpenCode working memory. Edit the text above to update this memory; do not delete this file.",
    `**Why:** ${rationale || "Captured by OpenCode working memory."}`,
    `**How to apply:** Treat this as ${entry.type} memory from OpenCode when it is relevant to the current task.`,
  ].join("\n");

  return [
    "---",
    `name: ${yamlValue(name)}`,
    `description: ${yamlValue(description)}`,
    `type: ${codeBuddyTypeFor(entry.type)}`,
    `opencode_id: ${yamlValue(entry.id)}`,
    `opencode_type: ${entry.type}`,
    "shared: true",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function extractMemoryText(body: string): string {
  const metadataIndex = body.indexOf(METADATA_MARKER);
  const beforeMetadata = metadataIndex >= 0 ? body.slice(0, metadataIndex) : body;
  const whyIndex = beforeMetadata.indexOf("**Why:**");
  return (whyIndex >= 0 ? beforeMetadata.slice(0, whyIndex) : beforeMetadata).trim();
}

function upsertManagedBlock(existing: string, block: string): string {
  const blockPattern = new RegExp(
    `${START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
    "g",
  );
  const withoutBlock = existing.replace(blockPattern, "").replace(/\s+$/, "");
  if (!block) return withoutBlock ? `${withoutBlock}\n` : "";
  return `${withoutBlock}${withoutBlock ? "\n\n" : ""}${block}\n`;
}

function buildIndexBlock(entries: Array<{ file: string; entry: LongTermMemoryEntry }>): string {
  if (entries.length === 0) return "";
  const lines = entries.map(({ file, entry }) => {
    const text = redactCredentials(entry.text).replace(/\s+/g, " ").slice(0, 120);
    return `- [${entry.type}] [${text}](${file})`;
  });
  return [
    START_MARKER,
    "### OpenCode Working Memory (auto-synced; do not edit this block)",
    "",
    ...lines,
    END_MARKER,
  ].join("\n");
}

function buildIndexPrompt(files: BridgeFile[], projectDir: string, globalDir: string | undefined, options: ResolvedOptions): string {
  const projectFiles = files
    .filter(file => file.scope === "project" && !file.relativePath.startsWith(OPENCODE_FILE_PREFIX))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const globalFiles = files
    .filter(file => file.scope === "global" && !file.relativePath.startsWith(OPENCODE_FILE_PREFIX))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const visible = [...globalFiles.slice(0, 3), ...projectFiles].slice(0, options.maxIndexEntries);

  if (visible.length === 0) return "";

  const lines = ["## Shared CodeBuddy memory (read-only index)", ""];
  lines.push(`Project memory: ${projectDir}`);
  if (globalDir) lines.push(`Global memory: ${globalDir}`);
  lines.push("", "Recent entries:");

  let text = lines.join("\n");
  let truncated = false;
  for (const file of visible) {
    const label = file.name ?? file.relativePath;
    const description = redactCredentials(file.description ?? "").replace(/\s+/g, " ").slice(0, 80);
    const line = `- [${file.type ?? "reference"}] ${label}${description ? `: ${description}` : ""}`;
    if (text.length + line.length + 1 > options.maxIndexChars) {
      truncated = true;
      break;
    }
    text += `\n${line}`;
  }

  text += "\n\nUse the read/grep tools on these paths when the user references prior work.";
  const sensitive = files
    .filter(file => file.sensitive && !file.relativePath.startsWith(OPENCODE_FILE_PREFIX))
    .sort((left, right) => {
      const priority = (file: BridgeFile): number => {
        const label = `${file.relativePath} ${file.name ?? ""}`.toLowerCase();
        if (/sudo|root/.test(label)) return 0;
        if (/vps|ssh|access|password|credential/.test(label)) return 1;
        return 2;
      };
      const delta = priority(left) - priority(right);
      return delta !== 0 ? delta : right.mtimeMs - left.mtimeMs;
    })
    .slice(0, 5);
  if (sensitive.length > 0) {
    text += `\nSensitive entries (read only when needed): ${sensitive.map(file => file.name ?? file.relativePath).join("; ")}`;
  }
  if (truncated) text += "\n[index truncated]";
  return text;
}

function applyImportedMemories(
  store: WorkspaceMemoryStore,
  files: BridgeFile[],
  state: BridgeState,
  options: ResolvedOptions,
): { changed: boolean; imported: number } {
  let changed = false;
  let imported = 0;

  const byId = new Map(store.entries.map(entry => [entry.id, entry]));
  const sharedFiles = files
    .filter(file => !file.opencodeId && file.shared)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, options.maxImportedShared);

  for (const file of files) {
    const previous = state.files[file.key];
    if (previous?.hash === file.hash) continue;

    if (file.opencodeId) {
      const entry = byId.get(file.opencodeId);
      if (!entry || entry.status !== "active") continue;
      const text = extractMemoryText(file.body);
      if (!text || text === entry.text) continue;

      entry.text = text.slice(0, LONG_TERM_LIMITS.maxEntryTextChars);
      entry.updatedAt = new Date(Math.max(Date.now(), file.mtimeMs)).toISOString();
      entry.tags = [...new Set([...(entry.tags ?? []), "codebuddy-edited"])];
      changed = true;
      imported += 1;
      continue;
    }

    if (!sharedFiles.includes(file)) continue;

    const id = `cb_${sha256(file.key).slice(0, 16)}`;
    const type = openCodeTypefrom(file.type, "reference");
    const rawText = extractMemoryText(file.body);
    const text = (options.includeSensitive ? rawText : redactCredentials(rawText))
      .slice(0, LONG_TERM_LIMITS.maxEntryTextChars);
    if (!text) continue;

    const existing = byId.get(id);
    if (existing) {
      if (existing.text === text && existing.type === type) continue;
      existing.text = text;
      existing.type = type;
      existing.updatedAt = new Date(Math.max(Date.now(), file.mtimeMs)).toISOString();
      existing.tags = [...new Set([...(existing.tags ?? []), "codebuddy", "shared", `cb:${file.key}`])];
    } else {
      const createdAt = new Date(file.mtimeMs).toISOString();
      const entry: LongTermMemoryEntry = {
        id,
        type,
        text,
        source: "manual",
        confidence: 0.85,
        status: "active",
        createdAt,
        updatedAt: createdAt,
        tags: ["codebuddy", "shared", `cb:${file.key}`],
      };
      store.entries.push(entry);
      byId.set(id, entry);
    }
    changed = true;
    imported += 1;
  }

  return { changed, imported };
}

function applyDeletedMemories(
  store: WorkspaceMemoryStore,
  files: BridgeFile[],
  state: BridgeState,
): { changed: boolean; imported: number } {
  const liveKeys = new Set(files.map(file => file.key));
  let changed = false;
  let imported = 0;

  for (const [key, previous] of Object.entries(state.files)) {
    if (liveKeys.has(key)) continue;

    if (previous.opencodeId) {
      const entry = store.entries.find(item => item.id === previous.opencodeId);
      if (entry && entry.status === "active") {
        entry.status = "superseded";
        entry.updatedAt = new Date().toISOString();
        changed = true;
        imported += 1;
      }
    }

    if (previous.sharedKey) {
      const entry = store.entries.find(item => (item.tags ?? []).includes(previous.sharedKey!));
      if (entry && entry.status === "active") {
        entry.status = "superseded";
        entry.updatedAt = new Date().toISOString();
        changed = true;
        imported += 1;
      }
    }
  }

  return { changed, imported };
}

async function exportOpenCodeMemories(
  root: string,
  store: WorkspaceMemoryStore,
  projectDir: string,
  state: BridgeState,
  options: ResolvedOptions,
): Promise<{ exported: number }> {
  await mkdir(projectDir, { recursive: true });

  const exportable = store.entries
    .filter(entry => entry.status === "active")
    .filter(entry => !(entry.tags ?? []).some(tag => tag === "codebuddy" || tag.startsWith("cb:")))
    .slice(0, LONG_TERM_LIMITS.maxEntries);

  const desired = new Map<string, { content: string; entry: LongTermMemoryEntry }>();
  for (const entry of exportable) {
    const file = `${OPENCODE_FILE_PREFIX}${sanitizeFilePart(entry.id)}.md`;
    desired.set(file, { content: renderOpenCodeMemory(entry, options), entry });
  }

  for (const [file, { content, entry }] of desired) {
    const filePath = join(projectDir, file);
    let current: string | undefined;
    try {
      current = await readFile(filePath, "utf8");
    } catch {
      current = undefined;
    }
    if (current !== content) {
      await atomicWriteText(filePath, content);
    }
    state.files[`project:${file}`] = {
      hash: sha256(content),
      mtimeMs: Date.now(),
      lastSyncedAt: new Date().toISOString(),
      opencodeId: entry.id,
    };
  }

  let projectEntries: string[] = [];
  try {
    projectEntries = await readdir(projectDir);
  } catch {
    projectEntries = [];
  }
  for (const file of projectEntries) {
    if (!file.startsWith(OPENCODE_FILE_PREFIX) || !file.endsWith(".md")) continue;
    if (desired.has(file)) continue;
    await rm(join(projectDir, file), { force: true });
    delete state.files[`project:${file}`];
  }

  const indexEntries = [...desired.entries()].map(([file, value]) => ({ file, entry: value.entry }));
  const indexPath = join(projectDir, "MEMORY.md");
  let index = "";
  try {
    index = await readFile(indexPath, "utf8");
  } catch {
    index = "# Memory Index\n";
  }
  const nextIndex = upsertManagedBlock(index, buildIndexBlock(indexEntries));
  if (nextIndex !== index) {
    await atomicWriteText(indexPath, nextIndex, 0o644);
  }

  return { exported: desired.size };
}

export async function syncCodeBuddyBridge(
  workspaceRoot: string,
  value?: boolean | CodeBuddyBridgeOptions,
): Promise<CodeBuddyBridgeResult> {
  const options = resolveOptions(value);
  if (!options.enabled) return { changed: false, indexPrompt: "", imported: 0, exported: 0 };

  if (!existsSync(options.homeDir)) {
    return { changed: false, indexPrompt: "", imported: 0, exported: 0 };
  }

  const projectDir = projectMemoryDir(workspaceRoot, options.homeDir);
  const globalDir = options.includeGlobal ? globalMemoryDir(options.homeDir) : undefined;

  const files = [
    ...await scanMemoryDir(projectDir, "project", options),
    ...(globalDir ? await scanMemoryDir(globalDir, "global", options) : []),
  ];

  const { path: statePath, state } = await readState(workspaceRoot);
  const probe = await loadWorkspaceMemory(workspaceRoot);
  const probeImport = applyImportedMemories(probe, files, state, options);
  const probeDeletes = applyDeletedMemories(probe, files, state);

  let changed = probeImport.changed || probeDeletes.changed;
  let imported = probeImport.imported + probeDeletes.imported;

  let store = probe;
  if (changed) {
    store = await updateWorkspaceMemory(workspaceRoot, current => {
      applyImportedMemories(current, files, state, options);
      applyDeletedMemories(current, files, state);
      return current;
    });
  }

  const { exported } = await exportOpenCodeMemories(workspaceRoot, store, projectDir, state, options);

  state.lastSyncAt = new Date().toISOString();
  await atomicWriteJSON(statePath, state);

  return {
    changed,
    indexPrompt: buildIndexPrompt(files, projectDir, globalDir, options),
    imported,
    exported,
    projectDir,
  };
}

/** Export only; used after compaction promotion, when no scan is needed. */
export async function exportCodeBuddyBridge(
  workspaceRoot: string,
  value?: boolean | CodeBuddyBridgeOptions,
): Promise<void> {
  const options = resolveOptions(value);
  if (!options.enabled || !existsSync(options.homeDir)) return;

  const projectDir = projectMemoryDir(workspaceRoot, options.homeDir);
  const { path: statePath, state } = await readState(workspaceRoot);
  const store = await loadWorkspaceMemory(workspaceRoot);
  await exportOpenCodeMemories(workspaceRoot, store, projectDir, state, options);
  state.lastSyncAt = new Date().toISOString();
  await atomicWriteJSON(statePath, state);
}
