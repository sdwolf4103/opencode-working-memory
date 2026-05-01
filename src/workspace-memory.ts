import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "./types.ts";
import { LONG_TERM_LIMITS } from "./types.ts";
import { migrationLogPath, workspaceKey, workspaceMemoryPath } from "./paths.ts";
import { atomicWriteJSON, readJSON, updateJSON } from "./storage.ts";
import { assessMemoryQuality, isHardQualityReason, isProgressSnapshotViolation } from "./memory-quality.ts";
import { redactCredentials } from "./redaction.ts";
import {
  RETENTION_TYPE_MAX,
  calculateRetentionStrength,
  reinforceMemory,
} from "./retention.ts";
import type { EvidenceEventInput, MemoryEvidenceRef } from "./evidence-log.ts";

// Minimum length for workspace_memory envelope: <workspace_memory>\n...\n</workspace_memory>
const MIN_ENVELOPE_LENGTH = 80;
const MIGRATION_ID = "2026-04-26-p0-cleanup";
const QUALITY_CLEANUP_MIGRATION_ID = "2026-04-28-quality-cleanup";
const RETENTION_CLOCK_BACKFILL_MIGRATION_ID = "2026-05-01-retention-clock-backfill";

export type MemoryConsolidationReason =
  | "promoted"
  | "absorbed_exact"
  | "absorbed_identity"
  | "superseded_existing"
  | "rejected_capacity";

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
  evidence: EvidenceEventInput[];
};

export type WorkspaceMemoryNormalizationResult = LongTermLimitResult & {
  store: WorkspaceMemoryStore;
  events: MemoryConsolidationEvent[];
};

export type WorkspaceMemoryRenderAccounting = {
  rendered: LongTermMemoryEntry[];
  omitted: Array<{
    memory: LongTermMemoryEntry;
    reason: "superseded" | "type_cap" | "global_cap" | "char_budget" | "empty_render_budget";
  }>;
  evidence: EvidenceEventInput[];
  prompt: string;
};

export type QualityCleanupMigrationLogEntry = {
  migrationId: string;
  timestamp: string;
  workspaceKey: string;
  workspaceRoot: string;
  entryId: string;
  type: LongTermMemoryEntry["type"];
  source: LongTermMemoryEntry["source"];
  text: string;
  reasons: string[];
  hardReasons: string[];
  beforeStatus: "active";
  afterStatus: "superseded";
};

export async function emptyWorkspaceMemory(root: string): Promise<WorkspaceMemoryStore> {
  const nowIso = new Date().toISOString();
  return {
    version: 1,
    workspace: { root, key: await workspaceKey(root) },
    limits: {
      maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars,
      maxEntries: LONG_TERM_LIMITS.maxEntries,
    },
    entries: [],
    migrations: [],
    updatedAt: nowIso,
    lastActivityAt: nowIso,
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
    lastActivityAt: loaded.lastActivityAt ?? loaded.updatedAt ?? fallback.lastActivityAt,
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
    if ((beforeEntry.retentionClock ?? null) !== (afterEntry.retentionClock ?? null)) return true;
  }

  const beforeMigrations = JSON.stringify(before.migrations ?? []);
  const afterMigrations = JSON.stringify(after.migrations ?? []);
  if ((before.lastActivityAt ?? "") !== (after.lastActivityAt ?? "")) return true;
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
    evidence: [],
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
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

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
  const beforeQualityCleanup = result;
  const qualityCleanup = runMigrationQualityCleanup(result, nowIso);
  result = qualityCleanup.store;
  let skipRemainingMigrations = false;
  if (qualityCleanup.events.length > 0) {
    try {
      await appendQualityCleanupMigrationLog(qualityCleanup.events);
    } catch (error) {
      console.error("[memory] failed to write quality cleanup migration log:", error);
      console.error("[memory] aborting migration to maintain audit trail integrity");
      result = beforeQualityCleanup;
      skipRemainingMigrations = true;
    }
  }
  if (!skipRemainingMigrations) {
    result = runMigrationP0Cleanup(result, nowIso);
  }

  result.entries = result.entries.map(entry => backfillRetentionClock(entry, nowMs));
  if (!result.migrations.includes(RETENTION_CLOCK_BACKFILL_MIGRATION_ID)) {
    result = {
      ...result,
      migrations: [...result.migrations, RETENTION_CLOCK_BACKFILL_MIGRATION_ID],
      updatedAt: nowIso,
    };
  }

  // P0 accounting only considers active entries. Entries that were already
  // superseded before this normalization are preserved in storage; entries that
  // lose during this enforcement are reported via accounting events but are not
  // archived as superseded records in this wave.
  const activeEntries = result.entries.filter(entry => entry.status !== "superseded");
  const supersededEntries = result.entries.filter(entry => entry.status === "superseded");
  const accounting = enforceLongTermLimitsWithAccounting(activeEntries, result);

  const normalizedStore = {
    ...result,
    entries: [...accounting.kept, ...supersededEntries],
    updatedAt: nowIso,
    lastActivityAt: nowIso,
  };

  return {
    store: normalizedStore,
    kept: accounting.kept,
    dropped: accounting.dropped,
    absorbed: accounting.absorbed,
    superseded: accounting.superseded,
    evidence: accounting.evidence,
    events: [...accounting.dropped, ...accounting.absorbed, ...accounting.superseded],
  };
}

function backfillRetentionClock(entry: LongTermMemoryEntry, nowMs: number): LongTermMemoryEntry {
  if (Number.isFinite(entry.retentionClock)) {
    return entry;
  }

  const createdAtMs = new Date(entry.createdAt).getTime();
  if (Number.isFinite(createdAtMs)) {
    return { ...entry, retentionClock: createdAtMs };
  }

  const updatedAtMs = new Date(entry.updatedAt).getTime();
  if (Number.isFinite(updatedAtMs)) {
    return { ...entry, retentionClock: updatedAtMs };
  }

  return { ...entry, retentionClock: nowMs };
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

async function appendQualityCleanupMigrationLog(events: QualityCleanupMigrationLogEntry[]): Promise<void> {
  if (events.length === 0) return;
  const path = migrationLogPath(QUALITY_CLEANUP_MIGRATION_ID);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, events.map(event => JSON.stringify(event)).join("\n") + "\n", "utf8");
}

export function runMigrationQualityCleanup(
  store: WorkspaceMemoryStore,
  nowIso: string,
): { store: WorkspaceMemoryStore; events: QualityCleanupMigrationLogEntry[] } {
  if (store.migrations?.includes(QUALITY_CLEANUP_MIGRATION_ID)) {
    return { store, events: [] };
  }

  const events: QualityCleanupMigrationLogEntry[] = [];
  let changed = false;
  const entries = store.entries.map(entry => {
    if (entry.source !== "compaction") return entry;
    if (entry.status === "superseded") return entry;

    const quality = assessMemoryQuality(entry);
    if (quality.accepted) return entry;

    const hardReasons = quality.reasons.filter(isHardQualityReason);
    if (hardReasons.length === 0) return entry;

    changed = true;
    events.push({
      migrationId: QUALITY_CLEANUP_MIGRATION_ID,
      timestamp: nowIso,
      workspaceKey: store.workspace.key,
      workspaceRoot: store.workspace.root,
      entryId: entry.id,
      type: entry.type,
      source: entry.source,
      text: entry.text,
      reasons: quality.reasons,
      hardReasons,
      beforeStatus: "active",
      afterStatus: "superseded",
    });

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
    store: {
      ...store,
      entries,
      migrations: [...(store.migrations ?? []), QUALITY_CLEANUP_MIGRATION_ID],
      updatedAt: changed ? nowIso : store.updatedAt,
    },
    events,
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

function capacityRemovalEvidence(
  memory: LongTermMemoryEntry,
  reason: "type_cap" | "global_cap" | "capacity",
): EvidenceEventInput {
  return {
    type: "memory_removed_capacity",
    phase: "storage",
    outcome: "removed",
    reasonCodes: [reason],
    memory: memoryEvidenceRef(memory),
    relations: [{
      role: "removed",
      memory: memoryEvidenceRef(memory),
    }],
    details: {
      type: memory.type,
      globalCap: LONG_TERM_LIMITS.maxEntries,
      ...(reason === "type_cap" ? { typeCap: RETENTION_TYPE_MAX[memory.type] } : {}),
      ...(typeof memory.retentionClock === "number" && Number.isFinite(memory.retentionClock) ? { retentionClock: memory.retentionClock } : {}),
      ...(memory.createdAt ? { createdAt: memory.createdAt } : {}),
      ...(memory.source ? { source: memory.source } : {}),
    },
  };
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

export function enforceLongTermLimitsWithAccounting(
  entries: LongTermMemoryEntry[],
  store?: WorkspaceMemoryStore,
): LongTermLimitResult {
  const now = Date.now();
  const lastActivityAt = store?.lastActivityAt;

  // Phase 1: filter active entries and trim text. Retention removal is by
  // strength/cap competition, not hard stale pruning.
  const phase1: LongTermMemoryEntry[] = [];
  for (const entry of entries) {
    if (entry.status === "superseded") continue;
    phase1.push({ ...entry, text: entry.text.slice(0, LONG_TERM_LIMITS.maxEntryTextChars) });
  }

  const dedupeResult = dedupeLongTermEntriesWithAccounting(phase1);
  const sorted = [...dedupeResult.kept].sort((a, b) => compareLongTermMemoryForRetention(a, b, now, lastActivityAt));
  const capped = applyTypeMaxCaps(sorted);
  const kept = capped.slice(0, LONG_TERM_LIMITS.maxEntries);
  const keptIds = new Set(kept.map(entry => entry.id));
  const cappedIds = new Set(capped.map(entry => entry.id));
  const typeCapLosers = sorted.filter(entry => !cappedIds.has(entry.id));
  const globalCapLosers = capped.filter(entry => !keptIds.has(entry.id));
  const capacityEvidence: EvidenceEventInput[] = [
    ...typeCapLosers.map(entry => capacityRemovalEvidence(entry, "type_cap")),
    ...globalCapLosers.map(entry => capacityRemovalEvidence(entry, "global_cap")),
  ];
  const capacityDropped = sorted
    .filter(entry => !keptIds.has(entry.id))
    .map(entry => consolidationEvent(entry, "rejected_capacity"));

  return {
    kept,
    dropped: [...dedupeResult.dropped, ...capacityDropped],
    absorbed: dedupeResult.absorbed,
    superseded: dedupeResult.superseded,
    evidence: [...dedupeResult.evidence, ...capacityEvidence],
  };
}

function applyTypeMaxCaps(entries: LongTermMemoryEntry[]): LongTermMemoryEntry[] {
  return applyTypeMaxCapsWithOmissions(entries).kept;
}

function applyTypeMaxCapsWithOmissions(entries: LongTermMemoryEntry[]): { kept: LongTermMemoryEntry[]; omitted: LongTermMemoryEntry[] } {
  const capped: LongTermMemoryEntry[] = [];
  const omitted: LongTermMemoryEntry[] = [];
  const typeCounts: Partial<Record<LongTermMemoryEntry["type"], number>> = {};

  for (const entry of entries) {
    const count = typeCounts[entry.type] ?? 0;
    const max = RETENTION_TYPE_MAX[entry.type] ?? Infinity;
    if (count >= max) {
      omitted.push(entry);
      continue;
    }

    capped.push(entry);
    typeCounts[entry.type] = count + 1;
  }

  return { kept: capped, omitted };
}

export function dedupeLongTermEntriesWithAccounting(entries: LongTermMemoryEntry[]): LongTermLimitResult {
  const now = Date.now();
  const absorbed: MemoryConsolidationEvent[] = [];
  const superseded: MemoryConsolidationEvent[] = [];
  const evidence: EvidenceEventInput[] = [];

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
      const reinforced = reinforceMemory(
        retained,
        reinforcementSessionId(retained, dropped),
        now,
      );
      const reinforcedEvent = reinforcementEvidence(retained, dropped, reinforced, reason);
      if (reinforcedEvent) evidence.push(reinforcedEvent);

      absorbed.push(consolidationEvent(dropped, reason, reinforced));
      entityDeduped.set(key, reinforced);
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
      const reinforced = reinforceMemory(
        retained,
        reinforcementSessionId(retained, dropped),
        now,
      );
      const reinforcedEvent = reinforcementEvidence(retained, dropped, reinforced, reason);
      if (reinforcedEvent) evidence.push(reinforcedEvent);

      if (reason === "superseded_existing") {
        superseded.push(consolidationEvent(dropped, reason, reinforced));
      } else {
        absorbed.push(consolidationEvent(dropped, reason, reinforced));
      }

      decisionDeduped.set(key, reinforced);
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
    evidence,
  };
}

function memoryEvidenceRef(memory: LongTermMemoryEntry): MemoryEvidenceRef {
  return {
    memoryId: memory.id,
    memoryKeyHash: workspaceMemoryExactKey(memory),
    identityKeyHash: workspaceMemoryIdentityKey(memory),
    type: memory.type,
    source: memory.source,
    status: memory.status,
  };
}

function reinforcementEvidence(
  retained: LongTermMemoryEntry,
  dropped: LongTermMemoryEntry,
  reinforced: LongTermMemoryEntry,
  reason: "absorbed_exact" | "absorbed_identity" | "superseded_existing",
): EvidenceEventInput | undefined {
  if ((reinforced.reinforcementCount ?? 0) <= (retained.reinforcementCount ?? 0)) return undefined;
  const duplicateReason = reason === "absorbed_identity" ? "duplicate_identity" : "duplicate_exact";
  return {
    type: "memory_reinforced",
    phase: "reinforcement",
    outcome: "reinforced",
    memory: memoryEvidenceRef(reinforced),
    relations: [
      { role: "reinforced", memory: memoryEvidenceRef(reinforced) },
      { role: "reinforced_by", memory: memoryEvidenceRef(dropped) },
    ],
    reasonCodes: [duplicateReason, "reinforcement_window_allowed"],
    textPreview: reinforced.text,
  };
}

function reinforcementSessionId(retained: LongTermMemoryEntry, dropped: LongTermMemoryEntry): string {
  return dropped.pendingOwnerSessionID ?? retained.pendingOwnerSessionID ?? "workspace-dedupe";
}

function compareLongTermMemoryForRetention(
  a: LongTermMemoryEntry,
  b: LongTermMemoryEntry,
  now: number,
  lastActivityAt?: string,
): number {
  const strengthA = calculateRetentionStrength(a, now, lastActivityAt);
  const strengthB = calculateRetentionStrength(b, now, lastActivityAt);
  if (strengthB !== strengthA) return strengthB - strengthA;

  const sourceDiff = sourcePriority(b.source) - sourcePriority(a.source);
  if (sourceDiff !== 0) return sourceDiff;
  const createdDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  if (createdDiff !== 0) return createdDiff;
  return a.id.localeCompare(b.id);
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
  return accountWorkspaceMemoryRender(store).prompt;
}

export function accountWorkspaceMemoryRender(store: WorkspaceMemoryStore): WorkspaceMemoryRenderAccounting {
  const now = Date.now();
  const maxChars = Math.min(
    store.limits.maxRenderedChars,
    LONG_TERM_LIMITS.maxRenderedChars
  );
  const omitted: WorkspaceMemoryRenderAccounting["omitted"] = [];
  const evidence: EvidenceEventInput[] = [];

  for (const entry of store.entries) {
    if (entry.status === "superseded") {
      omitted.push({ memory: entry, reason: "superseded" });
    }
  }

  const activeEntries = store.entries.filter(entry => entry.status !== "superseded");
  const phase1 = activeEntries.map(entry => ({ ...entry, text: entry.text.slice(0, LONG_TERM_LIMITS.maxEntryTextChars) }));
  const dedupeResult = dedupeLongTermEntriesWithAccounting(phase1);
  const sorted = [...dedupeResult.kept].sort((a, b) => compareLongTermMemoryForRetention(a, b, now, store.lastActivityAt));
  const typeCapResult = applyTypeMaxCapsWithOmissions(sorted);
  for (const memory of typeCapResult.omitted) omitted.push({ memory, reason: "type_cap" });
  const active = typeCapResult.kept.slice(0, LONG_TERM_LIMITS.maxEntries);
  for (const memory of typeCapResult.kept.slice(LONG_TERM_LIMITS.maxEntries)) omitted.push({ memory, reason: "global_cap" });

  if (active.length === 0) {
    for (const item of omitted) evidence.push(renderEvidence(item.memory, "omitted", item.reason));
    return { rendered: [], omitted, evidence, prompt: "" };
  }

  // If maxChars smaller than minimum envelope, return empty string
  if (maxChars < MIN_ENVELOPE_LENGTH) {
    for (const memory of active) omitted.push({ memory, reason: "empty_render_budget" });
    for (const item of omitted) evidence.push(renderEvidence(item.memory, "omitted", item.reason));
    return { rendered: [], omitted, evidence, prompt: "" };
  }

  const lines: string[] = [
    "Workspace memory (cross-session, verify if stale):",
  ];
  const rendered: LongTermMemoryEntry[] = [];

  for (const type of ["feedback", "project", "decision", "reference"] as const) {
    const items = active.filter(entry => entry.type === type);
    if (items.length === 0) continue;

    const sectionLines: string[] = [`${type}:`];

    for (const item of items) {
      const line = `- ${renderEntry(item)}`;
      if ([...lines, ...sectionLines, line].join("\n").length <= maxChars) {
        sectionLines.push(line);
        rendered.push(item);
      } else {
        omitted.push({ memory: item, reason: "char_budget" });
      }
    }

    if (sectionLines.length > 1) {
      lines.push(...sectionLines);
    }
  }

  for (const memory of rendered) evidence.push(renderEvidence(memory, "rendered"));
  for (const item of omitted) evidence.push(renderEvidence(item.memory, "omitted", item.reason));

  return { rendered, omitted, evidence, prompt: lines.join("\n") };
}

function renderEvidence(
  memory: LongTermMemoryEntry,
  outcome: "rendered" | "omitted",
  reason?: WorkspaceMemoryRenderAccounting["omitted"][number]["reason"],
): EvidenceEventInput {
  return {
    type: outcome === "rendered" ? "render_selected" : "render_omitted",
    phase: "render",
    outcome,
    memory: memoryEvidenceRef(memory),
    relations: [{ role: outcome === "rendered" ? "rendered" : "omitted", memory: memoryEvidenceRef(memory) }],
    reasonCodes: outcome === "rendered" ? ["within_caps", "within_char_budget"] : [reason ?? "char_budget"],
    textPreview: memory.text,
  };
}

function renderEntry(entry: LongTermMemoryEntry): string {
  const ageDays = Math.floor((Date.now() - new Date(entry.createdAt).getTime()) / 86_400_000);
  const stale = entry.staleAfterDays && ageDays > entry.staleAfterDays ? ` [${ageDays}d old, verify]` : "";
  const rationale = entry.rationale
    ? ` Why: ${entry.rationale.slice(0, LONG_TERM_LIMITS.maxRationaleChars)}`
    : "";
  return `${entry.text}${rationale}${stale}`;
}
