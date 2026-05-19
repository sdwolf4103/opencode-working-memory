import { relative } from "path";
import { sessionStatePath } from "./paths.ts";
import { atomicWriteJSON, readJSON, updateJSON } from "./storage.ts";
import type { ActiveFile, CompactionMemoryRef, LongTermMemoryEntry, OpenError, SessionDecision, SessionState } from "./types.ts";
import { HOT_STATE_LIMITS, LONG_TERM_LIMITS } from "./types.ts";
import { memoryKey } from "./pending-journal.ts";

type SessionStateInput = Omit<SessionState, "compactionMemoryRefs"> & {
  compactionMemoryRefs?: unknown;
};

const ACTION_WEIGHT: Record<ActiveFile["action"], number> = {
  edit: 50,
  write: 45,
  grep: 30,
  read: 20,
};

export function createEmptySessionState(sessionID: string): SessionState {
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

export async function loadSessionState(root: string, sessionID: string): Promise<SessionState> {
  const fallback = createEmptySessionState(sessionID);
  const loaded = await readJSON(await sessionStatePath(root, sessionID), () => fallback);
  loaded.sessionID = sessionID;
  loaded.activeFiles = Array.isArray(loaded.activeFiles) ? loaded.activeFiles : [];
  loaded.openErrors = Array.isArray(loaded.openErrors) ? loaded.openErrors : [];
  loaded.recentDecisions = Array.isArray(loaded.recentDecisions) ? loaded.recentDecisions : [];
  loaded.pendingMemories = Array.isArray(loaded.pendingMemories) ? loaded.pendingMemories : [];
  loaded.compactionMemoryRefs = normalizeCompactionMemoryRefs((loaded as SessionStateInput).compactionMemoryRefs);
  return loaded;
}

export async function saveSessionState(root: string, state: SessionState | SessionStateInput): Promise<void> {
  await atomicWriteJSON(await sessionStatePath(root, state.sessionID), normalizeSessionState(state));
}

export async function updateSessionState(
  root: string,
  sessionID: string,
  updater: (state: SessionState) => SessionState | Promise<SessionState>,
): Promise<SessionState> {
  const path = await sessionStatePath(root, sessionID);
  return updateJSON(path, () => createEmptySessionState(sessionID), async current => {
    current.sessionID = sessionID;
    current.activeFiles = Array.isArray(current.activeFiles) ? current.activeFiles : [];
    current.openErrors = Array.isArray(current.openErrors) ? current.openErrors : [];
    current.recentDecisions = Array.isArray(current.recentDecisions) ? current.recentDecisions : [];
    current.pendingMemories = Array.isArray(current.pendingMemories) ? current.pendingMemories : [];
    current.compactionMemoryRefs = normalizeCompactionMemoryRefs((current as SessionStateInput).compactionMemoryRefs);
    return normalizeSessionState(await updater(current));
  });
}

function normalizeSessionState(state: SessionState | SessionStateInput): SessionState {
  state.updatedAt = new Date().toISOString();
  state.activeFiles = state.activeFiles.slice(0, HOT_STATE_LIMITS.maxActiveFilesStored);
  state.openErrors = state.openErrors.slice(0, HOT_STATE_LIMITS.maxOpenErrorsStored);
  state.recentDecisions = state.recentDecisions.slice(0, HOT_STATE_LIMITS.maxRecentDecisionsStored);
  state.pendingMemories = dedupePendingMemories(Array.isArray(state.pendingMemories) ? state.pendingMemories : [])
    .slice(-HOT_STATE_LIMITS.maxPendingMemoriesStored);
  return {
    ...state,
    compactionMemoryRefs: normalizeCompactionMemoryRefs(state.compactionMemoryRefs),
  };
}

function normalizeCompactionMemoryRefs(value: unknown): CompactionMemoryRef[] {
  if (!Array.isArray(value)) return [];
  if (value.some(item => !isCompactionMemoryRef(item))) return [];
  return value.slice(0, LONG_TERM_LIMITS.maxEntries);
}

function isCompactionMemoryRef(value: unknown): value is CompactionMemoryRef {
  if (!isRecord(value)) return false;
  if (typeof value.ref !== "string" || !/^M[1-9]\d*$/.test(value.ref)) return false;
  if (typeof value.memoryId !== "string" || value.memoryId.trim() === "") return false;
  if (value.compactionId !== undefined && typeof value.compactionId !== "string") return false;
  if (!isLongTermType(value.type)) return false;
  if (!isLongTermSource(value.source)) return false;
  if (typeof value.exactKey !== "string" || value.exactKey.trim() === "") return false;
  if (typeof value.identityKey !== "string" || value.identityKey.trim() === "") return false;
  if (typeof value.textPreview !== "string") return false;
  return typeof value.capturedAt === "number" && Number.isFinite(value.capturedAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLongTermType(value: unknown): value is CompactionMemoryRef["type"] {
  return value === "feedback" || value === "project" || value === "decision" || value === "reference";
}

function isLongTermSource(value: unknown): value is CompactionMemoryRef["source"] {
  return value === "explicit" || value === "compaction" || value === "manual";
}

function dedupePendingMemories(memories: LongTermMemoryEntry[]): LongTermMemoryEntry[] {
  const seen = new Set<string>();
  const deduped: LongTermMemoryEntry[] = [];
  for (const memory of memories) {
    const key = memoryKey(memory);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(memory);
  }
  return deduped;
}

export function touchActiveFile(state: SessionState, filePath: string, action: ActiveFile["action"]): void {
  const now = Date.now();
  const existing = state.activeFiles.find(item => item.path === filePath);

  if (existing) {
    existing.count += 1;
    existing.lastSeen = now;
    if (ACTION_WEIGHT[action] >= ACTION_WEIGHT[existing.action]) {
      existing.action = action;
    }
  } else {
    state.activeFiles.push({
      path: filePath,
      action,
      count: 1,
      lastSeen: now,
    });
  }

  state.activeFiles = rankActiveFiles(state.activeFiles).slice(0, HOT_STATE_LIMITS.maxActiveFilesStored);
  state.updatedAt = new Date().toISOString();
}

export function upsertOpenError(state: SessionState, error: OpenError): void {
  const now = Date.now();
  const existing = state.openErrors.find(item => item.fingerprint === error.fingerprint);

  if (existing) {
    existing.summary = error.summary;
    existing.command = error.command ?? existing.command;
    existing.file = error.file ?? existing.file;
    existing.lastSeen = now;
    existing.status = "open";
    existing.seenCount += 1;
  } else {
    state.openErrors.unshift({
      ...error,
      firstSeen: error.firstSeen ?? now,
      lastSeen: now,
      seenCount: Math.max(error.seenCount ?? 1, 1),
      status: "open",
    });
  }

  state.openErrors.sort((a, b) => b.lastSeen - a.lastSeen);
  state.openErrors = state.openErrors.slice(0, HOT_STATE_LIMITS.maxOpenErrorsStored);
  state.updatedAt = new Date().toISOString();
}

export function markErrorsMaybeFixedForFile(
  state: SessionState,
  filePath: string,
  workspaceRoot = "",
): void {
  const candidates = new Set<string>([filePath]);
  if (workspaceRoot && filePath.startsWith(workspaceRoot)) {
    candidates.add(relative(workspaceRoot, filePath));
  }

  let changed = false;
  for (const error of state.openErrors) {
    if (error.status !== "open") continue;
    if (!error.file) continue;
    for (const candidate of candidates) {
      if (pathsMatch(error.file, candidate)) {
        error.status = "maybe_fixed";
        error.lastSeen = Date.now();
        changed = true;
        break;
      }
    }
  }

  if (changed) state.updatedAt = new Date().toISOString();
}

export function addRecentDecision(
  state: SessionState,
  decision: Pick<SessionDecision, "text" | "source" | "rationale">,
): void {
  const normalized = decision.text.toLowerCase().replace(/\s+/g, " ").trim();
  const existing = state.recentDecisions.find(item => (
    item.text.toLowerCase().replace(/\s+/g, " ").trim() === normalized
  ));
  const now = Date.now();

  if (existing) {
    existing.createdAt = now;
    existing.rationale = decision.rationale ?? existing.rationale;
    existing.source = decision.source;
  } else {
    state.recentDecisions.push({
      id: `decision_${now}_${Math.random().toString(36).slice(2, 8)}`,
      text: decision.text,
      rationale: decision.rationale,
      source: decision.source,
      createdAt: now,
    });
  }

  state.recentDecisions = state.recentDecisions.slice(-HOT_STATE_LIMITS.maxRecentDecisionsStored);
  state.updatedAt = new Date().toISOString();
}

export function clearErrorsForSuccessfulCommand(state: SessionState, command: string): void {
  const category = classifyCommand(command);
  if (!category) return;
  state.openErrors = state.openErrors.filter(error => error.category !== category);
  state.updatedAt = new Date().toISOString();
}

export type HotStateSection = "active_files" | "open_errors" | "recent_decisions" | "pending_memories";

export type HotStateOmissionReason = "section_cap" | "char_budget";

export type HotStateOmittedItem = {
  section: HotStateSection;
  reason: HotStateOmissionReason;
  text: string;
  memoryId?: string;
};

export type HotSessionStateRenderAccounting = {
  prompt: string;
  omitted: HotStateOmittedItem[];
  maxRenderedChars: number;
};

type HotStateRenderItem = {
  section: HotStateSection;
  line: string;
  memoryId?: string;
};

type HotStateRenderSection = {
  heading: `${HotStateSection}:`;
  items: HotStateRenderItem[];
};

const HOT_STATE_PREFIX = "Hot session state (current session):";

export function accountHotSessionStateRender(state: SessionState, workspaceRoot: string): HotSessionStateRenderAccounting {
  const maxRenderedChars = HOT_STATE_LIMITS.maxRenderedChars;
  const omitted: HotStateOmittedItem[] = [];
  const sections = buildHotStateRenderSections(state, workspaceRoot, omitted);

  if (sections.every(section => section.items.length === 0)) {
    return { prompt: "", omitted, maxRenderedChars };
  }

  const lines: string[] = [HOT_STATE_PREFIX];
  let renderedEntryCount = 0;

  for (const section of sections) {
    let headingRendered = false;

    for (const item of section.items) {
      if (headingRendered) {
        if (wouldFit(lines, item.line, maxRenderedChars)) {
          lines.push(item.line);
          renderedEntryCount += 1;
        } else {
          omitted.push(omitHotStateItem(item, "char_budget"));
        }
        continue;
      }

      if (wouldFit(lines, section.heading, maxRenderedChars)
        && wouldFit([...lines, section.heading], item.line, maxRenderedChars)) {
        lines.push(section.heading, item.line);
        headingRendered = true;
        renderedEntryCount += 1;
      } else {
        omitted.push(omitHotStateItem(item, "char_budget"));
      }
    }
  }

  if (renderedEntryCount === 0) return { prompt: "", omitted, maxRenderedChars };

  return { prompt: lines.join("\n"), omitted, maxRenderedChars };
}

export function renderHotSessionState(state: SessionState, workspaceRoot: string): string {
  return accountHotSessionStateRender(state, workspaceRoot).prompt;
}

function buildHotStateRenderSections(
  state: SessionState,
  workspaceRoot: string,
  omitted: HotStateOmittedItem[],
): HotStateRenderSection[] {
  const activeFiles = rankActiveFiles(state.activeFiles).map(item => ({
    section: "active_files" as const,
    line: `- ${displayPath(workspaceRoot, item.path)} (${item.action}, ${item.count}x)`,
  }));
  const openErrors = [...state.openErrors]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map(err => ({
      section: "open_errors" as const,
      line: `- [${err.category}] ${err.summary}`,
    }));
  const decisions = state.recentDecisions.map(item => ({
    section: "recent_decisions" as const,
    line: `- ${item.text}`,
  }));
  const pendingMemories = dedupePendingMemories(state.pendingMemories).map(item => ({
    section: "pending_memories" as const,
    line: `- [${item.type}] ${item.text}`,
    memoryId: item.id,
  }));

  const renderedActiveFiles = capHotStateItems(activeFiles, HOT_STATE_LIMITS.maxActiveFilesRendered, "start", omitted);
  const renderedOpenErrors = capHotStateItems(openErrors, HOT_STATE_LIMITS.maxOpenErrorsRendered, "start", omitted);
  const renderedDecisions = capHotStateItems(decisions, HOT_STATE_LIMITS.maxRecentDecisionsStored, "end", omitted);
  const renderedPendingMemories = capHotStateItems(
    pendingMemories,
    HOT_STATE_LIMITS.maxPendingMemoriesRendered,
    "end",
    omitted,
  );

  return [
    { heading: "active_files:", items: renderedActiveFiles },
    { heading: "open_errors:", items: renderedOpenErrors },
    { heading: "recent_decisions:", items: renderedDecisions },
    { heading: "pending_memories:", items: renderedPendingMemories },
  ];
}

function capHotStateItems(
  items: HotStateRenderItem[],
  cap: number,
  keep: "start" | "end",
  omitted: HotStateOmittedItem[],
): HotStateRenderItem[] {
  if (items.length <= cap) return items;

  const renderedItems = keep === "start" ? items.slice(0, cap) : items.slice(-cap);
  const omittedItems = keep === "start" ? items.slice(cap) : items.slice(0, items.length - cap);
  omitted.push(...omittedItems.map(item => omitHotStateItem(item, "section_cap")));
  return renderedItems;
}

function omitHotStateItem(item: HotStateRenderItem, reason: HotStateOmissionReason): HotStateOmittedItem {
  return {
    section: item.section,
    reason,
    text: item.line,
    ...(item.memoryId ? { memoryId: item.memoryId } : {}),
  };
}

function wouldFit(lines: string[], nextLine: string, maxRenderedChars: number): boolean {
  return [...lines, nextLine].join("\n").length <= maxRenderedChars;
}

function rankActiveFiles(activeFiles: ActiveFile[]): ActiveFile[] {
  return [...activeFiles].sort((a, b) => {
    const scoreA = ACTION_WEIGHT[a.action] + a.count * 3;
    const scoreB = ACTION_WEIGHT[b.action] + b.count * 3;
    if (scoreA !== scoreB) return scoreB - scoreA;
    return b.lastSeen - a.lastSeen;
  });
}

export function displayPath(workspaceRoot: string, filePath: string): string {
  if (!workspaceRoot || !filePath.startsWith(workspaceRoot)) return filePath;
  return relative(workspaceRoot, filePath) || ".";
}

function pathsMatch(errorFile: string, touchedFile: string): boolean {
  const normalizedError = errorFile.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedTouched = touchedFile.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalizedError === normalizedTouched
    || normalizedTouched.endsWith(`/${normalizedError}`)
    || normalizedError.endsWith(`/${normalizedTouched}`);
}

function classifyCommand(command: string): OpenError["category"] | null {
  const c = command.toLowerCase();
  if (/\b(tsc|typecheck)\b/.test(c)) return "typecheck";
  if (/\b(test|vitest|jest|mocha|pytest|go test|cargo test)\b/.test(c)) return "test";
  if (/\b(lint|eslint|biome)\b/.test(c)) return "lint";
  if (/\b(build|vite build|webpack|tsup)\b/.test(c)) return "build";
  return null;
}
