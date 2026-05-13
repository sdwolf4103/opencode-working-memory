import { extractionRejectionLogPath, workspaceKey } from "../../src/paths.ts";
import { HARD_QUALITY_REASONS, isArchitectureLikeDecision } from "../../src/memory-quality.ts";
import { ALLOWED_ORIGINS } from "./constants.ts";
import { readJSONLFile } from "./io.ts";
import { canonicalMemoryText, cleanText, countBy, objectFromCounts, truncate } from "./text.ts";
import { CliInputError, type CliOptions, type NormalizedRejection, type Origin, type RejectionLogRecord } from "./types.ts";

export { CliInputError } from "./types.ts";

export function inferOrigin(record: RejectionLogRecord): Origin {
  if (record.origin && ALLOWED_ORIGINS.has(record.origin as Origin)) return record.origin as Origin;
  if (record.source === "compaction") return "compaction_candidate";
  if (record.source === "explicit") return "explicit_trigger";
  if (record.source === "manual") return "manual";
  return "unknown";
}

export function normalizeRejection(record: RejectionLogRecord): NormalizedRejection | null {
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
    producerName: typeof record.producerName === "string" ? record.producerName : undefined,
    producerVersion: typeof record.producerVersion === "string" ? record.producerVersion : undefined,
    instrumentationVersion: typeof record.instrumentationVersion === "number" ? record.instrumentationVersion : undefined,
    decisionLogicName: typeof record.decisionLogicName === "string" ? record.decisionLogicName : undefined,
    decisionLogicVersion: typeof record.decisionLogicVersion === "number" ? record.decisionLogicVersion : undefined,
    text: record.text,
    reasons: record.reasons,
  };
}

export function sinceCutoff(rawSince: string | undefined, now = Date.now()): number | null {
  if (!rawSince) return null;
  const relative = rawSince.match(/^(\d+)([dhm])$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const multiplier = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000;
    return now - amount * multiplier;
  }
  const timestamp = new Date(rawSince).getTime();
  if (Number.isNaN(timestamp)) throw new CliInputError(`Invalid --since value: ${rawSince}`);
  return timestamp;
}

export function hasSoftReason(record: NormalizedRejection): boolean {
  return record.reasons.some(reason => !HARD_QUALITY_REASONS.has(reason));
}

export function hasWorkspaceScope(record: NormalizedRejection): boolean {
  return Boolean(record.workspaceKey || record.workspaceRoot || record.workspaceRootHash);
}

export async function workspaceKeyForOption(options: CliOptions): Promise<string | undefined> {
  return options.workspace ? workspaceKey(options.workspace) : undefined;
}

export async function loadRejectionRecords(options: CliOptions): Promise<{ path: string; invalidLines: number; records: NormalizedRejection[] }> {
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

export function uniqueByCanonicalText(records: NormalizedRejection[]): NormalizedRejection[] {
  const byText = new Map<string, NormalizedRejection>();
  for (const record of records) {
    const key = `${record.type}:${canonicalMemoryText(record.text)}`;
    if (!byText.has(key)) byText.set(key, record);
  }
  return [...byText.values()];
}

export function rejectionQualitySummary(records: NormalizedRejection[]): {
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

export function rejectionFalsePositiveRisk(summary: ReturnType<typeof rejectionQualitySummary>): "low" | "high" {
  const possible = summary.possibleFalsePositiveGroups.architecture_like_possible_false_positive.count;
  return possible >= 3 || (summary.uniqueTexts > 0 && possible / summary.uniqueTexts >= 0.5) ? "high" : "low";
}
