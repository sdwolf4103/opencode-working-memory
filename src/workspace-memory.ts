import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "./types.ts";
import { LONG_TERM_LIMITS } from "./types.ts";
import { workspaceKey, workspaceMemoryPath } from "./paths.ts";
import { atomicWriteJSON, readJSON, updateJSON } from "./storage.ts";

// Minimum length for workspace_memory envelope: <workspace_memory>\n...\n</workspace_memory>
const MIN_ENVELOPE_LENGTH = 80;

export async function emptyWorkspaceMemory(root: string): Promise<WorkspaceMemoryStore> {
  return {
    version: 1,
    workspace: { root, key: await workspaceKey(root) },
    limits: {
      maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars,
      maxEntries: LONG_TERM_LIMITS.maxEntries,
    },
    entries: [],
    updatedAt: new Date().toISOString(),
  };
}

export async function loadWorkspaceMemory(root: string): Promise<WorkspaceMemoryStore> {
  const fallback = await emptyWorkspaceMemory(root);
  const loaded = await readJSON(await workspaceMemoryPath(root), () => fallback);
  loaded.workspace = { root, key: await workspaceKey(root) };
  loaded.limits = {
    maxRenderedChars: loaded.limits?.maxRenderedChars ?? LONG_TERM_LIMITS.maxRenderedChars,
    maxEntries: loaded.limits?.maxEntries ?? LONG_TERM_LIMITS.maxEntries,
  };
  loaded.entries = Array.isArray(loaded.entries) ? loaded.entries : [];
  return loaded;
}

export async function saveWorkspaceMemory(root: string, store: WorkspaceMemoryStore): Promise<void> {
  const normalized = await normalizeWorkspaceMemory(root, store);
  await atomicWriteJSON(await workspaceMemoryPath(root), normalized);
}

export async function updateWorkspaceMemory(
  root: string,
  updater: (store: WorkspaceMemoryStore) => WorkspaceMemoryStore | Promise<WorkspaceMemoryStore>,
): Promise<WorkspaceMemoryStore> {
  const path = await workspaceMemoryPath(root);
  const fallback = await emptyWorkspaceMemory(root);
  return updateJSON(path, () => fallback, async current => {
    const normalized = await normalizeWorkspaceMemory(root, current);
    return normalizeWorkspaceMemory(root, await updater(normalized));
  });
}

async function normalizeWorkspaceMemory(
  root: string,
  store: WorkspaceMemoryStore,
): Promise<WorkspaceMemoryStore> {
  store.workspace = { root, key: await workspaceKey(root) };
  store.limits = {
    maxRenderedChars: store.limits?.maxRenderedChars ?? LONG_TERM_LIMITS.maxRenderedChars,
    maxEntries: store.limits?.maxEntries ?? LONG_TERM_LIMITS.maxEntries,
  };
  store.entries = enforceLongTermLimits(store.entries);
  store.updatedAt = new Date().toISOString();
  return store;
}

function sourcePriority(source: LongTermMemoryEntry["source"]): number {
  if (source === "explicit") return 3;
  if (source === "manual") return 2;
  return 1;
}

function canonicalMemoryText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, " ")
    .trim();
}

export function enforceLongTermLimits(entries: LongTermMemoryEntry[]): LongTermMemoryEntry[] {
  const byKey = new Map<string, LongTermMemoryEntry>();

  for (const entry of entries.filter(entry => entry.status === "active")) {
    const text = entry.text.slice(0, LONG_TERM_LIMITS.maxEntryTextChars);
    const key = `${entry.type}:${canonicalMemoryText(text)}`;

    const existing = byKey.get(key);

    // Source priority: explicit > manual > compaction
    // Same source: higher confidence wins
    if (!existing) {
      byKey.set(key, { ...entry, text });
    } else if (sourcePriority(entry.source) > sourcePriority(existing.source)) {
      byKey.set(key, { ...entry, text });
    } else if (sourcePriority(entry.source) === sourcePriority(existing.source)) {
      if (entry.confidence > existing.confidence) {
        byKey.set(key, { ...entry, text });
      }
    }
  }

  return [...byKey.values()]
    .sort((a, b) => priority(b) - priority(a))
    .slice(0, LONG_TERM_LIMITS.maxEntries);
}

function priority(entry: LongTermMemoryEntry): number {
  const typeWeight = {
    feedback: 400,
    decision: 300,
    project: 200,
    reference: 100,
  }[entry.type];

  const sourceWeight = entry.source === "explicit" ? 1000 : 0;
  return sourceWeight + typeWeight + entry.confidence * 10;
}

function wouldFit(
  lines: string[],
  nextLine: string,
  closingLine: string,
  maxChars: number
): boolean {
  return [...lines, nextLine, closingLine].join("\n").length <= maxChars;
}

export function renderWorkspaceMemory(store: WorkspaceMemoryStore): string {
  const active = enforceLongTermLimits(store.entries);
  if (active.length === 0) return "";

  const maxChars = Math.min(
    store.limits.maxRenderedChars,
    LONG_TERM_LIMITS.maxRenderedChars
  );

  // If maxChars smaller than minimum envelope, return empty string
  if (maxChars < MIN_ENVELOPE_LENGTH) return "";

  const lines: string[] = [
    "Workspace memory (cross-session, verify if stale):",
  ];

  for (const type of ["feedback", "project", "decision", "reference"] as const) {
    const items = active.filter(entry => entry.type === type);
    if (items.length === 0) continue;

    const sectionLines: string[] = [`${type}:`];

    for (const item of items) {
      const line = `- ${renderEntry(item)}`;
      if ([...lines, ...sectionLines, line].join("\n").length <= maxChars) {
        sectionLines.push(line);
      }
    }

    if (sectionLines.length > 1) {
      lines.push(...sectionLines);
    }
  }

  return lines.join("\n");
}

function renderEntry(entry: LongTermMemoryEntry): string {
  const ageDays = Math.floor((Date.now() - new Date(entry.createdAt).getTime()) / 86_400_000);
  const stale = entry.staleAfterDays && ageDays > entry.staleAfterDays ? ` [${ageDays}d old, verify]` : "";
  const rationale = entry.rationale
    ? ` Why: ${entry.rationale.slice(0, LONG_TERM_LIMITS.maxRationaleChars)}`
    : "";
  return `${entry.text}${rationale}${stale}`;
}
