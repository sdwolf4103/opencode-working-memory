import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "./types.ts";
import { LONG_TERM_LIMITS } from "./types.ts";
import { workspaceKey, workspaceMemoryPath } from "./paths.ts";
import { atomicWriteJSON, readJSON, updateJSON } from "./storage.ts";
import { assessMemoryQuality, isHardQualityReason, isProgressSnapshotViolation } from "./memory-quality.ts";

// Minimum length for workspace_memory envelope: <workspace_memory>\n...\n</workspace_memory>
const MIN_ENVELOPE_LENGTH = 80;
const MIGRATION_ID = "2026-04-26-p0-cleanup";
const QUALITY_CLEANUP_MIGRATION_ID = "2026-04-28-quality-cleanup";

const SECRET_VALUE = String.raw`[^` + "`" + String.raw`'",，,\s\[]+`;

const PASSWORD_LABELS = /password|passwd|pwd|密碼|密码|パスワード|비밀번호|contraseña|mot de passe|passwort/i;
const USERNAME_LABELS = /username|user name|用戶名|用户名|ユーザー名|사용자명|usuario|utilisateur|benutzer/i;
const SENSITIVE_LABELS = /api[_-]?key|token|bearer|secret|credential|auth|auth[_-]?key|private[_-]?key/i;

const PIN_PREFIX = String.raw`(\bPIN\b(?:\s*(?:是|=|:|：)\s*|\s+(?![是=:：])))`;
const PASSWORD_PREFIX = String.raw`((?:${PASSWORD_LABELS.source})(?:\s*(?:是|=|:|：)\s*|\s+(?![是=:：])))`;
const USERNAME_PREFIX = String.raw`((?:${USERNAME_LABELS.source})(?:\s*(?:是|=|:|：)\s*|\s+(?![是=:：])))`;
const SENSITIVE_PREFIX = String.raw`((?:${SENSITIVE_LABELS.source})(?:\s*(?:推|是|=|:|：)\s*|[:：]\s*))`;
const BEARER_PREFIX = String.raw`(Bearer\s+)`;

export type MemoryConsolidationReason =
  | "promoted"
  | "absorbed_exact"
  | "absorbed_identity"
  | "superseded_existing"
  | "rejected_capacity"
  | "rejected_stale";

export type MemoryConsolidationEvent = {
  memoryKey: string;
  identityKey: string;
  memory: LongTermMemoryEntry;
  reason: MemoryConsolidationReason;
  retainedId?: string;
  supersededId?: string;
};

export type LongTermLimitResult = {
  kept: LongTermMemoryEntry[];
  dropped: MemoryConsolidationEvent[];
  absorbed: MemoryConsolidationEvent[];
  superseded: MemoryConsolidationEvent[];
};

export type WorkspaceMemoryNormalizationResult = LongTermLimitResult & {
  store: WorkspaceMemoryStore;
  events: MemoryConsolidationEvent[];
};

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
  const normalized = await normalizeWorkspaceMemoryWithAccounting(root, store);

  // Persist security/correctness mutations, but avoid read-time maintenance
  // writes for ordering/capacity/timestamp-only normalization.
  if (hasSecurityOrMigrationChange(store, normalized.store)) {
    await atomicWriteJSON(path, normalized.store);
  }

  return normalized.store;
}

function hasSecurityOrMigrationChange(
  before: WorkspaceMemoryStore,
  after: WorkspaceMemoryStore,
): boolean {
  const beforeById = new Map((before.entries ?? []).map(entry => [entry.id, entry]));
  for (const afterEntry of after.entries ?? []) {
    const beforeEntry = beforeById.get(afterEntry.id);
    if (!beforeEntry) continue;
    if (beforeEntry.text !== afterEntry.text) return true;
    if ((beforeEntry.rationale ?? "") !== (afterEntry.rationale ?? "")) return true;
    if (beforeEntry.status !== afterEntry.status) return true;
  }

  const beforeMigrations = JSON.stringify(before.migrations ?? []);
  const afterMigrations = JSON.stringify(after.migrations ?? []);
  return beforeMigrations !== afterMigrations;
}

export async function saveWorkspaceMemory(root: string, store: WorkspaceMemoryStore): Promise<void> {
  const normalized = await normalizeWorkspaceMemory(root, store);
  await atomicWriteJSON(await workspaceMemoryPath(root), normalized);
}

export async function updateWorkspaceMemory(
  root: string,
  updater: (store: WorkspaceMemoryStore) => WorkspaceMemoryStore | Promise<WorkspaceMemoryStore>,
): Promise<WorkspaceMemoryStore> {
  return (await updateWorkspaceMemoryWithAccounting(root, updater)).store;
}

export async function updateWorkspaceMemoryWithAccounting(
  root: string,
  updater: (store: WorkspaceMemoryStore) => WorkspaceMemoryStore | Promise<WorkspaceMemoryStore>,
): Promise<WorkspaceMemoryNormalizationResult> {
  const path = await workspaceMemoryPath(root);
  const fallback = await emptyWorkspaceMemory(root);
  let finalResult: WorkspaceMemoryNormalizationResult | undefined;
  const store = await updateJSON(path, () => fallback, async current => {
    const normalized = await normalizeWorkspaceMemory(root, current);
    finalResult = await normalizeWorkspaceMemoryWithAccounting(root, await updater(normalized));
    return finalResult.store;
  });

  return finalResult ?? {
    store,
    kept: store.entries.filter(entry => entry.status !== "superseded"),
    dropped: [],
    absorbed: [],
    superseded: [],
    events: [],
  };
}

export async function normalizeWorkspaceMemory(
  root: string,
  store: WorkspaceMemoryStore,
): Promise<WorkspaceMemoryStore> {
  return (await normalizeWorkspaceMemoryWithAccounting(root, store)).store;
}

export async function normalizeWorkspaceMemoryWithAccounting(
  root: string,
  store: WorkspaceMemoryStore,
): Promise<WorkspaceMemoryNormalizationResult> {
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

  // One-time migrations for legacy/low-quality snapshot violations.
  // Run quality cleanup first so hard violations receive quality audit tags
  // before the older P0 project-only cleanup marks progress snapshots.
  result = runMigrationQualityCleanup(result, nowIso);
  result = runMigrationP0Cleanup(result, nowIso);

  // P0 accounting only considers active entries. Entries that were already
  // superseded before this normalization are preserved in storage; entries that
  // lose during this enforcement are reported via accounting events but are not
  // archived as superseded records in this wave.
  const activeEntries = result.entries.filter(entry => entry.status !== "superseded");
  const supersededEntries = result.entries.filter(entry => entry.status === "superseded");
  const accounting = enforceLongTermLimitsWithAccounting(activeEntries);

  const normalizedStore = {
    ...result,
    entries: [...accounting.kept, ...supersededEntries],
    updatedAt: nowIso,
  };

  return {
    store: normalizedStore,
    kept: accounting.kept,
    dropped: accounting.dropped,
    absorbed: accounting.absorbed,
    superseded: accounting.superseded,
    events: [...accounting.dropped, ...accounting.absorbed, ...accounting.superseded],
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

  // 4. Standalone sensitive keys/tokens
  result = result.replace(
    new RegExp(String.raw`${BEARER_PREFIX}(?!token\s*[:=：])[\`'"]?(${SECRET_VALUE})`, "gi"),
    "$1[REDACTED]",
  );

  result = result.replace(
    new RegExp(String.raw`${SENSITIVE_PREFIX}[\`'"]?(${SECRET_VALUE})`, "gi"),
    "$1[REDACTED]",
  );

  return result;
}

export function runMigrationP0Cleanup(
  store: WorkspaceMemoryStore,
  nowIso: string,
): WorkspaceMemoryStore {
  if (store.migrations?.includes(MIGRATION_ID)) {
    return store;
  }

  const entries = store.entries.map(entry => {
    if (entry.source !== "compaction") return entry;
    if (entry.type !== "project") return entry;

    if (isProgressSnapshotViolation(entry.text)) {
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

export function runMigrationQualityCleanup(
  store: WorkspaceMemoryStore,
  nowIso: string,
): WorkspaceMemoryStore {
  if (store.migrations?.includes(QUALITY_CLEANUP_MIGRATION_ID)) {
    return store;
  }

  let changed = false;
  const entries = store.entries.map(entry => {
    if (entry.source !== "compaction") return entry;
    if (entry.status === "superseded") return entry;

    const quality = assessMemoryQuality(entry);
    if (quality.accepted) return entry;

    const hardReasons = quality.reasons.filter(isHardQualityReason);
    if (hardReasons.length === 0) return entry;

    changed = true;
    const tags = new Set([
      ...(entry.tags ?? []),
      "quality_cleanup",
      ...hardReasons.map(reason => `quality:${reason}`),
    ]);

    return {
      ...entry,
      status: "superseded" as const,
      updatedAt: nowIso,
      tags: [...tags],
    };
  });

  return {
    ...store,
    entries,
    migrations: [...(store.migrations ?? []), QUALITY_CLEANUP_MIGRATION_ID],
    updatedAt: changed ? nowIso : store.updatedAt,
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

export function workspaceMemoryExactKey(entry: Pick<LongTermMemoryEntry, "type" | "text">): string {
  return `${entry.type}:${canonicalMemoryText(entry.text)}`;
}

function normalizeUrlIdentity(raw: string): string | null {
  const cleaned = raw.replace(/[),.;:!?]+$/g, "");
  try {
    const url = new URL(cleaned);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/g, "");
    }
    return `url:${url.toString()}`;
  } catch {
    return null;
  }
}

function normalizePathIdentity(raw: string): string | null {
  const unwrapped = raw
    .trim()
    .replace(/^[`"']+|[`"']+$/g, "")
    .replace(/[),.;:!?]+$/g, "")
    .replace(/\\+/g, "/");

  if (!unwrapped) return null;
  const collapsed = unwrapped.startsWith("/")
    ? `/${unwrapped.slice(1).replace(/\/+$/g, "/").replace(/\/+/g, "/")}`
    : unwrapped.replace(/\/+/g, "/");
  const withoutTrailingSlash = collapsed.length > 1 ? collapsed.replace(/\/+$/g, "") : collapsed;
  return `path:${withoutTrailingSlash}`;
}

function isConcretePathIdentity(pathIdentity: string): boolean {
  const path = pathIdentity.slice("path:".length);
  if (!path || path === "." || path === "..") return false;

  if (path.startsWith("/")) return true;
  if (/^\.\.?\//.test(path)) return true;
  if (/^\.[A-Za-z0-9_.-]+\//.test(path)) return true;
  if (/^[A-Za-z0-9_.-]+\//.test(path)) return true;
  return /\.(?:json|jsonc|ts|tsx|js|jsx|mjs|cjs|md|yaml|yml|toml|lock|config)$/i.test(path);
}

function normalizeConcretePathIdentity(raw: string): string | null {
  const pathIdentity = normalizePathIdentity(raw);
  if (!pathIdentity) return null;
  return isConcretePathIdentity(pathIdentity) ? pathIdentity : null;
}

function extractConcreteIdentityKey(text: string): string | null {
  const urlMatch = text.match(/https?:\/\/[^\s`"'<>]+/i);
  if (urlMatch) {
    const urlIdentity = normalizeUrlIdentity(urlMatch[0]);
    if (urlIdentity) return urlIdentity;
  }

  const wrappedPathPattern = /[`"']([^`"']+)[`"']/g;
  for (const match of text.matchAll(wrappedPathPattern)) {
    const pathIdentity = normalizeConcretePathIdentity(match[1]);
    if (pathIdentity) return pathIdentity;
  }

  const pathMatch = text.match(/(?:\/[^ \s`"'<>]+|(?:\.{1,2}[\\/]|[A-Za-z0-9_.-]+[\\/])[^\s`"'<>]+|[A-Za-z0-9_.-]+\.(?:json|jsonc|ts|tsx|js|jsx|mjs|cjs|md|yaml|yml|toml|lock|config))(?:\b|$)/);
  if (!pathMatch) return null;

  return normalizeConcretePathIdentity(pathMatch[0]);
}

export function workspaceMemoryIdentityKey(entry: Pick<LongTermMemoryEntry, "type" | "text">): string {
  if (entry.type === "project" || entry.type === "reference") {
    return `${entry.type}:${extractConcreteIdentityKey(entry.text) ?? canonicalMemoryText(entry.text)}`;
  }

  return workspaceMemoryExactKey(entry);
}

function consolidationEvent(
  memory: LongTermMemoryEntry,
  reason: MemoryConsolidationReason,
  retained?: LongTermMemoryEntry,
): MemoryConsolidationEvent {
  return {
    memoryKey: workspaceMemoryExactKey(memory),
    identityKey: workspaceMemoryIdentityKey(memory),
    memory,
    reason,
    retainedId: retained?.id,
    supersededId: reason === "superseded_existing" ? memory.id : undefined,
  };
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
  return enforceLongTermLimitsWithAccounting(entries).kept;
}

export function enforceLongTermLimitsWithAccounting(entries: LongTermMemoryEntry[]): LongTermLimitResult {
  const now = Date.now();
  const staleDropped: MemoryConsolidationEvent[] = [];

  // Phase 1: filter active, prune by age
  const phase1: LongTermMemoryEntry[] = [];
  for (const entry of entries) {
    if (entry.status === "superseded") continue;
    if (isPrunableByAge(entry, now)) {
      staleDropped.push(consolidationEvent(entry, "rejected_stale"));
      continue;
    }
    phase1.push({ ...entry, text: entry.text.slice(0, LONG_TERM_LIMITS.maxEntryTextChars) });
  }

  const dedupeResult = dedupeLongTermEntriesWithAccounting(phase1);
  const sorted = [...dedupeResult.kept].sort(compareLongTermMemoryForRetention);
  const kept = sorted.slice(0, LONG_TERM_LIMITS.maxEntries);
  const keptIds = new Set(kept.map(entry => entry.id));
  const capacityDropped = sorted
    .filter(entry => !keptIds.has(entry.id))
    .map(entry => consolidationEvent(entry, "rejected_capacity"));

  return {
    kept,
    dropped: [...staleDropped, ...dedupeResult.dropped, ...capacityDropped],
    absorbed: dedupeResult.absorbed,
    superseded: dedupeResult.superseded,
  };
}

export function dedupeLongTermEntriesWithAccounting(entries: LongTermMemoryEntry[]): LongTermLimitResult {
  const absorbed: MemoryConsolidationEvent[] = [];
  const superseded: MemoryConsolidationEvent[] = [];

  // For project/reference/feedback: dedupe by concrete identity or exact canonical text.
  const projectRefEntries = entries.filter(e => e.type === "project" || e.type === "reference" || e.type === "feedback");

  // Build identity key dedup for project/reference/feedback.
  const entityDeduped = new Map<string, LongTermMemoryEntry>();
  for (const entry of projectRefEntries) {
    const key = workspaceMemoryIdentityKey(entry);

    const existing = entityDeduped.get(key);
    if (!existing) {
      entityDeduped.set(key, entry);
    } else {
      const retained = chooseBetterMemory(entry, existing, "entity");
      const dropped = retained === entry ? existing : entry;
      const reason = workspaceMemoryExactKey(entry) === workspaceMemoryExactKey(existing)
        ? "absorbed_exact" as const
        : "absorbed_identity" as const;

      absorbed.push(consolidationEvent(dropped, reason, retained));

      if (retained === entry) {
        entityDeduped.set(key, entry);
      }
    }
  }

  // For decisions: exact canonical duplicates only.
  const decisionEntries = entries.filter(e => e.type === "decision");
  const decisionDeduped = new Map<string, LongTermMemoryEntry>();
  for (const entry of decisionEntries) {
    const key = workspaceMemoryIdentityKey(entry);

    const existing = decisionDeduped.get(key);
    if (!existing) {
      decisionDeduped.set(key, entry);
    } else {
      const retained = chooseBetterMemory(entry, existing, "supersession");
      const dropped = retained === entry ? existing : entry;
      const reason = workspaceMemoryExactKey(entry) === workspaceMemoryExactKey(existing)
        ? "absorbed_exact" as const
        : "superseded_existing" as const;

      if (reason === "superseded_existing") {
        superseded.push(consolidationEvent(dropped, reason, retained));
      } else {
        absorbed.push(consolidationEvent(dropped, reason, retained));
      }

      if (retained === entry) {
        decisionDeduped.set(key, entry);
      }
    }
  }

  // Merge deduped entries
  const phaseFinal = new Map<string, LongTermMemoryEntry>();
  for (const entry of [...entityDeduped.values(), ...decisionDeduped.values()]) {
    phaseFinal.set(entry.id, entry);
  }

  return {
    kept: [...phaseFinal.values()],
    dropped: [],
    absorbed,
    superseded,
  };
}

function compareLongTermMemoryForRetention(a: LongTermMemoryEntry, b: LongTermMemoryEntry): number {
  const pA = priority(a);
  const pB = priority(b);
  if (pB !== pA) return pB - pA;
  const sourceDiff = sourcePriority(b.source) - sourcePriority(a.source);
  if (sourceDiff !== 0) return sourceDiff;
  const createdDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  if (createdDiff !== 0) return createdDiff;
  return a.id.localeCompare(b.id);
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
