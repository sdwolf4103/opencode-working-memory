import type { EvidenceEventV1 } from "../../../src/evidence-log.ts";
import { formatStrength } from "../retention-model.ts";
import type { WorkspaceDiagSnapshot } from "../types.ts";

export function formatEvidenceRefs(eventIds: string[], allEvents: EvidenceEventV1[]): string {
  if (eventIds.length === 0) return "(none)";
  const byId = new Map(allEvents.map(event => [event.eventId, event]));
  return eventIds
    .map(id => {
      const event = byId.get(id);
      return event ? `${event.eventId} ${event.type}` : id;
    })
    .join(", ");
}

export function formatExplain(snapshot: WorkspaceDiagSnapshot): string {
  const lines: string[] = [];
  lines.push("Workspace memory explainability");
  lines.push("");

  if (snapshot.memories.length === 0) {
    lines.push("No memories found.");
  }

  for (const memory of snapshot.memories) {
    lines.push(`Memory ${memory.id}: ${memory.status}`);
    const strength = typeof memory.strength === "number" ? formatStrength(memory.strength) : "n/a";
    lines.push(`- strength=${strength}, type=${memory.type}, source=${memory.source}`);
    lines.push(`- reasons: ${memory.reasonCodes.length > 0 ? memory.reasonCodes.join(", ") : "(none)"}`);
    lines.push(`- evidence: ${formatEvidenceRefs(memory.evidenceEventIds, snapshot.allEvents)}`);
    lines.push("");
  }

  const quarantines = snapshot.recentEvents.filter(event => event.type === "storage_corrupt_json_quarantined");
  if (quarantines.length > 0) {
    lines.push("Quarantined stores:");
    for (const event of quarantines) {
      lines.push(`- quarantined_corrupt_store: ${event.eventId} ${event.type}; reasons=${event.reasonCodes.join(",")}`);
    }
  }
  return lines.join("\n");
}
