import { buildInspectionReadModel, coverageRows } from "../inspection-model.ts";
import { buildCoverageJSON, formatCoverage } from "../formatters/coverage.ts";
import type { CliOptions, CommandResult } from "../types.ts";

export async function runCoverage(options: CliOptions): Promise<CommandResult> {
  const model = await buildInspectionReadModel(options);
  const rows = coverageRows(model, options.includeHistorical === true);

  if (options.json) {
    return { stdout: JSON.stringify(buildCoverageJSON(rows), null, 2) };
  }

  return { stdout: formatCoverage(rows) };
}
