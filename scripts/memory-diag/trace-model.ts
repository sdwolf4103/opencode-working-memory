import type { EvidenceEventV1 } from "../../src/evidence-log.ts";
import { uniqueStrings } from "./text.ts";
import { statusFromOmissionReason } from "./workspace-snapshot.ts";

export function statusFromTraceEvent(event: EvidenceEventV1 | undefined): string {
  if (!event) return "unknown";
  if (event.type === "render_selected") return "rendered";
  if (event.type === "render_omitted") return statusFromOmissionReason(event.reasonCodes[0]);
  if (event.type === "promotion_absorbed_exact" || event.type === "promotion_absorbed_identity") return "omitted_absorbed_duplicate";
  if (event.type === "promotion_retry_scheduled") return "pending_retry";
  if (event.type === "promotion_rejected_capacity" || event.type === "promotion_retry_exhausted") return "pending_rejected_capacity";
  if (event.type === "storage_corrupt_json_quarantined") return "quarantined_corrupt_store";
  if (event.outcome === "superseded") return "omitted_superseded";
  return event.outcome;
}

export function formatTraceEvent(event: EvidenceEventV1): string {
  const reasons = event.reasonCodes.length > 0 ? event.reasonCodes.join(",") : "none";
  const relations = (event.relations ?? [])
    .map(relation => relation.memory?.memoryId ? `${relation.role}=${relation.memory.memoryId}` : undefined)
    .filter((value): value is string => Boolean(value));
  const relationText = relations.length > 0 ? `; ${relations.join(", ")}` : "";
  return `- ${event.eventId} ${event.type}: ${event.outcome}; reasons=${reasons}${relationText}`;
}

export function relationMemoryIds(events: EvidenceEventV1[], role: string): string[] {
  return uniqueStrings(events.flatMap(event => (event.relations ?? [])
    .filter(relation => relation.role === role)
    .map(relation => relation.memory?.memoryId ?? "")));
}
