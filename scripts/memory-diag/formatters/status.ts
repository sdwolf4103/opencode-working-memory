import {
  DORMANT_DECAY_MULTIPLIER,
  RETENTION_TYPE_MAX,
} from "../../../src/retention.ts";
import { TYPES } from "../constants.ts";
import { daysSinceIso, formatStrength } from "../retention-model.ts";
import { cleanText, truncate } from "../text.ts";
import type { MemoryInspectionReadModel, RetentionDiagItem } from "../types.ts";

export type MemoryStatusLevel = "ok" | "warning" | "degraded";

export type StatusReadout = {
  status: MemoryStatusLevel;
  summaryText: string;
  active: number;
  rendered: number;
  pending: number;
  rejectedLast7Days: number;
  evidenceCoveragePercent: number;
  needsAttention: string[];
  suggestedNextSteps: string[];
  caps: {
    active: number;
    maxEntries: number;
    rendered: number;
    typeCapped: number;
    globalCapped: number;
    typeCounts: Record<string, number>;
    capsFull: boolean;
  };
  retention: { present: number; missing: number; invalid: number };
  evidence: {
    currentWithEvidence: number;
    currentWithoutEvidence: number;
    evidenceMemoryIds: number;
    disappearances: number;
    unknownDisappearances: number;
    withTerminalReason: number;
  };
  rejections: {
    totalRecords: number;
    workspaceScopedCount: number;
    legacyUnscopedCount: number;
    falsePositiveRisk: string;
  };
  dormant: {
    lastActivityAt?: string;
    wallDaysSinceActivity: number | null;
    dormantDiscountActive: boolean;
    dormantDaysPastGrace: number;
  };
  topRendered: RetentionDiagItem[];
  weakestActive: RetentionDiagItem[];
};

export function formatStatus(readout: StatusReadout, model: MemoryInspectionReadModel, options: { verbose?: boolean; noEmoji?: boolean; isTty?: boolean; raw?: boolean } = {}): string {
  if (options.verbose) return formatStatusVerbose(readout, model, options);

  const lines: string[] = [];
  const label = statusLabel(readout.status, options);
  lines.push(`${label} Memory status`);
  lines.push("");
  lines.push("Key metrics:");
  lines.push(`  active memories: ${readout.active}`);
  lines.push(`  rendered: ${readout.rendered}`);
  lines.push(`  pending: ${readout.pending}`);
  lines.push(`  rejected 7d: ${readout.rejectedLast7Days}`);
  lines.push(`  evidence coverage: ${readout.evidenceCoveragePercent}%`);

  if (readout.needsAttention.length > 0) {
    lines.push("");
    lines.push("Needs attention:");
    for (const item of readout.needsAttention) lines.push(`  - ${item}`);
  }

  if (readout.status !== "ok" && readout.suggestedNextSteps.length > 0) {
    lines.push("");
    lines.push("Suggested next steps:");
    for (const item of readout.suggestedNextSteps) lines.push(`  - ${item}`);
  }

  return lines.join("\n");
}

function statusLabel(status: MemoryStatusLevel, options: { noEmoji?: boolean; isTty?: boolean }): string {
  const text = status === "ok" ? "OK" : status === "warning" ? "WARNING" : "DEGRADED";
  if (options.noEmoji || !options.isTty) return text;
  const emoji = status === "ok" ? "🧠" : status === "warning" ? "⚠️" : "✖️";
  return `${emoji} ${text}`;
}

function formatStatusVerbose(readout: StatusReadout, model: MemoryInspectionReadModel, options: { raw?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push("Memory status inspection");
  lines.push("");
  lines.push(readout.summaryText);
  lines.push("");
  lines.push("Caps:");
  lines.push(`  active: ${readout.caps.active} / ${readout.caps.maxEntries}`);
  for (const type of TYPES) {
    const count = readout.caps.typeCounts[type] ?? 0;
    const limit = RETENTION_TYPE_MAX[type];
    const marker = count >= limit ? " FULL" : "";
    lines.push(`  ${type}: ${count} / ${limit}${marker}`);
  }
  lines.push(`  rendered: ${readout.caps.rendered}`);
  lines.push(`  type-capped entries: ${readout.caps.typeCapped}`);
  lines.push(`  global-cap overflow: ${readout.caps.globalCapped}`);
  lines.push(`  caps full: ${readout.caps.capsFull ? "yes" : "no"}`);
  lines.push("");
  lines.push("Retention clocks:");
  lines.push(`  present: ${readout.retention.present}`);
  lines.push(`  missing: ${readout.retention.missing}`);
  lines.push(`  invalid: ${readout.retention.invalid}`);
  lines.push("");
  lines.push("Evidence:");
  lines.push(`  current with evidence: ${readout.evidence.currentWithEvidence}`);
  lines.push(`  current without evidence: ${readout.evidence.currentWithoutEvidence}`);
  lines.push(`  evidence memory ids: ${readout.evidence.evidenceMemoryIds}`);
  lines.push(`  disappearances: ${readout.evidence.disappearances}`);
  lines.push(`  unknown disappearances: ${readout.evidence.unknownDisappearances}`);
  lines.push("");
  lines.push("Rejection scoping:");
  lines.push(`  total records: ${readout.rejections.totalRecords}`);
  lines.push(`  workspace scoped: ${readout.rejections.workspaceScopedCount}`);
  lines.push(`  legacy unscoped: ${readout.rejections.legacyUnscopedCount}`);
  lines.push(`  false-positive risk: ${readout.rejections.falsePositiveRisk}`);
  lines.push("");
  lines.push("Dormancy:");
  lines.push(`  lastActivityAt: ${readout.dormant.lastActivityAt ?? "(missing)"}`);
  lines.push(`  wall days since activity: ${readout.dormant.wallDaysSinceActivity === null ? "unknown" : readout.dormant.wallDaysSinceActivity.toFixed(1)}`);
  lines.push(`  dormant discount active: ${readout.dormant.dormantDiscountActive ? "yes" : "no"}`);
  lines.push(`  dormant days past grace: ${readout.dormant.dormantDaysPastGrace.toFixed(1)}`);
  lines.push(`  dormant multiplier: ${DORMANT_DECAY_MULTIPLIER}`);
  lines.push("");
  lines.push("Top rendered candidates:");
  pushMemoryItems(lines, readout.topRendered, options.raw === true);
  lines.push("");
  lines.push("Weakest active memories:");
  pushMemoryItems(lines, readout.weakestActive, options.raw === true);
  lines.push("");
  lines.push("Store:");
  lines.push(`  superseded: ${model.store.entries.length - readout.active}`);
  return lines.join("\n");
}

function pushMemoryItems(lines: string[], items: RetentionDiagItem[], raw: boolean): void {
  if (items.length === 0) {
    lines.push("  (none)");
    return;
  }
  for (const item of items) {
    lines.push(`  - strength=${formatStrength(item.strength)} [${item.entry.type}] ${truncate(cleanText(item.entry.text, raw))}`);
  }
}
