import type { LongTermMemoryEntry, PendingMemoryJournalStore } from "./types.ts";
import { workspaceKey, workspacePendingJournalPath } from "./paths.ts";
import { atomicWriteJSON, readJSON, updateJSON } from "./storage.ts";

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

function normalizeJournal(
  root: string,
  store: PendingMemoryJournalStore,
): Promise<PendingMemoryJournalStore> {
  return workspaceKey(root).then(key => ({
    version: 1,
    workspace: { root, key },
    entries: dedupeByText(Array.isArray(store.entries) ? store.entries : []),
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
