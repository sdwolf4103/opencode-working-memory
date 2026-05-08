import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "./types.ts";

// Retention decay model constants (v1.5)
export const BASE_HALF_LIFE_DAYS = 45;
export const REINFORCEMENT_HALFLIFE_FACTOR = 0.85;
export const REINFORCEMENT_MAX_COUNT = 6;
export const REINFORCEMENT_MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const WORKSPACE_DORMANT_AFTER_DAYS = 14;
export const DORMANT_DECAY_MULTIPLIER = 0.25;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const TYPE_FACTOR = {
  reference: 1.0,
  project: 1.25,
  feedback: 2.25,
  decision: 2.5,
} as const;

export const SOURCE_FACTOR = {
  compaction: 1.0,
  manual: 1.4,
  explicit: 2.0,
} as const;

export const USER_IMPORTANCE_FACTOR = {
  low: 0.7,
  normal: 1.0,
  high: 1.5,
} as const;

export const RETENTION_TYPE_MAX = {
  feedback: 10,
  decision: 12,
  project: 8,
  reference: 6,
} as const;

export function calculateInitialStrength(memory: LongTermMemoryEntry): number {
  const typeFactor = TYPE_FACTOR[memory.type] ?? 1.0;
  const sourceFactor = SOURCE_FACTOR[memory.source] ?? 1.0;
  const importanceFactor = USER_IMPORTANCE_FACTOR[memory.userImportance ?? "normal"] ?? 1.0;

  return typeFactor * sourceFactor * importanceFactor;
}

export function calculateEffectiveHalfLife(memory: LongTermMemoryEntry): number {
  const reinforcementCount = Math.min(
    memory.reinforcementCount ?? 0,
    REINFORCEMENT_MAX_COUNT,
  );
  const factor = Math.pow(REINFORCEMENT_HALFLIFE_FACTOR, reinforcementCount);
  return BASE_HALF_LIFE_DAYS / factor;
}

function timestampMs(value: unknown, fallback: number): number {
  const ms = typeof value === "number" ? value : new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : fallback;
}

export function calculateRetentionStrength(
  memory: LongTermMemoryEntry,
  now: number,
  lastActivityAt?: string,
): number {
  const initialStrength = calculateInitialStrength(memory);
  const effectiveHalfLife = calculateEffectiveHalfLife(memory);

  // Use retentionClock if available, fallback to updatedAt.
  const retentionStart = Number.isFinite(memory.retentionClock)
    ? memory.retentionClock
    : memory.updatedAt ?? memory.createdAt;
  const createdAtMs = timestampMs(retentionStart, now);
  const effectiveAgeDays = calculateEffectiveAgeDays(createdAtMs, now, lastActivityAt);

  // Calculate strength using exponential decay.
  const strength = initialStrength * Math.pow(2, -effectiveAgeDays / effectiveHalfLife);

  return Number.isFinite(strength) ? Math.max(0, strength) : 0;
}

export function calculateDormantDays(store: WorkspaceMemoryStore, now: number): number {
  const lastActivity = store.lastActivityAt
    ? new Date(store.lastActivityAt).getTime()
    : now;
  if (!Number.isFinite(lastActivity)) return 0;

  const daysSinceActivity = (now - lastActivity) / DAY_MS;
  return Math.max(0, daysSinceActivity);
}

export function calculateEffectiveAgeDays(
  entryStartMs: number,
  now: number,
  lastActivityAt?: string,
): number {
  const wallAgeDays = Math.max(0, (now - entryStartMs) / DAY_MS);

  if (!lastActivityAt) return wallAgeDays;

  const lastActivityMs = new Date(lastActivityAt).getTime();
  if (!Number.isFinite(lastActivityMs)) return wallAgeDays;

  const dormantStartMs = lastActivityMs + WORKSPACE_DORMANT_AFTER_DAYS * DAY_MS;
  const overlapStartMs = Math.max(entryStartMs, dormantStartMs);
  const dormantOverlapDays = Math.max(0, (now - overlapStartMs) / DAY_MS);
  const activeDays = wallAgeDays - dormantOverlapDays;

  return activeDays + dormantOverlapDays * DORMANT_DECAY_MULTIPLIER;
}

function isSameUTCCalendarDay(ts1: number, ts2: number): boolean {
  const d1 = new Date(ts1);
  const d2 = new Date(ts2);
  return d1.getUTCFullYear() === d2.getUTCFullYear()
    && d1.getUTCMonth() === d2.getUTCMonth()
    && d1.getUTCDate() === d2.getUTCDate();
}

export function reinforceMemory(
  memory: LongTermMemoryEntry,
  sessionId: string,
  now: number,
): LongTermMemoryEntry {
  if (memory.lastReinforcedSessionID === sessionId) {
    return memory;
  }

  // Calendar-day diversity gate (OQ-2): same UTC day = no reinforcement.
  if (memory.lastReinforcedAt && isSameUTCCalendarDay(memory.lastReinforcedAt, now)) {
    return memory;
  }

  if (memory.lastReinforcedAt && now - memory.lastReinforcedAt < REINFORCEMENT_MIN_INTERVAL_MS) {
    return memory;
  }

  if ((memory.reinforcementCount ?? 0) >= REINFORCEMENT_MAX_COUNT) {
    return memory;
  }

  return {
    ...memory,
    reinforcementCount: (memory.reinforcementCount ?? 0) + 1,
    lastReinforcedAt: now,
    lastReinforcedSessionID: sessionId,
    retentionClock: now,
  };
}
