import { buildRejectedJSON, formatRejected } from "../formatters/rejected.ts";
import { loadRejectionRecords, rejectionFalsePositiveRisk, rejectionQualitySummary } from "../rejections-model.ts";
import type { CliOptions, CommandResult } from "../types.ts";

export async function runRejected(options: CliOptions): Promise<CommandResult> {
  const { path, invalidLines, records } = await loadRejectionRecords(options);
  const summary = rejectionQualitySummary(records);
  const falsePositiveRisk = rejectionFalsePositiveRisk(summary);

  if (options.json) {
    return { stdout: JSON.stringify(buildRejectedJSON({ summary, falsePositiveRisk }), null, 2) };
  }

  return {
    stdout: formatRejected({
      path,
      invalidLines,
      records,
      summary,
      falsePositiveRisk,
      raw: options.raw,
      verbose: options.verbose,
    }),
  };
}
