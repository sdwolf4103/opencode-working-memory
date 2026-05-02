import type { EvidenceEventV1 } from "../../src/evidence-log.ts";
import type { LongTermType } from "../../src/types.ts";
import { countBy, objectFromCounts, uniqueStrings } from "./text.ts";
import { groupEvidenceByMemoryId } from "./evidence-model.ts";
import { loadRejectionRecords } from "./rejections-model.ts";
import { snapshotForOptions } from "./workspace-snapshot.ts";
import type { CliOptions, CoverageClass, DisappearanceReason, MemoryInspectionReadModel } from "./types.ts";

export async function buildInspectionReadModel(options: CliOptions): Promise<MemoryInspectionReadModel> {
  const snapshot = await snapshotForOptions(options);
  const rejections = await loadRejectionRecords(options);
  return {
    snapshot,
    store: snapshot.store,
    pending: snapshot.journal,
    evidenceEvents: snapshot.allEvents,
    rejectionRecords: rejections.records,
    currentById: new Map(snapshot.store.entries.map(entry => [entry.id, entry])),
    evidenceByMemoryId: groupEvidenceByMemoryId(snapshot.allEvents),
  };
}

export function terminalDisappearanceReason(events: EvidenceEventV1[]): DisappearanceReason {
  const terminal = [...events].reverse().find(event =>
    event.type === "memory_removed_capacity"
      || event.type === "promotion_absorbed_exact"
      || event.type === "promotion_absorbed_identity"
      || event.type === "promotion_superseded"
  );
  const renderOmission = [...events].reverse().find(event => event.type === "render_omitted");
  const event = terminal ?? renderOmission;
  if (!event) {
    return { classification: "historical_absent_unknown_reason", terminalType: "unknown", reasonCodes: [] };
  }
  return {
    classification: "historical_absent_with_reason",
    terminalType: event.type,
    reasonCodes: event.reasonCodes,
    event,
  };
}

export function coverageClassForMemory(id: string, model: MemoryInspectionReadModel): CoverageClass {
  const events = model.evidenceByMemoryId.get(id) ?? [];
  if (!model.currentById.has(id)) return terminalDisappearanceReason(events).classification;
  if (events.length === 0) return "no_evidence";
  if (events.every(event => event.phase === "render")) return "render_only";
  return "full_lifecycle";
}

export function eventCounts(events: EvidenceEventV1[]): { total: number; byType: Record<string, number>; byPhase: Record<string, number> } {
  return {
    total: events.length,
    byType: objectFromCounts(countBy(events.map(event => event.type))),
    byPhase: objectFromCounts(countBy(events.map(event => event.phase))),
  };
}

export function coverageRows(model: MemoryInspectionReadModel, includeHistorical: boolean): Array<{
  id: string;
  class: CoverageClass;
  current: boolean;
  type?: LongTermType;
  eventCounts: ReturnType<typeof eventCounts>;
}> {
  const ids = new Set<string>(model.currentById.keys());
  if (includeHistorical) {
    for (const id of model.evidenceByMemoryId.keys()) ids.add(id);
  }
  return [...ids].sort().map(id => {
    const entry = model.currentById.get(id);
    const events = model.evidenceByMemoryId.get(id) ?? [];
    return {
      id,
      class: coverageClassForMemory(id, model),
      current: Boolean(entry),
      type: entry?.type ?? events.find(event => event.memory?.memoryId === id)?.memory?.type,
      eventCounts: eventCounts(events),
    };
  });
}

export function disappearanceRows(model: MemoryInspectionReadModel): Array<{
  id: string;
  classification: DisappearanceReason["classification"];
  terminalType: DisappearanceReason["terminalType"];
  reasonCodes: string[];
  event?: EvidenceEventV1;
  events: EvidenceEventV1[];
}> {
  const rows = [...model.evidenceByMemoryId.entries()]
    .filter(([id]) => !model.currentById.has(id))
    .map(([id, events]) => {
      const reason = terminalDisappearanceReason(events);
      return { id, ...reason, events };
    });
  return rows.sort((a, b) => a.classification.localeCompare(b.classification) || a.id.localeCompare(b.id));
}
