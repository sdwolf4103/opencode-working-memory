import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "./types.ts";
import { LONG_TERM_LIMITS } from "./types.ts";
import { workspaceKey, workspaceMemoryPath } from "./paths.ts";
import { atomicWriteJSON, readJSON, updateJSON } from "./storage.ts";

// Minimum length for workspace_memory envelope: <workspace_memory>\n...\n</workspace_memory>
const MIN_ENVELOPE_LENGTH = 80;
const MIGRATION_ID = "2026-04-26-p0-cleanup";

const SECRET_VALUE = String.raw`[^` + "`" + String.raw`'",，,\s\[]+`;

const PASSWORD_LABELS = /password|passwd|pwd|密碼|密码|パスワード|비밀번호|contraseña|mot de passe|passwort/i;
const USERNAME_LABELS = /username|user name|用戶名|用户名|ユーザー名|사용자명|usuario|utilisateur|benutzer/i;

const PIN_PREFIX = String.raw`(\bPIN\b(?:\s*(?:是|=|:|：)\s*|\s+(?![是=:：])))`;
const PASSWORD_PREFIX = String.raw`((?:${PASSWORD_LABELS.source})(?:\s*(?:是|=|:|：)\s*|\s+(?![是=:：])))`;
const USERNAME_PREFIX = String.raw`((?:${USERNAME_LABELS.source})(?:\s*(?:是|=|:|：)\s*|\s+(?![是=:：])))`;

export async function emptyWorkspaceMemory(root: string): Promise<WorkspaceMemoryStore> {
  return {
    version: 1,
    workspace: { root, key: await workspaceKey(root) },
    limits: {
      maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars,
      maxEntries: LONG_TERM_LIMITS.maxEntries,
    },
    entries: [],
    migrations: [],
    updatedAt: new Date().toISOString(),
  };
}

export async function loadWorkspaceMemory(root: string): Promise<WorkspaceMemoryStore> {
  const path = await workspaceMemoryPath(root);
  const fallback = await emptyWorkspaceMemory(root);
  const loaded = await readJSON(path, () => fallback) as Partial<WorkspaceMemoryStore>;

  const store: WorkspaceMemoryStore = {
    version: loaded.version ?? 1,
    workspace: loaded.workspace ?? { root, key: await workspaceKey(root) },
    limits: {
      maxRenderedChars: loaded.limits?.maxRenderedChars ?? LONG_TERM_LIMITS.maxRenderedChars,
      maxEntries: loaded.limits?.maxEntries ?? LONG_TERM_LIMITS.maxEntries,
    },
    entries: Array.isArray(loaded.entries) ? loaded.entries : [],
    migrations: Array.isArray(loaded.migrations) ? loaded.migrations : [],
    updatedAt: loaded.updatedAt ?? fallback.updatedAt,
  };

  // Always normalize on load so redaction/migrations are always-on.
  const normalized = await normalizeWorkspaceMemory(root, store);

  // Persist only when meaningful content changed (ignore timestamps).
  if (didStoreMeaningfullyChange(store, normalized)) {
    await atomicWriteJSON(path, normalized);
  }

  return normalized;
}

function didStoreMeaningfullyChange(
  before: WorkspaceMemoryStore,
  after: WorkspaceMemoryStore,
): boolean {
  const sanitize = (store: WorkspaceMemoryStore) => ({
    ...store,
    updatedAt: "",
    entries: store.entries.map(entry => ({
      ...entry,
      updatedAt: "",
    })),
  });

  return JSON.stringify(sanitize(before)) !== JSON.stringify(sanitize(after));
}

export async function saveWorkspaceMemory(root: string, store: WorkspaceMemoryStore): Promise<void> {
  const normalized = await normalizeWorkspaceMemory(root, store);
  await atomicWriteJSON(await workspaceMemoryPath(root), normalized);
}

export async function updateWorkspaceMemory(
  root: string,
  updater: (store: WorkspaceMemoryStore) => WorkspaceMemoryStore | Promise<WorkspaceMemoryStore>,
): Promise<WorkspaceMemoryStore> {
  const path = await workspaceMemoryPath(root);
  const fallback = await emptyWorkspaceMemory(root);
  return updateJSON(path, () => fallback, async current => {
    const normalized = await normalizeWorkspaceMemory(root, current);
    return normalizeWorkspaceMemory(root, await updater(normalized));
  });
}

async function normalizeWorkspaceMemory(
  root: string,
  store: WorkspaceMemoryStore,
): Promise<WorkspaceMemoryStore> {
  const nowIso = new Date().toISOString();

  let result: WorkspaceMemoryStore = {
    ...store,
    workspace: { root, key: await workspaceKey(root) },
    limits: {
      maxRenderedChars: store.limits?.maxRenderedChars ?? LONG_TERM_LIMITS.maxRenderedChars,
      maxEntries: store.limits?.maxEntries ?? LONG_TERM_LIMITS.maxEntries,
    },
    entries: Array.isArray(store.entries) ? store.entries : [],
    migrations: Array.isArray(store.migrations) ? store.migrations : [],
    updatedAt: nowIso,
  };

  // Always-on credential redaction
  result.entries = result.entries.map(entry => {
    const text = redactCredentials(entry.text);
    const rationale = entry.rationale ? redactCredentials(entry.rationale) : undefined;

    if (text === entry.text && rationale === entry.rationale) {
      return entry;
    }

    return {
      ...entry,
      text,
      rationale,
      updatedAt: nowIso,
    };
  });

  // One-time migration for legacy snapshot violations
  result = runMigrationP0Cleanup(result, nowIso);

  // Enforce limits on active entries while preserving superseded entries in storage
  const activeEntries = result.entries.filter(entry => entry.status !== "superseded");
  const supersededEntries = result.entries.filter(entry => entry.status === "superseded");
  const processedActive = enforceLongTermLimits(activeEntries);

  return {
    ...result,
    entries: [...processedActive, ...supersededEntries],
    updatedAt: nowIso,
  };
}

export function redactCredentials(text: string): string {
  let result = text;

  // 1. PIN
  result = result.replace(
    new RegExp(String.raw`${PIN_PREFIX}[\`'"]?(${SECRET_VALUE})`, "gi"),
    "$1[REDACTED]",
  );

  // 2. Username+password pair
  result = result.replace(
    new RegExp(
      String.raw`${USERNAME_PREFIX}[\`'"]?(${SECRET_VALUE})((?:，|,)\s*)${PASSWORD_PREFIX}[\`'"]?(${SECRET_VALUE})`,
      "gi",
    ),
    "$1[REDACTED]$3$4[REDACTED]",
  );

  // 3. Standalone password
  result = result.replace(
    new RegExp(String.raw`${PASSWORD_PREFIX}[\`'"]?(${SECRET_VALUE})`, "gi"),
    "$1[REDACTED]",
  );

  return result;
}

export function isProjectSnapshotViolation(text: string): boolean {
  // Test/suite counts
  if (/\d+\s+tests?\s+pass(?:ed)?/i.test(text)) return true;
  if (/\d+\s+suites?\s+(?:pass|fail)/i.test(text)) return true;

  // File counts with snapshot context, excluding limit statements
  if (/\d+\s*(?:個|个)?\s*(?:files?|文件)/i.test(text)) {
    const hasSnapshotContext = /同步|synced|uploaded|downloaded|completed|generated|created|modified|processed|完成/i.test(text);
    const hasLimitContext = /limit|max|maximum|min|minimum|supports?|allowed|per\s+(?:batch|request|upload)/i.test(text);
    if (hasSnapshotContext && !hasLimitContext) return true;
  }

  // Phase/Wave/Sprint/Milestone/Task progress
  if (/(?:phases?|waves?|sprints?|milestones?|tasks?)\s*\d+(?:\s*[-–]\s*\d+)?/i.test(text)) {
    if (/completed|done|finished|完成/i.test(text)) return true;
  }

  if (/(?:已完成|完成).{0,30}(?:phases?|waves?|sprints?|milestones?|tasks?)/i.test(text)) return true;

  return false;
}

export function runMigrationP0Cleanup(
  store: WorkspaceMemoryStore,
  nowIso: string,
): WorkspaceMemoryStore {
  if (store.migrations?.includes(MIGRATION_ID)) {
    return store;
  }

  const entries = store.entries.map(entry => {
    if (entry.source === "explicit") return entry;
    if (entry.type !== "project") return entry;

    if (isProjectSnapshotViolation(entry.text)) {
      return {
        ...entry,
        status: "superseded" as const,
        updatedAt: nowIso,
      };
    }

    return entry;
  });

  return {
    ...store,
    entries,
    migrations: [...(store.migrations || []), MIGRATION_ID],
    updatedAt: nowIso,
  };
}

function sourcePriority(source: LongTermMemoryEntry["source"]): number {
  if (source === "explicit") return 3;
  if (source === "manual") return 2;
  return 1;
}

function canonicalMemoryText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, " ")
    .trim();
}

/** Extract entity/destination keys for project and reference dedup */
function extractEntityKey(text: string): string | null {
  const normalized = canonicalMemoryText(text);
  // Check known key phrases (bilingual-friendly)
  // opencode + agenthub plugin system
  if (/opencode.*agenthub/i.test(normalized)) {
    return "opencode-agenthub plugin system";
  }
  // For generic config references, fall back to canonical text dedup — no entity key
  return null;
}

/** Extract decision topic key for supersession detection */
function decisionTopicKey(text: string): string | null {
  const normalized = text.toLowerCase();
  // Parser format versions
  if (/parser.*formats?|supports?\s*\d+\s*format/i.test(normalized)) {
    return "parser-supported-formats";
  }
  // Compaction template replacement
  if (/compaction.*template|output\.prompt|template.*replace/i.test(normalized)) {
    return "compaction-template-replacement";
  }
  // Plugin loading
  if (/plugin.*load|npm.*cache|plugin.*config/i.test(normalized)) {
    return "plugin-loading-config";
  }
  // Output format changes (purple/italic, YAML frontmatter, etc)
  if (/purple.*italic|markup|markdown.*render|frontmatter/i.test(normalized)) {
    return "output-format-rendering";
  }
  return null;
}

/** Extract feedback topic key for supersession detection */
function feedbackTopicKey(text: string): string | null {
  const normalized = text.toLowerCase();
  // Purple/italic rendering issue
  if (/purple.*italic/i.test(normalized)) {
    return "purple-italic-rendering";
  }
  // Browser login/server errors (500 internal_error)
  if (/login.*500|500.*internal|internal_error|server.*error/i.test(normalized)) {
    return "server-error";
  }
  // Port occupied / environment issues
  if (/port.*occup|9473|端口|舊進程|旧进程/i.test(normalized)) {
    return "port-occupied-environment";
  }
  // Theme preferences
  if (/theme|dark.*light|prefer.*theme/i.test(normalized)) {
    return "theme-preference";
  }
  return null;
}

export function workspaceMemoryIdentityKey(entry: Pick<LongTermMemoryEntry, "type" | "text">): string {
  if (entry.type === "project" || entry.type === "reference") {
    return `${entry.type}:${extractEntityKey(entry.text) ?? canonicalMemoryText(entry.text)}`;
  }

  if (entry.type === "feedback") {
    return `${entry.type}:${feedbackTopicKey(entry.text) ?? canonicalMemoryText(entry.text)}`;
  }

  return `decision:${decisionTopicKey(entry.text) ?? canonicalMemoryText(entry.text)}`;
}

/** Check if entry should be pruned by age (for compaction/manual entries only) */
function isPrunableByAge(entry: LongTermMemoryEntry, now: number): boolean {
  // Never prune feedback or explicit entries
  if (entry.type === "feedback") return false;
  if (entry.source === "explicit") return false;
  if (!entry.staleAfterDays) return false;

  const createdAt = new Date(entry.createdAt).getTime();
  const ageDays = (now - createdAt) / 86400000;
  const grace = 30; // 30-day grace period
  return ageDays > entry.staleAfterDays + grace;
}

/** Choose better memory when identity/topic keys conflict */
function chooseBetterMemory(
  a: LongTermMemoryEntry,
  b: LongTermMemoryEntry,
  mode: "entity" | "supersession" = "entity",
): LongTermMemoryEntry {
  // Source priority: explicit > manual > compaction
  if (sourcePriority(a.source) !== sourcePriority(b.source)) {
    return sourcePriority(a.source) > sourcePriority(b.source) ? a : b;
  }
  // Higher confidence wins
  if (a.confidence !== b.confidence) {
    return a.confidence > b.confidence ? a : b;
  }
  // For entity dedup: longer (more specific) beats shorter
  // For supersession: newer beats older (and thus longer is not preferred)
  if (mode === "supersession") {
    // Newer wins for same-topic supersession
    if (new Date(a.createdAt).getTime() !== new Date(b.createdAt).getTime()) {
      return new Date(a.createdAt) > new Date(b.createdAt) ? a : b;
    }
    return a.text.length > b.text.length ? a : b;
  }
  // Entity mode: longer text means more specific
  if (Math.abs(a.text.length - b.text.length) > 10) {
    return a.text.length > b.text.length ? a : b;
  }
  // Freshness tie-breaker
  return new Date(a.createdAt) > new Date(b.createdAt) ? a : b;
}

export function enforceLongTermLimits(entries: LongTermMemoryEntry[]): LongTermMemoryEntry[] {
  const now = Date.now();

  // Phase 1: filter active, prune by age
  const phase1 = entries
    .filter(entry => entry.status !== "superseded")
    .filter(entry => !isPrunableByAge(entry, now))
    .map(entry => ({ ...entry, text: entry.text.slice(0, LONG_TERM_LIMITS.maxEntryTextChars) }));

  // For project/reference/feedback: detect entity keys FIRST, then dedupe by entity OR canonical
  const projectRefEntries = phase1.filter(e => e.type === "project" || e.type === "reference" || e.type === "feedback");

  // Build entity key dedup for project/reference/feedback
  const entityDeduped = new Map<string, LongTermMemoryEntry>();
  for (const entry of projectRefEntries) {
    const key = workspaceMemoryIdentityKey(entry);
    const hasTopicIdentity = key !== `${entry.type}:${canonicalMemoryText(entry.text)}`;

    const existing = entityDeduped.get(key);
    if (!existing) {
      entityDeduped.set(key, entry);
    } else {
      // Feedback topic conflicts use supersession mode (newer beats longer)
      const mode = entry.type === "feedback" && hasTopicIdentity ? "supersession" as const : "entity" as const;
      if (chooseBetterMemory(entry, existing, mode) === entry) {
        entityDeduped.set(key, entry);
      }
    }
  }

  // For decisions: detect topic keys for supersession, or use canonical
  const decisionEntries = phase1.filter(e => e.type === "decision");
  const decisionDeduped = new Map<string, LongTermMemoryEntry>();
  for (const entry of decisionEntries) {
    const key = workspaceMemoryIdentityKey(entry);

    const existing = decisionDeduped.get(key);
    if (!existing) {
      decisionDeduped.set(key, entry);
    } else if (chooseBetterMemory(entry, existing, "supersession") === entry) {
      decisionDeduped.set(key, entry);
    }
  }

  // Merge deduped entries
  const phaseFinal = new Map<string, LongTermMemoryEntry>();
  for (const entry of [...entityDeduped.values(), ...decisionDeduped.values()]) {
    phaseFinal.set(entry.id, entry);
  }

  // Phase 6: sort and trim
  return [...phaseFinal.values()]
    .sort((a, b) => {
      const pA = priorityWithFreshness(a);
      const pB = priorityWithFreshness(b);
      if (pB !== pA) return pB - pA;
      const sourceDiff = sourcePriority(b.source) - sourcePriority(a.source);
      if (sourceDiff !== 0) return sourceDiff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })
    .slice(0, LONG_TERM_LIMITS.maxEntries);
}

function priority(entry: LongTermMemoryEntry): number {
  const typeWeight = {
    feedback: 400,
    decision: 300,
    project: 200,
    reference: 100,
  }[entry.type];

  const sourceWeight = entry.source === "explicit" ? 1000 : 0;
  return sourceWeight + typeWeight + entry.confidence * 10;
}

/** Extended priority including freshness for tie-breaking */
function priorityWithFreshness(entry: LongTermMemoryEntry): number {
  return priority(entry);
}

function wouldFit(
  lines: string[],
  nextLine: string,
  closingLine: string,
  maxChars: number
): boolean {
  return [...lines, nextLine, closingLine].join("\n").length <= maxChars;
}

export function renderWorkspaceMemory(store: WorkspaceMemoryStore): string {
  const active = enforceLongTermLimits(store.entries);
  if (active.length === 0) return "";

  const maxChars = Math.min(
    store.limits.maxRenderedChars,
    LONG_TERM_LIMITS.maxRenderedChars
  );

  // If maxChars smaller than minimum envelope, return empty string
  if (maxChars < MIN_ENVELOPE_LENGTH) return "";

  const lines: string[] = [
    "Workspace memory (cross-session, verify if stale):",
  ];

  for (const type of ["feedback", "project", "decision", "reference"] as const) {
    const items = active.filter(entry => entry.type === type);
    if (items.length === 0) continue;

    const sectionLines: string[] = [`${type}:`];

    for (const item of items) {
      const line = `- ${renderEntry(item)}`;
      if ([...lines, ...sectionLines, line].join("\n").length <= maxChars) {
        sectionLines.push(line);
      }
    }

    if (sectionLines.length > 1) {
      lines.push(...sectionLines);
    }
  }

  return lines.join("\n");
}

function renderEntry(entry: LongTermMemoryEntry): string {
  const ageDays = Math.floor((Date.now() - new Date(entry.createdAt).getTime()) / 86_400_000);
  const stale = entry.staleAfterDays && ageDays > entry.staleAfterDays ? ` [${ageDays}d old, verify]` : "";
  const rationale = entry.rationale
    ? ` Why: ${entry.rationale.slice(0, LONG_TERM_LIMITS.maxRationaleChars)}`
    : "";
  return `${entry.text}${rationale}${stale}`;
}
