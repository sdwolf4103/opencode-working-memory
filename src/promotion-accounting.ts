import type { LongTermMemoryEntry } from "./types.ts";
import { memoryKey } from "./pending-journal.ts";
import type { MemoryConsolidationEvent } from "./workspace-memory.ts";
import { workspaceMemoryIdentityKey } from "./workspace-memory.ts";

export type PendingPromotionAccounting = {
  promotedKeys: Set<string>;
  absorbedKeys: Set<string>;
  supersededKeys: Set<string>;
  rejectedKeys: Set<string>;
  clearableKeys: Set<string>;
};

export function accountPendingPromotions(input: {
  pending: LongTermMemoryEntry[];
  before: LongTermMemoryEntry[];
  after: LongTermMemoryEntry[];
  events?: MemoryConsolidationEvent[];
}): PendingPromotionAccounting {
  const beforeActive = input.before.filter(entry => entry.status !== "superseded");
  const afterActive = input.after.filter(entry => entry.status !== "superseded");
  const beforeExactKeys = new Set(beforeActive.map(entry => memoryKey(entry)));
  const afterExactKeys = new Set(afterActive.map(entry => memoryKey(entry)));
  const afterIdentityKeys = new Set(afterActive.map(entry => workspaceMemoryIdentityKey(entry)));
  const terminalEventByKey = new Map((input.events ?? []).map(event => [event.memoryKey, event]));

  const promotedKeys = new Set<string>();
  const absorbedKeys = new Set<string>();
  const supersededKeys = new Set<string>();
  const rejectedKeys = new Set<string>();

  for (const memory of input.pending) {
    const key = memoryKey(memory);
    const identityKey = workspaceMemoryIdentityKey(memory);

    if (beforeExactKeys.has(key)) {
      absorbedKeys.add(key);
      continue;
    }

    if (afterExactKeys.has(key)) {
      promotedKeys.add(key);
      continue;
    }

    const terminal = terminalEventByKey.get(key);
    if (terminal) {
      if (
        terminal.reason === "absorbed_exact" ||
        terminal.reason === "absorbed_identity"
      ) {
        absorbedKeys.add(key);
        continue;
      }

      if (terminal.reason === "superseded_existing") {
        supersededKeys.add(key);
        continue;
      }

      if (terminal.reason === "rejected_capacity" || terminal.reason === "rejected_stale") {
        rejectedKeys.add(key);
        continue;
      }
    }

    if (afterIdentityKeys.has(identityKey)) {
      absorbedKeys.add(key);
      continue;
    }

    rejectedKeys.add(key);
  }

  return {
    promotedKeys,
    absorbedKeys,
    supersededKeys,
    rejectedKeys,
    clearableKeys: new Set([
      ...promotedKeys,
      ...absorbedKeys,
      ...supersededKeys,
      ...input.pending
        .filter(memory => {
          const terminal = terminalEventByKey.get(memoryKey(memory));
          return memory.source === "compaction" && (
            terminal?.reason === "rejected_capacity" ||
            terminal?.reason === "rejected_stale"
          );
        })
        .map(memory => memoryKey(memory)),
    ]),
  };
}
