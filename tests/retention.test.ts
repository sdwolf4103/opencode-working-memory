import test from "node:test";
import assert from "node:assert/strict";
import {
  REINFORCEMENT_MAX_COUNT,
  REINFORCEMENT_MIN_INTERVAL_MS,
  tryReinforceMemory,
} from "../src/retention.ts";
import type { LongTermMemoryEntry } from "../src/types.ts";

const baseMemory = (overrides: Partial<LongTermMemoryEntry> = {}): LongTermMemoryEntry => ({
  id: "mem-retention",
  type: "decision",
  text: "Durable decision for reinforcement",
  source: "compaction",
  confidence: 0.75,
  status: "active",
  createdAt: "2026-05-10T00:00:00.000Z",
  updatedAt: "2026-05-10T00:00:00.000Z",
  ...overrides,
});

test("tryReinforceMemory blocks same session with exact reason", () => {
  const now = Date.UTC(2026, 4, 12, 12, 0, 0);
  const memory = baseMemory({
    reinforcementCount: 1,
    lastReinforcedAt: now - 2 * REINFORCEMENT_MIN_INTERVAL_MS,
    lastReinforcedSessionID: "session-a",
  });

  const decision = tryReinforceMemory(memory, "session-a", now);

  assert.equal(decision.outcome, "blocked");
  assert.equal(decision.blockReason, "same_session");
  assert.equal(decision.memory, memory);
});

test("tryReinforceMemory blocks different session on same UTC day", () => {
  const lastAt = Date.UTC(2026, 4, 12, 0, 15, 0);
  const now = Date.UTC(2026, 4, 12, 23, 30, 0);
  const memory = baseMemory({
    reinforcementCount: 1,
    lastReinforcedAt: lastAt,
    lastReinforcedSessionID: "session-a",
  });

  const decision = tryReinforceMemory(memory, "session-b", now);

  assert.equal(decision.outcome, "blocked");
  assert.equal(decision.blockReason, "same_utc_day");
  assert.equal(decision.lastReinforcedAt, lastAt);
});

test("tryReinforceMemory blocks min interval across UTC day boundary", () => {
  const lastAt = Date.UTC(2026, 4, 12, 23, 45, 0);
  const now = Date.UTC(2026, 4, 13, 0, 15, 0);
  const memory = baseMemory({
    reinforcementCount: 1,
    lastReinforcedAt: lastAt,
    lastReinforcedSessionID: "session-a",
  });

  const decision = tryReinforceMemory(memory, "session-b", now);

  assert.equal(decision.outcome, "blocked");
  assert.equal(decision.blockReason, "min_interval");
  assert.equal(decision.minIntervalMs, REINFORCEMENT_MIN_INTERVAL_MS);
});

test("tryReinforceMemory blocks max count with exact reason", () => {
  const now = Date.UTC(2026, 4, 12, 12, 0, 0);
  const memory = baseMemory({
    reinforcementCount: REINFORCEMENT_MAX_COUNT,
    lastReinforcedAt: Date.UTC(2026, 4, 10, 12, 0, 0),
    lastReinforcedSessionID: "session-a",
  });

  const decision = tryReinforceMemory(memory, "session-b", now);

  assert.equal(decision.outcome, "blocked");
  assert.equal(decision.blockReason, "max_count");
  assert.equal(decision.reinforcementCount, REINFORCEMENT_MAX_COUNT);
  assert.equal(decision.maxReinforcementCount, REINFORCEMENT_MAX_COUNT);
});

test("tryReinforceMemory reinforces allowed memory and wrapper returns memory only", () => {
  const now = Date.UTC(2026, 4, 12, 12, 0, 0);
  const memory = baseMemory({
    reinforcementCount: 1,
    lastReinforcedAt: Date.UTC(2026, 4, 10, 12, 0, 0),
    lastReinforcedSessionID: "session-a",
  });

  const decision = tryReinforceMemory(memory, "session-b", now);

  assert.equal(decision.outcome, "reinforced");
  assert.equal(decision.previousReinforcementCount, 1);
  assert.equal(decision.newReinforcementCount, 2);
  assert.notEqual(decision.memory, memory);
  assert.equal(decision.memory.reinforcementCount, 2);
  assert.equal(decision.memory.lastReinforcedAt, now);
  assert.equal(decision.memory.lastReinforcedSessionID, "session-b");
  assert.equal(decision.memory.retentionClock, now);
});
