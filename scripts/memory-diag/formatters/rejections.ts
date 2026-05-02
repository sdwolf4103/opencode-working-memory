import { hasSoftReason, rejectionQualitySummary } from "../rejections-model.ts";
import { cleanPath, cleanText, countBy, formatWorkspaceIdentity, sortedCounts, truncate } from "../text.ts";
import type { NormalizedRejection } from "../types.ts";

export type RejectionQualitySummary = ReturnType<typeof rejectionQualitySummary>;

export function buildRejectionQualityJSON(summary: RejectionQualitySummary, generatedAt = new Date().toISOString()): Record<string, unknown> {
  return {
    version: 1,
    generatedAt,
    ...summary,
  };
}

export function formatRejections(input: {
  path: string;
  invalidLines: number;
  records: NormalizedRejection[];
  raw: boolean;
}): string {
  const lines: string[] = [];
  lines.push("Extraction rejection summary");
  lines.push("");
  lines.push(`logPath=${cleanPath(input.path, input.raw)}`);
  if (input.invalidLines > 0) lines.push(`Invalid JSONL lines skipped: ${input.invalidLines}`);
  lines.push("");
  lines.push(`Total rejected: ${input.records.length}`);
  lines.push("");

  lines.push("By reason:");
  const byReason = sortedCounts(countBy(input.records.flatMap(record => record.reasons)));
  if (byReason.length === 0) lines.push("  (none)");
  else for (const [reason, count] of byReason) lines.push(`  ${reason.padEnd(24)} ${count}`);
  lines.push("");

  lines.push("By origin:");
  const byOrigin = sortedCounts(countBy(input.records.map(record => record.origin)));
  if (byOrigin.length === 0) lines.push("  (none)");
  else for (const [origin, count] of byOrigin) lines.push(`  ${origin.padEnd(24)} ${count}`);
  lines.push("");

  lines.push("Trigger-origin rejections (high priority for v1.5):");
  const triggerReasons = sortedCounts(countBy(input.records.filter(record => record.fromTrigger || record.origin === "explicit_trigger").flatMap(record => record.reasons)));
  if (triggerReasons.length === 0) lines.push("  (none)");
  else for (const [reason, count] of triggerReasons) lines.push(`  ${reason.padEnd(24)} ${count}`);
  lines.push("");

  lines.push("Recent suspicious soft rejects:");
  const suspicious = input.records
    .filter(hasSoftReason)
    .sort((a, b) => (new Date(b.timestamp).getTime() || 0) - (new Date(a.timestamp).getTime() || 0))
    .slice(0, 8);
  if (suspicious.length === 0) {
    lines.push("  (none)");
  } else {
    for (const record of suspicious) {
      const identity = formatWorkspaceIdentity(record.workspaceKey, record.workspaceRoot, input.raw);
      lines.push(`  - [${record.type}] ${JSON.stringify(truncate(cleanText(record.text, input.raw)))}`);
      lines.push(`    reasons: ${record.reasons.join(",")}`);
      lines.push(`    origin: ${record.origin}${identity ? ` (${identity})` : ""}`);
    }
  }
  return lines.join("\n");
}

export function formatRejectionQuality(input: {
  path: string;
  invalidLines: number;
  summary: RejectionQualitySummary;
  raw: boolean;
}): string {
  const lines: string[] = [];
  lines.push("Extraction rejection quality inspection");
  lines.push("");
  lines.push("Possible false-positive grouping is heuristic, not deterministic truth.");
  lines.push(`logPath=${cleanPath(input.path, input.raw)}`);
  if (input.invalidLines > 0) lines.push(`Invalid JSONL lines skipped: ${input.invalidLines}`);
  lines.push("");
  lines.push(`Total records: ${input.summary.totalRecords}`);
  lines.push(`Unique texts: ${input.summary.uniqueTexts}`);
  lines.push(`Workspace scoped: ${input.summary.workspaceScopedCount}`);
  lines.push(`Legacy unscoped: ${input.summary.legacyUnscopedCount}`);
  lines.push("");
  lines.push("Reason distribution (raw records):");
  for (const [reason, count] of Object.entries(input.summary.reasonDistribution)) lines.push(`  ${reason.padEnd(36)} ${count}`);
  if (Object.keys(input.summary.reasonDistribution).length === 0) lines.push("  (none)");
  lines.push("");
  lines.push("Reason distribution (unique text):");
  for (const [reason, count] of Object.entries(input.summary.uniqueReasonDistribution)) lines.push(`  ${reason.padEnd(36)} ${count}`);
  if (Object.keys(input.summary.uniqueReasonDistribution).length === 0) lines.push("  (none)");
  lines.push("");
  lines.push("Possible false-positive groups (heuristic, not deterministic):");
  for (const [group, data] of Object.entries(input.summary.possibleFalsePositiveGroups)) {
    lines.push(`  ${group}: ${data.count}`);
    for (const sample of data.samples) lines.push(`    - ${JSON.stringify(cleanText(sample, input.raw))}`);
  }
  return lines.join("\n");
}
