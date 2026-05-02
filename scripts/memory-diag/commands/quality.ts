import { buildInspectionReadModel } from "../inspection-model.ts";
import { buildQualityJSON, formatQuality } from "../formatters/quality.ts";
import type { CliOptions, CommandResult } from "../types.ts";

export async function runQuality(options: CliOptions): Promise<CommandResult> {
  const model = await buildInspectionReadModel(options);
  const now = Date.now();

  if (options.json) {
    return { stdout: JSON.stringify(buildQualityJSON(model, new Date(now).toISOString(), now), null, 2) };
  }

  return { stdout: formatQuality(model, now) };
}
