import type { LongTermMemoryEntry } from "./types.ts";
import { memoryKey } from "./pending-journal.ts";
import { workspaceMemoryIdentityKey } from "./workspace-memory.ts";

export type PendingPromotionAccounting = {
  promotedKeys: Set<string>;
  absorbedKeys: Set<string>;
  rejectedKeys: Set<string>;
  clearableKeys: Set<string>;
};

export function accountPendingPromotions(input: {
  pending: LongTermMemoryEntry[];
  before: LongTermMemoryEntry[];
  after: LongTermMemoryEntry[];
}): PendingPromotionAccounting {
  const beforeExactKeys = new Set(input.before.map(entry => memoryKey(entry)));
  const afterExactKeys = new Set(input.after.map(entry => memoryKey(entry)));
  const afterIdentityKeys = new Set(input.after.map(entry => workspaceMemoryIdentityKey(entry)));

  const promotedKeys = new Set<string>();
  const absorbedKeys = new Set<string>();
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

    if (afterIdentityKeys.has(identityKey)) {
      absorbedKeys.add(key);
      continue;
    }

    rejectedKeys.add(key);
  }

  return {
    promotedKeys,
    absorbedKeys,
    rejectedKeys,
    clearableKeys: new Set([...promotedKeys, ...absorbedKeys]),
  };
}
