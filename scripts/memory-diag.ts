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
import { assessMemoryQuality, HARD_QUALITY_REASONS } from "../src/memory-quality.ts";
import { redactCredentials } from "../src/redaction.ts";
import { scanWorkspaceResidues } from "../src/workspace-cleanup.ts";
import { renderWorkspaceMemory } from "../src/workspace-memory.ts";
import {
  DORMANT_DECAY_MULTIPLIER,
  RETENTION_TYPE_MAX,
  WORKSPACE_DORMANT_AFTER_DAYS,
  calculateRetentionStrength,
} from "../src/retention.ts";
import type { LongTermMemoryEntry, LongTermSource, LongTermType, PendingMemoryJournalStore, WorkspaceMemoryStore } from "../src/types.ts";
import { LONG_TERM_LIMITS, PROMOTION_RETRY_LIMITS } from "../src/types.ts";

type Command = "health" | "rejections" | "audit";
type Origin = "explicit_trigger" | "compaction_candidate" | "manual" | "migration_check" | "unknown";

type CliOptions = {
  raw: boolean;
  workspace?: string;
  all?: boolean;
  softOnly?: boolean;
  triggerOnly?: boolean;
  since?: string;
  migration?: string;
};

type RejectionLogRecord = {
  timestamp?: string;
  workspaceKey?: string;
  workspaceRoot?: string;
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
  bun scripts/memory-diag.ts health [--workspace <path>] [--all] [--raw]
  bun scripts/memory-diag.ts rejections [--soft-only] [--trigger-only] [--since 14d] [--raw]
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
  if (command !== "health" && command !== "rejections" && command !== "audit") {
    die(`Unknown subcommand: ${command}`);
  }

  const options: CliOptions = { raw: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--raw") options.raw = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--soft-only") options.softOnly = true;
    else if (arg === "--trigger-only") options.triggerOnly = true;
    else if (arg === "--workspace") {
      const value = rest[++i];
      if (!value) die("--workspace requires a path");
      options.workspace = value;
    } else if (arg === "--since") {
      const value = rest[++i];
      if (!value) die("--since requires a duration or ISO timestamp");
      options.since = value;
    } else if (arg === "--migration") {
      const value = rest[++i];
      if (!value) die("--migration requires an id");
      options.migration = value;
    } else {
      die(`Unknown option: ${arg}`);
    }
  }

  if (command === "health") {
    if (options.all && options.workspace) die("Use either --all or --workspace, not both");
  } else {
    if (options.all || options.workspace) die(`${command} does not accept --all or --workspace`);
  }
  if (command !== "rejections" && (options.softOnly || options.triggerOnly || options.since)) {
    die(`${command} does not accept rejection filters`);
  }
  if (command !== "audit" && options.migration) {
    die(`${command} does not accept --migration`);
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

async function runHealth(options: CliOptions): Promise<void> {
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

async function runRejections(options: CliOptions): Promise<void> {
  const path = extractionRejectionLogPath();
  const { records, invalidLines } = await readJSONLFile<RejectionLogRecord>(path);
  const cutoff = sinceCutoff(options.since);
  let normalized = records.map(normalizeRejection).filter((record): record is NormalizedRejection => record !== null);
  if (cutoff !== null) {
    normalized = normalized.filter(record => {
      const timestamp = new Date(record.timestamp).getTime();
      return !Number.isNaN(timestamp) && timestamp >= cutoff;
    });
  }
  if (options.softOnly) normalized = normalized.filter(hasSoftReason);
  if (options.triggerOnly) normalized = normalized.filter(record => record.fromTrigger || record.origin === "explicit_trigger");

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

const { command, options } = parseArgs(process.argv.slice(2));

if (command === "health") await runHealth(options);
else if (command === "rejections") await runRejections(options);
else await runAudit(options);
