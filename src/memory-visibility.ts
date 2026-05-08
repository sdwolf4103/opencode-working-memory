// No OpenCode SDK or TUI imports. Uses only local file-system reads from workspace memory, session state, and pending journal.

import { readFile } from "node:fs/promises";
import { sessionStatePath, workspaceKey, workspaceMemoryPath, workspacePendingJournalPath } from "./paths.ts";
import { redactCredentials } from "./redaction.ts";
import type { LongTermMemoryEntry, PendingMemoryJournalStore, SessionState, WorkspaceMemoryStore } from "./types.ts";
import { LONG_TERM_LIMITS } from "./types.ts";
import { accountWorkspaceMemoryCompactionRefs, accountWorkspaceMemoryRender } from "./workspace-memory.ts";

export type MemoryVisibilityCommand = "status" | "list" | "help";

type MemoryListItem = {
  ref: string;
  text: string;
};

export type MemoryStatusModel = {
  activeMemories: number;
  supersededMemories: number;
  renderedInPrompt: number;
  omittedActiveMemories: number;
  pendingInSession: number;
  pendingJournalMemories: number;
  openErrors: number;
  recentDecisions: number;
};

export type MemoryListModel = {
  activeMemories: number;
  renderedMemories: number;
  omittedActiveMemories: number;
  groups: Record<LongTermMemoryEntry["type"], MemoryListItem[]>;
};

const MAX_PREVIEW_CHARS = 120;
const MEMORY_TYPE_ORDER = ["feedback", "project", "decision", "reference"] as const satisfies readonly LongTermMemoryEntry["type"][];

function safePreview(text: string | undefined, maxChars = MAX_PREVIEW_CHARS): string {
  const clean = redactCredentials(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

async function readJSONSnapshot(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLongTermType(value: unknown): value is LongTermMemoryEntry["type"] {
  return value === "feedback" || value === "project" || value === "decision" || value === "reference";
}

function isLongTermSource(value: unknown): value is LongTermMemoryEntry["source"] {
  return value === "explicit" || value === "compaction" || value === "manual";
}

function isLongTermMemoryEntry(value: unknown): value is LongTermMemoryEntry {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string") return false;
  if (!isLongTermType(value.type)) return false;
  if (typeof value.text !== "string") return false;
  if (!isLongTermSource(value.source)) return false;
  if (typeof value.confidence !== "number") return false;
  if (value.status !== "active" && value.status !== "superseded") return false;
  if (typeof value.createdAt !== "string") return false;
  return typeof value.updatedAt === "string";
}

function memoryEntries(value: unknown): LongTermMemoryEntry[] {
  return Array.isArray(value) ? value.filter(isLongTermMemoryEntry) : [];
}

async function emptyWorkspaceMemorySnapshot(root: string): Promise<WorkspaceMemoryStore> {
  const nowIso = new Date().toISOString();
  return {
    version: 1,
    workspace: { root, key: await workspaceKey(root) },
    limits: {
      maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars,
      maxEntries: LONG_TERM_LIMITS.maxEntries,
    },
    entries: [],
    migrations: [],
    updatedAt: nowIso,
    lastActivityAt: nowIso,
  };
}

async function readWorkspaceMemorySnapshot(root: string): Promise<WorkspaceMemoryStore> {
  const fallback = await emptyWorkspaceMemorySnapshot(root);
  const loaded = await readJSONSnapshot(await workspaceMemoryPath(root));
  if (!isRecord(loaded)) return fallback;
  const limits = isRecord(loaded.limits) ? loaded.limits : {};

  return {
    version: 1,
    workspace: fallback.workspace,
    limits: {
      maxRenderedChars: typeof limits.maxRenderedChars === "number" ? limits.maxRenderedChars : LONG_TERM_LIMITS.maxRenderedChars,
      maxEntries: typeof limits.maxEntries === "number" ? limits.maxEntries : LONG_TERM_LIMITS.maxEntries,
    },
    entries: memoryEntries(loaded.entries),
    migrations: Array.isArray(loaded.migrations) ? loaded.migrations.filter(item => typeof item === "string") : [],
    updatedAt: typeof loaded.updatedAt === "string" ? loaded.updatedAt : fallback.updatedAt,
    lastActivityAt: typeof loaded.lastActivityAt === "string" ? loaded.lastActivityAt : undefined,
  };
}

async function emptyPendingJournalSnapshot(root: string): Promise<PendingMemoryJournalStore> {
  return {
    version: 1,
    workspace: { root, key: await workspaceKey(root) },
    entries: [],
    updatedAt: new Date().toISOString(),
  };
}

async function readPendingJournalSnapshot(root: string): Promise<PendingMemoryJournalStore> {
  const fallback = await emptyPendingJournalSnapshot(root);
  const loaded = await readJSONSnapshot(await workspacePendingJournalPath(root));
  if (!isRecord(loaded)) return fallback;
  return {
    version: 1,
    workspace: fallback.workspace,
    entries: memoryEntries(loaded.entries),
    updatedAt: typeof loaded.updatedAt === "string" ? loaded.updatedAt : fallback.updatedAt,
  };
}

function emptySessionStateSnapshot(sessionID: string): SessionState {
  return {
    version: 1,
    sessionID,
    turn: 0,
    updatedAt: new Date().toISOString(),
    activeFiles: [],
    openErrors: [],
    recentDecisions: [],
    pendingMemories: [],
    compactionMemoryRefs: [],
  };
}

async function readSessionStateSnapshot(root: string, sessionID: string): Promise<SessionState> {
  const fallback = emptySessionStateSnapshot(sessionID);
  const loaded = await readJSONSnapshot(await sessionStatePath(root, sessionID));
  if (!isRecord(loaded)) return fallback;
  return {
    ...fallback,
    turn: typeof loaded.turn === "number" ? loaded.turn : fallback.turn,
    updatedAt: typeof loaded.updatedAt === "string" ? loaded.updatedAt : fallback.updatedAt,
    activeFiles: Array.isArray(loaded.activeFiles) ? loaded.activeFiles as SessionState["activeFiles"] : [],
    openErrors: Array.isArray(loaded.openErrors) ? loaded.openErrors as SessionState["openErrors"] : [],
    recentDecisions: Array.isArray(loaded.recentDecisions) ? loaded.recentDecisions as SessionState["recentDecisions"] : [],
    pendingMemories: memoryEntries(loaded.pendingMemories),
    compactionMemoryRefs: Array.isArray(loaded.compactionMemoryRefs) ? loaded.compactionMemoryRefs as SessionState["compactionMemoryRefs"] : [],
  };
}

export async function getMemoryStatus(root: string, sessionID: string): Promise<MemoryStatusModel> {
  const [store, sessionState, pendingJournal] = await Promise.all([
    readWorkspaceMemorySnapshot(root),
    readSessionStateSnapshot(root, sessionID),
    readPendingJournalSnapshot(root),
  ]);
  const renderAccounting = accountWorkspaceMemoryRender(store);
  const activeEntries = store.entries.filter(entry => entry.status !== "superseded");
  const supersededEntries = store.entries.filter(entry => entry.status === "superseded");

  return {
    activeMemories: activeEntries.length,
    supersededMemories: supersededEntries.length,
    renderedInPrompt: renderAccounting.rendered.length,
    omittedActiveMemories: renderAccounting.omitted.filter(item => item.memory.status !== "superseded").length,
    pendingInSession: sessionState.pendingMemories.length,
    pendingJournalMemories: pendingJournal.entries.length,
    openErrors: sessionState.openErrors.filter(error => error.status === "open").length,
    recentDecisions: sessionState.recentDecisions.length,
  };
}

export function formatMemoryStatus(model: MemoryStatusModel): string {
  return [
    "## Memory status",
    "",
    "Workspace:",
    `- Active memories: ${model.activeMemories}`,
    `- Rendered in prompt: ${model.renderedInPrompt}`,
    `- Omitted active memories: ${model.omittedActiveMemories}`,
    `- Superseded memories: ${model.supersededMemories}`,
    "",
    "Pending:",
    `- Pending in this session: ${model.pendingInSession}`,
    `- Pending journal memories: ${model.pendingJournalMemories}`,
    "",
    "Session:",
    `- Open errors: ${model.openErrors}`,
    `- Recent decisions: ${model.recentDecisions}`,
    "",
    `Use /memory-list to view current [M1]-[M${LONG_TERM_LIMITS.maxEntries}] memory refs.`,
    "",
    "Local only: no LLM request was made.",
  ].join("\n");
}

function emptyMemoryListGroups(): MemoryListModel["groups"] {
  return { feedback: [], project: [], decision: [], reference: [] };
}

export async function getMemoryList(root: string): Promise<MemoryListModel> {
  const store = await readWorkspaceMemorySnapshot(root);
  const accounting = accountWorkspaceMemoryCompactionRefs(store);
  const groups = emptyMemoryListGroups();
  const renderedMemoryIds = new Set(accounting.rendered.map(memory => memory.id));

  for (const ref of accounting.refs) {
    if (!renderedMemoryIds.has(ref.memoryId)) continue;
    groups[ref.type].push({
      ref: ref.ref,
      text: safePreview(ref.textPreview),
    });
  }

  const renderedMemories = MEMORY_TYPE_ORDER.reduce((total, type) => total + groups[type].length, 0);

  return {
    activeMemories: store.entries.filter(entry => entry.status !== "superseded").length,
    renderedMemories,
    omittedActiveMemories: accounting.omitted.filter(item => item.memory.status !== "superseded").length,
    groups,
  };
}

export function formatMemoryList(model: MemoryListModel): string {
  const lines = [
    "## Current workspace memories",
    "",
  ];

  if (model.renderedMemories === 0) {
    lines.push("No active workspace memories are stored yet.", "", "Local only: no LLM request was made.");
    return lines.join("\n");
  }

  lines.push("Display refs are local to this output and may change after memory updates.", "");

  for (const type of MEMORY_TYPE_ORDER) {
    const group = model.groups[type];
    if (group.length === 0) continue;
    lines.push(`${type}:`);
    for (const item of group) {
      lines.push(`- [${item.ref}] ${item.text}`);
    }
    lines.push("");
  }

  lines.push(
    `Shown: ${model.renderedMemories} of ${model.activeMemories} active memories.`,
    `Omitted active memories: ${model.omittedActiveMemories}.`,
    "",
    "Local only: no LLM request was made.",
  );

  return lines.join("\n");
}

export function formatMemoryHelp(): string {
  return [
    "## Memory help",
    "",
    "Commands:",
    "- /memory-status — show local memory statistics.",
    `- /memory-list — show current workspace memories as display-local [M1]-[M${LONG_TERM_LIMITS.maxEntries}] refs.`,
    "- /memory-help — show this help.",
    "",
    "These commands are read-only, local-only, and do not call the LLM.",
  ].join("\n");
}

export async function renderMemoryCommand(root: string, sessionID: string, command: MemoryVisibilityCommand): Promise<string> {
  switch (command) {
    case "status":
      return formatMemoryStatus(await getMemoryStatus(root, sessionID));
    case "list":
      return formatMemoryList(await getMemoryList(root));
    case "help":
      return formatMemoryHelp();
    default:
      return formatMemoryHelp();
  }
}
