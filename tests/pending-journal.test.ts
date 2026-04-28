/**
 * Pending journal retention tests.
 *
 * Tests for max entries cap, TTL pruning, and dedupe behavior.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp as fsMkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadPendingJournal,
  savePendingJournal,
  appendPendingMemories,
  clearPendingMemories,
  recordPromotionRejections,
  memoryKey,
  PENDING_JOURNAL_LIMITS,
} from "../src/pending-journal.ts";
import type { LongTermMemoryEntry } from "../src/types.ts";
import { PROMOTION_RETRY_LIMITS } from "../src/types.ts";

describe("pending journal retention", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(await mkdtemp(), "test-workspace");
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("savePendingJournal prunes entries older than 30 days", async () => {
    const now = new Date();
    const staleDate = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    const freshDate = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

    const entries: LongTermMemoryEntry[] = [
      {
        type: "decision",
        text: "stale entry from 31 days ago",
        source: "compaction",
        createdAt: staleDate.toISOString(),
        updatedAt: staleDate.toISOString(),
      },
      {
        type: "decision",
        text: "fresh entry from yesterday",
        source: "compaction",
        createdAt: freshDate.toISOString(),
        updatedAt: freshDate.toISOString(),
      },
    ];

    await savePendingJournal(testDir, {
      version: 1,
      workspace: { root: testDir, key: "test" },
      entries,
      updatedAt: now.toISOString(),
    });

    const loaded = await loadPendingJournal(testDir);
    
    assert.strictEqual(loaded.entries.length, 1, "Should have 1 entry after pruning stale");
    assert.strictEqual(loaded.entries[0].text, "fresh entry from yesterday");
  });

  it("savePendingJournal caps entries at 50 newest entries", async () => {
    const now = Date.now();
    const entries: LongTermMemoryEntry[] = [];

    // Create 55 entries with distinct timestamps
    for (let i = 0; i < 55; i++) {
      const timestamp = new Date(now + i * 1000).toISOString();
      entries.push({
        type: "project",
        text: `Entry ${i}`,
        source: "compaction",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    await savePendingJournal(testDir, {
      version: 1,
      workspace: { root: testDir, key: "test" },
      entries,
      updatedAt: new Date().toISOString(),
    });

    const loaded = await loadPendingJournal(testDir);

    assert.strictEqual(
      loaded.entries.length,
      PENDING_JOURNAL_LIMITS.maxEntries,
      `Should have ${PENDING_JOURNAL_LIMITS.maxEntries} entries after cap`
    );

    // Oldest 5 (entries 0-4) should be removed
    const texts = loaded.entries.map(e => e.text);
    assert(!texts.includes("Entry 0"), "Entry 0 (oldest) should be removed");
    assert(!texts.includes("Entry 4"), "Entry 4 should be removed");
    
    // Newest 5 (entries 50-54) should be kept
    assert(texts.includes("Entry 50"), "Entry 50 should be kept");
    assert(texts.includes("Entry 54"), "Entry 54 (newest) should be kept");
  });

  it("savePendingJournal dedupes before applying cap", async () => {
    const now = Date.now();
    const entries: LongTermMemoryEntry[] = [];

    // Create duplicates + unique entries to exceed cap
    for (let i = 0; i < 25; i++) {
      const timestamp = new Date(now + i * 1000).toISOString();
      // Add duplicate for each entry
      entries.push({
        type: "project",
        text: `Entry ${i}`,
        source: "compaction",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      entries.push({
        type: "project",
        text: `Entry ${i}`, // Duplicate
        source: "explicit",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    // Total: 50 entries (25 pairs of duplicates)
    assert.strictEqual(entries.length, 50);

    await savePendingJournal(testDir, {
      version: 1,
      workspace: { root: testDir, key: "test" },
      entries,
      updatedAt: new Date().toISOString(),
    });

    const loaded = await loadPendingJournal(testDir);

    // After dedup: 25 unique entries, all should fit within cap
    assert.strictEqual(
      loaded.entries.length,
      25,
      "Should have 25 unique entries after dedup"
    );
  });

  it("appendPendingMemories also applies retention", async () => {
    // Start with some entries
    const entries: LongTermMemoryEntry[] = [];
    for (let i = 0; i < 30; i++) {
      entries.push({
        type: "project",
        text: `Initial ${i}`,
        source: "compaction",
        createdAt: new Date(Date.now() + i * 1000).toISOString(),
        updatedAt: new Date(Date.now() + i * 1000).toISOString(),
      });
    }

    await savePendingJournal(testDir, {
      version: 1,
      workspace: { root: testDir, key: "test" },
      entries,
      updatedAt: new Date().toISOString(),
    });

    // Append more entries to exceed cap
    const additional: LongTermMemoryEntry[] = [];
    for (let i = 0; i < 30; i++) {
      additional.push({
        type: "decision",
        text: `Additional ${i}`,
        source: "explicit",
        createdAt: new Date(Date.now() + (i + 30) * 1000).toISOString(),
        updatedAt: new Date(Date.now() + (i + 30) * 1000).toISOString(),
      });
    }

    await appendPendingMemories(testDir, additional);

    const loaded = await loadPendingJournal(testDir);

    // 30 initial + 30 additional = 60, but cap is 50
    assert.strictEqual(
      loaded.entries.length,
      PENDING_JOURNAL_LIMITS.maxEntries,
      `Should have ${PENDING_JOURNAL_LIMITS.maxEntries} entries after appending`
    );
  });

  it("retains old explicit and manual pending entries while under cap", async () => {
    const now = new Date();
    const staleDate = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);

    const entries: LongTermMemoryEntry[] = [
      {
        id: "explicit_old",
        type: "feedback",
        text: "Old explicit preference",
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: staleDate.toISOString(),
        updatedAt: staleDate.toISOString(),
      },
      {
        id: "manual_old",
        type: "reference",
        text: "Old manual reference",
        source: "manual",
        confidence: 1,
        status: "active",
        createdAt: staleDate.toISOString(),
        updatedAt: staleDate.toISOString(),
      },
      {
        id: "compaction_old",
        type: "reference",
        text: "Old compaction reference",
        source: "compaction",
        confidence: 0.75,
        status: "active",
        createdAt: staleDate.toISOString(),
        updatedAt: staleDate.toISOString(),
      },
    ];

    await savePendingJournal(testDir, {
      version: 1,
      workspace: { root: testDir, key: "test" },
      entries,
      updatedAt: now.toISOString(),
    });

    const loaded = await loadPendingJournal(testDir);

    assert.deepEqual(loaded.entries.map(entry => entry.id), ["explicit_old", "manual_old"]);
  });

  it("clears only entries matching both key and owner when owner is supplied", async () => {
    const now = new Date().toISOString();
    await appendPendingMemories(testDir, [
      {
        id: "a",
        type: "feedback",
        text: "Session A preference",
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
        pendingOwnerSessionID: "session-a",
      },
      {
        id: "b",
        type: "feedback",
        text: "Session B preference",
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
        pendingOwnerSessionID: "session-b",
      },
    ]);

    await clearPendingMemories(
      testDir,
      new Set(["feedback:session a preference", "feedback:session b preference"]),
      { ownerSessionID: "session-a" },
    );

    const loaded = await loadPendingJournal(testDir);
    assert.deepEqual(loaded.entries.map(entry => entry.pendingOwnerSessionID), ["session-b"]);
  });

  it("global unowned clear keeps owned entries with the same key", async () => {
    const now = new Date().toISOString();
    const unowned: LongTermMemoryEntry = {
      id: "clear-unowned",
      type: "feedback",
      text: "Prefer scoped cleanup.",
      source: "explicit",
      confidence: 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const owned: LongTermMemoryEntry = {
      ...unowned,
      id: "clear-owned",
      pendingOwnerSessionID: "session-owned",
    };

    await appendPendingMemories(testDir, [unowned, owned]);

    await clearPendingMemories(testDir, new Set([memoryKey(unowned)]), {
      clearUnowned: true,
    });

    const loaded = await loadPendingJournal(testDir);
    assert.deepEqual(loaded.entries.map(entry => entry.id), ["clear-owned"]);
    assert.equal(loaded.entries[0].pendingOwnerSessionID, "session-owned");
  });

  it("retains same-key pending entries owned by different sessions", async () => {
    const now = new Date().toISOString();
    await appendPendingMemories(testDir, [
      {
        id: "same-a",
        type: "feedback",
        text: "Prefer owner-scoped promotion.",
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
        pendingOwnerSessionID: "session-a",
      },
      {
        id: "same-b",
        type: "feedback",
        text: "Prefer owner-scoped promotion.",
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
        pendingOwnerSessionID: "session-b",
      },
    ]);

    const loaded = await loadPendingJournal(testDir);

    assert.deepEqual(
      loaded.entries.map(entry => entry.pendingOwnerSessionID).sort(),
      ["session-a", "session-b"],
      "same memory key must remain separately retryable/clearable per owner",
    );
  });

  it("records bounded promotion rejection attempts and exhausts only matching owner", async () => {
    const now = new Date().toISOString();
    const sessionA: LongTermMemoryEntry = {
      id: "reject-a",
      type: "reference",
      text: "Capacity rejected explicit reference.",
      source: "explicit",
      confidence: 0.1,
      status: "active",
      createdAt: now,
      updatedAt: now,
      pendingOwnerSessionID: "session-a",
    };
    const sessionB: LongTermMemoryEntry = {
      ...sessionA,
      id: "reject-b",
      pendingOwnerSessionID: "session-b",
    };
    await appendPendingMemories(testDir, [sessionA, sessionB]);

    for (let attempt = 1; attempt < PROMOTION_RETRY_LIMITS.maxExplicitAttempts; attempt += 1) {
      const exhausted = await recordPromotionRejections(
        testDir,
        new Set([memoryKey(sessionA)]),
        "rejected_capacity",
        { ownerSessionID: "session-a" },
      );

      assert.equal(exhausted.size, 0, "entry should not exhaust before the max attempt");
      const loaded = await loadPendingJournal(testDir);
      const ownedA = loaded.entries.find(entry => entry.pendingOwnerSessionID === "session-a");
      const ownedB = loaded.entries.find(entry => entry.pendingOwnerSessionID === "session-b");
      assert.equal(ownedA?.promotionAttempts, attempt);
      assert.equal(ownedA?.lastPromotionFailureReason, "rejected_capacity");
      assert.equal(ownedB?.promotionAttempts, undefined,
        "same-key entry for another owner must not be mutated");
    }

    const exhausted = await recordPromotionRejections(
      testDir,
      new Set([memoryKey(sessionA)]),
      "rejected_capacity",
      { ownerSessionID: "session-a" },
    );

    assert.deepEqual([...exhausted], [memoryKey(sessionA)]);
    const loaded = await loadPendingJournal(testDir);
    assert.deepEqual(loaded.entries.map(entry => entry.pendingOwnerSessionID), ["session-b"]);
  });

  it("global unowned rejection exhausts only unowned entries with the same key", async () => {
    const now = new Date().toISOString();
    const unowned: LongTermMemoryEntry = {
      id: "reject-unowned",
      type: "reference",
      text: "Capacity rejected unowned reference.",
      source: "explicit",
      confidence: 0.1,
      status: "active",
      createdAt: now,
      updatedAt: now,
      promotionAttempts: PROMOTION_RETRY_LIMITS.maxExplicitAttempts - 1,
    };
    const owned: LongTermMemoryEntry = {
      ...unowned,
      id: "reject-owned",
      pendingOwnerSessionID: "session-owned",
      promotionAttempts: undefined,
    };
    await appendPendingMemories(testDir, [unowned, owned]);

    const exhausted = await recordPromotionRejections(
      testDir,
      new Set([memoryKey(unowned)]),
      "rejected_capacity",
      { includeUnownedOnly: true },
    );

    assert.deepEqual([...exhausted], [memoryKey(unowned)]);
    const loaded = await loadPendingJournal(testDir);
    assert.deepEqual(loaded.entries.map(entry => entry.id), ["reject-owned"]);
    assert.equal(
      loaded.entries[0].promotionAttempts,
      undefined,
      "owned same-key entry must not be mutated by global unowned rejection",
    );
    assert.equal(loaded.entries[0].lastPromotionFailureReason, undefined);
  });

  it("drops invalid timestamp entries for every source as corruption safety", async () => {
    await savePendingJournal(testDir, {
      version: 1,
      workspace: { root: testDir, key: "test" },
      updatedAt: new Date().toISOString(),
      entries: [
        {
          id: "bad_explicit",
          type: "feedback",
          text: "Bad explicit timestamp",
          source: "explicit",
          confidence: 1,
          status: "active",
          createdAt: "not-a-date",
          updatedAt: "also-bad",
        },
        {
          id: "bad_manual",
          type: "reference",
          text: "Bad manual timestamp",
          source: "manual",
          confidence: 1,
          status: "active",
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "bad_compaction",
          type: "reference",
          text: "Bad compaction timestamp",
          source: "compaction",
          confidence: 0.75,
          status: "active",
          createdAt: "bad",
          updatedAt: "bad",
        },
      ],
    });

    const loaded = await loadPendingJournal(testDir);
    assert.equal(loaded.entries.length, 0);
  });

  it("savePendingJournal uses updatedAt when createdAt is missing", async () => {
    const now = new Date();
    const freshDate = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    const staleDate = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);

    const entries: LongTermMemoryEntry[] = [
      {
        type: "decision",
        text: "Entry with missing createdAt but fresh updatedAt",
        source: "compaction",
        createdAt: "", // invalid
        updatedAt: freshDate.toISOString(),
      },
      {
        type: "decision",
        text: "Entry with missing createdAt and stale updatedAt",
        source: "compaction",
        createdAt: "", // invalid
        updatedAt: staleDate.toISOString(),
      },
    ];

    await savePendingJournal(testDir, {
      version: 1,
      workspace: { root: testDir, key: "test" },
      entries,
      updatedAt: now.toISOString(),
    });

    const loaded = await loadPendingJournal(testDir);

    // Fresh entry should be kept, stale entry should be pruned
    assert.strictEqual(loaded.entries.length, 1);
    assert.strictEqual(
      loaded.entries[0].text,
      "Entry with missing createdAt but fresh updatedAt"
    );
  });
});

async function mkdtemp(): Promise<string> {
  const base = join(tmpdir(), "pending-journal-test");
  await mkdir(base, { recursive: true });
  return fsMkdtemp(join(base, "case-"));
}
