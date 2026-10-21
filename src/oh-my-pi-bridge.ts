/**
 * Two-way filesystem bridge between OpenCode working memory (JSON) and
 * oh-my-pi's `local` memory backend (plain Markdown).
 *
 * Ownership model:
 * - Lesson lines prefixed with `[opencode:<id>]` in `learned.md` are written by
 *   OpenCode. oh-my-pi may edit them; edits are imported back into workspace
 *   memory. Deleting a line supersedes the memory.
 * - All other `learned.md` lessons belong to oh-my-pi. They are indexed in the
 *   OpenCode prompt and the most recent ones are imported as read-mostly
 *   memories. The bridge never rewrites them.
 * - `memory_summary.md`, `MEMORY.md`, and `skills/` are owned by oh-my-pi's
 *   consolidation pipeline and are never touched.
 *
 * oh-my-pi reads `memory_summary.md` and `learned.md` from the project memory
 * root when it builds its system prompt, so exported lessons become visible on
 * the next oh-my-pi session. There are no hooks to install on either side.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWriteJSON, atomicWriteText, readJSON } from "./storage.ts";
import { memoryRoot } from "./paths.ts";
import { loadWorkspaceMemory, updateWorkspaceMemory } from "./workspace-memory.ts";
import { redactCredentials } from "./redaction.ts";
import {
  LONG_TERM_LIMITS,
  type LongTermMemoryEntry,
  type LongTermType,
  type WorkspaceMemoryStore,
} from "./types.ts";

export type OhMyPiBridgeOptions = {
  enabled?: boolean;
  /** oh-my-pi config root. Defaults to ~/.omp. */
  homeDir?: string;
  /** Agent state directory. Defaults to <homeDir>/agent. */
  agentDir?: string;
  /** Include credential-looking lessons in the index/import. Off by default. */
  includeSensitive?: boolean;
  /** Maximum OpenCode memories exported to learned.md. */
  maxExported?: number;
  /** Maximum oh-my-pi lessons imported into JSON memory. */
  maxImportedLessons?: number;
  /** Maximum oh-my-pi lessons listed in the OpenCode prompt. */
  maxIndexEntries?: number;
  /** Maximum characters spent on the oh-my-pi lesson index. */
  maxIndexChars?: number;
  /** Minimum time between full bridge scans. */
  syncIntervalMs?: number;
};

type ResolvedOptions = {
  enabled: boolean;
  homeDir: string;
  agentDir: string;
  includeSensitive: boolean;
  maxExported: number;
  maxImportedLessons: number;
  maxIndexEntries: number;
  maxIndexChars: number;
  syncIntervalMs: number;
};

type BridgeExportedEntry = {
  hash: string;
  text: string;
};

type BridgeImportedEntry = {
  entryId: string;
};

type BridgeState = {
  version: 1;
  lastSyncAt?: string;
  exported: Record<string, BridgeExportedEntry>;
  imported: Record<string, BridgeImportedEntry>;
};

type ParsedLesson = {
  text: string;
  context?: string;
};

type ParsedLearned = {
  lines: string[];
  exported: Map<string, string>;
  lessons: ParsedLesson[];
};

export type OhMyPiBridgeResult = {
  changed: boolean;
  indexPrompt: string;
  imported: number;
  exported: number;
  projectDir?: string;
};

const EXPORT_LINE = /^- \[opencode:([^\]]+)\]\s+(.*)$/;
const LESSON_LINE = /^- (.*)$/;
const LESSON_CONTEXT = /^(.*) _\(context: ([\s\S]*)\)_$/;
const OMP_LESSON_CAP = 100;
const OMP_TAG = "omp";
const SENSITIVE_PATTERN =
  /password|passwd|pwd|secret|credential|token|api[_-]?key|private[_-]?key|ssh|sudo|root|access|vps/i;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function resolveOptions(value: boolean | OhMyPiBridgeOptions | undefined): ResolvedOptions {
  const homeDir = join(homedir(), ".omp");
  if (value === true) {
    return {
      enabled: true,
      homeDir,
      agentDir: join(homeDir, "agent"),
      includeSensitive: false,
      maxExported: 12,
      maxImportedLessons: 12,
      maxIndexEntries: 14,
      maxIndexChars: 1600,
      syncIntervalMs: 3000,
    };
  }

  if (!value) {
    return {
      enabled: false,
      homeDir,
      agentDir: join(homeDir, "agent"),
      includeSensitive: false,
      maxExported: 12,
      maxImportedLessons: 12,
      maxIndexEntries: 14,
      maxIndexChars: 1600,
      syncIntervalMs: 3000,
    };
  }

  const resolvedHome = value.homeDir ?? homeDir;
  return {
    enabled: value.enabled !== false,
    homeDir: resolvedHome,
    agentDir: value.agentDir ?? join(resolvedHome, "agent"),
    includeSensitive: value.includeSensitive === true,
    maxExported: value.maxExported ?? 12,
    maxImportedLessons: value.maxImportedLessons ?? 12,
    maxIndexEntries: value.maxIndexEntries ?? 14,
    maxIndexChars: value.maxIndexChars ?? 1600,
    syncIntervalMs: value.syncIntervalMs ?? 3000,
  };
}

/**
 * Mirror oh-my-pi's `encodeProjectPath` in `memories/index.ts`:
 * `--<absolute path without the leading separator, separators -> dashes>--`.
 * Windows paths are case-folded because oh-my-pi normalizes scope cwds there.
 */
function encodeProjectPath(workspaceRoot: string): string {
  const resolved = resolve(workspaceRoot);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return `--${normalized.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function projectMemoryDir(workspaceRoot: string, agentDir: string): string {
  return join(agentDir, "memories", encodeProjectPath(workspaceRoot));
}

function parseLesson(rawText: string): ParsedLesson {
  const match = LESSON_CONTEXT.exec(rawText);
  if (!match) return { text: rawText.trim() };
  return { text: match[1].trim(), context: match[2].trim() };
}

function parseLearned(content: string): ParsedLearned {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();

  const exported = new Map<string, string>();
  const lessons: ParsedLesson[] = [];
  for (const line of lines) {
    const exportMatch = EXPORT_LINE.exec(line);
    if (exportMatch) {
      exported.set(exportMatch[1], exportMatch[2]);
      continue;
    }
    const lessonMatch = LESSON_LINE.exec(line);
    if (lessonMatch) lessons.push(parseLesson(lessonMatch[1]));
  }

  return { lines, exported, lessons };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readState(root: string): Promise<{ path: string; state: BridgeState }> {
  const path = join(await memoryRoot(root), "oh-my-pi-bridge.json");
  const raw = await readJSON<Partial<BridgeState>>(path, () => ({
    version: 1,
    exported: {},
    imported: {},
  }));
  const exported = isRecord(raw.exported) ? (raw.exported as Record<string, BridgeExportedEntry>) : {};
  const imported = isRecord(raw.imported) ? (raw.imported as Record<string, BridgeImportedEntry>) : {};
  return {
    path,
    state: {
      version: 1,
      lastSyncAt: raw.lastSyncAt,
      exported,
      imported,
    },
  };
}

function flattenText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeLessonKey(text: string): string {
  return flattenText(text).toLowerCase();
}

function lessonHash(text: string): string {
  return sha256(flattenText(text)).slice(0, 16);
}

function isSensitive(text: string): boolean {
  return SENSITIVE_PATTERN.test(text);
}

function addTag(tags: string[] | undefined, tag: string): string[] {
  return [...new Set([...(tags ?? []), tag])];
}

function importedText(entry: LongTermMemoryEntry, options: ResolvedOptions): string {
  const text = options.includeSensitive ? entry.text : redactCredentials(entry.text);
  return flattenText(text).slice(0, LONG_TERM_LIMITS.maxEntryTextChars);
}

function importType(text: string): LongTermType {
  if (/\b(prefer|always|never|do not|don't|must|avoid)\b/i.test(text)) return "feedback";
  if (/\b(decided|decision|chose|choose|convention)\b/i.test(text)) return "decision";
  return "project";
}

function applyExportedEdits(
  store: WorkspaceMemoryStore,
  parsed: ParsedLearned,
  options: ResolvedOptions,
): { changed: boolean; imported: number } {
  let changed = false;
  let imported = 0;
  const byId = new Map(store.entries.map(entry => [entry.id, entry]));

  for (const [id, rawText] of parsed.exported) {
    const entry = byId.get(id);
    if (!entry || entry.status !== "active") continue;
    const text = flattenText(options.includeSensitive ? rawText : redactCredentials(rawText))
      .slice(0, LONG_TERM_LIMITS.maxEntryTextChars);
    if (!text || text === entry.text) continue;

    entry.text = text;
    entry.updatedAt = new Date().toISOString();
    entry.tags = addTag(entry.tags, "omp-edited");
    changed = true;
    imported += 1;
  }

  return { changed, imported };
}

function applyDeletedExports(
  store: WorkspaceMemoryStore,
  parsed: ParsedLearned,
  state: BridgeState,
): { changed: boolean; imported: number } {
  let changed = false;
  let imported = 0;

  // At the lesson cap, a missing line may have been evicted by oh-my-pi's own
  // retention instead of deleted by the user. Do not supersede on that signal;
  // the next export puts the line back at the head of the lesson list.
  if (parsed.lessons.length >= OMP_LESSON_CAP - 1) return { changed, imported };

  for (const id of Object.keys(state.exported)) {
    if (parsed.exported.has(id)) continue;
    const entry = store.entries.find(item => item.id === id);
    if (!entry || entry.status !== "active") continue;
    entry.status = "superseded";
    entry.updatedAt = new Date().toISOString();
    changed = true;
    imported += 1;
  }

  return { changed, imported };
}

function applyDeletedOmpLessons(
  store: WorkspaceMemoryStore,
  parsed: ParsedLearned,
  state: BridgeState,
): { changed: boolean; imported: number; removedHashes: string[] } {
  let changed = false;
  let imported = 0;
  const removedHashes: string[] = [];

  // Same cap caveat as exported lines: eviction is not a user deletion.
  if (parsed.lessons.length >= OMP_LESSON_CAP - 1) return { changed, imported, removedHashes };

  const live = new Set(parsed.lessons.map(lesson => lessonHash(lesson.text)));
  for (const [hash, info] of Object.entries(state.imported)) {
    if (live.has(hash)) continue;
    removedHashes.push(hash);
    const entry = store.entries.find(item => item.id === info.entryId);
    if (!entry || entry.status !== "active") continue;
    entry.status = "superseded";
    entry.updatedAt = new Date().toISOString();
    changed = true;
    imported += 1;
  }

  return { changed, imported, removedHashes };
}

function applyOmpLessons(
  store: WorkspaceMemoryStore,
  parsed: ParsedLearned,
  state: BridgeState,
  options: ResolvedOptions,
): { changed: boolean; imported: number; newImports: Record<string, BridgeImportedEntry> } {
  const active = store.entries.filter(entry => entry.status === "active");
  const ompCount = active.filter(entry => (entry.tags ?? []).includes(OMP_TAG)).length;
  let slots = Math.min(
    options.maxImportedLessons - ompCount,
    LONG_TERM_LIMITS.maxEntries - active.length,
  );

  const newImports: Record<string, BridgeImportedEntry> = {};
  if (slots <= 0) return { changed: false, imported: 0, newImports };

  const existingText = new Set(active.map(entry => normalizeLessonKey(entry.text)));
  const seen = new Set<string>();
  let changed = false;
  let imported = 0;

  for (const lesson of parsed.lessons) {
    if (slots <= 0) break;

    const text = flattenText(lesson.text);
    if (!text) continue;
    if (!options.includeSensitive && isSensitive(text)) continue;

    const key = normalizeLessonKey(text);
    if (seen.has(key) || existingText.has(key)) continue;
    seen.add(key);

    const hash = lessonHash(text);
    if (state.imported[hash]) continue;

    const id = `omp_${hash}`;
    const createdAt = new Date().toISOString();
    const existing = store.entries.find(item => item.id === id);
    if (existing) {
      existing.status = "active";
      existing.text = text.slice(0, LONG_TERM_LIMITS.maxEntryTextChars);
      existing.rationale = lesson.context?.slice(0, LONG_TERM_LIMITS.maxRationaleChars);
      existing.updatedAt = createdAt;
      existing.tags = addTag(existing.tags, OMP_TAG);
    } else {
      store.entries.push({
        id,
        type: importType(text),
        text: text.slice(0, LONG_TERM_LIMITS.maxEntryTextChars),
        rationale: lesson.context?.slice(0, LONG_TERM_LIMITS.maxRationaleChars),
        source: "manual",
        confidence: 0.85,
        status: "active",
        createdAt,
        updatedAt: createdAt,
        tags: [OMP_TAG, "shared", `${OMP_TAG}:${hash}`],
      });
    }

    newImports[hash] = { entryId: id };
    changed = true;
    imported += 1;
    slots -= 1;
  }

  return { changed, imported, newImports };
}

function buildExportLines(
  store: WorkspaceMemoryStore,
  parsed: ParsedLearned,
  options: ResolvedOptions,
): string[] {
  const existing = new Set(parsed.lessons.map(lesson => normalizeLessonKey(lesson.text)));
  const exportable = store.entries
    .filter(entry => entry.status === "active")
    .filter(entry => !(entry.tags ?? []).some(tag => tag === OMP_TAG || tag.startsWith(`${OMP_TAG}:`)))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, options.maxExported);

  const lines: string[] = [];
  for (const entry of exportable) {
    const text = importedText(entry, options);
    if (!text) continue;
    // Do not duplicate a lesson oh-my-pi already owns verbatim.
    if (existing.has(normalizeLessonKey(text))) continue;
    lines.push(`- [opencode:${entry.id}] ${text}`);
  }
  return lines;
}

function renderLearnedContent(parsed: ParsedLearned, exportLines: string[]): string {
  const out: string[] = [];
  let inserted = false;

  for (const line of parsed.lines) {
    if (EXPORT_LINE.test(line)) {
      if (!inserted) {
        out.push(...exportLines);
        inserted = true;
      }
      continue;
    }
    out.push(line);
  }

  if (!inserted && exportLines.length > 0) {
    const firstLesson = out.findIndex(line => line.trimStart().startsWith("- "));
    if (firstLesson === -1) out.push(...exportLines);
    else out.splice(firstLesson, 0, ...exportLines);
  }

  while (out.length > 0 && out.at(-1) === "") out.pop();
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

function buildIndexPrompt(lessons: ParsedLesson[], filePath: string, options: ResolvedOptions): string {
  const visible: ParsedLesson[] = [];
  const seen = new Set<string>();
  for (const lesson of lessons) {
    const text = flattenText(lesson.text);
    if (!text) continue;
    if (!options.includeSensitive && isSensitive(text)) continue;
    const key = normalizeLessonKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    visible.push(lesson);
    if (visible.length >= options.maxIndexEntries) break;
  }

  if (visible.length === 0) return "";

  const lines = [
    "## Shared oh-my-pi memory (local backend)",
    "",
    `Memory file: ${filePath}`,
    "",
    "Recent lessons:",
  ];

  let text = lines.join("\n");
  let truncated = visible.length < lessons.length;
  for (const lesson of visible) {
    const label = flattenText(lesson.text).slice(0, 140);
    const line = `- ${label}`;
    if (text.length + line.length + 1 > options.maxIndexChars) {
      truncated = true;
      break;
    }
    text += `\n${line}`;
  }

  text += "\n\nUse the read tool on the memory file for the full list.";
  if (truncated) text += "\n[index truncated]";
  return text;
}

export async function syncOhMyPiBridge(
  workspaceRoot: string,
  value?: boolean | OhMyPiBridgeOptions,
): Promise<OhMyPiBridgeResult> {
  const options = resolveOptions(value);
  if (!options.enabled) return { changed: false, indexPrompt: "", imported: 0, exported: 0 };
  if (!existsSync(options.homeDir)) {
    return { changed: false, indexPrompt: "", imported: 0, exported: 0 };
  }

  const projectDir = projectMemoryDir(workspaceRoot, options.agentDir);
  const filePath = join(projectDir, "learned.md");

  let content: string | undefined;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    content = undefined;
  }
  const parsed = parseLearned(content ?? "");

  const { path: statePath, state } = await readState(workspaceRoot);
  const probe = await loadWorkspaceMemory(workspaceRoot);

  const probeEdits = applyExportedEdits(probe, parsed, options);
  const probeDeletes = content === undefined
    ? { changed: false, imported: 0 }
    : applyDeletedExports(probe, parsed, state);
  const probeLessonDeletes = applyDeletedOmpLessons(probe, parsed, state);
  const probeImports = applyOmpLessons(probe, parsed, state, options);

  const changed = probeEdits.changed
    || probeDeletes.changed
    || probeLessonDeletes.changed
    || probeImports.changed;
  const imported = probeEdits.imported
    + probeDeletes.imported
    + probeLessonDeletes.imported
    + probeImports.imported;

  let store = probe;
  if (changed) {
    store = await updateWorkspaceMemory(workspaceRoot, current => {
      applyExportedEdits(current, parsed, options);
      if (content !== undefined) applyDeletedExports(current, parsed, state);
      applyDeletedOmpLessons(current, parsed, state);
      applyOmpLessons(current, parsed, state, options);
      return current;
    });
  }

  const exportLines = buildExportLines(store, parsed, options);
  const nextContent = renderLearnedContent(parsed, exportLines);
  if (nextContent !== (content ?? "")) {
    await mkdir(projectDir, { recursive: true });
    await atomicWriteText(filePath, nextContent, 0o600);
  }

  const nextExported: Record<string, BridgeExportedEntry> = {};
  for (const line of exportLines) {
    const match = EXPORT_LINE.exec(line);
    if (!match) continue;
    nextExported[match[1]] = { hash: sha256(line), text: match[2] };
  }
  const nextImported: Record<string, BridgeImportedEntry> = { ...state.imported };
  for (const hash of probeLessonDeletes.removedHashes) {
    delete nextImported[hash];
  }
  for (const [hash, info] of Object.entries(probeImports.newImports)) {
    if (store.entries.some(entry => entry.id === info.entryId && entry.status === "active")) {
      nextImported[hash] = info;
    }
  }

  await atomicWriteJSON(statePath, {
    version: 1,
    lastSyncAt: new Date().toISOString(),
    exported: nextExported,
    imported: nextImported,
  } satisfies BridgeState);

  return {
    changed,
    indexPrompt: buildIndexPrompt(parsed.lessons, filePath, options),
    imported,
    exported: exportLines.length,
    projectDir,
  };
}

/** Export only; used after compaction promotion and session cleanup. */
export async function exportOhMyPiBridge(
  workspaceRoot: string,
  value?: boolean | OhMyPiBridgeOptions,
): Promise<void> {
  await syncOhMyPiBridge(workspaceRoot, value);
}
