import type { disappearanceRows } from "../inspection-model.ts";
import { eventCounts } from "../inspection-model.ts";
import { formatDetails } from "../text.ts";

export type DisappearanceRows = ReturnType<typeof disappearanceRows>;

export function buildDisappearancesJSON(rows: DisappearanceRows, options: { explain?: boolean; generatedAt?: string } = {}): Record<string, unknown> {
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

export function formatDisappearances(rows: DisappearanceRows, options: { explain?: boolean } = {}): string {
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
