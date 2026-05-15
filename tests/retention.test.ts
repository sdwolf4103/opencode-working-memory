import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_HALF_LIFE_DAYS,
  REINFORCEMENT_MAX_COUNT,
  tryReinforceMemory,
} from "../src/retention.ts";
import type { LongTermMemoryEntry } from "../src/types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const ROLLING_WINDOW_MS = 7 * DAY_MS;

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

test("tryReinforceMemory allows same session after rolling 8 days", () => {
  const lastAt = Date.UTC(2026, 4, 8, 12, 0, 0);
  const now = lastAt + 8 * DAY_MS;
  const memory = baseMemory({
    reinforcementCount: 1,
    lastReinforcedAt: lastAt,
    lastReinforcedSessionID: "session-a",
    retentionClock: lastAt,
  });

  const decision = tryReinforceMemory(memory, "session-a", now);

  assert.equal(decision.outcome, "reinforced");
  assert.equal(decision.reinforcementMode, "increment");
  assert.equal(decision.previousReinforcementCount, 1);
  assert.equal(decision.newReinforcementCount, 2);
  assert.equal(decision.memory.reinforcementCount, 2);
  assert.equal(decision.memory.retentionClock, now);
  assert.equal(decision.memory.lastReinforcedAt, now);
  assert.equal(decision.memory.lastReinforcedSessionID, "session-a");
  assert.equal(decision.sameSession, true);
  assert.equal(decision.elapsedMs, 8 * DAY_MS);
  assert.equal(decision.requiredElapsedMs, ROLLING_WINDOW_MS);
});

test("tryReinforceMemory allows exactly 7 rolling days after last reinforcement", () => {
  const lastAt = Date.UTC(2026, 4, 8, 12, 0, 0);
  const now = lastAt + ROLLING_WINDOW_MS;
  const memory = baseMemory({
    reinforcementCount: 5,
    lastReinforcedAt: lastAt,
    lastReinforcedSessionID: "session-a",
    retentionClock: lastAt,
  });

  const decision = tryReinforceMemory(memory, "session-b", now);

  assert.equal(decision.outcome, "reinforced");
  assert.equal(decision.reinforcementMode, "increment");
  assert.equal(decision.memory.reinforcementCount, 6);
  assert.equal(decision.memory.retentionClock, now);
  assert.equal(decision.memory.lastReinforcedAt, now);
  assert.equal(decision.memory.lastReinforcedSessionID, "session-b");
  assert.equal(decision.sameSession, false);
  assert.equal(decision.elapsedMs, ROLLING_WINDOW_MS);
  assert.equal(decision.requiredElapsedMs, ROLLING_WINDOW_MS);
});

test("tryReinforceMemory blocks 7 rolling days minus 1ms as min_elapsed_window", () => {
  const lastAt = Date.UTC(2026, 4, 8, 12, 0, 0);
  const now = lastAt + ROLLING_WINDOW_MS - 1;
  const memory = baseMemory({
    reinforcementCount: 1,
    lastReinforcedAt: lastAt,
    lastReinforcedSessionID: "session-a",
  });

  const decision = tryReinforceMemory(memory, "session-a", now);

  assert.equal(decision.outcome, "blocked");
  assert.equal(decision.blockReason, "min_elapsed_window");
  assert.equal(decision.memory, memory);
  assert.equal(decision.sameSession, true);
  assert.equal(decision.lastReinforcedAt, lastAt);
  assert.equal(decision.elapsedMs, ROLLING_WINDOW_MS - 1);
  assert.equal(decision.requiredElapsedMs, ROLLING_WINDOW_MS);
});

test("tryReinforceMemory blocks different session below rolling window", () => {
  const lastAt = Date.UTC(2026, 4, 8, 12, 0, 0);
  const now = lastAt + 3 * DAY_MS;
  const memory = baseMemory({
    reinforcementCount: 1,
    lastReinforcedAt: lastAt,
    lastReinforcedSessionID: "session-a",
  });

  const decision = tryReinforceMemory(memory, "session-b", now);

  assert.equal(decision.outcome, "blocked");
  assert.equal(decision.blockReason, "min_elapsed_window");
  assert.equal(decision.sameSession, false);
  assert.equal(decision.elapsedMs, 3 * DAY_MS);
  assert.equal(decision.requiredElapsedMs, ROLLING_WINDOW_MS);
});

test("tryReinforceMemory blocks UTC midnight crossing below rolling window", () => {
  const lastAt = Date.UTC(2026, 4, 12, 23, 45, 0);
  const now = Date.UTC(2026, 4, 13, 2, 15, 0);
  const memory = baseMemory({
    reinforcementCount: 1,
    lastReinforcedAt: lastAt,
    lastReinforcedSessionID: "session-a",
  });

  const decision = tryReinforceMemory(memory, "session-b", now);

  assert.equal(decision.outcome, "blocked");
  assert.equal(decision.blockReason, "min_elapsed_window");
  assert.notEqual(decision.blockReason, "same_utc_day");
  assert.equal(decision.elapsedMs, now - lastAt);
  assert.equal(decision.requiredElapsedMs, ROLLING_WINDOW_MS);
});

test("tryReinforceMemory refreshes saturated count after rolling window", () => {
  const lastAt = Date.UTC(2026, 4, 8, 12, 0, 0);
  const now = lastAt + ROLLING_WINDOW_MS;
  const memory = baseMemory({
    reinforcementCount: REINFORCEMENT_MAX_COUNT,
    lastReinforcedAt: lastAt,
    lastReinforcedSessionID: "session-a",
    retentionClock: lastAt,
  });

  const decision = tryReinforceMemory(memory, "session-b", now);

  assert.equal(decision.outcome, "reinforced");
  assert.equal(decision.reinforcementMode, "refresh_only");
  assert.equal(decision.previousReinforcementCount, REINFORCEMENT_MAX_COUNT);
  assert.equal(decision.newReinforcementCount, REINFORCEMENT_MAX_COUNT);
  assert.notEqual(decision.memory, memory);
  assert.equal(decision.memory.reinforcementCount, REINFORCEMENT_MAX_COUNT);
  assert.equal(decision.memory.lastReinforcedAt, now);
  assert.equal(decision.memory.lastReinforcedSessionID, "session-b");
  assert.equal(decision.memory.retentionClock, now);
  assert.equal(decision.elapsedMs, ROLLING_WINDOW_MS);
  assert.equal(decision.requiredElapsedMs, ROLLING_WINDOW_MS);
});

test("tryReinforceMemory blocks saturated count below rolling window as min_elapsed_window", () => {
  const lastAt = Date.UTC(2026, 4, 8, 12, 0, 0);
  const now = lastAt + ROLLING_WINDOW_MS - 1;
  const memory = baseMemory({
    reinforcementCount: REINFORCEMENT_MAX_COUNT,
    lastReinforcedAt: lastAt,
    lastReinforcedSessionID: "session-a",
  });

  const decision = tryReinforceMemory(memory, "session-b", now);

  assert.equal(decision.outcome, "blocked");
  assert.equal(decision.blockReason, "min_elapsed_window");
  assert.notEqual(decision.blockReason, "max_count");
  assert.equal(decision.reinforcementCount, REINFORCEMENT_MAX_COUNT);
  assert.equal(decision.maxReinforcementCount, REINFORCEMENT_MAX_COUNT);
  assert.equal(decision.requiredElapsedMs, ROLLING_WINDOW_MS);
});

test("tryReinforceMemory normalizes missing legacy timestamp while incrementing", () => {
  const now = Date.UTC(2026, 4, 12, 12, 0, 0);
  const memory = baseMemory({
    reinforcementCount: 2,
    lastReinforcedSessionID: "session-a",
  });

  const decision = tryReinforceMemory(memory, "session-b", now);

  assert.equal(decision.outcome, "reinforced");
  assert.equal(decision.reinforcementMode, "increment");
  assert.equal(decision.legacyMissingTimestamp, true);
  assert.equal(decision.memory.reinforcementCount, 3);
  assert.equal(decision.memory.lastReinforcedAt, now);
  assert.equal(decision.memory.retentionClock, now);
});

test("tryReinforceMemory normalizes invalid legacy timestamp while refresh-only saturated", () => {
  const now = Date.UTC(2026, 4, 12, 12, 0, 0);
  const memory = baseMemory({
    reinforcementCount: REINFORCEMENT_MAX_COUNT,
    lastReinforcedAt: Number.NaN,
    lastReinforcedSessionID: "session-a",
    retentionClock: Date.UTC(2026, 4, 8, 12, 0, 0),
  });

  const decision = tryReinforceMemory(memory, "session-b", now);

  assert.equal(decision.outcome, "reinforced");
  assert.equal(decision.reinforcementMode, "refresh_only");
  assert.equal(decision.legacyMissingTimestamp, true);
  assert.equal(decision.memory.reinforcementCount, REINFORCEMENT_MAX_COUNT);
  assert.equal(decision.memory.lastReinforcedAt, now);
  assert.equal(decision.memory.retentionClock, now);
});

test("BASE_HALF_LIFE_DAYS remains 45", () => {
  assert.equal(BASE_HALF_LIFE_DAYS, 45);
});
