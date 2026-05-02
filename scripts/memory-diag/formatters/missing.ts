import type { disappearanceRows } from "../inspection-model.ts";
import { eventCounts } from "../inspection-model.ts";
import { formatDetails } from "../text.ts";

export type DisappearanceRows = ReturnType<typeof disappearanceRows>;

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

function buildDisappearancesJSON(rows: DisappearanceRows, options: { explain?: boolean; generatedAt?: string } = {}): Record<string, unknown> {
  return {
    version: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    disappearances: rows.map(row => ({
      id: row.id,
      classification: row.classification,
      terminalType: row.terminalType,
      reasonCodes: row.reasonCodes,
      eventCounts: eventCounts(row.events),
      details: options.explain ? row.event?.details : undefined,
    })),
  };
}

function formatDisappearances(rows: DisappearanceRows, options: { explain?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push("Memory disappearances");
  lines.push("");
  if (rows.length === 0) {
    lines.push("No evidence-only memories found.");
    return lines.join("\n");
  }
  for (const row of rows) {
    const reasons = row.reasonCodes.length > 0 ? row.reasonCodes.join(",") : "none";
    lines.push(`Memory ${row.id}: ${row.classification} terminal=${row.terminalType} reasons=${reasons}`);
    if (options.explain) {
      lines.push(`  events: ${row.events.map(event => event.type).join(", ")}`);
      if (row.event?.type === "memory_removed_capacity") {
        lines.push(`  memory_removed_capacity details: ${formatDetails(row.event.details)}`);
      }
      const renderTypeCap = row.events.find(event => event.type === "render_omitted" && event.reasonCodes.includes("type_cap"));
      if (renderTypeCap) {
        lines.push(`  render_omitted type-cap observation: reasons=${renderTypeCap.reasonCodes.join(",")} details=${formatDetails(renderTypeCap.details)}`);
      }
    }
  }
  return lines.join("\n");
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
