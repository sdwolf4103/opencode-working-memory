import test from "node:test";
import assert from "node:assert/strict";
import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "../src/types.ts";
import { renderWorkspaceMemory, enforceLongTermLimits } from "../src/workspace-memory.ts";

function entry(id: string, text: string, type: LongTermMemoryEntry["type"] = "decision"): LongTermMemoryEntry {
  const now = new Date().toISOString();
  return {
    id,
    type,
    text,
    source: "compaction",
    confidence: 0.75,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================
// Task 2: renderWorkspaceMemory tests
// ============================================

test("renderWorkspaceMemory respects budget and fits entries", () => {
  const entries = Array.from({ length: 28 }, (_, i) =>
    entry(`mem_${i}`, `Long durable memory entry ${i} `.repeat(20))
  );

  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root: "/repo", key: "abc" },
    limits: { maxRenderedChars: 700, maxEntries: 28 },
    entries,
    updatedAt: new Date().toISOString(),
  };

  const rendered = renderWorkspaceMemory(store);

  assert.ok(!rendered.includes("<workspace_memory>"),
    "Should not contain XML tags");
  assert.ok(rendered.length <= 700,
    `Rendered memory must not exceed maxChars. Got: ${rendered.length}`);
});

test("renderWorkspaceMemory returns empty string when maxChars too small", () => {
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root: "/repo", key: "abc" },
    limits: { maxRenderedChars: 50, maxEntries: 28 },
    entries: [entry("test", "test memory")],
    updatedAt: new Date().toISOString(),
  };

  const rendered = renderWorkspaceMemory(store);
  assert.equal(rendered, "",
    "When maxChars too small for even minimal envelope, return empty string");
});

test("renderWorkspaceMemory respects small budget", () => {
  // Create entries that would overflow a small budget
  const entries = [
    entry("a", "First memory entry that is reasonably long"),
    entry("b", "Second memory entry that is also reasonably long"),
    entry("c", "Third memory entry that is also reasonably long"),
  ];

  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root: "/repo", key: "abc" },
    limits: { maxRenderedChars: 200, maxEntries: 28 },
    entries,
    updatedAt: new Date().toISOString(),
  };

  const rendered = renderWorkspaceMemory(store);

  assert.ok(!rendered.includes("<workspace_memory>"),
    "Should not contain XML tags");
  assert.ok(rendered.length <= 200,
    `Must respect maxChars limit. Got: ${rendered.length}`);
});

test("renderWorkspaceMemory returns empty for no entries", () => {
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root: "/repo", key: "abc" },
    limits: { maxRenderedChars: 5200, maxEntries: 28 },
    entries: [],
    updatedAt: new Date().toISOString(),
  };

  const rendered = renderWorkspaceMemory(store);
  assert.equal(rendered, "");
});

// ============================================
// PR-2 Task 5 tests (for enforceLongTermLimits)
// ============================================

test("enforceLongTermLimits dedupes with canonical text", () => {
  const now = new Date().toISOString();

  const a: LongTermMemoryEntry = {
    id: "a",
    type: "decision",
    text: "OpenCode uses NPM CACHE for plugin loading",
    source: "compaction",
    confidence: 0.75,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const b: LongTermMemoryEntry = {
    id: "b",
    type: "decision",
    text: "opencode uses npm cache for plugin loading!!!",
    source: "compaction",
    confidence: 0.8,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const kept = enforceLongTermLimits([a, b]);

  assert.equal(kept.length, 1, "Should dedupe similar texts");
  assert.equal(kept[0].confidence, 0.8, "Higher confidence should win for same source");
});

test("enforceLongTermLimits preserves explicit over compaction", () => {
  const now = new Date().toISOString();

  const explicit: LongTermMemoryEntry = {
    id: "explicit",
    type: "decision",
    text: "Use pnpm for this project",
    source: "explicit",
    confidence: 0.5,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const compaction: LongTermMemoryEntry = {
    id: "compaction",
    type: "decision",
    text: "Use pnpm for this project",
    source: "compaction",
    confidence: 0.9,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const kept = enforceLongTermLimits([explicit, compaction]);

  assert.equal(kept.length, 1);
  assert.equal(kept[0].source, "explicit",
    "Explicit source should win over compaction even with lower confidence");
  assert.equal(kept[0].confidence, 0.5, "Original explicit confidence preserved");
});

test("enforceLongTermLimits same source higher confidence wins", () => {
  const now = new Date().toISOString();

  const a: LongTermMemoryEntry = {
    id: "a",
    type: "decision",
    text: "Project uses TypeScript",
    source: "compaction",
    confidence: 0.7,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const b: LongTermMemoryEntry = {
    id: "b",
    type: "decision",
    text: "Project uses TypeScript",
    source: "compaction",
    confidence: 0.9,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const kept = enforceLongTermLimits([a, b]);

  assert.equal(kept.length, 1);
  assert.equal(kept[0].confidence, 0.9, "Higher confidence wins for same source");
});

test("enforceLongTermLimits respects maxEntries limit", () => {
  const now = new Date().toISOString();
  const entries = Array.from({ length: 50 }, (_, i) => ({
    id: `mem_${i}`,
    type: "decision" as const,
    text: `Unique memory entry number ${i}`,
    source: "compaction" as const,
    confidence: 0.75,
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
  }));

  const kept = enforceLongTermLimits(entries);
  assert.ok(kept.length <= 28, `Should respect maxEntries. Got: ${kept.length}`);
});