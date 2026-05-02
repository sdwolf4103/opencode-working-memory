import { RETENTION_TYPE_MAX } from "../../../src/retention.ts";
import { TYPES } from "../constants.ts";
import { disappearanceRows } from "../inspection-model.ts";
import { retentionCandidatesForDiag, retentionClockSummary } from "../retention-model.ts";
import { rejectionFalsePositiveRisk, rejectionQualitySummary } from "../rejections-model.ts";
import type { MemoryInspectionReadModel } from "../types.ts";

export function buildQualityJSON(model: MemoryInspectionReadModel, generatedAt = new Date().toISOString(), now = new Date(generatedAt).getTime()): Record<string, unknown> {
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
  const summaryText = `Summary: Workspace memory quality is ${status}: ${active.length} active memories, ${evidenceCovered}/${active.length} with evidence, ${disappearances.length} evidence-only disappearances (${unknownDisappearances} unknown), ${clocks.invalid} invalid retention clocks, and ${rejectionSummary.legacyUnscopedCount} legacy unscoped rejection records.`;
  const caps = {
    active: active.length,
    maxEntries: model.store.limits.maxEntries,
    rendered: retention.rendered.length,
    typeCapped: retention.typeCapped.length,
    globalCapped: retention.globalCapped.length,
    typeCounts,
    capsFull,
  };
  const evidence = {
    currentWithEvidence: evidenceCovered,
    currentWithoutEvidence: active.length - evidenceCovered,
    evidenceMemoryIds: model.evidenceByMemoryId.size,
    disappearances: disappearances.length,
    unknownDisappearances,
    withTerminalReason: disappearances.length - unknownDisappearances,
  };

  return {
    version: 1,
    generatedAt,
    status,
    summaryText,
    store: { active: active.length, pending: model.pending.entries.length, superseded: model.store.entries.length - active.length },
    caps,
    retention: clocks,
    evidence,
    rejections: { ...rejectionSummary, falsePositiveRisk },
  };
}

export function formatQuality(model: MemoryInspectionReadModel, now: number): string {
  const data = buildQualityJSON(model, new Date(now).toISOString(), now) as {
    summaryText: string;
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
    };
    rejections: {
      totalRecords: number;
      workspaceScopedCount: number;
      legacyUnscopedCount: number;
      falsePositiveRisk: string;
    };
  };
  const lines: string[] = [];
  lines.push("Memory quality inspection");
  lines.push("");
  lines.push(data.summaryText);
  lines.push("");
  lines.push("Caps:");
  lines.push(`  active: ${data.caps.active} / ${data.caps.maxEntries}`);
  for (const type of TYPES) {
    const count = data.caps.typeCounts[type] ?? 0;
    const limit = RETENTION_TYPE_MAX[type];
    const marker = count >= limit ? " FULL" : "";
    lines.push(`  ${type}: ${count} / ${limit}${marker}`);
  }
  lines.push(`  rendered: ${data.caps.rendered}`);
  lines.push(`  type-capped entries: ${data.caps.typeCapped}`);
  lines.push(`  global-cap overflow: ${data.caps.globalCapped}`);
  lines.push(`  caps full: ${data.caps.capsFull ? "yes" : "no"}`);
  lines.push("");
  lines.push("Retention clocks:");
  lines.push(`  present: ${data.retention.present}`);
  lines.push(`  missing: ${data.retention.missing}`);
  lines.push(`  invalid: ${data.retention.invalid}`);
  lines.push("");
  lines.push("Evidence:");
  lines.push(`  current with evidence: ${data.evidence.currentWithEvidence}`);
  lines.push(`  current without evidence: ${data.evidence.currentWithoutEvidence}`);
  lines.push(`  evidence memory ids: ${data.evidence.evidenceMemoryIds}`);
  lines.push(`  disappearances: ${data.evidence.disappearances}`);
  lines.push(`  unknown disappearances: ${data.evidence.unknownDisappearances}`);
  lines.push("");
  lines.push("Rejection scoping:");
  lines.push(`  total records: ${data.rejections.totalRecords}`);
  lines.push(`  workspace scoped: ${data.rejections.workspaceScopedCount}`);
  lines.push(`  legacy unscoped: ${data.rejections.legacyUnscopedCount}`);
  lines.push(`  false-positive risk: ${data.rejections.falsePositiveRisk}`);
  return lines.join("\n");
}
