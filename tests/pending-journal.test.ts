/**
 * Pending journal retention tests.
 *
 * Tests for max entries cap, TTL pruning, and dedupe behavior.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadPendingJournal,
  savePendingJournal,
  appendPendingMemories,
  PENDING_JOURNAL_LIMITS,
} from "../src/pending-journal.ts";
import type { LongTermMemoryEntry } from "../src/types.ts";

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

  it("savePendingJournal prunes stale entries regardless of source", async () => {
    const now = new Date();
    const staleDate = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);

    const entries: LongTermMemoryEntry[] = [
      {
        type: "decision",
        text: "Stale explicit entry",
        source: "explicit",
        createdAt: staleDate.toISOString(),
        updatedAt: staleDate.toISOString(),
      },
      {
        type: "decision",
        text: "Stale compaction entry",
        source: "compaction",
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

    // Both explicit and compaction entries past maxAgeDays are pruned
    // Retention does not differentiate by source
    assert.strictEqual(
      loaded.entries.length,
      0,
      "Stale entries should be pruned regardless of source"
    );
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
  return base;
}