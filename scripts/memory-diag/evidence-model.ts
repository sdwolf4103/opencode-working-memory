import type { EvidenceEventV1 } from "../../src/evidence-log.ts";
import { uniqueStrings } from "./text.ts";

export function eventMemoryIds(event: EvidenceEventV1): string[] {
  return uniqueStrings([
    event.memory?.memoryId ?? "",
    ...(event.relations ?? []).map(relation => relation.memory?.memoryId ?? ""),
  ]);
}

export function groupEvidenceByMemoryId(events: EvidenceEventV1[]): Map<string, EvidenceEventV1[]> {
  const grouped = new Map<string, EvidenceEventV1[]>();
  for (const event of events) {
    for (const id of eventMemoryIds(event)) {
      const bucket = grouped.get(id) ?? [];
      bucket.push(event);
      grouped.set(id, bucket);
    }
  }
  return grouped;
}