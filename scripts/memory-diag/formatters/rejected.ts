import { rejectionFalsePositiveRisk, rejectionQualitySummary } from "../rejections-model.ts";
import { cleanPath, cleanText, countBy, sortedCounts, truncate } from "../text.ts";
import type { NormalizedRejection } from "../types.ts";

export type RejectedSummary = ReturnType<typeof rejectionQualitySummary>;
export type RejectedFalsePositiveRisk = ReturnType<typeof rejectionFalsePositiveRisk>;

export function buildRejectedJSON(input: {
  summary: RejectedSummary;
  falsePositiveRisk: RejectedFalsePositiveRisk;
  generatedAt?: string;
}): Record<string, unknown> {
  return {
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    ...input.summary,
    falsePositiveRisk: input.falsePositiveRisk,
  };
}

export function formatRejected(input: {
  path: string;
  invalidLines: number;
  records: NormalizedRejection[];
  summary: RejectedSummary;
  falsePositiveRisk: RejectedFalsePositiveRisk;
  raw: boolean;
  verbose?: boolean;
}): string {
  const lines: string[] = [];
  lines.push("Rejected memory summary");
  lines.push("");
  lines.push(`Total rejected: ${input.summary.totalRecords}`);
  lines.push(`Unique texts: ${input.summary.uniqueTexts}`);
  lines.push("");

  lines.push("Top reasons:");
  const byReason = sortedCounts(countBy(input.records.flatMap(record => record.reasons))).slice(0, 5);
  if (byReason.length === 0) lines.push("  (none)");
  else for (const [reason, count] of byReason) lines.push(`  ${reason.padEnd(36)} ${count}`);
  lines.push("");

  lines.push(`False-positive risk: ${input.falsePositiveRisk}`);
  if (input.falsePositiveRisk === "high") {
    lines.push("⚠️ Possible false positives detected. Use --verbose to inspect samples.");
  }
  lines.push("");

  lines.push("Recent samples:");
  const samples = [...input.records]
    .sort((a, b) => (new Date(b.timestamp).getTime() || 0) - (new Date(a.timestamp).getTime() || 0))
    .slice(0, 5);
  if (samples.length === 0) {
    lines.push("  (none)");
  } else {
    for (const record of samples) {
      lines.push(`  - [${record.type}] ${truncate(cleanText(record.text, input.raw))}`);
      lines.push(`    reasons: ${record.reasons.length > 0 ? record.reasons.join(",") : "none"}`);
    }
  }

  if (!input.verbose) return lines.join("\n");

  lines.push("");
  lines.push("Possible false-positive grouping is heuristic, not deterministic truth.");
  lines.push(`logPath=${cleanPath(input.path, input.raw)}`);
  if (input.invalidLines > 0) lines.push(`Invalid JSONL lines skipped: ${input.invalidLines}`);
  lines.push("");

  lines.push("Reason distribution (raw records):");
  for (const [reason, count] of Object.entries(input.summary.reasonDistribution)) lines.push(`  ${reason.padEnd(36)} ${count}`);
  if (Object.keys(input.summary.reasonDistribution).length === 0) lines.push("  (none)");
  lines.push("");

  lines.push("Reason distribution (unique text):");
  for (const [reason, count] of Object.entries(input.summary.uniqueReasonDistribution)) lines.push(`  ${reason.padEnd(36)} ${count}`);
  if (Object.keys(input.summary.uniqueReasonDistribution).length === 0) lines.push("  (none)");
  lines.push("");

  lines.push("By origin:");
  const byOrigin = sortedCounts(countBy(input.records.map(record => record.origin)));
  if (byOrigin.length === 0) lines.push("  (none)");
  else for (const [origin, count] of byOrigin) lines.push(`  ${origin.padEnd(36)} ${count}`);
  lines.push("");

  lines.push("Possible false-positive groups (heuristic, not deterministic):");
  for (const [group, data] of Object.entries(input.summary.possibleFalsePositiveGroups)) {
    lines.push(`  ${group}: ${data.count}`);
    for (const sample of data.samples) lines.push(`    - ${JSON.stringify(cleanText(sample, input.raw))}`);
  }

  return lines.join("\n");
}
