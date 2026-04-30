import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "../src/types.ts";
import { HOT_STATE_LIMITS, LONG_TERM_LIMITS } from "../src/types.ts";
import { workspaceKey, workspaceMemoryPath } from "../src/paths.ts";
import {
  renderWorkspaceMemory,
  accountWorkspaceMemoryRender,
  enforceLongTermLimits,
  dedupeLongTermEntriesWithAccounting,
  enforceLongTermLimitsWithAccounting,
  normalizeWorkspaceMemoryWithAccounting,
  workspaceMemoryExactKey,
  workspaceMemoryIdentityKey,
  runMigrationP0Cleanup,
  runMigrationQualityCleanup,
  loadWorkspaceMemory,
  saveWorkspaceMemory,
  updateWorkspaceMemoryWithAccounting,
} from "../src/workspace-memory.ts";
import {
  RETENTION_TYPE_MAX,
  calculateInitialStrength,
  calculateEffectiveHalfLife,
  calculateRetentionStrength,
  calculateDormantDays,
  calculateEffectiveAgeDays,
  reinforceMemory,
} from "../src/retention.ts";
import { redactCredentials } from "../src/redaction.ts";
import { assessMemoryQuality, isHardQualityReason, isProgressSnapshotViolation } from "../src/memory-quality.ts";
import { reviewerCurrent28Fixture } from "./fixtures/memory-quality-current-28.ts";
import { REAL_WORKSPACE_FIXTURES } from "./fixtures/real-workspaces-snapshot.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

test("default prompt budgets use calibrated conservative character caps", () => {
  assert.equal(LONG_TERM_LIMITS.maxRenderedChars, 3600);
  assert.equal(LONG_TERM_LIMITS.targetRenderedChars, 3000);
  assert.equal(HOT_STATE_LIMITS.maxRenderedChars, 700);
});

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

test("accountWorkspaceMemoryRender reports rendered and omitted reasons", () => {
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root: "/repo", key: "abc" },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    entries: [
      ...Array.from({ length: 12 }, (_, i) => entry(`feedback-render-${i}`, `Unique rendered feedback preference ${i}`, "feedback")),
      { ...entry("superseded-render", "Old superseded memory", "decision"), status: "superseded" as const },
    ],
    updatedAt: new Date().toISOString(),
  };

  const accounting = accountWorkspaceMemoryRender(store);

  assert.equal(accounting.rendered.length, 10);
  assert.ok(accounting.omitted.some(item => item.reason === "type_cap"));
  assert.ok(accounting.omitted.some(item => item.reason === "superseded"));
  assert.ok(accounting.evidence.some(event => event.type === "render_selected"));
  assert.ok(accounting.evidence.some(event => event.type === "render_omitted" && event.reasonCodes.includes("type_cap")));
});

test("accountWorkspaceMemoryRender reports char budget and empty budget omissions", () => {
  const charBudgetStore: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root: "/repo", key: "abc" },
    limits: { maxRenderedChars: 180, maxEntries: LONG_TERM_LIMITS.maxEntries },
    entries: Array.from({ length: 3 }, (_, i) => entry(`char-budget-${i}`, `Long rendered memory ${i} `.repeat(20), "decision")),
    updatedAt: new Date().toISOString(),
  };
  const emptyBudgetStore: WorkspaceMemoryStore = {
    ...charBudgetStore,
    limits: { maxRenderedChars: 10, maxEntries: LONG_TERM_LIMITS.maxEntries },
  };

  const charBudget = accountWorkspaceMemoryRender(charBudgetStore);
  const emptyBudget = accountWorkspaceMemoryRender(emptyBudgetStore);

  assert.ok(charBudget.omitted.some(item => item.reason === "char_budget"));
  assert.ok(emptyBudget.omitted.some(item => item.reason === "empty_render_budget"));
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

test("calculateInitialStrength multiplies type, source, and importance factors", () => {
  const memory: LongTermMemoryEntry = {
    ...entry("strength", "Never store raw credentials", "reference"),
    source: "explicit",
    userImportance: "high",
    safetyCritical: true,
  };

  assert.equal(calculateInitialStrength(memory), 3);
});

test("calculateInitialStrength ignores deprecated safetyCritical field", () => {
  const memory: LongTermMemoryEntry = {
    ...entry("safety-deprecated", "Deprecated safety field should not affect strength", "decision"),
    source: "explicit",
    userImportance: "high",
    safetyCritical: true,
  };

  const withoutSafety = { ...memory, safetyCritical: undefined };

  assert.equal(calculateInitialStrength(memory), calculateInitialStrength(withoutSafety));
});

test("calculateEffectiveHalfLife clamps reinforcement count at configured maximum", () => {
  const unreinforced = entry("unreinforced", "Use pnpm for this project");
  const overReinforced: LongTermMemoryEntry = {
    ...entry("over-reinforced", "Use npm scripts for verification"),
    reinforcementCount: 99,
  };

  assert.equal(calculateEffectiveHalfLife(unreinforced), 45);
  assert.equal(
    calculateEffectiveHalfLife(overReinforced),
    45 / Math.pow(0.85, 6),
  );
});

test("calculateRetentionStrength slows decay for dormancy after activity grace", () => {
  const now = Date.UTC(2026, 3, 29);
  const nineteenDaysAgo = now - 19 * DAY_MS;
  const memory: LongTermMemoryEntry = {
    ...entry("retention-clock", "Use TypeScript for plugin code", "reference"),
    source: "compaction",
    retentionClock: nineteenDaysAgo,
    updatedAt: new Date(now).toISOString(),
  };

  // 19 wall-clock days since last activity: 14 active days + 5 dormant days at 25% = 15.25 effective days.
  const lastActivityAt = new Date(nineteenDaysAgo).toISOString();
  const expectedEffectiveAgeDays = 14 + 5 * 0.25;
  const expected = Math.pow(2, -expectedEffectiveAgeDays / 45);

  assert.equal(calculateRetentionStrength(memory, now, lastActivityAt), expected);
});

test("calculateEffectiveAgeDays matches plan worked dormant example", () => {
  const now = Date.UTC(2026, 3, 29);
  const twentyEightDaysAgo = now - 28 * DAY_MS;

  assert.equal(
    calculateEffectiveAgeDays(twentyEightDaysAgo, now, new Date(twentyEightDaysAgo).toISOString()),
    17.5,
  );
});

test("calculateRetentionStrength falls back to updatedAt when retentionClock is absent", () => {
  const now = Date.UTC(2026, 3, 29);
  const memory: LongTermMemoryEntry = {
    ...entry("updated-at", "Prefer concise verification summaries", "feedback"),
    source: "manual",
    updatedAt: new Date(now - 45 * DAY_MS).toISOString(),
  };

  const initialStrength = 2.25 * 1.4;
  assert.equal(calculateRetentionStrength(memory, now), initialStrength / 2);
});

test("calculateEffectiveAgeDays does not charge old dormancy to fresh entries", () => {
  const now = Date.UTC(2026, 3, 29);
  const lastActivityAt = new Date(now - 180 * DAY_MS).toISOString();

  assert.equal(calculateEffectiveAgeDays(now, now, lastActivityAt), 0);
});

test("calculateEffectiveAgeDays discounts dormant overlap since entry creation", () => {
  const now = Date.UTC(2026, 3, 29);
  const entryCreatedSevenDaysAgo = now - 7 * DAY_MS;
  const lastActivityAt = new Date(now - 180 * DAY_MS).toISOString();

  assert.equal(
    calculateEffectiveAgeDays(entryCreatedSevenDaysAgo, now, lastActivityAt),
    1.75,
  );
});

test("calculateRetentionStrength returns finite value for invalid updatedAt fallback", () => {
  const now = Date.UTC(2026, 3, 29);
  const memory: LongTermMemoryEntry = {
    ...entry("bad-updated-at", "Invalid timestamps should not corrupt sorting", "feedback"),
    updatedAt: "not-a-date",
    retentionClock: undefined,
  };

  const strength = calculateRetentionStrength(memory, now);

  assert.equal(Number.isFinite(strength), true);
  assert.ok(strength >= 0);
});

test("calculateRetentionStrength returns finite value for invalid retentionClock", () => {
  const now = Date.UTC(2026, 3, 29);
  const memory: LongTermMemoryEntry = {
    ...entry("bad-retention-clock", "Invalid retention clocks should fall back safely", "decision"),
    retentionClock: Number.NaN,
    updatedAt: new Date(now - 45 * DAY_MS).toISOString(),
  };

  const strength = calculateRetentionStrength(memory, now);

  assert.equal(Number.isFinite(strength), true);
  assert.ok(strength >= 0);
});

test("calculateDormantDays applies fourteen day workspace activity grace", () => {
  const now = Date.UTC(2026, 3, 29);
  const activeWithinGrace: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root: "/repo", key: "abc" },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    entries: [],
    updatedAt: new Date(now).toISOString(),
    lastActivityAt: new Date(now - 13 * DAY_MS).toISOString(),
  };
  const dormantPastGrace: WorkspaceMemoryStore = {
    ...activeWithinGrace,
    lastActivityAt: new Date(now - 20 * DAY_MS).toISOString(),
  };

  assert.equal(calculateDormantDays(activeWithinGrace, now), 13);
  assert.equal(calculateDormantDays(dormantPastGrace, now), 20);
});

test("normalizeWorkspaceMemoryWithAccounting uses dormant workspace days for strength ordering", async () => {
  const now = Date.now();
  const reinforcedOldReference: LongTermMemoryEntry = {
    ...entry("reinforced-old", "Project uses the legacy local plugin architecture", "project"),
    retentionClock: now - 100 * DAY_MS,
    reinforcementCount: 6,
  };
  const freshReference: LongTermMemoryEntry = {
    ...entry("fresh", "Fresh docs live at https://example.com/fresh", "reference"),
    retentionClock: now,
  };
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root: "/repo", key: "abc" },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    entries: [freshReference, reinforcedOldReference],
    updatedAt: new Date(now).toISOString(),
    lastActivityAt: new Date(now - (14 + 1000) * DAY_MS).toISOString(),
  };

  const result = await normalizeWorkspaceMemoryWithAccounting("/repo", store);

  assert.deepEqual(result.kept.map(memory => memory.id), ["reinforced-old", "fresh"]);
});

test("reinforceMemory enforces session interval and max guards", () => {
  const now = Date.UTC(2026, 3, 29);
  const base = entry("reinforce", "Durable memory should reinforce only when gated");
  const reinforced = reinforceMemory(base, "session-a", now);

  assert.notEqual(reinforced, base);
  assert.equal(reinforced.reinforcementCount, 1);
  assert.equal(reinforced.lastReinforcedAt, now);
  assert.equal(reinforced.lastReinforcedSessionID, "session-a");
  assert.equal(reinforced.retentionClock, now);

  assert.equal(reinforceMemory(reinforced, "session-a", now + 2 * 60 * 60 * 1000), reinforced);
  assert.equal(reinforceMemory(reinforced, "session-b", now + 30 * 60 * 1000), reinforced);

  const atMax: LongTermMemoryEntry = {
    ...base,
    reinforcementCount: 6,
    lastReinforcedAt: now - 2 * 60 * 60 * 1000,
  };
  assert.equal(reinforceMemory(atMax, "session-c", now), atMax);
});

test("dedupeLongTermEntriesWithAccounting reinforces absorbed exact duplicates", () => {
  const now = Date.now();
  const retained: LongTermMemoryEntry = {
    ...entry("retained", "Use pnpm for package management", "decision"),
    retentionClock: now - 10 * 24 * 60 * 60 * 1000,
    createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const duplicate: LongTermMemoryEntry = {
    ...entry("duplicate", "use pnpm for package management!!!", "decision"),
    pendingOwnerSessionID: "reinforce-session",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

  const result = dedupeLongTermEntriesWithAccounting([retained, duplicate]);

  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].id, "duplicate");
  assert.equal(result.kept[0].reinforcementCount, 1);
  assert.equal(result.kept[0].lastReinforcedSessionID, "reinforce-session");
  assert.ok(typeof result.kept[0].retentionClock === "number");
  assert.ok(result.evidence.some(event =>
    event.type === "memory_reinforced" &&
    event.reasonCodes.includes("duplicate_exact") &&
    event.relations?.some(relation => relation.role === "reinforced" && relation.memory?.memoryId === "duplicate") &&
    event.relations?.some(relation => relation.role === "reinforced_by" && relation.memory?.memoryId === "retained")
  ));
});

test("dedupeLongTermEntriesWithAccounting emits identity reinforcement evidence", () => {
  const now = Date.now();
  const retained: LongTermMemoryEntry = {
    ...entry("retained-identity", "OpenCode plugin config location: `.opencode-agenthub/current/xdg/opencode/opencode.json` in workspace", "reference"),
    retentionClock: now - 10 * DAY_MS,
  };
  const duplicate: LongTermMemoryEntry = {
    ...entry("duplicate-identity", "OpenCode plugin config: .opencode-agenthub/current/xdg/opencode/opencode.json in workspace", "reference"),
    pendingOwnerSessionID: "identity-session",
  };

  const result = dedupeLongTermEntriesWithAccounting([retained, duplicate]);

  assert.ok(result.evidence.some(event =>
    event.type === "memory_reinforced" && event.reasonCodes.includes("duplicate_identity")
  ));
});

test("reinforced memory with same initial strength and age ranks above unreinforced memory", () => {
  const now = Date.now();
  const age = now - 120 * DAY_MS;
  const unreinforced: LongTermMemoryEntry = {
    ...entry("unreinforced", "Always run typecheck before commit", "feedback"),
    retentionClock: age,
    createdAt: new Date(age).toISOString(),
    updatedAt: new Date(age).toISOString(),
  };
  const reinforced: LongTermMemoryEntry = {
    ...entry("reinforced", "Prefer functional composition over inheritance", "feedback"),
    retentionClock: age,
    createdAt: new Date(age).toISOString(),
    updatedAt: new Date(age).toISOString(),
    reinforcementCount: 6,
  };

  const kept = enforceLongTermLimits([unreinforced, reinforced]);

  assert.deepEqual(kept.map(memory => memory.id), ["reinforced", "unreinforced"]);
});

test("dedupe reinforcement does not increment for same session", () => {
  const now = Date.now();
  const existing: LongTermMemoryEntry = {
    ...entry("existing", "Use pnpm for package management", "decision"),
    source: "manual",
    pendingOwnerSessionID: "same-session",
    reinforcementCount: 1,
    lastReinforcedAt: now - 2 * 60 * 60 * 1000,
    lastReinforcedSessionID: "same-session",
  };
  const duplicate: LongTermMemoryEntry = {
    ...entry("duplicate", "use pnpm for package management!!!", "decision"),
    pendingOwnerSessionID: "same-session",
  };

  const result = dedupeLongTermEntriesWithAccounting([existing, duplicate]);
  const retained = result.kept.find(memory => memory.id === "existing");

  assert.ok(retained, "existing manual memory should be retained");
  assert.equal(retained.reinforcementCount, 1);
  assert.equal(retained.lastReinforcedSessionID, "same-session");
  assert.equal(result.evidence.some(event => event.type === "memory_reinforced"), false);
});

test("dedupe reinforcement does not increment under one hour", () => {
  const now = Date.now();
  const existing: LongTermMemoryEntry = {
    ...entry("existing", "Prefer deterministic consolidation accounting", "feedback"),
    source: "manual",
    reinforcementCount: 1,
    lastReinforcedAt: now - 30 * 60 * 1000,
    lastReinforcedSessionID: "old-session",
  };
  const duplicate: LongTermMemoryEntry = {
    ...entry("duplicate", "prefer deterministic consolidation accounting!!!", "feedback"),
    pendingOwnerSessionID: "new-session",
  };

  const result = dedupeLongTermEntriesWithAccounting([existing, duplicate]);
  const retained = result.kept.find(memory => memory.id === "existing");

  assert.ok(retained, "existing manual memory should be retained");
  assert.equal(retained.reinforcementCount, 1);
  assert.equal(retained.lastReinforcedSessionID, "old-session");
  assert.equal(result.evidence.some(event => event.type === "memory_reinforced"), false);
});

test("dedupe reinforcement does not emit evidence at max reinforcement count", () => {
  const existing: LongTermMemoryEntry = {
    ...entry("existing-max", "Prefer deterministic consolidation accounting", "feedback"),
    source: "manual",
    reinforcementCount: 6,
  };
  const duplicate: LongTermMemoryEntry = {
    ...entry("duplicate-max", "prefer deterministic consolidation accounting!!!", "feedback"),
    pendingOwnerSessionID: "new-session",
  };

  const result = dedupeLongTermEntriesWithAccounting([existing, duplicate]);

  assert.equal(result.evidence.some(event => event.type === "memory_reinforced"), false);
});

test("enforceLongTermLimits orders entries by retention strength", () => {
  const now = Date.now();
  const freshFeedback: LongTermMemoryEntry = {
    ...entry("fresh-feedback", "User prefers direct concise answers", "feedback"),
    source: "compaction",
    updatedAt: new Date(now).toISOString(),
  };
  const oldExplicitReference: LongTermMemoryEntry = {
    ...entry("old-explicit-reference", "Legacy docs are at https://example.com/old", "reference"),
    source: "explicit",
    updatedAt: new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString(),
  };

  const kept = enforceLongTermLimits([oldExplicitReference, freshFeedback]);

  assert.deepEqual(kept.map(memory => memory.id), ["fresh-feedback", "old-explicit-reference"]);
});

test("enforceLongTermLimits applies per-type caps after strength sorting", () => {
  const entries = Array.from({ length: 12 }, (_, i) =>
    entry(`feedback_${i}`, `Unique user feedback preference ${i}`, "feedback")
  );

  const kept = enforceLongTermLimits(entries);

  assert.equal(kept.length, 10);
  assert.equal(kept.filter(memory => memory.type === "feedback").length, 10);
});

test("safetyCritical entries compete under RETENTION_TYPE_MAX caps like other entries", () => {
  const safetyEntries: LongTermMemoryEntry[] = Array.from({ length: 6 }, (_, i) => ({
    ...entry(`safety-${i}`, `Safety memory ${i}`, "feedback"),
    source: "explicit",
    safetyCritical: true,
  }));

  const ordinaryEntries: LongTermMemoryEntry[] = Array.from({ length: 10 }, (_, i) => ({
    ...entry(`ordinary-${i}`, `Ordinary memory ${i}`, "feedback"),
    source: "explicit",
  }));

  const all = [...safetyEntries, ...ordinaryEntries];
  const kept = enforceLongTermLimits(all);

  const feedbackCount = kept.filter(e => e.type === "feedback").length;
  assert.equal(feedbackCount, RETENTION_TYPE_MAX.feedback);
  // safetyCritical entries are no longer exempt from type caps
  assert.ok(kept.filter(e => e.safetyCritical).length < 6);
});

test("workspace memory JSON with deprecated safetyCritical loads and competes normally", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-safety-compat-"));
  try {
    const key = await workspaceKey(root);
    const path = await workspaceMemoryPath(root);
    const now = new Date().toISOString();
    const safetyEntries: LongTermMemoryEntry[] = Array.from({ length: 6 }, (_, i) => ({
      ...entry(`safety-fixture-${i}`, `Safety fixture memory ${i}`, "feedback"),
      source: "explicit",
      userImportance: i === 0 ? "high" : "normal",
      safetyCritical: true,
    }));
    const ordinaryEntries: LongTermMemoryEntry[] = Array.from({ length: 10 }, (_, i) => ({
      ...entry(`ordinary-fixture-${i}`, `Ordinary fixture memory ${i}`, "feedback"),
      source: "explicit",
    }));
    const store: WorkspaceMemoryStore = {
      version: 1,
      workspace: { root, key },
      limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
      entries: [...safetyEntries, ...ordinaryEntries],
      migrations: [],
      updatedAt: now,
      lastActivityAt: now,
    };

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(store, null, 2), "utf8");

    const loaded = await loadWorkspaceMemory(root);
    const safetyEntry = loaded.entries.find(memory => memory.safetyCritical);
    assert.ok(safetyEntry, "fixture should include deprecated safetyCritical entries");
    assert.equal(
      calculateInitialStrength(safetyEntry),
      calculateInitialStrength({ ...safetyEntry, safetyCritical: undefined }),
    );

    const kept = enforceLongTermLimits(loaded.entries);
    assert.equal(kept.filter(memory => memory.type === "feedback").length, RETENTION_TYPE_MAX.feedback);
    assert.ok(kept.filter(memory => memory.safetyCritical).length < safetyEntries.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enforceLongTermLimits applies type caps to deprecated safetyCritical entries", () => {
  const ordinaryFeedback = Array.from({ length: 12 }, (_, i) =>
    entry(`feedback_${i}`, `Unique safe ordinary feedback preference ${i}`, "feedback")
  );
  const safetyCriticalFeedback: LongTermMemoryEntry = {
    ...entry("safety-feedback", "Never persist raw credentials in memory", "feedback"),
    safetyCritical: true,
  };

  const kept = enforceLongTermLimits([safetyCriticalFeedback, ...ordinaryFeedback]);

  assert.equal(kept.length, RETENTION_TYPE_MAX.feedback);
  assert.equal(kept.filter(memory => memory.type === "feedback").length, RETENTION_TYPE_MAX.feedback);
});

test("mixed retention scenario applies caps and reinforcement ordering", () => {
  const now = Date.now();
  const oldAge = now - 120 * DAY_MS;
  const ordinaryFeedback = Array.from({ length: 17 }, (_, i) =>
    entry(`mixed-feedback-${i}`, `Unique mixed ordinary feedback preference ${i}`, "feedback")
  );
  const decisions = Array.from({ length: 11 }, (_, i) =>
    entry(`mixed-decision-${i}`, `Unique mixed durable decision ${i}`, "decision")
  );
  const safetyCriticalFeedback: LongTermMemoryEntry = {
    ...entry("mixed-safety-feedback", "Never store production credentials in memory", "feedback"),
    safetyCritical: true,
  };
  const oldReinforcedReference: LongTermMemoryEntry = {
    ...entry("old-reinforced", "Legacy reinforced reference lives at https://example.com/reinforced", "reference"),
    retentionClock: oldAge,
    createdAt: new Date(oldAge).toISOString(),
    updatedAt: new Date(oldAge).toISOString(),
    reinforcementCount: 6,
  };
  const oldUnreinforcedReference: LongTermMemoryEntry = {
    ...entry("old-unreinforced", "Legacy unreinforced reference lives at https://example.com/unreinforced", "reference"),
    retentionClock: oldAge,
    createdAt: new Date(oldAge).toISOString(),
    updatedAt: new Date(oldAge).toISOString(),
  };
  const entries = [
    ...ordinaryFeedback,
    ...decisions,
    safetyCriticalFeedback,
    oldReinforcedReference,
    oldUnreinforcedReference,
  ];
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root: "/repo", key: "abc" },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    entries,
    updatedAt: new Date(now).toISOString(),
    lastActivityAt: new Date(now).toISOString(),
  };

  assert.ok(entries.filter(memory => memory.type === "feedback").length > 10);
  assert.ok(entries.filter(memory => memory.type === "decision").length > 10);

  const result = enforceLongTermLimitsWithAccounting(entries, store);

  assert.ok(result.kept.length <= 28);
  assert.ok(result.kept.filter(memory => memory.type === "feedback").length <= RETENTION_TYPE_MAX.feedback);
  assert.ok(result.kept.filter(memory => memory.type === "decision").length <= RETENTION_TYPE_MAX.decision);
  assert.equal(result.kept.filter(memory => memory.type === "feedback").length, RETENTION_TYPE_MAX.feedback);
  const reinforcedIndex = result.kept.findIndex(memory => memory.id === "old-reinforced");
  const unreinforcedIndex = result.kept.findIndex(memory => memory.id === "old-unreinforced");
  assert.ok(reinforcedIndex >= 0, "old reinforced reference should be kept");
  assert.ok(unreinforcedIndex >= 0, "old unreinforced reference should be kept");
  assert.ok(reinforcedIndex < unreinforcedIndex);
});

test("type max sum above global cap still respects maxEntries", () => {
  const entries: LongTermMemoryEntry[] = [
    ...Array.from({ length: 10 }, (_, i) => entry(`feedback-${i}`, `Unique feedback preference ${i}`, "feedback")),
    ...Array.from({ length: 10 }, (_, i) => entry(`decision-${i}`, `Unique durable decision ${i}`, "decision")),
    ...Array.from({ length: 8 }, (_, i) => entry(`project-${i}`, `Unique project fact ${i}`, "project")),
    ...Array.from({ length: 6 }, (_, i) => entry(`reference-${i}`, `Unique reference fact ${i}`, "reference")),
  ];

  const kept = enforceLongTermLimits(entries);

  assert.equal(entries.length, 34);
  assert.equal(kept.length, LONG_TERM_LIMITS.maxEntries);
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
  const entries = [
    ...Array.from({ length: 10 }, (_, i) => entry(`feedback_${i}`, `Capacity feedback ${i}`, "feedback")),
    ...Array.from({ length: 10 }, (_, i) => entry(`decision_${i}`, `Capacity decision ${i}`, "decision")),
    ...Array.from({ length: 8 }, (_, i) => entry(`project_${i}`, `Capacity project ${i}`, "project")),
    ...Array.from({ length: 2 }, (_, i) => entry(`reference_${i}`, `Capacity overflow reference ${i}`, "reference")),
  ].map(memory => ({ ...memory, createdAt: now, updatedAt: now }));

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
  const entries = [
    ...Array.from({ length: 10 }, (_, i) => entry(`overflow_feedback_${i}`, `Overflow feedback ${i}`, "feedback")),
    ...Array.from({ length: 10 }, (_, i) => entry(`overflow_decision_${i}`, `Overflow decision ${i}`, "decision")),
    ...Array.from({ length: 8 }, (_, i) => entry(`overflow_project_${i}`, `Overflow project ${i}`, "project")),
    entry("overflow_reference", "Overflow low strength reference", "reference"),
  ].map(memory => ({ ...memory, createdAt: now, updatedAt: now }));
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root, key: "abc" },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    migrations: ["2026-04-26-p0-cleanup"],
    entries,
    updatedAt: now,
  };

  const result = await normalizeWorkspaceMemoryWithAccounting(root, store);

  assert.equal(result.kept.length, LONG_TERM_LIMITS.maxEntries);
  assert.equal(result.store.entries.filter(entry => entry.status === "active").length, LONG_TERM_LIMITS.maxEntries);
  assert.equal(result.dropped.filter(event => event.reason === "rejected_capacity").length, 1);
});

test("normalizeWorkspaceMemoryWithAccounting retains stale entries for cap competition", async () => {
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

  assert.equal(result.kept.length, 1);
  assert.equal(result.store.entries.length, 1);
  assert.equal(result.dropped.length, 0);
  assert.equal(result.kept[0].id, "stale_normalize");
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
      store.entries.push(
        ...Array.from({ length: 10 }, (_, i) => entry(`persisted_feedback_${i}`, `Persisted feedback ${i}`, "feedback")),
        ...Array.from({ length: 10 }, (_, i) => entry(`persisted_decision_${i}`, `Persisted decision ${i}`, "decision")),
        ...Array.from({ length: 8 }, (_, i) => entry(`persisted_project_${i}`, `Persisted project ${i}`, "project")),
        entry("persisted_reference", "Persisted low strength reference", "reference"),
      );
      store.entries = store.entries.map(memory => ({ ...memory, createdAt: now, updatedAt: now }));
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

test("enforceLongTermLimits stale: old compaction entry remains eligible for cap competition", () => {
  const entries = [
    agedEntry("stale", "Compaction output contract changed from XML to HTML comments to avoid Markdown rendering issues", "decision", { daysAgo: 76, staleAfterDays: 45 }),
  ];

  const kept = enforceLongTermLimits(entries);
  assert.equal(kept.length, 1, "Stale compaction entry should decay but not be hard-pruned");
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

test("quality cleanup migration aborts supersede when audit log cannot be written", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "wm-quality-audit-fail-"));
  const dataHome = join(sandbox, "xdg-data-home");
  const root = join(sandbox, "workspace");
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  const previousConsoleError = console.error;
  process.env.XDG_DATA_HOME = dataHome;
  console.error = () => {};

  try {
    await mkdir(root, { recursive: true });
    const now = "2026-04-28T00:00:00.000Z";
    const storePath = await workspaceMemoryPath(root);
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, JSON.stringify({
      version: 1,
      workspace: { root, key: await workspaceKey(root) },
      limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
      entries: [{
        id: "hard_progress",
        type: "project",
        text: "Test suite: 1237 tests pass, 226 suites",
        source: "compaction",
        confidence: 0.75,
        status: "active",
        createdAt: now,
        updatedAt: now,
        staleAfterDays: 60,
      }],
      migrations: [],
      updatedAt: now,
    }, null, 2), "utf8");

    const blockedLogDir = join(dataHome, "opencode-working-memory", "migration-logs");
    await writeFile(blockedLogDir, "not a directory", "utf8");

    const loaded = await loadWorkspaceMemory(root);
    const persisted = JSON.parse(await readFile(storePath, "utf8")) as WorkspaceMemoryStore;

    assert.equal(loaded.entries.find(entry => entry.id === "hard_progress")?.status, "active");
    assert.equal(persisted.entries.find(entry => entry.id === "hard_progress")?.status, "active");
    assert.equal(loaded.migrations?.includes("2026-04-28-quality-cleanup"), false);
    assert.equal(persisted.migrations?.includes("2026-04-28-quality-cleanup"), false);
  } finally {
    console.error = previousConsoleError;
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgDataHome;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("real workspace regression fixture is de-identified and English-only", () => {
  const cjkText = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const identifyingTerms = [
    "medical-atlas",
    "opencode-record",
    "agent-reports",
    "pdf-extraction",
    "self-repo",
    "OpenCode Working Memory",
  ];
  const failures: string[] = [];

  for (const [workspaceName, fixtureEntries] of Object.entries(REAL_WORKSPACE_FIXTURES)) {
    if (identifyingTerms.some(term => workspaceName.includes(term))) {
      failures.push(`${workspaceName}: workspace key should be generalized`);
    }

    for (const entry of fixtureEntries) {
      if (cjkText.test(entry.text)) {
        failures.push(`${workspaceName}/${entry.id}: text must be English-only`);
      }
      for (const term of identifyingTerms) {
        if (entry.text.includes(term)) {
          failures.push(`${workspaceName}/${entry.id}: text contains identifying term ${term}`);
        }
      }
    }
  }

  assert.equal(failures.length, 0, `Fixture privacy failures:\n${failures.join("\n")}`);
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

test("loadWorkspaceMemory records activity for an already normalized store", async () => {
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

    const loaded = await loadWorkspaceMemory(root);
    await loadWorkspaceMemory(root);

    const after = (await stat(storePath)).mtimeMs;
    assert.ok(after > before, "normalized loads should update workspace activity timestamp");
    assert.ok(loaded.lastActivityAt, "load should expose last activity timestamp");
  } finally {
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("loadWorkspaceMemory preserves ordering while recording activity", async () => {
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
    assert.ok(after > before, "load should write updated workspace activity timestamp");
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
    assert.ok(afterSecondLoad > beforeSecondLoad, "second load should update workspace activity timestamp");
    const persistedAfterSecondLoad = await readFile(storePath, "utf-8");
    assert.equal(persistedAfterSecondLoad.includes("sk-test-123"), false);
    assert.equal(persistedAfterSecondLoad.includes("sushi"), false);
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
