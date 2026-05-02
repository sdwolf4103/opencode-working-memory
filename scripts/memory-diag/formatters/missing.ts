import { buildDisappearancesJSON, formatDisappearances, type DisappearanceRows } from "./disappearances.ts";

export type MissingSummary = {
  total: number;
  explained: number;
  needsReview: number;
};

export function missingSummary(rows: DisappearanceRows): MissingSummary {
  return {
    total: rows.length,
    explained: rows.filter(row => row.classification === "historical_absent_with_reason").length,
    needsReview: rows.filter(row => row.classification === "historical_absent_unknown_reason").length,
  };
}

export function buildMissingJSON(rows: DisappearanceRows, options: { explain?: boolean; generatedAt?: string } = {}): Record<string, unknown> {
  return {
    ...buildDisappearancesJSON(rows, options),
    summary: missingSummary(rows),
  };
}

export function formatMissing(rows: DisappearanceRows, options: { verbose?: boolean; explain?: boolean } = {}): string {
  const summary = missingSummary(rows);
  const lines: string[] = [];
  lines.push("Missing memory summary");
  lines.push("");
  if (rows.length === 0) {
    lines.push("No missing memories found.");
    return lines.join("\n");
  }

  lines.push(`Total missing: ${summary.total}`);
  lines.push(`Explained: ${summary.explained}`);
  lines.push(`Needs review: ${summary.needsReview}`);
  lines.push("");

  const unknownRows = rows
    .filter(row => row.classification === "historical_absent_unknown_reason")
    .slice(0, 5);
  lines.push("Unknown disappearance samples:");
  if (unknownRows.length === 0) {
    lines.push("  (none)");
  } else {
    for (const row of unknownRows) {
      const reasons = row.reasonCodes.length > 0 ? row.reasonCodes.join(",") : "none";
      lines.push(`  - ${row.id} terminal=${row.terminalType} reasons=${reasons}`);
    }
  }

  if (options.verbose || options.explain) {
    lines.push("");
    lines.push(formatDisappearances(rows, { explain: true }));
  }

  return lines.join("\n");
}
