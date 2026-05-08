// No OpenCode SDK or TUI imports. Uses only local file-system reads from workspace memory, session state, pending journal, and evidence log.

import { readFile } from "node:fs/promises";
import type { EvidenceEventV1 } from "./evidence-log.ts";
import { queryEvidenceEvents } from "./evidence-log.ts";
import { sessionStatePath, workspaceKey, workspaceMemoryPath, workspacePendingJournalPath } from "./paths.ts";
import { redactCredentials } from "./redaction.ts";
import type { LongTermMemoryEntry, PendingMemoryJournalStore, SessionState, WorkspaceMemoryStore } from "./types.ts";
import { LONG_TERM_LIMITS } from "./types.ts";
import { accountWorkspaceMemoryRender } from "./workspace-memory.ts";

export type MemoryVisibilityCommand = "status" | "activity" | "help";

export type MemoryPreview = {
  id: string;
  type: LongTermMemoryEntry["type"];
  source: LongTermMemoryEntry["source"];
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
  previews: MemoryPreview[];
};

export type MemoryActivityModel = {
  events: EvidenceEventV1[];
  limit: number;
};

const DEFAULT_ACTIVITY_LIMIT = 10;
const MAX_ACTIVITY_LIMIT = 50;
const MAX_PREVIEWS = 3;
const MAX_PREVIEW_CHARS = 120;

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_ACTIVITY_LIMIT;
  return Math.max(0, Math.min(MAX_ACTIVITY_LIMIT, Math.trunc(limit ?? DEFAULT_ACTIVITY_LIMIT)));
}

function safePreview(text: string | undefined, maxChars = MAX_PREVIEW_CHARS): string {
  const clean = redactCredentials(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function summarizeReasons(reasons: string[] | undefined): string {
  return reasons && reasons.length > 0 ? reasons.join(", ") : "no_reason_recorded";
}

function memoryPreview(memory: LongTermMemoryEntry): MemoryPreview {
  return {
    id: memory.id,
    type: memory.type,
    source: memory.source,
    text: safePreview(memory.text),
  };
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
    previews: activeEntries.slice(0, MAX_PREVIEWS).map(memoryPreview),
  };
}

export function formatMemoryStatus(model: MemoryStatusModel): string {
  const lines = [
    "## Memory status",
    "",
    `Active memories: ${model.activeMemories}`,
    `Rendered in prompt: ${model.renderedInPrompt}`,
    `Omitted active memories: ${model.omittedActiveMemories}`,
    `Superseded memories: ${model.supersededMemories}`,
    `Pending in this session: ${model.pendingInSession}`,
    `Pending journal memories: ${model.pendingJournalMemories}`,
    `Open errors: ${model.openErrors}`,
    `Recent decisions: ${model.recentDecisions}`,
  ];

  if (model.previews.length > 0) {
    lines.push("", "Recent active memory previews:");
    for (const preview of model.previews) {
      lines.push(`- ${preview.type}/${preview.source}: ${preview.text}`);
    }
  } else {
    lines.push("", "No active workspace memories are stored yet.");
  }

  lines.push("", "Local only: no LLM request was made.");
  return lines.join("\n");
}

export async function getMemoryActivity(root: string, options: { limit?: number } = {}): Promise<MemoryActivityModel> {
  const limit = clampLimit(options.limit);
  return {
    events: await queryEvidenceEvents(root, { newestFirst: true, limit }),
    limit,
  };
}

function formatActivityEvent(event: EvidenceEventV1): string {
  const time = event.createdAt || "unknown_time";
  const memoryType = event.memory?.type ? ` ${event.memory.type}` : "";
  const memoryId = event.memory?.memoryId ? ` ${event.memory.memoryId}` : "";
  const preview = safePreview(event.textPreview);
  const previewText = preview ? ` — ${preview}` : "";
  return `- ${time} — ${event.outcome}/${event.phase}${memoryType}${memoryId} — ${summarizeReasons(event.reasonCodes)}${previewText}`;
}

export function formatMemoryActivity(model: MemoryActivityModel): string {
  const lines = [
    "## Recent memory activity",
    "",
  ];

  if (model.events.length === 0) {
    lines.push(`No retained memory activity exists in the local evidence log for the last ${model.limit} events.`);
  } else {
    lines.push(...model.events.map(formatActivityEvent));
  }

  lines.push("", "Local only: no LLM request was made.");
  return lines.join("\n");
}

export function formatMemoryHelp(): string {
  return [
    "## Memory help",
    "",
    "Available display commands:",
    "- /memory status — show local workspace/session memory counts.",
    "- /memory activity — show recent local memory evidence activity.",
    "- /memory last — alias for /memory activity.",
    "- /memory help — show this help text.",
    "",
    "Compaction output already appears in the conversation through OpenCode's built-in flow.",
    "This command reads local memory files and does not call the LLM.",
    "Future commands such as /memory delete and /memory edit are not available in v1.6.1.",
    "",
    "Local only: no LLM request was made.",
  ].join("\n");
}

export async function renderMemoryCommand(root: string, sessionID: string, command: MemoryVisibilityCommand): Promise<string> {
  switch (command) {
    case "status":
      return formatMemoryStatus(await getMemoryStatus(root, sessionID));
    case "activity":
      return formatMemoryActivity(await getMemoryActivity(root));
    case "help":
      return formatMemoryHelp();
    default:
      return formatMemoryHelp();
  }
}
