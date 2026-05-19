import type { LongTermType } from "./types.ts";

// Current workspace-memory display/render order. This is intentionally a narrow
// shared constant, not a broader memory-kind policy registry.
export const MEMORY_TYPE_ORDER = ["feedback", "project", "decision", "reference"] as const satisfies readonly LongTermType[];

export function emptyMemoryTypeGroups<T>(): Record<LongTermType, T[]> {
  return {
    feedback: [],
    project: [],
    decision: [],
    reference: [],
  };
}
