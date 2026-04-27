import type { LongTermMemoryEntry, PendingMemoryJournalStore } from "./types.ts";
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
    const key = memoryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }

  return result;
}

function isStaleEntry(entry: LongTermMemoryEntry, maxAgeDays: number): boolean {
  const createdAt = entry.createdAt ? new Date(entry.createdAt).getTime() : NaN;
  const updatedAt = entry.updatedAt ? new Date(entry.updatedAt).getTime() : NaN;
  
  // If both timestamps are invalid, treat as stale
  if (Number.isNaN(createdAt) && Number.isNaN(updatedAt)) {
    return true;
  }
  
  // Use createdAt as primary age timestamp
  const ageMs = Date.now() - (Number.isNaN(createdAt) ? updatedAt : createdAt);
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  
  return ageMs > maxAgeMs;
}

function applyRetention(
  entries: LongTermMemoryEntry[],
  maxEntries: number,
  maxAgeDays: number,
): LongTermMemoryEntry[] {
  // 1. Dedupe first
  const deduped = dedupeByText(entries);
  
  // 2. Remove stale entries
  const freshEntries = deduped.filter(entry => !isStaleEntry(entry, maxAgeDays));
  
  // 3. Sort by createdAt descending (newest first) for cap
  const sorted = [...freshEntries].sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bTime - aTime;
  });
  
  // 4. Keep maxEntries newest
  const capped = sorted.slice(0, maxEntries);
  
  // 5. Restore stable order (oldest-to-newest) for consistency with existing code
  return capped.sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return aTime - bTime;
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

export async function clearPendingMemories(root: string, keys?: Set<string>): Promise<void> {
  await updatePendingJournal(root, store => {
    if (!keys || keys.size === 0) {
      store.entries = [];
      return store;
    }
    store.entries = store.entries.filter(entry => !keys.has(memoryKey(entry)));
    return store;
  });
}
