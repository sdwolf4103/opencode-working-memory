#!/usr/bin/env bun
/**
 * Maintainer-only offline diagnostics for memory quality calibration.
 * Does not send telemetry, make API calls, or affect plugin runtime behavior.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { dataHome, extractionRejectionLogPath, migrationLogPath, workspaceKey, workspaceMemoryPath, workspacePendingJournalPath } from "../src/paths.ts";
import { assessMemoryQuality, HARD_QUALITY_REASONS, isArchitectureLikeDecision } from "../src/memory-quality.ts";
import { redactCredentials } from "../src/redaction.ts";
import { scanWorkspaceResidues } from "../src/workspace-cleanup.ts";
import { accountWorkspaceMemoryRender, renderWorkspaceMemory } from "../src/workspace-memory.ts";
import {
  DORMANT_DECAY_MULTIPLIER,
  RETENTION_TYPE_MAX,
  WORKSPACE_DORMANT_AFTER_DAYS,
  calculateRetentionStrength,
} from "../src/retention.ts";
import type { LongTermMemoryEntry, LongTermSource, LongTermType, PendingMemoryJournalStore, WorkspaceMemoryStore } from "../src/types.ts";
import { LONG_TERM_LIMITS, PROMOTION_RETRY_LIMITS } from "../src/types.ts";
import {
  queryEvidenceEvents,
  summarizeMemoryEvidence,
  traceMemoryLifecycle,
  type EvidenceEventType,
  type EvidenceEventV1,
  type EvidenceOutcome,
} from "../src/evidence-log.ts";

export type MemoryRenderStatus =
  | "rendered"
  | "omitted_superseded"
  | "omitted_type_cap"
  | "omitted_global_cap"
  | "omitted_char_budget"
  | "omitted_absorbed_duplicate"
  | "pending_retry"
  | "pending_rejected_capacity"
  | "quarantined_corrupt_store";

export type MemoryDiagJSON = {
  version: 1;
  workspace: { rootHash: string; key: string };
  generatedAt: string;
  summary: {
    storedActive: number;
    rendered: number;
    pending: number;
    rejectedLast7Days: number;
    corruptStoresQuarantinedLast30Days: number;
  };
  memories: Array<{
    id: string;
    type: "feedback" | "project" | "decision" | "reference";
    source: "explicit" | "compaction" | "manual";
    status: MemoryRenderStatus;
    strength?: number;
    reasonCodes: string[];
    textPreview?: string;
    evidenceEventIds: string[];
  }>;
  recentEvents: Array<{
    eventId: string;
    type: EvidenceEventType;
    outcome: EvidenceOutcome;
    createdAt: string;
    memoryId?: string;
    reasonCodes: string[];
  }>;
};

type Command = "health" | "quality" | "coverage" | "disappearances" | "rejections" | "audit" | "explain" | "trace";
type Origin = "explicit_trigger" | "compaction_candidate" | "manual" | "migration_check" | "unknown";

type CliOptions = {
  raw: boolean;
  json?: boolean;
  workspace?: string;
  all?: boolean;
  softOnly?: boolean;
  triggerOnly?: boolean;
  includeHistorical?: boolean;
  quality?: boolean;
  reason?: string;
  unique?: boolean;
  explain?: boolean;
  since?: string;
  migration?: string;
  memory?: string;
};

type RejectionLogRecord = {
  timestamp?: string;
  workspaceKey?: string;
  workspaceRoot?: string;
  workspaceRootHash?: string;
  type?: LongTermType;
  source?: LongTermSource | string;
  origin?: string;
  fromTrigger?: boolean;
  text?: string;
  reasons?: string[];
};

type NormalizedRejection = Required<Pick<RejectionLogRecord, "timestamp" | "type" | "text" | "reasons">> & {
  workspaceKey?: string;
  workspaceRoot?: string;
  workspaceRootHash?: string;
  source?: string;
  origin: Origin;
  fromTrigger: boolean;
};

type MigrationLogRecord = {
  migrationId?: string;
  timestamp?: string;
  workspaceKey?: string;
  workspaceRoot?: string;
  entryId?: string;
  type?: LongTermType;
  source?: LongTermSource | string;
  text?: string;
  reasons?: string[];
  hardReasons?: string[];
  beforeStatus?: string;
  afterStatus?: string;
};

const TYPES: LongTermType[] = ["feedback", "decision", "project", "reference"];
const SUSPICIOUS_REASONS = [
  "progress_snapshot",
  "active_file_snapshot",
  "commit_or_ci_snapshot",
  "temporary_status",
  "raw_error",
  "code_or_api_signature",
] as const;
const ALLOWED_ORIGINS = new Set<Origin>([
  "explicit_trigger",
  "compaction_candidate",
  "manual",
  "migration_check",
  "unknown",
]);

function usage(): string {
  return `Usage:
  bun scripts/memory-diag.ts health [--workspace <path>] [--all] [--raw] [--json]
  bun scripts/memory-diag.ts quality [--workspace <path>] [--raw] [--json]
  bun scripts/memory-diag.ts coverage [--workspace <path>] [--include-historical] [--raw] [--json]
  bun scripts/memory-diag.ts disappearances [--workspace <path>] [--explain] [--raw] [--json]
  bun scripts/memory-diag.ts rejections --quality [--workspace <path>] [--reason <reason>] [--unique] [--json] [--raw]
  bun scripts/memory-diag.ts explain [--workspace <path>] [--raw]
  bun scripts/memory-diag.ts trace --memory <id> [--workspace <path>] [--raw]
  bun scripts/memory-diag.ts rejections [--soft-only] [--trigger-only] [--since 14d] [--reason <reason>] [--unique] [--workspace <path>] [--raw]
  bun scripts/memory-diag.ts audit [--migration <id>] [--raw]
`;
}

function die(message: string): never {
  console.error(message);
  console.error(usage());
  process.exit(1);
}

function parseArgs(argv: string[]): { command: Command; options: CliOptions } {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    process.exit(0);
  }
  if (command !== "health" && command !== "quality" && command !== "coverage" && command !== "disappearances" && command !== "rejections" && command !== "audit" && command !== "explain" && command !== "trace") {
    die(`Unknown subcommand: ${command}`);
  }

  const options: CliOptions = { raw: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--raw") options.raw = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--soft-only") options.softOnly = true;
    else if (arg === "--trigger-only") options.triggerOnly = true;
    else if (arg === "--include-historical") options.includeHistorical = true;
    else if (arg === "--quality") options.quality = true;
    else if (arg === "--unique") options.unique = true;
    else if (arg === "--explain") options.explain = true;
    else if (arg === "--workspace") {
      const value = rest[++i];
      if (!value) die("--workspace requires a path");
      options.workspace = value;
    } else if (arg === "--since") {
      const value = rest[++i];
      if (!value) die("--since requires a duration or ISO timestamp");
      options.since = value;
    } else if (arg === "--reason") {
      const value = rest[++i];
      if (!value) die("--reason requires a reason code");
      options.reason = value;
    } else if (arg === "--migration") {
      const value = rest[++i];
      if (!value) die("--migration requires an id");
      options.migration = value;
    } else if (arg === "--memory") {
      const value = rest[++i];
      if (!value) die("--memory requires an id");
      options.memory = value;
    } else {
      die(`Unknown option: ${arg}`);
    }
  }

  if (command === "health") {
    if (options.all && options.workspace) die("Use either --all or --workspace, not both");
    if (options.json && options.all) die("health --json does not support --all");
  } else if (command === "explain" || command === "trace") {
    if (options.all) die(`${command} does not accept --all`);
  } else if (command === "quality" || command === "coverage" || command === "disappearances" || command === "rejections") {
    if (options.all) die(`${command} does not accept --all`);
  } else {
    if (options.all || options.workspace) die(`${command} does not accept --all or --workspace`);
  }
  if (options.json && command !== "health" && command !== "quality" && command !== "coverage" && command !== "disappearances" && !(command === "rejections" && options.quality)) {
    die(`${command} does not accept --json`);
  }
  if (command !== "rejections" && (options.softOnly || options.triggerOnly || options.since)) {
    die(`${command} does not accept rejection filters`);
  }
  if (command !== "coverage" && options.includeHistorical) die(`${command} does not accept --include-historical`);
  if (command !== "rejections" && (options.quality || options.reason || options.unique)) die(`${command} does not accept rejection quality filters`);
  if (command !== "disappearances" && options.explain) die(`${command} does not accept --explain`);
  if (command === "rejections" && options.json && !options.quality) die("rejections --json requires --quality");
  if (command !== "audit" && options.migration) {
    die(`${command} does not accept --migration`);
  }
  if (command !== "trace" && options.memory) {
    die(`${command} does not accept --memory`);
  }
  if (command === "trace" && !options.memory) {
    die("--memory requires an id");
  }

  return { command, options };
}

function countBy<T extends string>(items: T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

function sortedCounts<T extends string>(counts: Map<T, number>): Array<[T, number]> {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function workspaceRootHash(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

function redactAbsolutePaths(text: string): string {
  return text.replace(/(?:^|[\s"'`(=:\[])(\/(?:Users|home|private|tmp|var|opt|Volumes|[^\s"'`)\],;:]+)\/[^\s"'`)\],;:]*)/g, (match, path) => match.replace(path, "<path>"));
}

function cleanText(text: string, raw: boolean): string {
  if (raw) return text;
  return redactAbsolutePaths(redactCredentials(text));
}

function cleanPath(path: string, raw: boolean): string {
  return raw ? path : "<path>";
}

function formatWorkspaceIdentity(workspaceKeyValue: string | undefined, workspaceRoot: string | undefined, raw: boolean): string {
  const parts: string[] = [];
  if (workspaceKeyValue) parts.push(`workspaceKey=${workspaceKeyValue}`);
  if (workspaceRoot) {
    parts.push(raw ? `workspaceRoot=${workspaceRoot}` : `workspaceRootHash=${workspaceRootHash(workspaceRoot)}`);
  }
  return parts.join(" ");
}

function truncate(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

async function readJSONFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readJSONLFile<T>(path: string): Promise<{ records: T[]; invalidLines: number }> {
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch {
    return { records: [], invalidLines: 0 };
  }

  const records: T[] = [];
  let invalidLines = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch {
      invalidLines += 1;
    }
  }
  return { records, invalidLines };
}

function canonicalMemoryText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, " ")
    .trim();
}

function ageDays(entry: LongTermMemoryEntry): number | null {
  const time = new Date(entry.createdAt).getTime();
  if (Number.isNaN(time)) return null;
  return Math.floor((Date.now() - time) / 86_400_000);
}

function formatStrength(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : "0.000";
}

function daysSinceIso(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (now - ms) / 86_400_000);
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

type RetentionDiagItem = {
  entry: LongTermMemoryEntry;
  strength: number;
};

function isSafetyCriticalForDiag(entry: LongTermMemoryEntry): boolean {
  return entry.safetyCritical === true;
}

function retentionCandidatesForDiag(store: WorkspaceMemoryStore): {
  sorted: RetentionDiagItem[];
  rendered: RetentionDiagItem[];
  typeCapped: RetentionDiagItem[];
  globalCapped: RetentionDiagItem[];
} {
  const now = Date.now();
  const active = store.entries.filter(entry => entry.status !== "superseded");
  const sorted = active
    .map(entry => ({ entry, strength: calculateRetentionStrength(entry, now, store.lastActivityAt) }))
    .sort((a, b) => b.strength - a.strength || a.entry.id.localeCompare(b.entry.id));

  const rendered: RetentionDiagItem[] = [];
  const typeCapped: RetentionDiagItem[] = [];
  const globalCapped: RetentionDiagItem[] = [];
  const typeCounts: Partial<Record<LongTermType, number>> = {};

  for (const item of sorted) {
    const count = typeCounts[item.entry.type] ?? 0;
    const max = RETENTION_TYPE_MAX[item.entry.type] ?? Infinity;
    if (count >= max) {
      typeCapped.push(item);
      continue;
    }
    typeCounts[item.entry.type] = count + 1;

    if (rendered.length < LONG_TERM_LIMITS.maxEntries) {
      rendered.push(item);
    } else {
      globalCapped.push(item);
    }
  }

  return { sorted, rendered, typeCapped, globalCapped };
}

function promotionLimit(source: LongTermSource): number {
  if (source === "manual") return PROMOTION_RETRY_LIMITS.maxManualAttempts;
  return PROMOTION_RETRY_LIMITS.maxExplicitAttempts;
}

function emptyStore(root: string, key: string): WorkspaceMemoryStore {
  return {
    version: 1,
    workspace: { root, key },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    entries: [],
    migrations: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function normalizedStore(store: WorkspaceMemoryStore | null, root: string, key: string): WorkspaceMemoryStore {
  const fallback = emptyStore(root, key);
  return {
    ...fallback,
    ...(store ?? {}),
    workspace: store?.workspace ?? fallback.workspace,
    limits: {
      maxRenderedChars: store?.limits?.maxRenderedChars ?? fallback.limits.maxRenderedChars,
      maxEntries: store?.limits?.maxEntries ?? fallback.limits.maxEntries,
    },
    entries: Array.isArray(store?.entries) ? store.entries : [],
    migrations: Array.isArray(store?.migrations) ? store.migrations : [],
  };
}

function normalizedJournal(journal: PendingMemoryJournalStore | null): PendingMemoryJournalStore {
  return {
    version: 1,
    workspace: journal?.workspace ?? { root: "", key: "" },
    entries: Array.isArray(journal?.entries) ? journal.entries : [],
    updatedAt: journal?.updatedAt ?? new Date(0).toISOString(),
  };
}

type WorkspaceDiagSnapshot = {
  store: WorkspaceMemoryStore;
  journal: PendingMemoryJournalStore;
  retention: ReturnType<typeof retentionCandidatesForDiag>;
  memories: MemoryDiagJSON["memories"];
  recentEvents: MemoryDiagJSON["recentEvents"];
  allEvents: EvidenceEventV1[];
  summary: MemoryDiagJSON["summary"];
};

type MemoryInspectionReadModel = {
  store: WorkspaceMemoryStore;
  pending: PendingMemoryJournalStore;
  evidenceEvents: EvidenceEventV1[];
  rejectionRecords: NormalizedRejection[];
  currentById: Map<string, LongTermMemoryEntry>;
  evidenceByMemoryId: Map<string, EvidenceEventV1[]>;
};

type CoverageClass = "full_lifecycle" | "render_only" | "no_evidence" | "historical_absent_with_reason" | "historical_absent_unknown_reason";

type DisappearanceReason = {
  classification: "historical_absent_with_reason" | "historical_absent_unknown_reason";
  terminalType: EvidenceEventType | "unknown";
  reasonCodes: string[];
  event?: EvidenceEventV1;
};

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function eventMemoryId(event: EvidenceEventV1): string | undefined {
  return event.memory?.memoryId
    ?? event.relations?.map(relation => relation.memory?.memoryId).find((id): id is string => Boolean(id));
}

function eventMemoryIds(event: EvidenceEventV1): string[] {
  return uniqueStrings([
    event.memory?.memoryId ?? "",
    ...(event.relations ?? []).map(relation => relation.memory?.memoryId ?? ""),
  ]);
}

function isWithinDays(iso: string, days: number): boolean {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) && ms >= Date.now() - days * 86_400_000;
}

function renderStatusReason(status: MemoryRenderStatus, fallback?: string): string[] {
  switch (status) {
    case "rendered": return ["within_caps", "within_char_budget"];
    case "omitted_superseded": return ["superseded"];
    case "omitted_type_cap": return ["type_cap"];
    case "omitted_global_cap": return ["global_cap"];
    case "omitted_char_budget": return [fallback === "empty_render_budget" ? "empty_render_budget" : "char_budget"];
    case "omitted_absorbed_duplicate": return ["absorbed_duplicate"];
    case "pending_retry": return ["retryable_capacity_rejection"];
    case "pending_rejected_capacity": return ["capacity_rejected", "max_attempts_reached"];
    case "quarantined_corrupt_store": return ["invalid_json"];
  }
}

function statusFromOmissionReason(reason: string | undefined): MemoryRenderStatus {
  if (reason === "superseded") return "omitted_superseded";
  if (reason === "type_cap") return "omitted_type_cap";
  if (reason === "global_cap") return "omitted_global_cap";
  return "omitted_char_budget";
}

function pendingStatus(entry: LongTermMemoryEntry): MemoryRenderStatus {
  const attempts = entry.promotionAttempts ?? 0;
  return attempts >= promotionLimit(entry.source) ? "pending_rejected_capacity" : "pending_retry";
}

function safeTextPreview(text: string): string {
  return truncate(cleanText(text, false), 120);
}

async function buildWorkspaceDiagSnapshot(input: {
  root: string;
  key: string;
  memoryPath: string;
  pendingPath: string;
}): Promise<WorkspaceDiagSnapshot> {
  const rawStore = await readJSONFile<WorkspaceMemoryStore>(input.memoryPath);
  const storeRoot = rawStore?.workspace?.root ?? input.root;
  const storeKey = rawStore?.workspace?.key ?? input.key;
  const store = normalizedStore(rawStore, storeRoot, storeKey);
  const journal = normalizedJournal(await readJSONFile<PendingMemoryJournalStore>(input.pendingPath));
  const retention = retentionCandidatesForDiag(store);
  const renderAccounting = accountWorkspaceMemoryRender(store);
  const renderedIds = new Set(renderAccounting.rendered.map(memory => memory.id));
  const omittedById = new Map(renderAccounting.omitted.map(item => [item.memory.id, item.reason]));
  const allEvents = await queryEvidenceEvents(input.root);
  const recentEvidence = await queryEvidenceEvents(input.root, { newestFirst: true, limit: 50 });
  const memoryRows: MemoryDiagJSON["memories"] = [];
  const seenIds = new Set<string>();

  for (const entry of store.entries) {
    const omissionReason = omittedById.get(entry.id);
    const status: MemoryRenderStatus = renderedIds.has(entry.id)
      ? "rendered"
      : statusFromOmissionReason(omissionReason ?? (entry.status === "superseded" ? "superseded" : undefined));
    const summary = await summarizeMemoryEvidence(input.root, { memoryId: entry.id });
    memoryRows.push({
      id: entry.id,
      type: entry.type,
      source: entry.source,
      status,
      strength: calculateRetentionStrength(entry, Date.now(), store.lastActivityAt),
      reasonCodes: uniqueStrings([...renderStatusReason(status, omissionReason), ...summary.reasonCodes]),
      textPreview: safeTextPreview(entry.text),
      evidenceEventIds: summary.eventIds,
    });
    seenIds.add(entry.id);
  }

  for (const entry of journal.entries) {
    const status = pendingStatus(entry);
    const summary = await summarizeMemoryEvidence(input.root, { memoryId: entry.id });
    memoryRows.push({
      id: entry.id,
      type: entry.type,
      source: entry.source,
      status,
      strength: calculateRetentionStrength(entry, Date.now(), store.lastActivityAt),
      reasonCodes: uniqueStrings([...renderStatusReason(status), entry.lastPromotionFailureReason ?? "", ...summary.reasonCodes]),
      textPreview: safeTextPreview(entry.text),
      evidenceEventIds: summary.eventIds,
    });
    seenIds.add(entry.id);
  }

  for (const event of allEvents) {
    if (event.outcome !== "absorbed") continue;
    const memory = event.memory;
    if (!memory?.memoryId || !memory.type || !memory.source || seenIds.has(memory.memoryId)) continue;
    const summary = await summarizeMemoryEvidence(input.root, { memoryId: memory.memoryId });
    memoryRows.push({
      id: memory.memoryId,
      type: memory.type,
      source: memory.source,
      status: "omitted_absorbed_duplicate",
      reasonCodes: uniqueStrings([...renderStatusReason("omitted_absorbed_duplicate"), ...summary.reasonCodes]),
      evidenceEventIds: summary.eventIds.length > 0 ? summary.eventIds : [event.eventId],
    });
    seenIds.add(memory.memoryId);
  }

  const recentEvents = recentEvidence.map(event => ({
    eventId: event.eventId,
    type: event.type,
    outcome: event.outcome,
    createdAt: event.createdAt,
    memoryId: eventMemoryId(event),
    reasonCodes: uniqueStrings([
      ...event.reasonCodes,
      ...(event.type === "storage_corrupt_json_quarantined" ? ["quarantined_corrupt_store"] : []),
    ]),
  }));

  return {
    store,
    journal,
    retention,
    memories: memoryRows,
    recentEvents,
    allEvents,
    summary: {
      storedActive: store.entries.filter(entry => entry.status !== "superseded").length,
      rendered: retention.rendered.length,
      pending: journal.entries.length,
      rejectedLast7Days: allEvents.filter(event => event.outcome === "rejected" && isWithinDays(event.createdAt, 7)).length,
      corruptStoresQuarantinedLast30Days: allEvents.filter(event => event.type === "storage_corrupt_json_quarantined" && isWithinDays(event.createdAt, 30)).length,
    },
  };
}

async function buildMemoryDiagJSON(root: string): Promise<MemoryDiagJSON> {
  const key = await workspaceKey(root);
  const snapshot = await buildWorkspaceDiagSnapshot({
    root,
    key,
    memoryPath: await workspaceMemoryPath(root),
    pendingPath: await workspacePendingJournalPath(root),
  });

  return {
    version: 1,
    workspace: { rootHash: workspaceRootHash(snapshot.store.workspace.root || root), key: snapshot.store.workspace.key || key },
    generatedAt: new Date().toISOString(),
    summary: snapshot.summary,
    memories: snapshot.memories,
    recentEvents: snapshot.recentEvents,
  };
}

async function runHealth(options: CliOptions): Promise<void> {
  if (options.json) {
    const root = options.workspace ?? process.cwd();
    console.log(JSON.stringify(await buildMemoryDiagJSON(root), null, 2));
    return;
  }

  if (options.all) {
    const scan = await scanWorkspaceResidues({ includeOrphans: true, minAgeMs: 0 });
    console.log("Workspace memory health");
    console.log("");
    if (scan.results.length === 0) {
      console.log("No workspace stores found.");
      return;
    }
    for (let i = 0; i < scan.results.length; i += 1) {
      const result = scan.results[i];
      if (i > 0) console.log("");
      await printWorkspaceHealth({
        root: result.root,
        key: result.workspaceKey,
        memoryPath: join(result.workspaceDir, "workspace-memory.json"),
        pendingPath: join(result.workspaceDir, "workspace-pending-journal.json"),
        raw: options.raw,
      });
    }
    return;
  }

  const root = options.workspace ?? process.cwd();
  const key = await workspaceKey(root);
  await printWorkspaceHealth({
    root,
    key,
    memoryPath: await workspaceMemoryPath(root),
    pendingPath: await workspacePendingJournalPath(root),
    raw: options.raw,
    includeTitle: true,
  });
}

async function printWorkspaceHealth(input: {
  root?: string;
  key: string;
  memoryPath: string;
  pendingPath: string;
  raw: boolean;
  includeTitle?: boolean;
}): Promise<void> {
  if (input.includeTitle) {
    console.log("Workspace memory health");
    console.log("");
  }

  const rawStore = await readJSONFile<WorkspaceMemoryStore>(input.memoryPath);
  const storeRoot = rawStore?.workspace?.root ?? input.root ?? "";
  const storeKey = rawStore?.workspace?.key ?? input.key;
  const store = normalizedStore(rawStore, storeRoot, storeKey);
  const journal = normalizedJournal(await readJSONFile<PendingMemoryJournalStore>(input.pendingPath));

  const identity = formatWorkspaceIdentity(storeKey, storeRoot || undefined, input.raw);
  if (identity) console.log(identity);
  console.log(`memoryPath=${cleanPath(input.memoryPath, input.raw)}`);
  console.log(`pendingPath=${cleanPath(input.pendingPath, input.raw)}`);
  if (!rawStore) console.log("memory store: missing or unreadable (treated as empty)");
  if (!existsSync(input.pendingPath)) console.log("pending journal: missing (treated as empty)");
  console.log("");

  const active = store.entries.filter(entry => entry.status !== "superseded");
  const superseded = store.entries.filter(entry => entry.status === "superseded");
  const retention = retentionCandidatesForDiag(store);
  const renderedEntries = retention.rendered.map(item => item.entry);
  const renderedEstimate = renderWorkspaceMemory(store).length;

  console.log(`Stored active memories: ${active.length}`);
  console.log(`Superseded memories: ${superseded.length}`);
  console.log(`Rendered candidates: ${renderedEntries.length}`);
  console.log(`Rendered estimate: ${renderedEstimate.toLocaleString()} chars`);
  console.log("");

  const pendingEntries = journal.entries;
  const retryable = pendingEntries.filter(entry => (entry.promotionAttempts ?? 0) < promotionLimit(entry.source)).length;
  const nearRetryLimit = pendingEntries.filter(entry => (entry.promotionAttempts ?? 0) >= promotionLimit(entry.source) - 1).length;
  const pendingBySource = countBy(pendingEntries.map(entry => entry.source));
  console.log("Pending journal:");
  console.log(`  total: ${pendingEntries.length}`);
  console.log(`  retryable: ${retryable}`);
  console.log(`  near retry limit: ${nearRetryLimit}`);
  console.log("  by source:");
  for (const source of ["explicit", "manual", "compaction"] as LongTermSource[]) {
    console.log(`    ${source}: ${pendingBySource.get(source) ?? 0}`);
  }
  console.log("");

  console.log("By type:");
  for (const type of TYPES) {
    const storedCount = active.filter(entry => entry.type === type).length;
    const renderedCount = renderedEntries.filter(entry => entry.type === type).length;
    const supersededCount = superseded.filter(entry => entry.type === type).length;
    console.log(`  ${type.padEnd(9)} stored=${String(storedCount).padEnd(3)} rendered=${String(renderedCount).padEnd(3)} typeCap=${RETENTION_TYPE_MAX[type]} superseded=${supersededCount}`);
  }
  console.log("");

  console.log("Retention caps:");
  console.log(`  type-capped entries: ${retention.typeCapped.length}`);
  console.log(`  global-cap overflow: ${retention.globalCapped.length}`);
  console.log("");

  const olderThan30 = active.filter(entry => (ageDays(entry) ?? 0) > 30).length;
  const olderThan90 = active.filter(entry => (ageDays(entry) ?? 0) > 90).length;
  const staleMarked = active.filter(entry => {
    const days = ageDays(entry);
    return Boolean(entry.staleAfterDays && days !== null && days > entry.staleAfterDays);
  }).length;
  console.log("Age:");
  console.log(`  stale-marked: ${staleMarked}`);
  console.log(`  older than 30d: ${olderThan30}`);
  console.log(`  older than 90d: ${olderThan90}`);
  console.log("");

  const wallDaysSinceActivity = daysSinceIso(store.lastActivityAt);
  const dormantDiscountActive = wallDaysSinceActivity !== null && wallDaysSinceActivity > WORKSPACE_DORMANT_AFTER_DAYS;
  const dormantDaysPastGrace = wallDaysSinceActivity === null
    ? 0
    : Math.max(0, wallDaysSinceActivity - WORKSPACE_DORMANT_AFTER_DAYS);
  console.log("Dormancy:");
  console.log(`  lastActivityAt: ${store.lastActivityAt ?? "(missing)"}`);
  console.log(`  wall days since activity: ${wallDaysSinceActivity === null ? "unknown" : wallDaysSinceActivity.toFixed(1)}`);
  console.log(`  dormant discount active: ${dormantDiscountActive ? "yes" : "no"}`);
  console.log(`  dormant days past grace: ${dormantDaysPastGrace.toFixed(1)}`);
  console.log(`  dormant multiplier: ${DORMANT_DECAY_MULTIPLIER}`);
  console.log("");

  const highImportanceCount = active.filter(entry => entry.userImportance === "high").length;
  const safetyCriticalCount = active.filter(isSafetyCriticalForDiag).length;
  const maxReinforcedCount = active.filter(entry => (entry.reinforcementCount ?? 0) >= 6).length;
  const highImportanceRatio = active.length === 0 ? 0 : highImportanceCount / active.length;
  const maxReinforcedRatio = active.length === 0 ? 0 : maxReinforcedCount / active.length;
  const highImportanceAlert = highImportanceRatio > 0.3;
  const safetyCriticalWarning = safetyCriticalCount > 0;
  const maxReinforcedAlert = maxReinforcedRatio > 0.1;
  console.log("Retention monitoring:");
  console.log(`  high_importance_ratio: ${formatPercent(highImportanceRatio)} (alert > 30%)${highImportanceAlert ? " ALERT" : ""}`);
  console.log(`  safety_critical_count: ${safetyCriticalCount} (deprecated field)${safetyCriticalWarning ? " WARNING" : ""}`);
  console.log(`  max_reinforced_count: ${maxReinforcedAlert ? `${maxReinforcedCount} (${formatPercent(maxReinforcedRatio)}, alert > 10%) ALERT` : `${maxReinforcedCount} (alert > 10% active)`}`);
  console.log("");

  const qualityByEntry = active.map(entry => ({ entry, quality: assessMemoryQuality(entry) }));
  const duplicateCounts = countBy(active.map(entry => `${entry.type}:${canonicalMemoryText(entry.text)}`));
  const duplicateExtras = [...duplicateCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  console.log("Quality warnings:");
  console.log(`  progress-like active memories: ${qualityByEntry.filter(item => item.quality.reasons.includes("progress_snapshot")).length}`);
  console.log(`  path-heavy active memories: ${qualityByEntry.filter(item => item.quality.reasons.includes("path_heavy")).length}`);
  console.log(`  duplicate-ish exact canonical text: ${duplicateExtras}`);
  console.log(`  very long entries: ${active.filter(entry => entry.text.length > LONG_TERM_LIMITS.maxEntryTextChars).length}`);
  console.log("");

  console.log("Suspicious active memories:");
  for (const reason of SUSPICIOUS_REASONS) {
    console.log(`  ${reason}-like: ${qualityByEntry.filter(item => item.quality.reasons.includes(reason)).length}`);
  }

  const failingQuality = qualityByEntry.filter(item => !item.quality.accepted);
  if (failingQuality.length > 0) {
    console.log("");
    console.log("Active memories failing offline quality checks:");
    for (const item of failingQuality.slice(0, 8)) {
      console.log(`  - [${item.entry.type}] reasons=${item.quality.reasons.join(",")} ${JSON.stringify(truncate(cleanText(item.entry.text, input.raw)))}`);
    }
  }

  console.log("");
  console.log("Top rendered candidates:");
  const top = retention.rendered.slice(0, 5);
  if (top.length === 0) {
    console.log("  (none)");
  } else {
    for (const item of top) {
      console.log(`  - strength=${formatStrength(item.strength)} [${item.entry.type}] ${truncate(cleanText(item.entry.text, input.raw))}`);
    }
  }

  console.log("");
  console.log("Weakest active memories:");
  const weakest = retention.sorted.slice(-5).reverse();
  if (weakest.length === 0) {
    console.log("  (none)");
  } else {
    for (const item of weakest) {
      console.log(`  - strength=${formatStrength(item.strength)} [${item.entry.type}] ${truncate(cleanText(item.entry.text, input.raw))}`);
    }
  }
}

function inferOrigin(record: RejectionLogRecord): Origin {
  if (record.origin && ALLOWED_ORIGINS.has(record.origin as Origin)) return record.origin as Origin;
  if (record.source === "compaction") return "compaction_candidate";
  if (record.source === "explicit") return "explicit_trigger";
  if (record.source === "manual") return "manual";
  return "unknown";
}

function normalizeRejection(record: RejectionLogRecord): NormalizedRejection | null {
  if (!record.text || !Array.isArray(record.reasons)) return null;
  const origin = inferOrigin(record);
  return {
    timestamp: record.timestamp ?? "",
    workspaceKey: record.workspaceKey,
    workspaceRoot: record.workspaceRoot,
    workspaceRootHash: record.workspaceRootHash,
    type: record.type ?? "project",
    source: record.source,
    origin,
    fromTrigger: typeof record.fromTrigger === "boolean" ? record.fromTrigger : origin === "explicit_trigger",
    text: record.text,
    reasons: record.reasons,
  };
}

function sinceCutoff(rawSince: string | undefined): number | null {
  if (!rawSince) return null;
  const relative = rawSince.match(/^(\d+)([dhm])$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const multiplier = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000;
    return Date.now() - amount * multiplier;
  }
  const timestamp = new Date(rawSince).getTime();
  if (Number.isNaN(timestamp)) die(`Invalid --since value: ${rawSince}`);
  return timestamp;
}

function hasSoftReason(record: NormalizedRejection): boolean {
  return record.reasons.some(reason => !HARD_QUALITY_REASONS.has(reason));
}

function hasWorkspaceScope(record: NormalizedRejection): boolean {
  return Boolean(record.workspaceKey || record.workspaceRoot || record.workspaceRootHash);
}

async function workspaceKeyForOption(options: CliOptions): Promise<string | undefined> {
  return options.workspace ? workspaceKey(options.workspace) : undefined;
}

async function loadRejectionRecords(options: CliOptions): Promise<{ path: string; invalidLines: number; records: NormalizedRejection[] }> {
  const path = extractionRejectionLogPath();
  const { records, invalidLines } = await readJSONLFile<RejectionLogRecord>(path);
  const cutoff = sinceCutoff(options.since);
  const requestedWorkspaceKey = await workspaceKeyForOption(options);
  let normalized = records.map(normalizeRejection).filter((record): record is NormalizedRejection => record !== null);

  if (requestedWorkspaceKey) {
    normalized = normalized.filter(record => !record.workspaceKey || record.workspaceKey === requestedWorkspaceKey);
  }
  if (cutoff !== null) {
    normalized = normalized.filter(record => {
      const timestamp = new Date(record.timestamp).getTime();
      return !Number.isNaN(timestamp) && timestamp >= cutoff;
    });
  }
  if (options.softOnly) normalized = normalized.filter(hasSoftReason);
  if (options.triggerOnly) normalized = normalized.filter(record => record.fromTrigger || record.origin === "explicit_trigger");
  if (options.reason) normalized = normalized.filter(record => record.reasons.includes(options.reason ?? ""));

  return { path, invalidLines, records: normalized };
}

function uniqueByCanonicalText(records: NormalizedRejection[]): NormalizedRejection[] {
  const byText = new Map<string, NormalizedRejection>();
  for (const record of records) {
    const key = `${record.type}:${canonicalMemoryText(record.text)}`;
    if (!byText.has(key)) byText.set(key, record);
  }
  return [...byText.values()];
}

function objectFromCounts<T extends string>(counts: Map<T, number>): Record<string, number> {
  return Object.fromEntries(sortedCounts(counts));
}

function groupEvidenceByMemoryId(events: EvidenceEventV1[]): Map<string, EvidenceEventV1[]> {
  const grouped = new Map<string, EvidenceEventV1[]>();
  for (const event of events) {
    for (const id of eventMemoryIds(event)) {
      const bucket = grouped.get(id) ?? [];
      bucket.push(event);
      grouped.set(id, bucket);
    }
  }
  return grouped;
}

async function buildInspectionReadModel(options: CliOptions): Promise<MemoryInspectionReadModel> {
  const snapshot = await snapshotForOptions(options);
  const rejections = await loadRejectionRecords(options);
  return {
    store: snapshot.store,
    pending: snapshot.journal,
    evidenceEvents: snapshot.allEvents,
    rejectionRecords: rejections.records,
    currentById: new Map(snapshot.store.entries.map(entry => [entry.id, entry])),
    evidenceByMemoryId: groupEvidenceByMemoryId(snapshot.allEvents),
  };
}

function terminalDisappearanceReason(events: EvidenceEventV1[]): DisappearanceReason {
  const terminal = [...events].reverse().find(event =>
    event.type === "memory_removed_capacity"
      || event.type === "promotion_absorbed_exact"
      || event.type === "promotion_absorbed_identity"
      || event.type === "promotion_superseded"
  );
  const renderOmission = [...events].reverse().find(event => event.type === "render_omitted");
  const event = terminal ?? renderOmission;
  if (!event) {
    return { classification: "historical_absent_unknown_reason", terminalType: "unknown", reasonCodes: [] };
  }
  return {
    classification: "historical_absent_with_reason",
    terminalType: event.type,
    reasonCodes: event.reasonCodes,
    event,
  };
}

function coverageClassForMemory(id: string, model: MemoryInspectionReadModel): CoverageClass {
  const events = model.evidenceByMemoryId.get(id) ?? [];
  if (!model.currentById.has(id)) return terminalDisappearanceReason(events).classification;
  if (events.length === 0) return "no_evidence";
  if (events.every(event => event.phase === "render")) return "render_only";
  return "full_lifecycle";
}

function eventCounts(events: EvidenceEventV1[]): { total: number; byType: Record<string, number>; byPhase: Record<string, number> } {
  return {
    total: events.length,
    byType: objectFromCounts(countBy(events.map(event => event.type))),
    byPhase: objectFromCounts(countBy(events.map(event => event.phase))),
  };
}

function coverageRows(model: MemoryInspectionReadModel, includeHistorical: boolean): Array<{
  id: string;
  class: CoverageClass;
  current: boolean;
  type?: LongTermType;
  eventCounts: ReturnType<typeof eventCounts>;
}> {
  const ids = new Set<string>(model.currentById.keys());
  if (includeHistorical) {
    for (const id of model.evidenceByMemoryId.keys()) ids.add(id);
  }
  return [...ids].sort().map(id => {
    const entry = model.currentById.get(id);
    const events = model.evidenceByMemoryId.get(id) ?? [];
    return {
      id,
      class: coverageClassForMemory(id, model),
      current: Boolean(entry),
      type: entry?.type ?? events.find(event => event.memory?.memoryId === id)?.memory?.type,
      eventCounts: eventCounts(events),
    };
  });
}

function disappearanceRows(model: MemoryInspectionReadModel): Array<{
  id: string;
  classification: DisappearanceReason["classification"];
  terminalType: DisappearanceReason["terminalType"];
  reasonCodes: string[];
  event?: EvidenceEventV1;
  events: EvidenceEventV1[];
}> {
  const rows = [...model.evidenceByMemoryId.entries()]
    .filter(([id]) => !model.currentById.has(id))
    .map(([id, events]) => {
      const reason = terminalDisappearanceReason(events);
      return { id, ...reason, events };
    });
  return rows.sort((a, b) => a.classification.localeCompare(b.classification) || a.id.localeCompare(b.id));
}

function formatDetails(details: EvidenceEventV1["details"]): string {
  if (!details || Object.keys(details).length === 0) return "none";
  return Object.entries(details).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("|") : String(value)}`).join(" ");
}

function retentionClockSummary(entries: LongTermMemoryEntry[]): { present: number; missing: number; invalid: number } {
  let present = 0;
  let missing = 0;
  let invalid = 0;
  for (const entry of entries) {
    if (entry.retentionClock === undefined) {
      missing += 1;
    } else if (!Number.isFinite(entry.retentionClock) || entry.retentionClock <= 0) {
      invalid += 1;
    } else {
      present += 1;
    }
  }
  return { present, missing, invalid };
}

function rejectionQualitySummary(records: NormalizedRejection[]): {
  totalRecords: number;
  uniqueTexts: number;
  workspaceScopedCount: number;
  legacyUnscopedCount: number;
  reasonDistribution: Record<string, number>;
  uniqueReasonDistribution: Record<string, number>;
  possibleFalsePositiveGroups: Record<string, { count: number; samples: string[] }>;
} {
  const uniqueRecords = uniqueByCanonicalText(records);
  const badDecisionUnique = uniqueRecords.filter(record => record.reasons.includes("bad_decision"));
  const groups: Record<string, { count: number; samples: string[] }> = {
    architecture_like_possible_false_positive: { count: 0, samples: [] },
    clearly_garbage: { count: 0, samples: [] },
    ambiguous: { count: 0, samples: [] },
  };

  for (const record of badDecisionUnique) {
    const hardReasons = record.reasons.filter(reason => HARD_QUALITY_REASONS.has(reason));
    const statusLike = /\b(?:implemented|added|updated|fixed|completed|reviewed|tests?|CI|commit|wave|phase|task|session)\b/i.test(record.text);
    const group = isArchitectureLikeDecision(record.text) && hardReasons.length === 0 && !statusLike
      ? "architecture_like_possible_false_positive"
      : hardReasons.length > 0 || statusLike
        ? "clearly_garbage"
        : "ambiguous";
    groups[group].count += 1;
    if (groups[group].samples.length < 5) groups[group].samples.push(truncate(cleanText(record.text, false), 120));
  }

  return {
    totalRecords: records.length,
    uniqueTexts: uniqueRecords.length,
    workspaceScopedCount: records.filter(hasWorkspaceScope).length,
    legacyUnscopedCount: records.filter(record => !hasWorkspaceScope(record)).length,
    reasonDistribution: objectFromCounts(countBy(records.flatMap(record => record.reasons))),
    uniqueReasonDistribution: objectFromCounts(countBy(uniqueRecords.flatMap(record => record.reasons))),
    possibleFalsePositiveGroups: groups,
  };
}

function rejectionFalsePositiveRisk(summary: ReturnType<typeof rejectionQualitySummary>): "low" | "high" {
  const possible = summary.possibleFalsePositiveGroups.architecture_like_possible_false_positive.count;
  return possible >= 3 || (summary.uniqueTexts > 0 && possible / summary.uniqueTexts >= 0.5) ? "high" : "low";
}

async function runCoverage(options: CliOptions): Promise<void> {
  const model = await buildInspectionReadModel(options);
  const rows = coverageRows(model, options.includeHistorical === true);
  const classCounts = objectFromCounts(countBy(rows.map(row => row.class)));

  if (options.json) {
    console.log(JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      classCounts,
      memories: rows,
    }, null, 2));
    return;
  }

  console.log("Memory evidence coverage");
  console.log("");
  console.log("Class counts:");
  for (const cls of ["full_lifecycle", "render_only", "no_evidence", "historical_absent_with_reason", "historical_absent_unknown_reason"] as CoverageClass[]) {
    console.log(`  ${cls}: ${classCounts[cls] ?? 0}`);
  }
  console.log("");
  console.log("Per-memory rows:");
  if (rows.length === 0) console.log("  (none)");
  for (const row of rows) {
    const phases = row.eventCounts.byPhase;
    console.log(`  ${row.id} ${row.class} current=${row.current ? "yes" : "no"} total=${row.eventCounts.total} extraction=${phases.extraction ?? 0} promotion=${phases.promotion ?? 0} render=${phases.render ?? 0} storage=${phases.storage ?? 0}`);
  }
}

async function runDisappearances(options: CliOptions): Promise<void> {
  const model = await buildInspectionReadModel(options);
  const rows = disappearanceRows(model);

  if (options.json) {
    console.log(JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      disappearances: rows.map(row => ({
        id: row.id,
        classification: row.classification,
        terminalType: row.terminalType,
        reasonCodes: row.reasonCodes,
        eventCounts: eventCounts(row.events),
        details: options.explain ? row.event?.details : undefined,
      })),
    }, null, 2));
    return;
  }

  console.log("Memory disappearances");
  console.log("");
  if (rows.length === 0) {
    console.log("No evidence-only memories found.");
    return;
  }
  for (const row of rows) {
    const reasons = row.reasonCodes.length > 0 ? row.reasonCodes.join(",") : "none";
    console.log(`Memory ${row.id}: ${row.classification} terminal=${row.terminalType} reasons=${reasons}`);
    if (options.explain) {
      console.log(`  events: ${row.events.map(event => event.type).join(", ")}`);
      if (row.event?.type === "memory_removed_capacity") {
        console.log(`  memory_removed_capacity details: ${formatDetails(row.event.details)}`);
      }
      const renderTypeCap = row.events.find(event => event.type === "render_omitted" && event.reasonCodes.includes("type_cap"));
      if (renderTypeCap) {
        console.log(`  render_omitted type-cap observation: reasons=${renderTypeCap.reasonCodes.join(",")} details=${formatDetails(renderTypeCap.details)}`);
      }
    }
  }
}

async function runQuality(options: CliOptions): Promise<void> {
  const model = await buildInspectionReadModel(options);
  const active = model.store.entries.filter(entry => entry.status !== "superseded");
  const retention = retentionCandidatesForDiag(model.store);
  const clocks = retentionClockSummary(active);
  const disappearances = disappearanceRows(model);
  const evidenceCovered = active.filter(entry => (model.evidenceByMemoryId.get(entry.id) ?? []).length > 0).length;
  const rejectionSummary = rejectionQualitySummary(model.rejectionRecords);
  const falsePositiveRisk = rejectionFalsePositiveRisk(rejectionSummary);
  const typeCounts = Object.fromEntries(TYPES.map(type => [type, active.filter(entry => entry.type === type).length]));
  const capsFull = active.length >= model.store.limits.maxEntries || TYPES.some(type => (typeCounts[type] ?? 0) >= RETENTION_TYPE_MAX[type]);
  const unknownDisappearances = disappearances.filter(row => row.classification === "historical_absent_unknown_reason").length;
  const status = unknownDisappearances > 0 || clocks.invalid > 0
    ? "degraded"
    : capsFull || rejectionSummary.legacyUnscopedCount > 0 || falsePositiveRisk === "high"
      ? "warning"
      : "ok";
  const summaryText = `Summary: Workspace memory quality is ${status}: ${active.length} active memories, ${evidenceCovered}/${active.length} with evidence, ${disappearances.length} evidence-only disappearances (${unknownDisappearances} unknown), ${clocks.invalid} invalid retention clocks, and ${rejectionSummary.legacyUnscopedCount} legacy unscoped rejection records.`;
  const caps = {
    active: active.length,
    maxEntries: model.store.limits.maxEntries,
    rendered: retention.rendered.length,
    typeCapped: retention.typeCapped.length,
    globalCapped: retention.globalCapped.length,
    typeCounts,
    capsFull,
  };
  const evidence = {
    currentWithEvidence: evidenceCovered,
    currentWithoutEvidence: active.length - evidenceCovered,
    evidenceMemoryIds: model.evidenceByMemoryId.size,
    disappearances: disappearances.length,
    unknownDisappearances,
    withTerminalReason: disappearances.length - unknownDisappearances,
  };

  if (options.json) {
    console.log(JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      status,
      summaryText,
      store: { active: active.length, pending: model.pending.entries.length, superseded: model.store.entries.length - active.length },
      caps,
      retention: clocks,
      evidence,
      rejections: { ...rejectionSummary, falsePositiveRisk },
    }, null, 2));
    return;
  }

  console.log("Memory quality inspection");
  console.log("");
  console.log(summaryText);
  console.log("");
  console.log("Caps:");
  console.log(`  active: ${caps.active} / ${caps.maxEntries}`);
  for (const type of TYPES) {
    const count = caps.typeCounts[type] ?? 0;
    const limit = RETENTION_TYPE_MAX[type];
    const marker = count >= limit ? " FULL" : "";
    console.log(`  ${type}: ${count} / ${limit}${marker}`);
  }
  console.log(`  rendered: ${caps.rendered}`);
  console.log(`  type-capped entries: ${caps.typeCapped}`);
  console.log(`  global-cap overflow: ${caps.globalCapped}`);
  console.log(`  caps full: ${caps.capsFull ? "yes" : "no"}`);
  console.log("");
  console.log("Retention clocks:");
  console.log(`  present: ${clocks.present}`);
  console.log(`  missing: ${clocks.missing}`);
  console.log(`  invalid: ${clocks.invalid}`);
  console.log("");
  console.log("Evidence:");
  console.log(`  current with evidence: ${evidence.currentWithEvidence}`);
  console.log(`  current without evidence: ${evidence.currentWithoutEvidence}`);
  console.log(`  evidence memory ids: ${evidence.evidenceMemoryIds}`);
  console.log(`  disappearances: ${evidence.disappearances}`);
  console.log(`  unknown disappearances: ${evidence.unknownDisappearances}`);
  console.log("");
  console.log("Rejection scoping:");
  console.log(`  total records: ${rejectionSummary.totalRecords}`);
  console.log(`  workspace scoped: ${rejectionSummary.workspaceScopedCount}`);
  console.log(`  legacy unscoped: ${rejectionSummary.legacyUnscopedCount}`);
  console.log(`  false-positive risk: ${falsePositiveRisk}`);
}

async function runRejections(options: CliOptions): Promise<void> {
  const { path, invalidLines, records } = await loadRejectionRecords(options);
  const normalized = options.unique ? uniqueByCanonicalText(records) : records;

  if (options.quality) {
    const summary = rejectionQualitySummary(records);
    if (options.json) {
      console.log(JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        ...summary,
      }, null, 2));
      return;
    }

    console.log("Extraction rejection quality inspection");
    console.log("");
    console.log("Possible false-positive grouping is heuristic, not deterministic truth.");
    console.log(`logPath=${cleanPath(path, options.raw)}`);
    if (invalidLines > 0) console.log(`Invalid JSONL lines skipped: ${invalidLines}`);
    console.log("");
    console.log(`Total records: ${summary.totalRecords}`);
    console.log(`Unique texts: ${summary.uniqueTexts}`);
    console.log(`Workspace scoped: ${summary.workspaceScopedCount}`);
    console.log(`Legacy unscoped: ${summary.legacyUnscopedCount}`);
    console.log("");
    console.log("Reason distribution (raw records):");
    for (const [reason, count] of Object.entries(summary.reasonDistribution)) console.log(`  ${reason.padEnd(36)} ${count}`);
    if (Object.keys(summary.reasonDistribution).length === 0) console.log("  (none)");
    console.log("");
    console.log("Reason distribution (unique text):");
    for (const [reason, count] of Object.entries(summary.uniqueReasonDistribution)) console.log(`  ${reason.padEnd(36)} ${count}`);
    if (Object.keys(summary.uniqueReasonDistribution).length === 0) console.log("  (none)");
    console.log("");
    console.log("Possible false-positive groups (heuristic, not deterministic):");
    for (const [group, data] of Object.entries(summary.possibleFalsePositiveGroups)) {
      console.log(`  ${group}: ${data.count}`);
      for (const sample of data.samples) console.log(`    - ${JSON.stringify(cleanText(sample, options.raw))}`);
    }
    return;
  }

  console.log("Extraction rejection summary");
  console.log("");
  console.log(`logPath=${cleanPath(path, options.raw)}`);
  if (invalidLines > 0) console.log(`Invalid JSONL lines skipped: ${invalidLines}`);
  console.log("");
  console.log(`Total rejected: ${normalized.length}`);
  console.log("");

  console.log("By reason:");
  const byReason = sortedCounts(countBy(normalized.flatMap(record => record.reasons)));
  if (byReason.length === 0) console.log("  (none)");
  else for (const [reason, count] of byReason) console.log(`  ${reason.padEnd(24)} ${count}`);
  console.log("");

  console.log("By origin:");
  const byOrigin = sortedCounts(countBy(normalized.map(record => record.origin)));
  if (byOrigin.length === 0) console.log("  (none)");
  else for (const [origin, count] of byOrigin) console.log(`  ${origin.padEnd(24)} ${count}`);
  console.log("");

  console.log("Trigger-origin rejections (high priority for v1.5):");
  const triggerReasons = sortedCounts(countBy(normalized.filter(record => record.fromTrigger || record.origin === "explicit_trigger").flatMap(record => record.reasons)));
  if (triggerReasons.length === 0) console.log("  (none)");
  else for (const [reason, count] of triggerReasons) console.log(`  ${reason.padEnd(24)} ${count}`);
  console.log("");

  console.log("Recent suspicious soft rejects:");
  const suspicious = normalized
    .filter(hasSoftReason)
    .sort((a, b) => (new Date(b.timestamp).getTime() || 0) - (new Date(a.timestamp).getTime() || 0))
    .slice(0, 8);
  if (suspicious.length === 0) {
    console.log("  (none)");
  } else {
    for (const record of suspicious) {
      const identity = formatWorkspaceIdentity(record.workspaceKey, record.workspaceRoot, options.raw);
      console.log(`  - [${record.type}] ${JSON.stringify(truncate(cleanText(record.text, options.raw)))}`);
      console.log(`    reasons: ${record.reasons.join(",")}`);
      console.log(`    origin: ${record.origin}${identity ? ` (${identity})` : ""}`);
    }
  }
}

function migrationLogsRoot(): string {
  return join(dataHome(), "opencode-working-memory", "migration-logs");
}

async function migrationLogPaths(options: CliOptions): Promise<string[]> {
  if (options.migration) return [migrationLogPath(options.migration)];
  const root = migrationLogsRoot();
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  return entries.filter(entry => entry.endsWith(".jsonl")).sort().map(entry => join(root, entry));
}

function migrationIdFromPath(path: string): string {
  return path.split("/").pop()?.replace(/\.jsonl$/, "") ?? "unknown";
}

function riskySupersedeReasons(record: MigrationLogRecord): string[] {
  const reasons: string[] = [];
  const hardReasonsMissing = !Array.isArray(record.hardReasons);
  const hardReasons = Array.isArray(record.hardReasons) ? record.hardReasons : [];
  const qualityReasons = Array.isArray(record.reasons) ? record.reasons : [];
  const text = record.text ?? "";

  if (hardReasonsMissing || hardReasons.length === 0) reasons.push("missing_or_empty_hardReasons");
  if (qualityReasons.length > 0 && hardReasons.length === 0) reasons.push("soft_reasons_without_hardReasons");
  if (/\b(?:User|user|prefers|requires|wants|insists)\b|用戶|使用者|偏好|要求|不要|不刪除/u.test(text)) reasons.push("user_preference_marker");
  if (/\b(?:must|should|do not|never|is|are|follows)\b|必須|應該|採用|維持|需支援/iu.test(text)) reasons.push("durable_rule_marker");
  if ((record.type === "feedback" || record.type === "decision") && hardReasons.length === 1 && hardReasons[0] === "path_heavy") {
    reasons.push("feedback_or_decision_path_heavy_only");
  }

  return reasons;
}

async function runAudit(options: CliOptions): Promise<void> {
  const paths = await migrationLogPaths(options);
  console.log("Migration audit report");
  console.log("");
  if (paths.length === 0) {
    console.log("No migration logs found.");
    return;
  }

  for (let i = 0; i < paths.length; i += 1) {
    const path = paths[i];
    const migrationId = options.migration ?? migrationIdFromPath(path);
    const { records, invalidLines } = await readJSONLFile<MigrationLogRecord>(path);
    const superseded = records.filter(record => !record.afterStatus || record.afterStatus === "superseded");
    const hardReasons = superseded.flatMap(record => {
      if (Array.isArray(record.hardReasons)) return record.hardReasons;
      return Array.isArray(record.reasons) ? record.reasons.filter(reason => HARD_QUALITY_REASONS.has(reason)) : [];
    });
    const risky = superseded
      .map(record => ({ record, reasons: riskySupersedeReasons(record) }))
      .filter(item => item.reasons.length > 0);

    if (i > 0) console.log("");
    console.log(`Migration: ${migrationId}`);
    console.log(`logPath=${cleanPath(path, options.raw)}`);
    if (invalidLines > 0) console.log(`Invalid JSONL lines skipped: ${invalidLines}`);
    console.log(`Superseded entries: ${superseded.length}`);
    console.log("");

    console.log("By hard reason:");
    const byHardReason = sortedCounts(countBy(hardReasons));
    if (byHardReason.length === 0) console.log("  (none)");
    else for (const [reason, count] of byHardReason) console.log(`  ${reason.padEnd(24)} ${count}`);
    console.log("");

    console.log("Potentially risky supersedes:");
    console.log(`  ${risky.length}`);
    for (const item of risky.slice(0, 10)) {
      const record = item.record;
      const hard = Array.isArray(record.hardReasons) ? record.hardReasons : [];
      const identity = formatWorkspaceIdentity(record.workspaceKey, record.workspaceRoot, options.raw);
      console.log(`  - [${record.type ?? "unknown"}] hardReasons=${JSON.stringify(hard)} risk=${item.reasons.join(",")} ${JSON.stringify(truncate(cleanText(record.text ?? "", options.raw)))}`);
      if (identity) console.log(`    ${identity}`);
    }
  }
}

async function snapshotForOptions(options: CliOptions): Promise<WorkspaceDiagSnapshot> {
  const root = options.workspace ?? process.cwd();
  const key = await workspaceKey(root);
  return buildWorkspaceDiagSnapshot({
    root,
    key,
    memoryPath: await workspaceMemoryPath(root),
    pendingPath: await workspacePendingJournalPath(root),
  });
}

function formatEvidenceRefs(eventIds: string[], allEvents: EvidenceEventV1[]): string {
  if (eventIds.length === 0) return "(none)";
  const byId = new Map(allEvents.map(event => [event.eventId, event]));
  return eventIds
    .map(id => {
      const event = byId.get(id);
      return event ? `${event.eventId} ${event.type}` : id;
    })
    .join(", ");
}

async function runExplain(options: CliOptions): Promise<void> {
  const snapshot = await snapshotForOptions(options);
  console.log("Workspace memory explainability");
  console.log("");

  if (snapshot.memories.length === 0) {
    console.log("No memories found.");
  }

  for (const memory of snapshot.memories) {
    console.log(`Memory ${memory.id}: ${memory.status}`);
    const strength = typeof memory.strength === "number" ? formatStrength(memory.strength) : "n/a";
    console.log(`- strength=${strength}, type=${memory.type}, source=${memory.source}`);
    console.log(`- reasons: ${memory.reasonCodes.length > 0 ? memory.reasonCodes.join(", ") : "(none)"}`);
    console.log(`- evidence: ${formatEvidenceRefs(memory.evidenceEventIds, snapshot.allEvents)}`);
    console.log("");
  }

  const quarantines = snapshot.recentEvents.filter(event => event.type === "storage_corrupt_json_quarantined");
  if (quarantines.length > 0) {
    console.log("Quarantined stores:");
    for (const event of quarantines) {
      console.log(`- quarantined_corrupt_store: ${event.eventId} ${event.type}; reasons=${event.reasonCodes.join(",")}`);
    }
  }
}

function statusFromTraceEvent(event: EvidenceEventV1 | undefined): string {
  if (!event) return "unknown";
  if (event.type === "render_selected") return "rendered";
  if (event.type === "render_omitted") return statusFromOmissionReason(event.reasonCodes[0]);
  if (event.type === "promotion_absorbed_exact" || event.type === "promotion_absorbed_identity") return "omitted_absorbed_duplicate";
  if (event.type === "promotion_retry_scheduled") return "pending_retry";
  if (event.type === "promotion_rejected_capacity" || event.type === "promotion_retry_exhausted") return "pending_rejected_capacity";
  if (event.type === "storage_corrupt_json_quarantined") return "quarantined_corrupt_store";
  if (event.outcome === "superseded") return "omitted_superseded";
  return event.outcome;
}

function formatTraceEvent(event: EvidenceEventV1): string {
  const reasons = event.reasonCodes.length > 0 ? event.reasonCodes.join(",") : "none";
  const relations = (event.relations ?? [])
    .map(relation => relation.memory?.memoryId ? `${relation.role}=${relation.memory.memoryId}` : undefined)
    .filter((value): value is string => Boolean(value));
  const relationText = relations.length > 0 ? `; ${relations.join(", ")}` : "";
  return `- ${event.eventId} ${event.type}: ${event.outcome}; reasons=${reasons}${relationText}`;
}

function relationMemoryIds(events: EvidenceEventV1[], role: string): string[] {
  return uniqueStrings(events.flatMap(event => (event.relations ?? [])
    .filter(relation => relation.role === role)
    .map(relation => relation.memory?.memoryId ?? "")));
}

async function runTrace(options: CliOptions): Promise<void> {
  const root = options.workspace ?? process.cwd();
  const memoryId = options.memory;
  if (!memoryId) die("--memory requires an id");

  const [snapshot, trace] = await Promise.all([
    snapshotForOptions(options),
    traceMemoryLifecycle(root, { memoryId }),
  ]);
  const memoryRow = snapshot.memories.find(memory => memory.id === memoryId);
  const status = memoryRow?.status ?? statusFromTraceEvent(trace.events.at(-1));

  console.log(`Memory ${memoryId}: ${status}`);
  console.log("");
  console.log("Lifecycle:");
  if (trace.events.length === 0) {
    console.log("(none)");
    return;
  }

  for (const event of trace.events) {
    console.log(formatTraceEvent(event));
  }

  const supersededBy = relationMemoryIds(trace.events, "superseded_by");
  if (supersededBy.length > 0) {
    console.log("");
    console.log("Superseded by:");
    for (const id of supersededBy) console.log(`- ${id}`);
  }

  const reinforcedBy = relationMemoryIds(trace.events, "reinforced_by");
  if (reinforcedBy.length > 0) {
    console.log("");
    console.log("Reinforced by:");
    for (const id of reinforcedBy) console.log(`- ${id}`);
  }
}

const { command, options } = parseArgs(process.argv.slice(2));

if (command === "health") await runHealth(options);
else if (command === "quality") await runQuality(options);
else if (command === "coverage") await runCoverage(options);
else if (command === "disappearances") await runDisappearances(options);
else if (command === "rejections") await runRejections(options);
else if (command === "audit") await runAudit(options);
else if (command === "explain") await runExplain(options);
else await runTrace(options);
