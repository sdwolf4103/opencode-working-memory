import { formatRejections, formatRejectionQuality, buildRejectionQualityJSON } from "../formatters/rejections.ts";
import { loadRejectionRecords, rejectionFalsePositiveRisk, rejectionQualitySummary, uniqueByCanonicalText } from "../rejections-model.ts";
import type { CliOptions, CommandResult } from "../types.ts";

export async function runRejections(options: CliOptions): Promise<CommandResult> {
  const { path, invalidLines, records } = await loadRejectionRecords(options);
  const normalized = options.unique ? uniqueByCanonicalText(records) : records;

  if (options.quality) {
    const summary = rejectionQualitySummary(records);
    if (options.json) {
      return { stdout: JSON.stringify({ ...buildRejectionQualityJSON(summary), falsePositiveRisk: rejectionFalsePositiveRisk(summary) }, null, 2) };
    }

    return { stdout: formatRejectionQuality({ path, invalidLines, summary, raw: options.raw }) };
  }

  return { stdout: formatRejections({ path, invalidLines, records: normalized, raw: options.raw }) };
}
