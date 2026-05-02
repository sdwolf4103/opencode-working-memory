import {
  RETENTION_TYPE_MAX,
  calculateRetentionStrength,
} from "../../src/retention.ts";
import type { LongTermMemoryEntry, LongTermSource, LongTermType, WorkspaceMemoryStore } from "../../src/types.ts";
import { LONG_TERM_LIMITS, PROMOTION_RETRY_LIMITS } from "../../src/types.ts";
import type { RetentionDiagItem } from "./types.ts";

export function ageDays(entry: LongTermMemoryEntry, now = Date.now()): number | null {
  const time = new Date(entry.createdAt).getTime();
  if (Number.isNaN(time)) return null;
  return Math.floor((now - time) / 86_400_000);
}

export function formatStrength(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : "0.000";
}

export function daysSinceIso(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (now - ms) / 86_400_000);
}

export function isSafetyCriticalForDiag(entry: LongTermMemoryEntry): boolean {
  return entry.safetyCritical === true;
}

export function retentionCandidatesForDiag(store: WorkspaceMemoryStore, now = Date.now()): {
  sorted: RetentionDiagItem[];
  rendered: RetentionDiagItem[];
  typeCapped: RetentionDiagItem[];
  globalCapped: RetentionDiagItem[];
} {
  const active = store.entries.filter(entry => entry.status !== "superseded");
  const sorted = active
    .map(entry => ({ entry, strength: calculateRetentionStrength(entry, now, store.lastActivityAt) }))
    .sort((a, b) => b.strength - a.strength || a.entry.id.localeCompare(b.entry.id));

  const rendered: RetentionDiagItem[] = [];
  const typeCapped: RetentionDiagItem[] = [];
  const globalCapped: RetentionDiagItem[] = [];
  const typeCounts: Partial<Record<LongTermType, number>> = {};

  for (const item of sorted) {
    const count = typeCounts[item.entry.type] ?? 0;
    const max = RETENTION_TYPE_MAX[item.entry.type] ?? Infinity;
    if (count >= max) {
      typeCapped.push(item);
      continue;
    }
    typeCounts[item.entry.type] = count + 1;

    if (rendered.length < LONG_TERM_LIMITS.maxEntries) {
      rendered.push(item);
    } else {
      globalCapped.push(item);
    }
  }

  return { sorted, rendered, typeCapped, globalCapped };
}

export function promotionLimit(source: LongTermSource): number {
  if (source === "manual") return PROMOTION_RETRY_LIMITS.maxManualAttempts;
  return PROMOTION_RETRY_LIMITS.maxExplicitAttempts;
}

export function retentionClockSummary(entries: LongTermMemoryEntry[]): { present: number; missing: number; invalid: number } {
  let present = 0;
  let missing = 0;
  let invalid = 0;
  for (const entry of entries) {
    if (entry.retentionClock === undefined) {
      missing += 1;
    } else if (!Number.isFinite(entry.retentionClock) || entry.retentionClock <= 0) {
      invalid += 1;
    } else {
      present += 1;
    }
  }
  return { present, missing, invalid };
}
