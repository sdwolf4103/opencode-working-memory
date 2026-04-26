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

/** Extract entity/destination keys for project and reference dedup */
function extractEntityKey(text: string): string | null {
  const normalized = canonicalMemoryText(text);
  // Check known key phrases (bilingual-friendly)
  // opencode + agenthub plugin system
  if (/opencode.*agenthub/i.test(normalized)) {
    return "opencode-agenthub plugin system";
  }
  // plugin config variations
  if (/plugin.*config|config.*plugin/i.test(normalized)) {
    return "plugin config";
  }
  return null;
}

/** Extract decision topic key for supersession detection */
function decisionTopicKey(text: string): string | null {
  const normalized = text.toLowerCase();
  // Parser format versions
  if (/parser.*formats?|supports?\s*\d+\s*format/i.test(normalized)) {
    return "parser-supported-formats";
  }
  // Compaction template replacement
  if (/compaction.*template|output\.prompt|template.*replace/i.test(normalized)) {
    return "compaction-template-replacement";
  }
  // Plugin loading
  if (/plugin.*load|npm.*cache|plugin.*config/i.test(normalized)) {
    return "plugin-loading-config";
  }
  // Output format changes (purple/italic, YAML frontmatter, etc)
  if (/purple.*italic|markup|markdown.*render|frontmatter/i.test(normalized)) {
    return "output-format-rendering";
  }
  return null;
}

/** Extract feedback topic key for supersession detection */
function feedbackTopicKey(text: string): string | null {
  const normalized = text.toLowerCase();
  // Purple/italic rendering issue
  if (/purple.*italic/i.test(normalized)) {
    return "purple-italic-rendering";
  }
  // Browser login/server errors
  if (/login.*500|500.*internal|server.*error|port.*occup/i.test(normalized)) {
    return "server-error-port-issue";
  }
  // Theme preferences
  if (/theme|dark.*light|prefer.*theme/i.test(normalized)) {
    return "theme-preference";
  }
  return null;
}

/** Check if entry should be pruned by age (for compaction/manual entries only) */
function isPrunableByAge(entry: LongTermMemoryEntry, now: number): boolean {
  // Never prune feedback or explicit entries
  if (entry.type === "feedback") return false;
  if (entry.source === "explicit") return false;
  if (!entry.staleAfterDays) return false;

  const createdAt = new Date(entry.createdAt).getTime();
  const ageDays = (now - createdAt) / 86400000;
  const grace = 30; // 30-day grace period
  return ageDays > entry.staleAfterDays + grace;
}

/** Choose better memory when identity/topic keys conflict */
function chooseBetterMemory(
  a: LongTermMemoryEntry,
  b: LongTermMemoryEntry,
  mode: "entity" | "supersession" = "entity",
): LongTermMemoryEntry {
  // Source priority: explicit > manual > compaction
  if (sourcePriority(a.source) !== sourcePriority(b.source)) {
    return sourcePriority(a.source) > sourcePriority(b.source) ? a : b;
  }
  // Higher confidence wins
  if (a.confidence !== b.confidence) {
    return a.confidence > b.confidence ? a : b;
  }
  // For entity dedup: longer (more specific) beats shorter
  // For supersession: newer beats older (and thus longer is not preferred)
  if (mode === "supersession") {
    // Newer wins for same-topic supersession
    if (new Date(a.createdAt).getTime() !== new Date(b.createdAt).getTime()) {
      return new Date(a.createdAt) > new Date(b.createdAt) ? a : b;
    }
    return a.text.length > b.text.length ? a : b;
  }
  // Entity mode: longer text means more specific
  if (Math.abs(a.text.length - b.text.length) > 10) {
    return a.text.length > b.text.length ? a : b;
  }
  // Freshness tie-breaker
  return new Date(a.createdAt) > new Date(b.createdAt) ? a : b;
}

export function enforceLongTermLimits(entries: LongTermMemoryEntry[]): LongTermMemoryEntry[] {
  const now = Date.now();

  // Phase 1: filter active, prune by age
  const phase1 = entries
    .filter(entry => entry.status === "active")
    .filter(entry => !isPrunableByAge(entry, now))
    .map(entry => ({ ...entry, text: entry.text.slice(0, LONG_TERM_LIMITS.maxEntryTextChars) }));

  // For project/reference/feedback: detect entity keys FIRST, then dedupe by entity OR canonical
  const projectRefEntries = phase1.filter(e => e.type === "project" || e.type === "reference" || e.type === "feedback");

  // Build entity key dedup for project/reference/feedback
  const entityDeduped = new Map<string, LongTermMemoryEntry>();
  for (const entry of projectRefEntries) {
    const entityKey = entry.type === "project" || entry.type === "reference"
      ? extractEntityKey(entry.text)
      : feedbackTopicKey(entry.text);
    const key = entityKey ? `${entry.type}:${entityKey}` : `${entry.type}:${canonicalMemoryText(entry.text)}`;

    const existing = entityDeduped.get(key);
    if (!existing) {
      entityDeduped.set(key, entry);
    } else if (chooseBetterMemory(entry, existing) === entry) {
      entityDeduped.set(key, entry);
    }
  }

  // For decisions: detect topic keys for supersession, or use canonical
  const decisionEntries = phase1.filter(e => e.type === "decision");
  const decisionDeduped = new Map<string, LongTermMemoryEntry>();
  for (const entry of decisionEntries) {
    const topic = decisionTopicKey(entry.text);
    const key = topic ? `decision:${topic}` : `decision:${canonicalMemoryText(entry.text)}`;

    const existing = decisionDeduped.get(key);
    if (!existing) {
      decisionDeduped.set(key, entry);
    } else if (chooseBetterMemory(entry, existing, "supersession") === entry) {
      decisionDeduped.set(key, entry);
    }
  }

  // Merge deduped entries
  const phaseFinal = new Map<string, LongTermMemoryEntry>();
  for (const entry of [...entityDeduped.values(), ...decisionDeduped.values()]) {
    phaseFinal.set(entry.id, entry);
  }

  // Phase 6: sort and trim
  return [...phaseFinal.values()]
    .sort((a, b) => {
      const pA = priorityWithFreshness(a);
      const pB = priorityWithFreshness(b);
      if (pB !== pA) return pB - pA;
      const sourceDiff = sourcePriority(b.source) - sourcePriority(a.source);
      if (sourceDiff !== 0) return sourceDiff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })
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

/** Extended priority including freshness for tie-breaking */
function priorityWithFreshness(entry: LongTermMemoryEntry): number {
  return priority(entry);
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
