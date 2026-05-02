import type { EvidenceEventV1 } from "../../../src/evidence-log.ts";
import { formatTraceEvent, relationMemoryIds, statusFromTraceEvent } from "../trace-model.ts";
import type { WorkspaceDiagSnapshot } from "../types.ts";

export function formatTrace(memoryId: string, snapshot: WorkspaceDiagSnapshot, trace: { events: EvidenceEventV1[] }): string {
  const lines: string[] = [];
  const memoryRow = snapshot.memories.find(memory => memory.id === memoryId);
  const status = memoryRow?.status ?? statusFromTraceEvent(trace.events.at(-1));

  lines.push(`Memory ${memoryId}: ${status}`);
  lines.push("");
  lines.push("Lifecycle:");
  if (trace.events.length === 0) {
    lines.push("(none)");
    return lines.join("\n");
  }

  for (const event of trace.events) {
    lines.push(formatTraceEvent(event));
  }

  const supersededBy = relationMemoryIds(trace.events, "superseded_by");
  if (supersededBy.length > 0) {
    lines.push("");
    lines.push("Superseded by:");
    for (const id of supersededBy) lines.push(`- ${id}`);
  }

  const reinforcedBy = relationMemoryIds(trace.events, "reinforced_by");
  if (reinforcedBy.length > 0) {
    lines.push("");
    lines.push("Reinforced by:");
    for (const id of reinforcedBy) lines.push(`- ${id}`);
  }
  return lines.join("\n");
}
