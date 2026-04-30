import type { LongTermMemoryEntry } from "./types.ts";
import { memoryKey } from "./pending-journal.ts";
import type { MemoryConsolidationEvent } from "./workspace-memory.ts";
import { workspaceMemoryIdentityKey } from "./workspace-memory.ts";
import type { EvidenceEventInput, MemoryEvidenceRef } from "./evidence-log.ts";

export type PendingPromotionAccounting = {
  promotedKeys: Set<string>;
  absorbedKeys: Set<string>;
  supersededKeys: Set<string>;
  rejectedKeys: Set<string>;
  retryableRejectedKeys: Set<string>;
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

      if (terminal.reason === "rejected_capacity") {
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

  const clearableKeys = new Set([
    ...promotedKeys,
    ...absorbedKeys,
    ...supersededKeys,
    ...input.pending
      .filter(memory => {
        const terminal = terminalEventByKey.get(memoryKey(memory));
        return memory.source === "compaction" && terminal?.reason === "rejected_capacity";
      })
      .map(memory => memoryKey(memory)),
  ]);

  const retryableRejectedKeys = new Set(
    input.pending
      .filter(memory => {
        const key = memoryKey(memory);
        return rejectedKeys.has(key) &&
          !clearableKeys.has(key) &&
          (memory.source === "explicit" || memory.source === "manual");
      })
      .map(memory => memoryKey(memory)),
  );

  return {
    promotedKeys,
    absorbedKeys,
    supersededKeys,
    rejectedKeys,
    retryableRejectedKeys,
    clearableKeys,
  };
}

function memoryRef(memory: LongTermMemoryEntry | undefined): MemoryEvidenceRef | undefined {
  if (!memory) return undefined;
  return {
    memoryId: memory.id,
    memoryKeyHash: memoryKey(memory),
    identityKeyHash: workspaceMemoryIdentityKey(memory),
    type: memory.type,
    source: memory.source,
    status: memory.status,
  };
}

function retainedMemoryFor(
  pending: LongTermMemoryEntry,
  event: MemoryConsolidationEvent | undefined,
  after: LongTermMemoryEntry[],
): LongTermMemoryEntry | undefined {
  if (event?.retainedId) {
    const byId = after.find(memory => memory.id === event.retainedId);
    if (byId) return byId;
  }

  const exactKey = memoryKey(pending);
  const identityKey = workspaceMemoryIdentityKey(pending);
  return after.find(memory => memory.status !== "superseded" && (
    memoryKey(memory) === exactKey || workspaceMemoryIdentityKey(memory) === identityKey
  ));
}

function promotionEventBase(
  type: EvidenceEventInput["type"],
  outcome: EvidenceEventInput["outcome"],
  memory: LongTermMemoryEntry,
  reasonCodes: string[],
): EvidenceEventInput {
  return {
    type,
    phase: "promotion",
    outcome,
    memory: memoryRef(memory),
    reasonCodes,
    textPreview: memory.text,
  };
}

export function promotionAccountingEvidenceEvents(input: {
  pending: LongTermMemoryEntry[];
  after: LongTermMemoryEntry[];
  events?: MemoryConsolidationEvent[];
  accounting: PendingPromotionAccounting;
  exhaustedRejectedKeys?: Set<string>;
}): EvidenceEventInput[] {
  const terminalByKey = new Map((input.events ?? []).map(event => [event.memoryKey, event]));
  const exhaustedRejectedKeys = input.exhaustedRejectedKeys ?? new Set<string>();
  const evidence: EvidenceEventInput[] = [];

  for (const pending of input.pending) {
    const key = memoryKey(pending);
    const terminal = terminalByKey.get(key);
    const retained = retainedMemoryFor(pending, terminal, input.after);

    if (input.accounting.promotedKeys.has(key)) {
      evidence.push({
        ...promotionEventBase("promotion_promoted", "promoted", pending, ["new_workspace_entry"]),
        relations: [
          { role: "promoted", memory: memoryRef(retained ?? pending) },
        ],
      });
      continue;
    }

    if (input.accounting.absorbedKeys.has(key)) {
      const exact = terminal?.reason !== "absorbed_identity";
      evidence.push({
        ...promotionEventBase(
          exact ? "promotion_absorbed_exact" : "promotion_absorbed_identity",
          "absorbed",
          pending,
          [exact ? "same_exact_key" : "same_identity_key"],
        ),
        relations: [
          { role: "absorbed" as const, memory: memoryRef(pending) },
          { role: "retained" as const, memory: memoryRef(retained) },
        ].filter(relation => relation.memory),
      });
      continue;
    }

    if (input.accounting.supersededKeys.has(key)) {
      evidence.push({
        ...promotionEventBase("promotion_superseded", "superseded", pending, ["superseded_existing"]),
        relations: [
          { role: "superseded" as const, memory: memoryRef(pending) },
          { role: "superseded_by" as const, memory: memoryRef(retained) },
        ].filter(relation => relation.memory),
      });
      continue;
    }

    if (input.accounting.rejectedKeys.has(key)) {
      evidence.push(promotionEventBase("promotion_rejected_capacity", "rejected", pending, ["capacity_rejected"]));
      if (input.accounting.retryableRejectedKeys.has(key)) {
        evidence.push(promotionEventBase(
          exhaustedRejectedKeys.has(key) ? "promotion_retry_exhausted" : "promotion_retry_scheduled",
          exhaustedRejectedKeys.has(key) ? "exhausted" : "retried",
          pending,
          [exhaustedRejectedKeys.has(key) ? "max_attempts_reached" : "retryable_capacity_rejection"],
        ));
      }
    }
  }

  return evidence;
}
