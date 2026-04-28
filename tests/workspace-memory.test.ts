import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "../src/types.ts";
import { LONG_TERM_LIMITS } from "../src/types.ts";
import { workspaceKey, workspaceMemoryPath } from "../src/paths.ts";
import {
  renderWorkspaceMemory,
  enforceLongTermLimits,
  dedupeLongTermEntriesWithAccounting,
  enforceLongTermLimitsWithAccounting,
  normalizeWorkspaceMemoryWithAccounting,
  workspaceMemoryExactKey,
  workspaceMemoryIdentityKey,
  redactCredentials,
  runMigrationP0Cleanup,
  runMigrationQualityCleanup,
  loadWorkspaceMemory,
  saveWorkspaceMemory,
  updateWorkspaceMemoryWithAccounting,
} from "../src/workspace-memory.ts";
import { assessMemoryQuality, isHardQualityReason, isProgressSnapshotViolation } from "../src/memory-quality.ts";
import { reviewerCurrent28Fixture } from "./fixtures/memory-quality-current-28.ts";
import { REAL_WORKSPACE_FIXTURES } from "./fixtures/real-workspaces-snapshot.ts";

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

test("normalization ordering is deterministic for retention ties", () => {
  const createdAt = "2026-04-28T00:00:00.000Z";
  const a = {
    ...entry("a", "Durable unique memory A"),
    createdAt,
    updatedAt: createdAt,
  };
  const b = {
    ...entry("b", "Durable unique memory B"),
    createdAt,
    updatedAt: createdAt,
  };

  const first = enforceLongTermLimits([b, a]).map(memory => memory.id);
  const second = enforceLongTermLimits([a, b]).map(memory => memory.id);

  assert.deepEqual(first, ["a", "b"]);
  assert.deepEqual(second, ["a", "b"]);
});

test("dedupeLongTermEntriesWithAccounting reports exact duplicates as absorbed", () => {
  const now = new Date().toISOString();
  const lower: LongTermMemoryEntry = {
    id: "lower",
    type: "decision",
    text: "OpenCode uses NPM CACHE for plugin loading",
    source: "compaction",
    confidence: 0.7,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const higher: LongTermMemoryEntry = {
    id: "higher",
    type: "decision",
    text: "opencode uses npm cache for plugin loading!!!",
    source: "compaction",
    confidence: 0.8,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const result = dedupeLongTermEntriesWithAccounting([lower, higher]);

  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].id, "higher");
  assert.deepEqual(result.absorbed.map(event => event.reason), ["absorbed_exact"]);
  assert.equal(result.absorbed[0].memory.id, "lower");
});

test("dedupeLongTermEntriesWithAccounting reports concrete path identity duplicates as absorbed", () => {
  const older = agedEntry(
    "older",
    "OpenCode plugin config location: `.opencode-agenthub/current/xdg/opencode/opencode.json` in workspace",
    "reference",
    { daysAgo: 5 },
  );
  const newer = agedEntry(
    "newer",
    "OpenCode plugin config: .opencode-agenthub/current/xdg/opencode/opencode.json in workspace",
    "reference",
    { daysAgo: 0 },
  );

  const result = dedupeLongTermEntriesWithAccounting([older, newer]);

  assert.equal(result.kept.length, 1);
  assert.equal(result.absorbed.length, 1);
  assert.equal(result.absorbed[0].reason, "absorbed_identity");
  assert.equal(result.absorbed[0].retainedId, result.kept[0].id);
  assert.equal(
    workspaceMemoryIdentityKey(older),
    "reference:path:.opencode-agenthub/current/xdg/opencode/opencode.json",
  );
});

test("dedupeLongTermEntriesWithAccounting reports path identity duplicates as absorbed", () => {
  const older = entry("older", "Config location: .opencode/opencode.json", "reference");
  const newer = entry("newer", "OpenCode config path `.opencode/opencode.json`", "reference");

  const result = dedupeLongTermEntriesWithAccounting([older, newer]);

  assert.equal(result.kept.length, 1);
  assert.equal(result.absorbed.length, 1);
  assert.equal(result.absorbed[0].reason, "absorbed_identity");
  assert.equal(result.superseded.length, 0);
});

test("dedupeLongTermEntriesWithAccounting does not supersede parser decision variants by topic", () => {
  const older = agedEntry(
    "older",
    "Parser supports 3 formats: HTML comment, Markdown section, legacy XML",
    "decision",
    { daysAgo: 5 },
  );
  const newer = agedEntry(
    "newer",
    "Parser supports 4 formats: plain text label, Markdown section, legacy section name, legacy XML",
    "decision",
    { daysAgo: 0 },
  );

  const result = dedupeLongTermEntriesWithAccounting([older, newer]);

  assert.equal(result.kept.length, 2);
  assert.equal(result.superseded.length, 0);
});

test("dedupeLongTermEntriesWithAccounting does not report heuristic topic supersession", () => {
  const older = entry("older", "Parser supports 3 formats: HTML comment, Markdown section, legacy XML", "decision");
  const newer = entry("newer", "Parser supports 4 formats: plain text label, Markdown section, legacy section name, legacy XML", "decision");

  const result = dedupeLongTermEntriesWithAccounting([older, newer]);

  assert.equal(result.kept.length, 2);
  assert.equal(result.absorbed.length, 0);
  assert.equal(result.superseded.length, 0);
});

test("enforceLongTermLimitsWithAccounting reports capacity drops", () => {
  const now = new Date().toISOString();
  const entries = Array.from({ length: LONG_TERM_LIMITS.maxEntries + 2 }, (_, i) => ({
    id: `mem_${i}`,
    type: "reference" as const,
    text: `Unique low priority reference ${i}`,
    source: "compaction" as const,
    confidence: i < LONG_TERM_LIMITS.maxEntries ? 0.8 : 0.1,
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
  }));

  const result = enforceLongTermLimitsWithAccounting(entries);

  assert.equal(result.kept.length, LONG_TERM_LIMITS.maxEntries);
  assert.equal(result.dropped.filter(event => event.reason === "rejected_capacity").length, 2);
  assert.ok(result.dropped.every(event => event.memory.source === "compaction"));
});

test("workspaceMemoryExactKey uses pending-compatible canonical semantics", () => {
  const now = new Date().toISOString();
  const entry: LongTermMemoryEntry = {
    id: "key_alignment",
    type: "decision",
    text: "OpenCode uses NPM CACHE for plugin loading!!!",
    source: "compaction",
    confidence: 0.75,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  assert.equal(workspaceMemoryExactKey(entry), "decision:opencode uses npm cache for plugin loading");
});

test("normalizeWorkspaceMemoryWithAccounting redacts credentials before accounting", async () => {
  const root = "/repo";
  const now = new Date().toISOString();
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root, key: "abc" },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    migrations: ["2026-04-26-p0-cleanup"],
    entries: [{
      id: "cred",
      type: "reference",
      text: "Admin PIN 是 456123",
      rationale: "password: sushi",
      source: "explicit",
      confidence: 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }],
    updatedAt: now,
  };

  const result = await normalizeWorkspaceMemoryWithAccounting(root, store);

  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].text, "Admin PIN 是 [REDACTED]");
  assert.equal(result.kept[0].rationale, "password: [REDACTED]");
  assert.equal(result.store.entries[0].text, "Admin PIN 是 [REDACTED]");
});

test("normalizeWorkspaceMemoryWithAccounting reports overflow capacity drops", async () => {
  const root = "/repo";
  const now = new Date().toISOString();
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root, key: "abc" },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    migrations: ["2026-04-26-p0-cleanup"],
    entries: Array.from({ length: LONG_TERM_LIMITS.maxEntries + 1 }, (_, i) => ({
      id: `overflow_${i}`,
      type: "reference" as const,
      text: `Overflow reference ${i}`,
      source: "compaction" as const,
      confidence: i < LONG_TERM_LIMITS.maxEntries ? 0.8 : 0.1,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    })),
    updatedAt: now,
  };

  const result = await normalizeWorkspaceMemoryWithAccounting(root, store);

  assert.equal(result.kept.length, LONG_TERM_LIMITS.maxEntries);
  assert.equal(result.store.entries.filter(entry => entry.status === "active").length, LONG_TERM_LIMITS.maxEntries);
  assert.equal(result.dropped.filter(event => event.reason === "rejected_capacity").length, 1);
});

test("normalizeWorkspaceMemoryWithAccounting reports stale entry removal", async () => {
  const root = "/repo";
  const now = new Date().toISOString();
  const stale = agedEntry(
    "stale_normalize",
    "Old compaction decision should be removed by normalization accounting",
    "decision",
    { daysAgo: 90, staleAfterDays: 1 },
  );
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root, key: "abc" },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    migrations: ["2026-04-26-p0-cleanup"],
    entries: [stale],
    updatedAt: now,
  };

  const result = await normalizeWorkspaceMemoryWithAccounting(root, store);

  assert.equal(result.kept.length, 0);
  assert.equal(result.store.entries.length, 0);
  assert.deepEqual(result.dropped.map(event => event.reason), ["rejected_stale"]);
  assert.equal(result.dropped[0].memory.id, "stale_normalize");
});

test("updateWorkspaceMemoryWithAccounting emits accounting events for persisted updates", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "wm-accounting-update-"));
  const dataHome = join(sandbox, "xdg-data-home");
  const root = join(sandbox, "workspace");
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;

  try {
    const now = new Date().toISOString();
    const result = await updateWorkspaceMemoryWithAccounting(root, store => {
      store.entries.push(...Array.from({ length: LONG_TERM_LIMITS.maxEntries + 1 }, (_, i) => ({
        id: `persisted_${i}`,
        type: "reference" as const,
        text: `Persisted accounting reference ${i}`,
        source: "compaction" as const,
        confidence: i < LONG_TERM_LIMITS.maxEntries ? 0.8 : 0.1,
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
      })));
      return store;
    });

    assert.equal(result.store.entries.filter(entry => entry.status === "active").length, LONG_TERM_LIMITS.maxEntries);
    assert.equal(result.events.filter(event => event.reason === "rejected_capacity").length, 1);

    const persisted = await loadWorkspaceMemory(root);
    assert.equal(persisted.entries.filter(entry => entry.status === "active").length, LONG_TERM_LIMITS.maxEntries);
  } finally {
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
    await rm(sandbox, { recursive: true, force: true });
  }
});

// ============================================
// P0d: identity-key dedup, supersession, staleness
// ============================================

test("enforceLongTermLimits project: phrase-only opencode-agenthub variants do not collapse", () => {
  const entries = [
    agedEntry("p1", "此 repo 在開發時使用 opencode-agenthub 插件系統", "project", { daysAgo: 2 }),
    agedEntry("p2", "This repo uses the opencode-agenthub plugin system", "project", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  const projectEntries = kept.filter(e => e.type === "project");
  assert.equal(projectEntries.length, 2, "Phrase-only repo/product names should not form a dedupe identity");
});

test("enforceLongTermLimits reference: same concrete config path variants collapse to one", () => {
  const entries = [
    agedEntry("r1", "OpenCode plugin config location: `.opencode-agenthub/current/xdg/opencode/opencode.json` in workspace", "reference", { daysAgo: 1 }),
    agedEntry("r2", "OpenCode plugin config: .opencode-agenthub/current/xdg/opencode/opencode.json in workspace", "reference", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  const refEntries = kept.filter(e => e.type === "reference");
  assert.equal(refEntries.length, 1, "Shared concrete paths should merge despite wording differences");
  assert.equal(
    workspaceMemoryIdentityKey(entries[0]),
    "reference:path:.opencode-agenthub/current/xdg/opencode/opencode.json",
  );
});

test("workspaceMemoryIdentityKey reference: normalizes wrapped path punctuation", () => {
  const a = agedEntry("a", "Config path is `.opencode/opencode.json`.", "reference", { daysAgo: 1 });
  const b = agedEntry("b", "Config path: .opencode/opencode.json", "reference", { daysAgo: 0 });

  assert.equal(workspaceMemoryIdentityKey(a), "reference:path:.opencode/opencode.json");
  assert.equal(workspaceMemoryIdentityKey(b), "reference:path:.opencode/opencode.json");
  assert.equal(enforceLongTermLimits([a, b]).length, 1);
});

test("enforceLongTermLimits reference: same URL variants collapse to one", () => {
  const entries = [
    agedEntry("u1", "Docs live at https://Example.com/docs/memory/#section", "reference", { daysAgo: 2 }),
    agedEntry("u2", "Memory documentation: https://example.com/docs/memory/", "reference", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  const refEntries = kept.filter(e => e.type === "reference");
  assert.equal(refEntries.length, 1, "Shared normalized URLs should merge despite wording differences");
  assert.equal(workspaceMemoryIdentityKey(entries[0]), "reference:url:https://example.com/docs/memory");
});

test("workspaceMemoryIdentityKey reference: strips URL hash but preserves query", () => {
  const withHash = agedEntry("a", "Docs: https://example.com/memory?version=1#install", "reference", { daysAgo: 1 });
  const sameWithoutHash = agedEntry("b", "Docs: https://EXAMPLE.com/memory?version=1", "reference", { daysAgo: 0 });
  const differentQuery = agedEntry("c", "Docs: https://example.com/memory?version=2", "reference", { daysAgo: 0 });

  assert.equal(workspaceMemoryIdentityKey(withHash), "reference:url:https://example.com/memory?version=1");
  assert.equal(workspaceMemoryIdentityKey(sameWithoutHash), "reference:url:https://example.com/memory?version=1");
  assert.equal(workspaceMemoryIdentityKey(differentQuery), "reference:url:https://example.com/memory?version=2");
  assert.equal(enforceLongTermLimits([withHash, sameWithoutHash, differentQuery]).length, 2);
});

test("enforceLongTermLimits decision: parser format variants do not supersede by topic", () => {
  const entries = [
    agedEntry("d1", "Parser supports 3 formats: HTML comment, Markdown section, legacy XML", "decision", { daysAgo: 2 }),
    agedEntry("d2", "Parser supports 4 formats: plain text label, Markdown section, legacy section name, legacy XML", "decision", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  const decisionEntries = kept.filter(e => e.text.includes("formats"));
  assert.equal(decisionEntries.length, 2, "Distinct decision wording should not be superseded without explicit replacement metadata");
});

test("enforceLongTermLimits decision: plugin-loading config variants do not supersede by topic", () => {
  const entries = [
    agedEntry("d1", "Plugin loading uses OpenCode config plugin array for extension registration", "decision", { daysAgo: 2 }),
    agedEntry("d2", "OpenCode plugin config remains singular plugin, not plugins, for compatibility", "decision", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  const decisionEntries = kept.filter(e => e.type === "decision" && /plugin/i.test(e.text));
  assert.equal(decisionEntries.length, 2, "Plugin-loading/config decision variants should not supersede without explicit replacement metadata");
});

test("enforceLongTermLimits feedback: purple italic variants do not supersede by topic", () => {
  const entries = [
    agedEntry("f1", "Purple/italic text issue resolved by using plain text labels instead of any special markup syntax", "feedback", { daysAgo: 2 }),
    agedEntry("f2", "Purple/italic text issue resolved by replacing default compaction template with ---free version using only Markdown headings", "feedback", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  const feedbackEntries = kept.filter(e => e.type === "feedback");
  assert.equal(feedbackEntries.length, 2, "Distinct feedback wording should not be superseded without explicit replacement metadata");
});

test("enforceLongTermLimits decision: exact canonical duplicates still collapse", () => {
  const entries = [
    agedEntry("d1", "Parser supports 4 formats!!!", "decision", { daysAgo: 1 }),
    agedEntry("d2", "parser supports 4 formats", "decision", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  const decisions = kept.filter(e => e.type === "decision");
  assert.equal(decisions.length, 1, "Exact canonical decision duplicates should still collapse");
});

test("enforceLongTermLimits feedback: exact canonical duplicates still collapse", () => {
  const entries = [
    agedEntry("f1", "Users prefer dark theme!!!", "feedback", { daysAgo: 1 }),
    agedEntry("f2", "users prefer dark theme", "feedback", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  const feedbackEntries = kept.filter(e => e.type === "feedback");
  assert.equal(feedbackEntries.length, 1, "Exact canonical feedback duplicates should still collapse");
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

test("enforceLongTermLimits feedback: 500 error and port issue are NOT collapsed", () => {
  // Distinct feedback entries should remain separate
  const entries = [
    agedEntry("f1", "瀏覽器登入出現 500 internal_error，代碼邏輯正確但原因不明", "feedback", { daysAgo: 0 }),
    agedEntry("f2", "端口 9473 可能被舊進程佔用，需殺掉後重啟", "feedback", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  const feedbackEntries = kept.filter(e => e.type === "feedback");
  assert.equal(feedbackEntries.length, 2, "Distinct feedback items should not collapse");
});

test("enforceLongTermLimits config: unrelated plugin configs are NOT collapsed", () => {
  const entries = [
    agedEntry("c1", "OpenCode plugin config: .opencode-agenthub/current/xdg/opencode/opencode.json in workspace", "reference", { daysAgo: 0 }),
    agedEntry("c2", "Vite plugin config location: vite.config.ts at project root", "reference", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  const refEntries = kept.filter(e => e.type === "reference");
  assert.equal(refEntries.length, 2, "Unrelated plugin configs should remain separate");
});

test("enforceLongTermLimits reference: plugin array wording does not collapse without shared path", () => {
  const entries = [
    agedEntry("a", "OpenCode config uses a plugin array", "reference", { daysAgo: 1 }),
    agedEntry("b", "OpenCode config plugin array should include the working memory plugin", "reference", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  assert.equal(kept.filter(e => e.type === "reference").length, 2, "The plugin array key is product wording, not a dedupe identity");
});

test("enforceLongTermLimits decision: newer shorter parser decision does not replace older longer decision", () => {
  const older = agedEntry("d1", "Parser supports 3 formats: HTML comment, Markdown section, legacy XML with backward compatibility", "decision", { daysAgo: 5 });
  const newer = agedEntry("d2", "Parser supports 4 formats", "decision", { daysAgo: 0 });

  const kept = enforceLongTermLimits([older, newer]);
  const decisions = kept.filter(e => e.type === "decision" && /parser.*format/i.test(e.text));
  assert.equal(decisions.length, 2, "Newer decision should not replace older decision by heuristic topic");
});

test("enforceLongTermLimits feedback: English port issue does NOT collapse with server error", () => {
  const entries = [
    agedEntry("e1", "Browser login 500 internal_error, code correct but cause unknown", "feedback", { daysAgo: 0 }),
    agedEntry("e2", "Port 9473 occupied by old process, may need to kill and restart", "feedback", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  const feedbackEntries = kept.filter(e => e.type === "feedback");
  assert.equal(feedbackEntries.length, 2, "English port issue and server error should remain separate");
});

test("enforceLongTermLimits config: unrelated generic plugin configs do NOT collapse", () => {
  const entries = [
    agedEntry("c1", "Vite plugin config location: vite.config.ts at project root", "reference", { daysAgo: 0 }),
    agedEntry("c2", "ESLint plugin config location: eslint.config.js at project root", "reference", { daysAgo: 0 }),
  ];

  const kept = enforceLongTermLimits(entries);
  const refEntries = kept.filter(e => e.type === "reference");
  assert.equal(refEntries.length, 2, "Unrelated plugin configs without entity key should remain separate");
});

test("enforceLongTermLimits feedback: newer shorter purple italic feedback does not replace older longer feedback", () => {
  const older = agedEntry("f1", "Purple/italic text issue resolved by using plain text labels instead of any special markup syntax in the prompt", "feedback", { daysAgo: 5 });
  const newer = agedEntry("f2", "Purple/italic text fixed via template replacement", "feedback", { daysAgo: 0 });

  const kept = enforceLongTermLimits([older, newer]);
  const feedbackEntries = kept.filter(e => e.type === "feedback");
  assert.equal(feedbackEntries.length, 2, "Newer feedback should not replace older feedback by heuristic topic");
});

// ============================================
// Workspace cleanup migration tests
// ============================================

test("redactCredentials preserves PIN delimiter variants", () => {
  assert.equal(redactCredentials("Admin PIN 是 456123"), "Admin PIN 是 [REDACTED]");
  assert.equal(redactCredentials("Admin PIN = 456123"), "Admin PIN = [REDACTED]");
  assert.equal(redactCredentials("Admin PIN 456123"), "Admin PIN [REDACTED]");
});

test("redactCredentials handles multilingual passwords", () => {
  assert.equal(redactCredentials("パスワード：secret"), "パスワード：[REDACTED]");
  assert.equal(redactCredentials("비밀번호: secret"), "비밀번호: [REDACTED]");
  assert.equal(redactCredentials("contraseña: secret"), "contraseña: [REDACTED]");
});

test("redactCredentials handles username+password pair and punctuation boundary", () => {
  assert.equal(
    redactCredentials("測試用戶名：shihlab，密碼：sushi"),
    "測試用戶名：[REDACTED]，密碼：[REDACTED]",
  );
  assert.equal(
    redactCredentials("密碼：sushi，用於測試"),
    "密碼：[REDACTED]，用於測試",
  );
});

test("redactCredentials handles generic API keys and tokens", () => {
  assert.equal(redactCredentials("API_KEY: sk-123456789"), "API_KEY: [REDACTED]");
  assert.equal(redactCredentials("Bearer Token: eyJhbGciOiJIUzI1..."), "Bearer Token: [REDACTED]");
  assert.equal(redactCredentials("GitHub Secret: ghp_abc123"), "GitHub Secret: [REDACTED]");
  assert.equal(redactCredentials("auth: abc123def"), "auth: [REDACTED]");
});

test("redactCredentials redacts bearer tokens", () => {
  assert.equal(
    redactCredentials("Bearer sk-test-123"),
    "Bearer [REDACTED]",
  );
  assert.equal(
    redactCredentials("Authorization: Bearer sk-test-123"),
    "Authorization: Bearer [REDACTED]",
  );
  assert.equal(
    redactCredentials("curl -H 'Authorization: Bearer ghp_secret123'"),
    "curl -H 'Authorization: Bearer [REDACTED]'",
  );
});

test("redactCredentials does not redact benign security-related wording", () => {
  assert.equal(redactCredentials("token budget is 5200 characters"), "token budget is 5200 characters");
  assert.equal(redactCredentials("auth config uses OAuth"), "auth config uses OAuth");
  assert.equal(redactCredentials("secret manager is not supported"), "secret manager is not supported");
  assert.equal(redactCredentials("private key handling is out of scope"), "private key handling is out of scope");
});

test("redactCredentials redacts common sensitive key delimiters", () => {
  assert.equal(redactCredentials("token=ghp_abc123"), "token=[REDACTED]");
  assert.equal(redactCredentials("private_key: -----BEGIN"), "private_key: [REDACTED]");
  assert.equal(redactCredentials("credential：abc123"), "credential：[REDACTED]");
  assert.equal(redactCredentials("api-key: sk-live-123"), "api-key: [REDACTED]");
});

test("redactCredentials is idempotent and also redacts rationale text", () => {
  assert.equal(redactCredentials("password: [REDACTED]"), "password: [REDACTED]");

  const now = new Date().toISOString();
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root: "/repo", key: "abc" },
    limits: { maxRenderedChars: 5200, maxEntries: 28 },
    migrations: [],
    entries: [
      {
        id: "cred",
        type: "reference",
        text: "Admin PIN 是 456123",
        rationale: "password: sushi",
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  };

  const migrated = runMigrationP0Cleanup(
    {
      ...store,
      entries: store.entries.map(entry => ({
        ...entry,
        text: redactCredentials(entry.text),
        rationale: entry.rationale ? redactCredentials(entry.rationale) : undefined,
      })),
    },
    now,
  );
  assert.equal(migrated.entries[0].text, "Admin PIN 是 [REDACTED]");
  assert.equal(migrated.entries[0].rationale, "password: [REDACTED]");
});

test("shared progress snapshot rule detects wave progress and avoids limit context false positives", () => {
  assert.equal(isProgressSnapshotViolation("1237 tests pass, 226 suites"), true);
  assert.equal(isProgressSnapshotViolation("USB 同步：37 個文件"), true);
  assert.equal(isProgressSnapshotViolation("Waves 1-5 已完成，Wave 6 deferred"), true);

  assert.equal(isProgressSnapshotViolation("Upload limit is 10 files"), false);
  assert.equal(isProgressSnapshotViolation("Project supports 5 test suites"), false);
});

test("runMigrationP0Cleanup marks only non-explicit project snapshots and runs once", () => {
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 1000).toISOString();

  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root: "/repo", key: "abc" },
    limits: { maxRenderedChars: 5200, maxEntries: 28 },
    migrations: [],
    entries: [
      {
        id: "project-snapshot",
        type: "project",
        text: "Phase 1-4 已完成",
        source: "compaction",
        confidence: 0.75,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "project-explicit",
        type: "project",
        text: "Waves 1-5 已完成",
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "feedback-snapshot-like",
        type: "feedback",
        text: "1237 tests pass",
        source: "compaction",
        confidence: 0.75,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  };

  const once = runMigrationP0Cleanup(store, now);
  assert.deepEqual(once.migrations, ["2026-04-26-p0-cleanup"]);
  assert.equal(once.entries.find(e => e.id === "project-snapshot")?.status, "superseded");
  assert.equal(once.entries.find(e => e.id === "project-explicit")?.status, "active");
  assert.equal(once.entries.find(e => e.id === "feedback-snapshot-like")?.status, "active");

  const twice = runMigrationP0Cleanup(once, later);
  assert.deepEqual(twice.migrations, ["2026-04-26-p0-cleanup"], "migration id should not duplicate");
  assert.equal(twice.entries.find(e => e.id === "project-snapshot")?.updatedAt, once.entries.find(e => e.id === "project-snapshot")?.updatedAt);
});

test("quality cleanup migration preserves soft-only feedback and decision violations", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-quality-soft-preserve-"));
  try {
    const now = new Date().toISOString();
    await saveWorkspaceMemory(root, {
      version: 1,
      workspace: { root, key: await workspaceKey(root) },
      limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
      entries: [
        {
          id: "soft_feedback",
          type: "feedback",
          text: "UI 要統一風格：兩個表格都要 scrollable，約 20 rows",
          source: "compaction",
          confidence: 0.75,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "soft_decision",
          type: "decision",
          text: "Product branding is \"OpenCode Working Memory\" without \"Plugin\" in the name",
          source: "compaction",
          confidence: 0.75,
          status: "active",
          createdAt: now,
          updatedAt: now,
          staleAfterDays: 45,
        },
      ],
      migrations: [],
      updatedAt: now,
    });

    const loaded = await loadWorkspaceMemory(root);
    assert.equal(loaded.entries.find(e => e.id === "soft_feedback")?.status, "active");
    assert.equal(loaded.entries.find(e => e.id === "soft_decision")?.status, "active");
    assert.ok(loaded.migrations?.includes("2026-04-28-quality-cleanup"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quality cleanup migration supersedes hard quality violations", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-quality-hard-supersede-"));
  try {
    const now = new Date().toISOString();
    await saveWorkspaceMemory(root, {
      version: 1,
      workspace: { root, key: await workspaceKey(root) },
      limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
      entries: [{
        id: "hard_progress",
        type: "project",
        text: "測試套件：1237 tests pass, 226 suites",
        source: "compaction",
        confidence: 0.75,
        status: "active",
        createdAt: now,
        updatedAt: now,
        staleAfterDays: 60,
      }],
      migrations: [],
      updatedAt: now,
    });

    const loaded = await loadWorkspaceMemory(root);
    const entry = loaded.entries.find(e => e.id === "hard_progress");
    assert.equal(entry?.status, "superseded");
    assert.ok(entry?.tags?.includes("quality_cleanup"));
    assert.ok(entry?.tags?.includes("quality:progress_snapshot"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quality cleanup migration writes audit log for hard supersedes", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-quality-audit-root-"));
  const dataHome = await mkdtemp(join(tmpdir(), "wm-quality-audit-data-"));
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;

  try {
    const now = new Date().toISOString();
    await saveWorkspaceMemory(root, {
      version: 1,
      workspace: { root, key: await workspaceKey(root) },
      limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
      entries: [{
        id: "hard_progress",
        type: "project",
        text: "測試套件：1237 tests pass, 226 suites",
        source: "compaction",
        confidence: 0.75,
        status: "active",
        createdAt: now,
        updatedAt: now,
        staleAfterDays: 60,
      }],
      migrations: [],
      updatedAt: now,
    });

    await loadWorkspaceMemory(root);

    const logPath = join(dataHome, "opencode-working-memory", "migration-logs", "2026-04-28-quality-cleanup.jsonl");
    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.migrationId, "2026-04-28-quality-cleanup");
    assert.equal(event.entryId, "hard_progress");
    assert.deepEqual(event.hardReasons, ["progress_snapshot"]);
    assert.equal(event.beforeStatus, "active");
    assert.equal(event.afterStatus, "superseded");
    assert.equal(event.text, "測試套件：1237 tests pass, 226 suites");
  } finally {
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgDataHome;
    await rm(root, { recursive: true, force: true });
    await rm(dataHome, { recursive: true, force: true });
  }
});

test("quality cleanup migration regression against real workspace samples", async () => {
  const failures: string[] = [];
  const now = "2026-04-28T00:00:00.000Z";

  for (const [workspaceName, fixtureEntries] of Object.entries(REAL_WORKSPACE_FIXTURES)) {
    const root = `/fixture/${workspaceName}`;
    const store = {
      version: 1,
      workspace: { root, key: workspaceName.padEnd(16, "0").slice(0, 16) },
      limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
      entries: fixtureEntries.map(({ expectedAfterMigration, expectation, ...entry }) => entry),
      migrations: [],
      updatedAt: now,
    };

    const result = runMigrationQualityCleanup(store, now).store;
    const byId = new Map(result.entries.map(entry => [entry.id, entry]));

    for (const original of fixtureEntries) {
      const after = byId.get(original.id);
      if (!after) {
        failures.push(`${workspaceName}/${original.id}: missing after migration`);
        continue;
      }
      if (after.status !== original.expectedAfterMigration) {
        failures.push(
          `${workspaceName}/${original.id}: expected ${original.expectedAfterMigration}, got ${after.status}\n` +
          `  text: ${original.text.slice(0, 120)}\n` +
          `  why: ${original.expectation}`,
        );
      }
    }
  }

  assert.equal(failures.length, 0, `Regression failures:\n${failures.join("\n")}`);
});

test("quality cleanup migration supersedes only hard violations from current fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-quality-cleanup-"));
  try {
    const now = new Date().toISOString();
    await saveWorkspaceMemory(root, {
      version: 1,
      workspace: { root, key: await workspaceKey(root) },
      limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
      entries: reviewerCurrent28Fixture,
      migrations: [],
      updatedAt: now,
    });

    const loaded = await loadWorkspaceMemory(root);
    const activeIds = new Set(loaded.entries.filter(entry => entry.status === "active").map(entry => entry.id));
    const supersededIds = new Set(loaded.entries.filter(entry => entry.status === "superseded").map(entry => entry.id));

    for (const entry of reviewerCurrent28Fixture) {
      const quality = assessMemoryQuality(entry);
      const hasHardReason = quality.reasons.some(isHardQualityReason);
      if (entry.source === "compaction" && !quality.accepted && hasHardReason) {
        assert.equal(supersededIds.has(entry.id), true, `${entry.id} should be superseded`);
      } else {
        assert.equal(activeIds.has(entry.id), true, `${entry.id} should remain active`);
      }
    }

    assert.ok(loaded.migrations?.includes("2026-04-28-quality-cleanup"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quality cleanup migration dedupes tags", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-quality-tags-"));
  try {
    const now = new Date().toISOString();
    await saveWorkspaceMemory(root, {
      version: 1,
      workspace: { root, key: await workspaceKey(root) },
      limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
      entries: [{
        id: "bad_with_tags",
        type: "feedback",
        text: "Wave 1 completed successfully and all tests passed",
        source: "compaction",
        confidence: 0.75,
        status: "active",
        createdAt: now,
        updatedAt: now,
        tags: ["quality_cleanup", "quality:progress_snapshot"],
      }],
      migrations: [],
      updatedAt: now,
    });

    const loaded = await loadWorkspaceMemory(root);
    const tags = loaded.entries[0].tags ?? [];
    assert.equal(tags.filter(tag => tag === "quality_cleanup").length, 1);
    assert.equal(tags.filter(tag => tag === "quality:progress_snapshot").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quality cleanup migration does not supersede explicit memories", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-quality-explicit-"));
  try {
    const now = new Date().toISOString();
    const explicitBadShape = {
      id: "explicit_progress_like",
      type: "feedback" as const,
      text: "Wave 1 completed successfully and all tests passed",
      source: "explicit" as const,
      confidence: 1,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };

    await saveWorkspaceMemory(root, {
      version: 1,
      workspace: { root, key: await workspaceKey(root) },
      limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
      entries: [explicitBadShape],
      migrations: [],
      updatedAt: now,
    });

    const loaded = await loadWorkspaceMemory(root);
    assert.equal(loaded.entries[0].status, "active");
    assert.equal(loaded.entries[0].source, "explicit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quality cleanup migration does not supersede manual memories", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-quality-manual-"));
  try {
    const now = new Date().toISOString();
    const manualBadShape = {
      id: "manual_progress_like",
      type: "feedback" as const,
      text: "Wave 1 completed successfully and all tests passed",
      source: "manual" as const,
      confidence: 0.9,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };

    await saveWorkspaceMemory(root, {
      version: 1,
      workspace: { root, key: await workspaceKey(root) },
      limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
      entries: [manualBadShape],
      migrations: [],
      updatedAt: now,
    });

    const loaded = await loadWorkspaceMemory(root);
    assert.equal(loaded.entries[0].status, "active");
    assert.equal(loaded.entries[0].source, "manual");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renderWorkspaceMemory excludes superseded entries", () => {
  const now = new Date().toISOString();
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root: "/repo", key: "abc" },
    limits: { maxRenderedChars: 5200, maxEntries: 28 },
    migrations: ["2026-04-26-p0-cleanup"],
    entries: [
      {
        id: "active-1",
        type: "decision",
        text: "Use pnpm for this workspace",
        source: "compaction",
        confidence: 0.75,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "sup-1",
        type: "project",
        text: "Waves 1-5 已完成",
        source: "compaction",
        confidence: 0.75,
        status: "superseded",
        createdAt: now,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  };

  const rendered = renderWorkspaceMemory(store);
  assert.match(rendered, /Use pnpm/);
  assert.doesNotMatch(rendered, /Waves 1-5 已完成/);
});

test("loadWorkspaceMemory does not rewrite an already normalized store", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "wm-normalized-"));
  const dataHome = join(sandbox, "xdg-data-home");
  const root = join(sandbox, "workspace");
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;

  try {
    await mkdir(root, { recursive: true });
    const now = "2026-04-28T00:00:00.000Z";
    await saveWorkspaceMemory(root, {
      version: 1,
      workspace: { root, key: "test" },
      limits: {
        maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars,
        maxEntries: LONG_TERM_LIMITS.maxEntries,
      },
      entries: [
        {
          ...entry("normalized-feedback", "Normalized feedback memory", "feedback"),
          source: "explicit",
          confidence: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      migrations: [],
      updatedAt: now,
    });

    const storePath = await workspaceMemoryPath(root);
    const before = (await stat(storePath)).mtimeMs;
    await sleep(20);

    await loadWorkspaceMemory(root);
    await loadWorkspaceMemory(root);

    const after = (await stat(storePath)).mtimeMs;
    assert.equal(after, before, "normalized loads should not touch the store file");
  } finally {
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("loadWorkspaceMemory does not persist pure ordering normalization", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "wm-ordering-"));
  const dataHome = join(sandbox, "xdg-data-home");
  const root = join(sandbox, "workspace");
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;

  try {
    await mkdir(root, { recursive: true });
    const now = "2026-04-28T00:00:00.000Z";
    await saveWorkspaceMemory(root, {
      version: 1,
      workspace: { root, key: "test" },
      limits: {
        maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars,
        maxEntries: LONG_TERM_LIMITS.maxEntries,
      },
      entries: [
        {
          ...entry("feedback-first", "High priority feedback memory", "feedback"),
          source: "explicit",
          confidence: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          ...entry("reference-second", "Lower priority reference memory", "reference"),
          source: "compaction",
          confidence: 0.75,
          createdAt: now,
          updatedAt: now,
        },
      ],
      migrations: [],
      updatedAt: now,
    });

    const storePath = await workspaceMemoryPath(root);
    const canonical = JSON.parse(await readFile(storePath, "utf-8")) as WorkspaceMemoryStore;
    await writeFile(
      storePath,
      JSON.stringify({ ...canonical, entries: [...canonical.entries].reverse() }, null, 2),
      "utf-8",
    );

    const before = (await stat(storePath)).mtimeMs;
    await sleep(20);
    const loaded = await loadWorkspaceMemory(root);
    const after = (await stat(storePath)).mtimeMs;

    assert.deepEqual(loaded.entries.map(memory => memory.id), ["feedback-first", "reference-second"]);
    assert.equal(after, before, "order-only normalization should not write during load");
  } finally {
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("loadWorkspaceMemory persists redaction changes and is stable afterward", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "wm-redact-stable-"));
  const dataHome = join(sandbox, "xdg-data-home");
  const root = join(sandbox, "workspace");
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;

  try {
    await mkdir(root, { recursive: true });
    const now = "2026-04-28T00:00:00.000Z";
    const unredactedStore: WorkspaceMemoryStore = {
      version: 1,
      workspace: { root, key: "test" },
      limits: {
        maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars,
        maxEntries: LONG_TERM_LIMITS.maxEntries,
      },
      entries: [
        {
          id: "bearer-secret",
          text: "Authorization: Bearer sk-test-123",
          rationale: "password: sushi",
          type: "reference",
          source: "manual",
          confidence: 0.9,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      ],
      migrations: ["2026-04-26-p0-cleanup"],
      updatedAt: now,
    };

    const storePath = await workspaceMemoryPath(root);
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, JSON.stringify(unredactedStore, null, 2), "utf-8");

    const loaded = await loadWorkspaceMemory(root);
    assert.equal(loaded.entries[0].text, "Authorization: Bearer [REDACTED]");
    assert.equal(loaded.entries[0].rationale, "password: [REDACTED]");

    const persistedAfterFirstLoad = await readFile(storePath, "utf-8");
    assert.equal(persistedAfterFirstLoad.includes("sk-test-123"), false);
    assert.equal(persistedAfterFirstLoad.includes("sushi"), false);

    const beforeSecondLoad = (await stat(storePath)).mtimeMs;
    await sleep(20);
    await loadWorkspaceMemory(root);
    const afterSecondLoad = (await stat(storePath)).mtimeMs;
    assert.equal(afterSecondLoad, beforeSecondLoad, "second load should not rewrite redacted content");
  } finally {
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("loadWorkspaceMemory normalizes and persists credentials from legacy unredacted store", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "wm-redact-"));
  const dataHome = join(sandbox, "xdg-data-home");
  const root = join(sandbox, "workspace");
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;

  try {
    const now = new Date().toISOString();
    // Write UNREDACTED JSON directly to disk (simulating legacy store)
    const unredactedStore: WorkspaceMemoryStore = {
      version: 1,
      workspace: { root, key: "test" },
      limits: {
        maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars,
        maxEntries: LONG_TERM_LIMITS.maxEntries,
      },
      entries: [
        {
          id: "cred-1",
          text: "Admin PIN 是 456123",
          type: "project",
          source: "compaction",
          confidence: 0.75,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      ],
      migrations: [],
      updatedAt: now,
    };

    // Write directly to disk WITHOUT using saveWorkspaceMemory (which would redact)
    const { mkdir, writeFile } = await import("node:fs/promises");
    const storePath = await workspaceMemoryPath(root);
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, JSON.stringify(unredactedStore, null, 2), "utf-8");

    // Load should normalize and redact
    const loaded = await loadWorkspaceMemory(root);
    assert.equal(loaded.entries[0].text, "Admin PIN 是 [REDACTED]");

    // Verify persisted to disk (not just in-memory)
    const { readFile } = await import("node:fs/promises");
    const persistedRaw = await readFile(storePath, "utf-8");
    const persisted = JSON.parse(persistedRaw);
    assert.equal(persisted.entries[0].text, "Admin PIN 是 [REDACTED]");
  } finally {
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
    await rm(sandbox, { recursive: true, force: true });
  }
});
