import { RETENTION_TYPE_MAX, WORKSPACE_DORMANT_AFTER_DAYS } from "../../../src/retention.ts";
import { TYPES } from "../constants.ts";
import { formatStatus, type StatusReadout } from "../formatters/status.ts";
import { buildInspectionReadModel, disappearanceRows } from "../inspection-model.ts";
import { retentionCandidatesForDiag, retentionClockSummary, daysSinceIso } from "../retention-model.ts";
import { rejectionFalsePositiveRisk, rejectionQualitySummary } from "../rejections-model.ts";
import { isWithinDays, memoryDiagJSONFromSnapshot } from "../workspace-snapshot.ts";
import type { CliOptions, CommandResult, MemoryInspectionReadModel } from "../types.ts";

export function buildStatusReadout(model: MemoryInspectionReadModel, now = Date.now()): StatusReadout {
  const active = model.store.entries.filter(entry => entry.status !== "superseded");
  const retention = retentionCandidatesForDiag(model.store, now);
  const clocks = retentionClockSummary(active);
  const disappearances = disappearanceRows(model);
  const evidenceCovered = active.filter(entry => (model.evidenceByMemoryId.get(entry.id) ?? []).length > 0).length;
  const rejectionSummary = rejectionQualitySummary(model.rejectionRecords);
  const falsePositiveRisk = rejectionFalsePositiveRisk(rejectionSummary);
  const typeCounts = Object.fromEntries(TYPES.map(type => [type, active.filter(entry => entry.type === type).length]));
  const capsFull = active.length >= model.store.limits.maxEntries || TYPES.some(type => (typeCounts[type] ?? 0) >= RETENTION_TYPE_MAX[type]);
  const unknownDisappearances = disappearances.filter(row => row.classification === "historical_absent_unknown_reason").length;
  const status = unknownDisappearances > 0 || clocks.invalid > 0
    ? "degraded"
    : capsFull || rejectionSummary.legacyUnscopedCount > 0 || falsePositiveRisk === "high"
      ? "warning"
      : "ok";
  const rejectedLast7Days = model.evidenceEvents.filter(event => event.outcome === "rejected" && isWithinDays(event.createdAt, 7, now)).length;
  const evidenceCoveragePercent = active.length === 0 ? 100 : Math.round((evidenceCovered / active.length) * 100);
  const needsAttention: string[] = [];
  if (clocks.invalid > 0) needsAttention.push(`${clocks.invalid} invalid retention clocks`);
  if (unknownDisappearances > 0) needsAttention.push(`${unknownDisappearances} memories disappeared without terminal evidence`);
  if (capsFull) needsAttention.push("memory store is at or over retention caps");
  if (rejectionSummary.legacyUnscopedCount > 0) needsAttention.push(`${rejectionSummary.legacyUnscopedCount} legacy unscoped rejection records`);
  if (falsePositiveRisk === "high") needsAttention.push("possible rejection false-positive risk is high");
  const suggestedNextSteps: string[] = [];
  if (clocks.invalid > 0 || unknownDisappearances > 0) suggestedNextSteps.push("Run memory-diag missing --verbose to inspect missing-memory evidence.");
  if (capsFull) suggestedNextSteps.push("Run memory-diag explain to see which memories are hidden by caps.");
  if (rejectionSummary.legacyUnscopedCount > 0 || falsePositiveRisk === "high") suggestedNextSteps.push("Run memory-diag rejected --verbose to inspect rejection quality.");
  const wallDaysSinceActivity = daysSinceIso(model.store.lastActivityAt, now);
  const dormantDiscountActive = wallDaysSinceActivity !== null && wallDaysSinceActivity > WORKSPACE_DORMANT_AFTER_DAYS;
  const dormantDaysPastGrace = wallDaysSinceActivity === null ? 0 : Math.max(0, wallDaysSinceActivity - WORKSPACE_DORMANT_AFTER_DAYS);

  return {
    status,
    summaryText: `Summary: Workspace memory quality is ${status}: ${active.length} active memories, ${evidenceCovered}/${active.length} with evidence, ${disappearances.length} evidence-only disappearances (${unknownDisappearances} unknown), ${clocks.invalid} invalid retention clocks, and ${rejectionSummary.legacyUnscopedCount} legacy unscoped rejection records.`,
    active: active.length,
    rendered: retention.rendered.length,
    pending: model.pending.entries.length,
    rejectedLast7Days,
    evidenceCoveragePercent,
    needsAttention,
    suggestedNextSteps,
    caps: {
      active: active.length,
      maxEntries: model.store.limits.maxEntries,
      rendered: retention.rendered.length,
      typeCapped: retention.typeCapped.length,
      globalCapped: retention.globalCapped.length,
      typeCounts,
      capsFull,
    },
    retention: clocks,
    evidence: {
      currentWithEvidence: evidenceCovered,
      currentWithoutEvidence: active.length - evidenceCovered,
      evidenceMemoryIds: model.evidenceByMemoryId.size,
      disappearances: disappearances.length,
      unknownDisappearances,
      withTerminalReason: disappearances.length - unknownDisappearances,
    },
    rejections: { ...rejectionSummary, falsePositiveRisk },
    dormant: {
      lastActivityAt: model.store.lastActivityAt,
      wallDaysSinceActivity,
      dormantDiscountActive,
      dormantDaysPastGrace,
    },
    topRendered: retention.rendered.slice(0, 5),
    weakestActive: retention.sorted.slice(-5).reverse(),
  };
}

export async function runStatus(options: CliOptions): Promise<CommandResult> {
  const now = Date.now();
  const model = await buildInspectionReadModel(options);
  const readout = buildStatusReadout(model, now);

  if (options.json) {
    const root = options.workspace ?? process.cwd();
    const diag = memoryDiagJSONFromSnapshot(root, model.snapshot);
    return {
      stdout: JSON.stringify({
        ...diag,
        summary: {
          ...diag.summary,
          status: readout.status,
          evidenceCoveragePercent: readout.evidenceCoveragePercent,
          needsAttention: readout.needsAttention,
          suggestedNextSteps: readout.suggestedNextSteps,
        },
      }, null, 2),
    };
  }

  return {
    stdout: formatStatus(readout, model, {
      verbose: options.verbose,
      noEmoji: options.noEmoji,
      isTty: process.stdout.isTTY === true,
      raw: options.raw,
    }),
  };
}
