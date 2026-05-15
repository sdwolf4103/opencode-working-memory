import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "./types.ts";

export type ReinforcementBlockReason =
  | "min_elapsed_window"
  /** @deprecated Historical diagnostic literal; no longer produced by new policy. */
  | "same_session"
  /** @deprecated Historical diagnostic literal; no longer produced by new policy. */
  | "same_utc_day"
  /** @deprecated Historical diagnostic literal; no longer produced by new policy. */
  | "min_interval"
  /** @deprecated Historical diagnostic literal; no longer produced by new policy. */
  | "max_count";

export type ReinforcementMode = "increment" | "refresh_only";

type ReinforcementDecisionMetadata = {
  attemptedAt: number;
  lastReinforcedAt?: number;
  elapsedMs?: number;
  requiredElapsedMs: number;
  sameSession: boolean;
  legacyMissingTimestamp?: boolean;
};

export type ReinforcementDecision =
  | ({
      outcome: "reinforced";
      memory: LongTermMemoryEntry;
      previousReinforcementCount: number;
      newReinforcementCount: number;
      reinforcementMode: ReinforcementMode;
    } & ReinforcementDecisionMetadata)
  | ({
      outcome: "blocked";
      memory: LongTermMemoryEntry;
      blockReason: ReinforcementBlockReason;
      reinforcementCount: number;
      maxReinforcementCount: number;
    } & ReinforcementDecisionMetadata);

// Retention decay model constants (v1.5)
export const BASE_HALF_LIFE_DAYS = 45;
export const REINFORCEMENT_HALFLIFE_FACTOR = 0.85;
export const REINFORCEMENT_MAX_COUNT = 6;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const REINFORCEMENT_MIN_ELAPSED_MS = 7 * DAY_MS;
export const REINFORCEMENT_MIN_INTERVAL_MS = 60 * 60 * 1000; // Deprecated compatibility constant; new policy uses REINFORCEMENT_MIN_ELAPSED_MS.
export const WORKSPACE_DORMANT_AFTER_DAYS = 14;
export const DORMANT_DECAY_MULTIPLIER = 0.25;

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

export function tryReinforceMemory(
  memory: LongTermMemoryEntry,
  sessionId: string,
  now: number,
): ReinforcementDecision {
  const count = memory.reinforcementCount ?? 0;
  const lastAt = validLastReinforcedAt(memory.lastReinforcedAt);
  const lastSession = memory.lastReinforcedSessionID;
  const sameSession = lastSession === sessionId;
  const legacyMissingTimestamp = count > 0 && lastAt === undefined;
  const metadata: ReinforcementDecisionMetadata = {
    attemptedAt: now,
    ...(lastAt !== undefined ? {
      lastReinforcedAt: lastAt,
      elapsedMs: now - lastAt,
    } : {}),
    requiredElapsedMs: REINFORCEMENT_MIN_ELAPSED_MS,
    sameSession,
    ...(legacyMissingTimestamp ? { legacyMissingTimestamp: true } : {}),
  };

  if (lastAt !== undefined && now - lastAt < REINFORCEMENT_MIN_ELAPSED_MS) {
    return blockedDecision(memory, "min_elapsed_window", count, metadata);
  }

  const reinforcementMode: ReinforcementMode = count >= REINFORCEMENT_MAX_COUNT
    ? "refresh_only"
    : "increment";
  const newReinforcementCount = reinforcementMode === "refresh_only" ? count : count + 1;
  const reinforced: LongTermMemoryEntry = {
    ...memory,
    reinforcementCount: newReinforcementCount,
    lastReinforcedAt: now,
    lastReinforcedSessionID: sessionId,
    retentionClock: now,
  };
  return {
    outcome: "reinforced",
    memory: reinforced,
    previousReinforcementCount: count,
    newReinforcementCount,
    reinforcementMode,
    ...metadata,
  };
}

function validLastReinforcedAt(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function blockedDecision(
  memory: LongTermMemoryEntry,
  blockReason: ReinforcementBlockReason,
  reinforcementCount: number,
  metadata: ReinforcementDecisionMetadata,
): ReinforcementDecision {
  return {
    outcome: "blocked",
    memory,
    blockReason,
    reinforcementCount,
    maxReinforcementCount: REINFORCEMENT_MAX_COUNT,
    ...metadata,
  };
}
