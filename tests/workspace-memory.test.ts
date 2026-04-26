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

/** Create an entry with a createdAt offset from now (negative = in the past) */
function agedEntry(
  id: string,
  text: string,
  type: LongTermMemoryEntry["type"] = "decision",
  opts: { daysAgo: number; source?: "compaction" | "explicit" | "manual"; staleAfterDays?: number } = { daysAgo: 0, source: "compaction" },
): LongTermMemoryEntry {
  const createdAt = new Date(Date.now() - opts.daysAgo * 86400000).toISOString();
  return {
    id,
    type,
    text,
    source: opts.source ?? "compaction",
    confidence: 0.75,
    status: "active",
    createdAt,
    updatedAt: createdAt,
    staleAfterDays: opts.staleAfterDays,
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

// ============================================
// P0d: identity-key dedup, supersession, staleness
// ============================================

test("enforceLongTermLimits project: bilingual variants collapse to one", () => {
  // All three mention opencode-agenthub plugin system - should merge
  const entries = [
    agedEntry("p1", "此 repo 在開發時使用 opencode-agenthub 插件系統，目錄位於 /Users/sd_wo/work/opencode-working-memory/.opencode-agenthub/", "project", { daysAgo: 2 }),
    agedEntry("p2", "此 repo 在開發時使用 opencode-agenthub 插件系統", "project", { daysAgo: 1 }),
    agedEntry("p3", "This repo uses opencode-agenthub plugin system at /Users/sd_wo/work/opencode-working-memory/", "project", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  const projectEntries = kept.filter(e => e.type === "project");
  assert.equal(projectEntries.length, 1, "All three project variants should merge to one");
});

test("enforceLongTermLimits reference: same config path variants collapse to one", () => {
  const entries = [
    agedEntry("r1", "OpenCode plugin config location: .opencode-agenthub/current/xdg/opencode/opencode.json in workspace", "reference", { daysAgo: 1 }),
    agedEntry("r2", "OpenCode plugin config: .opencode-agenthub/current/xdg/opencode/opencode.json in workspace", "reference", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  const refEntries = kept.filter(e => e.type === "reference");
  assert.equal(refEntries.length, 1, "Both reference variants should merge to one");
});

test("enforceLongTermLimits decision: newer supersedes older on same topic", () => {
  // "4 formats" supersedes "3 formats" on the same parser topic
  const entries = [
    agedEntry("d1", "Parser supports 3 formats: HTML comment, Markdown section, legacy XML", "decision", { daysAgo: 2 }),
    agedEntry("d2", "Parser supports 4 formats: plain text label, Markdown section, legacy section name, legacy XML", "decision", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  const decisionEntries = kept.filter(e => e.text.includes("formats"));
  assert.equal(decisionEntries.length, 1, "Newer 4-formats should supersede older 3-formats");
  assert.ok(decisionEntries[0].text.includes("4 formats"), "Kept entry should be the 4-formats one");
});

test("enforceLongTermLimits feedback: newer supersedes older on same issue", () => {
  const entries = [
    agedEntry("f1", "Purple/italic text issue resolved by using plain text labels instead of any special markup syntax", "feedback", { daysAgo: 2 }),
    agedEntry("f2", "Purple/italic text issue resolved by replacing default compaction template with ---free version using only Markdown headings", "feedback", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  const feedbackEntries = kept.filter(e => e.type === "feedback");
  assert.equal(feedbackEntries.length, 1, "Newer purple/italic fix should supersede older");
  assert.ok(feedbackEntries[0].text.includes("replacing default compaction template"), "Kept entry should be the newer fix");
});

test("enforceLongTermLimits stale: compaction entry older than staleAfterDays+grace is pruned", () => {
  // decision with staleAfterDays=45, 76 days old (> 45+30 grace=75)
  const entries = [
    agedEntry("stale", "Compaction output contract changed from XML to HTML comments to avoid Markdown rendering issues", "decision", { daysAgo: 76, staleAfterDays: 45 }),
  ];

  const kept = enforceLongTermLimits(entries);
  assert.equal(kept.length, 0, "Stale compaction entry should be pruned");
});

test("enforceLongTermLimits stale: explicit entry is retained even if old", () => {
  // explicit entry - never auto-pruned regardless of age
  const entries = [
    agedEntry("old_explicit", "User explicitly set Admin PIN 456123 for the system", "reference", { daysAgo: 500, source: "explicit", staleAfterDays: 90 }),
  ];

  const kept = enforceLongTermLimits(entries);
  assert.equal(kept.length, 1, "Explicit entry should never be age-pruned");
});

test("enforceLongTermLimits stale: feedback entry is retained regardless of age", () => {
  // feedback - never age-pruned (only superseded)
  const entries = [
    agedEntry("old_feedback", "Users prefer darker themes over light themes", "feedback", { daysAgo: 300, staleAfterDays: 30 }),
  ];

  const kept = enforceLongTermLimits(entries);
  assert.equal(kept.length, 1, "Feedback entry should never be age-pruned");
});

test("enforceLongTermLimits stale: compaction entry within grace period is retained", () => {
  // decision staleAfterDays=45, 60 days old (< 45+30=75 grace) - should keep
  const entries = [
    agedEntry("within_grace", "Some compaction decision made two months ago", "decision", { daysAgo: 60, staleAfterDays: 45 }),
  ];

  const kept = enforceLongTermLimits(entries);
  assert.equal(kept.length, 1, "Entry within grace period should be retained");
});

test("enforceLongTermLimits dedup before trim: cleanup runs before maxEntries slice", () => {
  // 30 entries that should dedupe to < 28, confirming trim doesn't run before dedupe
  const entries = [
    ...Array.from({ length: 15 }, (_, i) =>
      agedEntry(`a${i}`, "opencode uses npm cache for plugin loading", "decision", { daysAgo: 0 })
    ),
    ...Array.from({ length: 15 }, (_, i) =>
      agedEntry(`b${i}`, "opencode uses npm cache for plugin loading", "decision", { daysAgo: 0 })
    ),
  ];

  const kept = enforceLongTermLimits(entries);
  assert.equal(kept.length, 1, "All duplicates should merge to 1 entry, far below maxEntries");
});

test("enforceLongTermLimits priority: freshness used as tie-breaker among same priority entries", () => {
  // Same type, same source, same confidence — newer should win
  const older = agedEntry("older", "Some durable configuration fact about the workspace", "reference", { daysAgo: 30, source: "compaction", staleAfterDays: 90 });
  const newer = agedEntry("newer", "Some durable configuration fact about the workspace", "reference", { daysAgo: 5, source: "compaction", staleAfterDays: 90 });

  const kept = enforceLongTermLimits([older, newer]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, "newer", "Newer entry should win as tie-breaker");
});