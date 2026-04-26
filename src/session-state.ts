import { relative } from "path";
import { sessionStatePath } from "./paths.ts";
import { atomicWriteJSON, readJSON, updateJSON } from "./storage.ts";
import type { ActiveFile, OpenError, SessionDecision, SessionState } from "./types.ts";
import { HOT_STATE_LIMITS } from "./types.ts";

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
  };
}

export async function loadSessionState(root: string, sessionID: string): Promise<SessionState> {
  const fallback = createEmptySessionState(sessionID);
  const loaded = await readJSON(await sessionStatePath(root, sessionID), () => fallback);
  loaded.sessionID = sessionID;
  loaded.activeFiles = Array.isArray(loaded.activeFiles) ? loaded.activeFiles : [];
  loaded.openErrors = Array.isArray(loaded.openErrors) ? loaded.openErrors : [];
  loaded.recentDecisions = Array.isArray(loaded.recentDecisions) ? loaded.recentDecisions : [];
  return loaded;
}

export async function saveSessionState(root: string, state: SessionState): Promise<void> {
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
    return normalizeSessionState(await updater(current));
  });
}

function normalizeSessionState(state: SessionState): SessionState {
  state.updatedAt = new Date().toISOString();
  state.activeFiles = state.activeFiles.slice(0, HOT_STATE_LIMITS.maxActiveFilesStored);
  state.openErrors = state.openErrors.slice(0, HOT_STATE_LIMITS.maxOpenErrorsStored);
  state.recentDecisions = state.recentDecisions.slice(0, HOT_STATE_LIMITS.maxRecentDecisionsStored);
  return state;
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

export function renderHotSessionState(state: SessionState, workspaceRoot: string): string {
  const activeFiles = rankActiveFiles(state.activeFiles).slice(0, HOT_STATE_LIMITS.maxActiveFilesRendered);
  const openErrors = [...state.openErrors]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, HOT_STATE_LIMITS.maxOpenErrorsRendered);
  const decisions = state.recentDecisions.slice(-HOT_STATE_LIMITS.maxRecentDecisionsStored);

  if (activeFiles.length === 0 && openErrors.length === 0 && decisions.length === 0) return "";

  const lines: string[] = ["Hot session state (current session):"];

  if (activeFiles.length > 0) {
    lines.push("active_files:");
    for (const item of activeFiles) {
      const viewPath = displayPath(workspaceRoot, item.path);
      lines.push(`- ${viewPath} (${item.action}, ${item.count}x)`);
    }
  }

  if (openErrors.length > 0) {
    lines.push("open_errors:");
    for (const err of openErrors) {
      lines.push(`- [${err.category}] ${err.summary}`);
    }
  }

  if (decisions.length > 0) {
    lines.push("recent_decisions:");
    for (const decision of decisions) {
      lines.push(`- ${decision.text}`);
    }
  }

  return lines.join("\n").slice(0, HOT_STATE_LIMITS.maxRenderedChars);
}

function rankActiveFiles(activeFiles: ActiveFile[]): ActiveFile[] {
  return [...activeFiles].sort((a, b) => {
    const scoreA = ACTION_WEIGHT[a.action] + a.count * 3;
    const scoreB = ACTION_WEIGHT[b.action] + b.count * 3;
    if (scoreA !== scoreB) return scoreB - scoreA;
    return b.lastSeen - a.lastSeen;
  });
}

function displayPath(workspaceRoot: string, filePath: string): string {
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
