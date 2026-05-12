import { buildQualityJSON, formatQualityReviewBoard } from "../formatters/quality.ts";
import { buildInspectionReadModel } from "../inspection-model.ts";
import { buildQualityReviewBoard } from "../quality-review-model.ts";
import type { CliOptions, CommandResult } from "../types.ts";

export async function runQuality(options: CliOptions): Promise<CommandResult> {
  const model = await buildInspectionReadModel(options);
  const report = buildQualityReviewBoard(model, {
    verbose: options.verbose,
    raw: options.raw,
    noEmoji: options.noEmoji,
    json: options.json,
  });

  if (options.json) {
    return { stdout: JSON.stringify(buildQualityJSON(report, options.raw), null, 2) };
  }

  return { stdout: formatQualityReviewBoard(report, { verbose: options.verbose, noEmoji: options.noEmoji }) };
}
