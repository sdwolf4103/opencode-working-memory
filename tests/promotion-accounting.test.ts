import test from "node:test";
import assert from "node:assert/strict";
import type { LongTermMemoryEntry } from "../src/types.ts";
import { accountPendingPromotions } from "../src/promotion-accounting.ts";
import { memoryKey } from "../src/pending-journal.ts";

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

test("accountPendingPromotions marks same-topic decision represented after normalization as absorbed", () => {
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
  assert.deepEqual([...result.absorbedKeys], [memoryKey(pending[0])]);
  assert.equal(result.rejectedKeys.size, 0);
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
