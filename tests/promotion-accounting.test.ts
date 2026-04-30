import test from "node:test";
import assert from "node:assert/strict";
import type { LongTermMemoryEntry } from "../src/types.ts";
import { accountPendingPromotions, promotionAccountingEvidenceEvents } from "../src/promotion-accounting.ts";
import { memoryKey } from "../src/pending-journal.ts";
import type { MemoryConsolidationEvent } from "../src/workspace-memory.ts";
import { workspaceMemoryExactKey, workspaceMemoryIdentityKey } from "../src/workspace-memory.ts";

function mem(
  id: string,
  text: string,
  opts: Partial<LongTermMemoryEntry> = {},
): LongTermMemoryEntry {
  const now = opts.createdAt ?? new Date().toISOString();
  return {
    id,
    type: opts.type ?? "decision",
    text,
    source: opts.source ?? "compaction",
    confidence: opts.confidence ?? 0.75,
    status: opts.status ?? "active",
    createdAt: now,
    updatedAt: opts.updatedAt ?? now,
    staleAfterDays: opts.staleAfterDays,
    rationale: opts.rationale,
    supersedes: opts.supersedes,
    tags: opts.tags,
  };
}

function event(
  memory: LongTermMemoryEntry,
  reason: MemoryConsolidationEvent["reason"],
): MemoryConsolidationEvent {
  return {
    memoryKey: workspaceMemoryExactKey(memory),
    identityKey: workspaceMemoryIdentityKey(memory),
    memory,
    reason,
  };
}

test("accountPendingPromotions marks exact retained pending memory as promoted", () => {
  const pending = [mem("pending", "Use frozen rendered snapshots for cache stability.")];
  const before: LongTermMemoryEntry[] = [];
  const after = [pending[0]];

  const result = accountPendingPromotions({ pending, before, after });

  assert.deepEqual([...result.promotedKeys], [memoryKey(pending[0])]);
  assert.equal(result.absorbedKeys.size, 0);
  assert.equal(result.rejectedKeys.size, 0);
  assert.deepEqual([...result.clearableKeys], [memoryKey(pending[0])]);
});

test("accountPendingPromotions marks exact duplicate already represented before promotion as absorbed", () => {
  const existing = mem("existing", "Prefer stable cache boundaries.", { source: "explicit" });
  const pending = [mem("pending", "prefer stable cache boundaries.", { source: "explicit" })];
  const before = [existing];
  const after = [existing];

  const result = accountPendingPromotions({ pending, before, after });

  assert.equal(result.promotedKeys.size, 0);
  assert.deepEqual([...result.absorbedKeys], [memoryKey(pending[0])]);
  assert.equal(result.rejectedKeys.size, 0);
  assert.deepEqual([...result.clearableKeys], [memoryKey(pending[0])]);
});

test("accountPendingPromotions marks same exact key present before promotion as absorbed, not promoted", () => {
  const existing = mem("existing", "Use stable cache boundaries.", { source: "explicit" });
  const pending = [mem("pending", "Use stable cache boundaries.", { source: "explicit" })];
  const before = [existing];
  const after = [existing];

  const result = accountPendingPromotions({ pending, before, after });

  assert.equal(result.promotedKeys.size, 0,
    "a pending memory whose exact key already existed before promotion is absorbed, not newly promoted");
  assert.deepEqual([...result.absorbedKeys], [memoryKey(pending[0])]);
  assert.equal(result.rejectedKeys.size, 0);
});

test("accountPendingPromotions ignores superseded exact keys when detecting existing absorption", () => {
  const superseded = mem("superseded", "Revive this memory when it is remembered again.", {
    source: "explicit",
    status: "superseded",
  });
  const pending = [mem("pending", "Revive this memory when it is remembered again.", {
    source: "explicit",
  })];
  const before = [superseded];
  const after = [superseded, pending[0]];

  const result = accountPendingPromotions({ pending, before, after });

  assert.deepEqual([...result.promotedKeys], [memoryKey(pending[0])]);
  assert.equal(result.absorbedKeys.size, 0);
  assert.deepEqual([...result.clearableKeys], [memoryKey(pending[0])]);
});

test("accountPendingPromotions does not absorb same-topic decision without exact match", () => {
  const existing = mem("existing", "Parser supports 2 candidate formats.", {
    type: "decision",
    source: "compaction",
    confidence: 0.9,
    createdAt: "2026-04-27T10:00:00.000Z",
    updatedAt: "2026-04-27T10:00:00.000Z",
  });
  const pending = [mem("pending", "Parser supports 3 candidate formats.", {
    type: "decision",
    source: "compaction",
    confidence: 0.75,
    createdAt: "2026-04-27T09:00:00.000Z",
    updatedAt: "2026-04-27T09:00:00.000Z",
  })];
  const before = [existing];
  const after = [existing];

  const result = accountPendingPromotions({ pending, before, after });

  assert.equal(result.promotedKeys.size, 0);
  assert.equal(result.absorbedKeys.size, 0);
  assert.deepEqual([...result.rejectedKeys], [memoryKey(pending[0])]);
});

test("accountPendingPromotions keeps pending memory rejected when no equivalent survived", () => {
  const pending = [mem("pending", "Low priority memory that did not fit the workspace cap.", {
    type: "reference",
    source: "compaction",
  })];
  const before: LongTermMemoryEntry[] = [];
  const after: LongTermMemoryEntry[] = [];

  const result = accountPendingPromotions({ pending, before, after });

  assert.equal(result.promotedKeys.size, 0);
  assert.equal(result.absorbedKeys.size, 0);
  assert.deepEqual([...result.rejectedKeys], [memoryKey(pending[0])]);
  assert.equal(result.clearableKeys.size, 0);
});

test("accountPendingPromotions clears accounting absorbed identity events", () => {
  const pending = [mem("pending_identity", "This repo uses opencode-agenthub plugin system", {
    type: "project",
    source: "compaction",
  })];

  const result = accountPendingPromotions({
    pending,
    before: [],
    after: [],
    events: [event(pending[0], "absorbed_identity")],
  });

  assert.deepEqual([...result.absorbedKeys], [memoryKey(pending[0])]);
  assert.deepEqual([...result.clearableKeys], [memoryKey(pending[0])]);
  assert.equal(result.rejectedKeys.size, 0);
});

test("accountPendingPromotions separates accounting superseded events", () => {
  const pending = [mem("pending_topic", "Parser supports 3 candidate formats.", {
    type: "decision",
    source: "compaction",
  })];

  const result = accountPendingPromotions({
    pending,
    before: [],
    after: [],
    events: [event(pending[0], "superseded_existing")],
  });

  assert.deepEqual([...result.supersededKeys], [memoryKey(pending[0])]);
  assert.deepEqual([...result.clearableKeys], [memoryKey(pending[0])]);
  assert.equal(result.absorbedKeys.size, 0);
  assert.equal(result.rejectedKeys.size, 0);
});

test("accountPendingPromotions clears compaction capacity rejection from accounting", () => {
  const pending = [mem("pending_capacity", "Weak compaction reference that should lose capacity review.", {
    type: "reference",
    source: "compaction",
  })];

  const result = accountPendingPromotions({
    pending,
    before: [],
    after: [],
    events: [event(pending[0], "rejected_capacity")],
  });

  assert.deepEqual([...result.rejectedKeys], [memoryKey(pending[0])]);
  assert.deepEqual([...result.clearableKeys], [memoryKey(pending[0])]);
});

test("accountPendingPromotions keeps explicit capacity rejection pending", () => {
  const pending = [mem("pending_explicit_capacity", "Explicit reference should retry if capacity rejected.", {
    type: "reference",
    source: "explicit",
  })];

  const result = accountPendingPromotions({
    pending,
    before: [],
    after: [],
    events: [event(pending[0], "rejected_capacity")],
  });

  assert.deepEqual([...result.rejectedKeys], [memoryKey(pending[0])]);
  assert.equal(result.clearableKeys.size, 0);
  assert.deepEqual([...result.retryableRejectedKeys], [memoryKey(pending[0])]);
});

test("accountPendingPromotions marks manual capacity rejection as retryable", () => {
  const pending = [mem("pending_manual_capacity", "Manual reference should retry if capacity rejected.", {
    type: "reference",
    source: "manual",
  })];

  const result = accountPendingPromotions({
    pending,
    before: [],
    after: [],
    events: [event(pending[0], "rejected_capacity")],
  });

  assert.deepEqual([...result.rejectedKeys], [memoryKey(pending[0])]);
  assert.equal(result.clearableKeys.size, 0);
  assert.deepEqual([...result.retryableRejectedKeys], [memoryKey(pending[0])]);
});

test("promotionAccountingEvidenceEvents maps every promotion outcome with relations", () => {
  const promoted = mem("promoted", "Promoted memory should produce evidence.", { source: "explicit" });
  const absorbed = mem("absorbed", "Absorbed memory should produce evidence.", { source: "explicit" });
  const retained = mem("retained", "absorbed memory should produce evidence.", { source: "explicit" });
  const identityAbsorbed = mem("identity-absorbed", "Project config lives in `src/config.ts`", { type: "reference" });
  const identityRetained = mem("identity-retained", "Project config lives in `./src/config.ts`", { type: "reference" });
  const superseded = mem("superseded", "Parser supports 3 formats.", { source: "compaction" });
  const replacement = mem("replacement", "Parser supports 4 formats.", { source: "compaction" });
  const capacity = mem("capacity", "Capacity rejected explicit memory should retry.", { source: "explicit", type: "reference" });
  const exhausted = mem("exhausted", "Exhausted explicit memory should stop retrying.", { source: "explicit", type: "reference" });
  const pending = [promoted, absorbed, identityAbsorbed, superseded, capacity, exhausted];
  const accounting = {
    promotedKeys: new Set([memoryKey(promoted)]),
    absorbedKeys: new Set([memoryKey(absorbed), memoryKey(identityAbsorbed)]),
    supersededKeys: new Set([memoryKey(superseded)]),
    rejectedKeys: new Set([memoryKey(capacity), memoryKey(exhausted)]),
    retryableRejectedKeys: new Set([memoryKey(capacity), memoryKey(exhausted)]),
    clearableKeys: new Set([memoryKey(promoted), memoryKey(absorbed), memoryKey(identityAbsorbed), memoryKey(superseded), memoryKey(exhausted)]),
  };
  const events = [
    { ...event(absorbed, "absorbed_exact"), retainedId: retained.id },
    { ...event(identityAbsorbed, "absorbed_identity"), retainedId: identityRetained.id },
    { ...event(superseded, "superseded_existing"), retainedId: replacement.id, supersededId: superseded.id },
    event(capacity, "rejected_capacity"),
    event(exhausted, "rejected_capacity"),
  ];

  const evidence = promotionAccountingEvidenceEvents({
    pending,
    after: [promoted, retained, identityRetained, replacement],
    events,
    accounting,
    exhaustedRejectedKeys: new Set([memoryKey(exhausted)]),
  });

  const expectedPromotionEventTypes = new Set([
    "promotion_promoted",
    "promotion_absorbed_exact",
    "promotion_absorbed_identity",
    "promotion_superseded",
    "promotion_rejected_capacity",
    "promotion_retry_scheduled",
    "promotion_retry_exhausted",
  ]);

  assert.deepEqual(new Set(evidence.map(event => event.type)), expectedPromotionEventTypes);
  const absorbedEvent = evidence.find(event => event.type === "promotion_absorbed_exact");
  assert.ok(absorbedEvent?.relations?.some(relation => relation.role === "absorbed" && relation.memory?.memoryId === absorbed.id));
  assert.ok(absorbedEvent?.relations?.some(relation => relation.role === "retained" && relation.memory?.memoryId === retained.id));
  const supersededEvent = evidence.find(event => event.type === "promotion_superseded");
  assert.ok(supersededEvent?.relations?.some(relation => relation.role === "superseded" && relation.memory?.memoryId === superseded.id));
  assert.ok(supersededEvent?.relations?.some(relation => relation.role === "superseded_by" && relation.memory?.memoryId === replacement.id));
});
