import type { coverageRows } from "../inspection-model.ts";
import { countBy, objectFromCounts } from "../text.ts";
import type { CoverageClass } from "../types.ts";

export type CoverageRows = ReturnType<typeof coverageRows>;

export function buildCoverageJSON(rows: CoverageRows, generatedAt = new Date().toISOString()): Record<string, unknown> {
  const classCounts = objectFromCounts(countBy(rows.map(row => row.class)));
  return {
    version: 1,
    generatedAt,
    classCounts,
    memories: rows,
  };
}

export function formatCoverage(rows: CoverageRows): string {
  const classCounts = objectFromCounts(countBy(rows.map(row => row.class)));
  const lines: string[] = [];
  lines.push("Memory evidence coverage");
  lines.push("");
  lines.push("Class counts:");
  for (const cls of ["full_lifecycle", "render_only", "no_evidence", "historical_absent_with_reason", "historical_absent_unknown_reason"] as CoverageClass[]) {
    lines.push(`  ${cls}: ${classCounts[cls] ?? 0}`);
  }
  lines.push("");
  lines.push("Per-memory rows:");
  if (rows.length === 0) lines.push("  (none)");
  for (const row of rows) {
    const phases = row.eventCounts.byPhase;
    lines.push(`  ${row.id} ${row.class} current=${row.current ? "yes" : "no"} total=${row.eventCounts.total} extraction=${phases.extraction ?? 0} promotion=${phases.promotion ?? 0} render=${phases.render ?? 0} storage=${phases.storage ?? 0}`);
  }
  return lines.join("\n");
}
