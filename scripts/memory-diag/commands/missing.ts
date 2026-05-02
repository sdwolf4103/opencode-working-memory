import { buildInspectionReadModel, disappearanceRows } from "../inspection-model.ts";
import { buildMissingJSON, formatMissing } from "../formatters/missing.ts";
import type { CliOptions, CommandResult } from "../types.ts";

export async function runMissing(options: CliOptions): Promise<CommandResult> {
  const model = await buildInspectionReadModel(options);
  const rows = disappearanceRows(model);

  if (options.json) {
    return { stdout: JSON.stringify(buildMissingJSON(rows, { explain: options.explain }), null, 2) };
  }

  return { stdout: formatMissing(rows, { verbose: options.verbose, explain: options.explain }) };
}
