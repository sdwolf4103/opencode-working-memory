import type { LongTermMemoryEntry, PendingMemoryJournalStore } from "./types.ts";
import { PROMOTION_RETRY_LIMITS } from "./types.ts";
import { workspaceKey, workspacePendingJournalPath } from "./paths.ts";
import { atomicWriteJSON, readJSON, updateJSON } from "./storage.ts";

/**
 * Retention limits for the pending memory journal.
 *
 * The journal is a scratchpad for memories that haven't been promoted to
 * workspace memory yet. It should not grow unboundedly:
 * - maxEntries: Hard cap on number of pending entries
 * - maxAgeDays: Prune entries older than this (compaction candidates that
 *   were never promoted)
 */
export const PENDING_JOURNAL_LIMITS = {
  maxEntries: 50,
  maxAgeDays: 30,
} as const;

function normalizeMemoryText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, " ")
    .trim();
}

export function memoryKey(entry: Pick<LongTermMemoryEntry, "type" | "text">): string {
  return `${entry.type}:${normalizeMemoryText(entry.text)}`;
}

export async function emptyPendingJournal(root: string): Promise<PendingMemoryJournalStore> {
  return {
    version: 1,
    workspace: { root, key: await workspaceKey(root) },
    entries: [],
    updatedAt: new Date().toISOString(),
  };
}

function dedupeByText(entries: LongTermMemoryEntry[]): LongTermMemoryEntry[] {
  const seen = new Set<string>();
  const result: LongTermMemoryEntry[] = [];

  for (const entry of entries) {
    const key = `${memoryKey(entry)}\u0000${entry.pendingOwnerSessionID ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }

  return result;
}

/**
 * Get the effective timestamp for an entry, preferring updatedAt over createdAt.
 * Returns 0 if both are invalid/missing.
 */
function entryTime(entry: LongTermMemoryEntry): number {
  const updatedAt = entry.updatedAt ? new Date(entry.updatedAt).getTime() : NaN;
  if (!Number.isNaN(updatedAt)) return updatedAt;

  const createdAt = entry.createdAt ? new Date(entry.createdAt).getTime() : NaN;
  if (!Number.isNaN(createdAt)) return createdAt;

  return 0;
}

function isStaleEntry(entry: LongTermMemoryEntry, maxAgeDays: number): boolean {
  const time = entryTime(entry);

  // Invalid timestamps are corruption safety and apply to every source.
  if (time === 0) return true;

  // TTL policy applies only to compaction candidates. Explicit/manual entries
  // represent user intent and should survive age while under the hard cap.
  if (entry.source !== "compaction") return false;

  return Date.now() - time > maxAgeDays * 86_400_000;
}

function applyRetention(
  entries: LongTermMemoryEntry[],
  maxEntries: number,
  maxAgeDays: number,
): LongTermMemoryEntry[] {
  const deduped = dedupeByText(entries);
  const freshEntries = deduped.filter(entry => !isStaleEntry(entry, maxAgeDays));
  const sorted = [...freshEntries].sort((a, b) => {
    const timeDiff = entryTime(b) - entryTime(a);
    if (timeDiff !== 0) return timeDiff;
    return a.id.localeCompare(b.id);
  });
  const capped = sorted.slice(0, maxEntries);
  return capped.sort((a, b) => {
    const timeDiff = entryTime(a) - entryTime(b);
    if (timeDiff !== 0) return timeDiff;
    return a.id.localeCompare(b.id);
  });
}

function normalizeJournal(
  root: string,
  store: PendingMemoryJournalStore,
): Promise<PendingMemoryJournalStore> {
  return workspaceKey(root).then(key => ({
    version: 1,
    workspace: { root, key },
    entries: applyRetention(
      Array.isArray(store.entries) ? store.entries : [],
      PENDING_JOURNAL_LIMITS.maxEntries,
      PENDING_JOURNAL_LIMITS.maxAgeDays,
    ),
    updatedAt: new Date().toISOString(),
  }));
}

export async function loadPendingJournal(root: string): Promise<PendingMemoryJournalStore> {
  const path = await workspacePendingJournalPath(root);
  const fallback = await emptyPendingJournal(root);
  const loaded = await readJSON(path, () => fallback) as Partial<PendingMemoryJournalStore>;
  return normalizeJournal(root, {
    version: loaded.version ?? 1,
    workspace: loaded.workspace ?? fallback.workspace,
    entries: Array.isArray(loaded.entries) ? loaded.entries : [],
    updatedAt: loaded.updatedAt ?? fallback.updatedAt,
  });
}

export async function savePendingJournal(root: string, store: PendingMemoryJournalStore): Promise<void> {
  await atomicWriteJSON(await workspacePendingJournalPath(root), await normalizeJournal(root, store));
}

export async function updatePendingJournal(
  root: string,
  updater: (store: PendingMemoryJournalStore) => PendingMemoryJournalStore | Promise<PendingMemoryJournalStore>,
): Promise<PendingMemoryJournalStore> {
  const path = await workspacePendingJournalPath(root);
  const fallback = await emptyPendingJournal(root);
  return updateJSON(path, () => fallback, async current => {
    const normalized = await normalizeJournal(root, current);
    return normalizeJournal(root, await updater(normalized));
  });
}

export async function appendPendingMemories(root: string, memories: LongTermMemoryEntry[]): Promise<void> {
  if (memories.length === 0) return;
  await updatePendingJournal(root, store => {
    store.entries.push(...memories);
    return store;
  });
}

export async function hasPendingJournalEntries(root: string): Promise<boolean> {
  const journal = await loadPendingJournal(root);
  return journal.entries.length > 0;
}

export async function clearPendingMemories(
  root: string,
  keys?: Set<string>,
  options: { ownerSessionID?: string; clearUnowned?: boolean } = {},
): Promise<void> {
  await updatePendingJournal(root, store => {
    if (!keys || keys.size === 0) {
      store.entries = [];
      return store;
    }

    store.entries = store.entries.filter(entry => {
      if (!keys.has(memoryKey(entry))) return true;

      if (options.ownerSessionID) {
        if (entry.pendingOwnerSessionID === options.ownerSessionID) return false;
        if (options.clearUnowned && !entry.pendingOwnerSessionID) return false;
        return true;
      }

      if (options.clearUnowned) {
        return Boolean(entry.pendingOwnerSessionID);
      }

      return false;
    });
    return store;
  });
}

export async function recordPromotionRejections(
  root: string,
  keys: Set<string>,
  reason: string,
  options: { ownerSessionID?: string; includeUnownedOnly?: boolean } = {},
): Promise<Set<string>> {
  const exhausted = new Set<string>();
  if (keys.size === 0) return exhausted;

  await updatePendingJournal(root, store => {
    const nowIso = new Date().toISOString();
    const exhaustedEntries = new Set<string>();

    store.entries = store.entries.map(entry => {
      const key = memoryKey(entry);
      if (!keys.has(key)) return entry;
      if (options.ownerSessionID && entry.pendingOwnerSessionID !== options.ownerSessionID) return entry;
      if (!options.ownerSessionID && options.includeUnownedOnly && entry.pendingOwnerSessionID) return entry;

      const promotionAttempts = (entry.promotionAttempts ?? 0) + 1;
      const max = entry.source === "manual"
        ? PROMOTION_RETRY_LIMITS.maxManualAttempts
        : PROMOTION_RETRY_LIMITS.maxExplicitAttempts;

      if (promotionAttempts >= max) {
        exhausted.add(key);
        exhaustedEntries.add(`${key}\u0000${entry.pendingOwnerSessionID ?? ""}`);
      }

      return {
        ...entry,
        promotionAttempts,
        lastPromotionAttemptAt: nowIso,
        lastPromotionFailureReason: reason,
      };
    });

    store.entries = store.entries.filter(entry => (
      !exhaustedEntries.has(`${memoryKey(entry)}\u0000${entry.pendingOwnerSessionID ?? ""}`)
    ));
    return store;
  });

  return exhausted;
}
