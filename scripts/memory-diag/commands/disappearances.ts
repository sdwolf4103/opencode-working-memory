import { buildInspectionReadModel, disappearanceRows } from "../inspection-model.ts";
import { buildDisappearancesJSON, formatDisappearances } from "../formatters/disappearances.ts";
import type { CliOptions, CommandResult } from "../types.ts";

export async function runDisappearances(options: CliOptions): Promise<CommandResult> {
  const model = await buildInspectionReadModel(options);
  const rows = disappearanceRows(model);

  if (options.json) {
    return { stdout: JSON.stringify(buildDisappearancesJSON(rows, { explain: options.explain }), null, 2) };
  }

  return { stdout: formatDisappearances(rows, { explain: options.explain }) };
}
