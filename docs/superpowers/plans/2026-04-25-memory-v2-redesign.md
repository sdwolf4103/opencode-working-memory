# Memory V2 Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current heavy four-tier memory plugin with a low-token, no-extra-agent-call memory system that provides workspace-scoped long-term memory and session hot state.

**Architecture:** Implement three layers: stable workspace memory, hot session state, and native OpenCode state integration. Workspace memory is frozen per session and refreshed at compaction boundaries; hot session state tracks active files and unresolved blocking errors automatically from tool events; OpenCode todos remain owned by OpenCode and are only read during compaction.

**Tech Stack:** TypeScript, OpenCode Plugin hooks, Node/Bun file APIs, JSON sidecar storage under user data directory, TypeScript typecheck via `npm run typecheck`.

---

## Design Summary

### What changes

- Remove default agent-visible memory tools from the normal flow.
- Remove raw tool-output cache and pressure-monitor intervention from the core path.
- Add workspace-scoped long-term memory that persists across sessions but does not cross workspaces.
- Add hot session state that is fully automatic and tiny: active files, open blocking errors, and recent decisions for compaction only.
- Reuse OpenCode compaction to extract long-term memory candidates with no extra LLM call.
- Read OpenCode todos during compaction instead of duplicating todo storage.

### What stays out of memory

- Long-term memory does **not** save file lists, stack traces, code signatures, API docs, git history, architecture snapshots, or temporary task progress.
- Short-term memory does **not** save todos or dependency facts because OpenCode and project files already own those.

---

## File Structure

Current project has a single `index.ts`. This plan splits memory behavior into focused modules while keeping `index.ts` as the plugin entrypoint.

### Create

- `src/paths.ts` — computes workspace-scoped storage paths under user data directory.
- `src/storage.ts` — atomic JSON read/write helpers with safe defaults.
- `src/types.ts` — canonical schemas and constants for long-term memory and session state.
- `src/workspace-memory.ts` — load/save/merge/render long-term workspace memory.
- `src/session-state.ts` — load/save/update/render active files, open errors, recent decisions.
- `src/extractors.ts` — deterministic extraction from user messages, tool args, bash output, and compaction summaries.
- `src/opencode.ts` — thin wrappers around OpenCode SDK calls for latest user messages, summaries, and todos.
- `src/plugin.ts` — hook orchestration.
- `tests/extractors.test.ts` — unit tests for deterministic extraction.
- `tests/workspace-memory.test.ts` — unit tests for merge, dedupe, limits, staleness rendering.
- `tests/session-state.test.ts` — unit tests for active files and error lifecycle.

### Modify

- `index.ts` — replace monolithic implementation with `export { default } from "./src/plugin";`.
- `package.json` — add a test script using Node’s built-in test runner or Bun test depending available runtime.
- `README.md` — update feature description from four-tier memory to Memory V2.
- `docs/architecture.md` — replace stale four-tier docs with three-layer design.
- `docs/configuration.md` — document limits and optional debug tools.
- `AGENTS.md` — update development guide, storage paths, and testing commands.

---

## Wave 1 — Storage, Types, and Deterministic Core

### Task 1: Add canonical types and limits

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Create memory and session schemas**

Add this file:

```ts
export type LongTermType = "feedback" | "project" | "decision" | "reference";

export type LongTermSource = "explicit" | "compaction" | "manual";

export type LongTermMemoryEntry = {
  id: string;
  type: LongTermType;
  text: string;
  rationale?: string;
  source: LongTermSource;
  confidence: number;
  status: "active" | "superseded";
  createdAt: string;
  updatedAt: string;
  staleAfterDays?: number;
  supersedes?: string[];
  tags?: string[];
};

export type WorkspaceMemoryStore = {
  version: 1;
  workspace: {
    root: string;
    key: string;
  };
  limits: {
    maxRenderedChars: number;
    maxEntries: number;
  };
  entries: LongTermMemoryEntry[];
  updatedAt: string;
};

export type ActiveFile = {
  path: string;
  action: "read" | "grep" | "edit" | "write";
  count: number;
  lastSeen: number;
};

export type OpenError = {
  id: string;
  category: "typecheck" | "test" | "lint" | "build" | "runtime" | "tool";
  summary: string;
  command?: string;
  file?: string;
  fingerprint: string;
  status: "open" | "maybe_fixed";
  firstSeen: number;
  lastSeen: number;
  seenCount: number;
};

export type SessionDecision = {
  id: string;
  text: string;
  rationale?: string;
  source: "assistant" | "user" | "compaction";
  createdAt: number;
  promotedToLongTerm?: boolean;
};

export type SessionState = {
  version: 1;
  sessionID: string;
  turn: number;
  updatedAt: string;
  activeFiles: ActiveFile[];
  openErrors: OpenError[];
  recentDecisions: SessionDecision[];
};

export const LONG_TERM_LIMITS = {
  maxRenderedChars: 5200,
  targetRenderedChars: 4200,
  maxEntries: 28,
  maxEntryTextChars: 260,
  maxRationaleChars: 180,
} as const;

export const HOT_STATE_LIMITS = {
  maxRenderedChars: 1200,
  maxActiveFilesStored: 20,
  maxActiveFilesRendered: 8,
  maxOpenErrorsStored: 5,
  maxOpenErrorsRendered: 3,
  maxRecentDecisionsStored: 8,
} as const;
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS or existing unrelated failures only. Since file is not imported yet, it should not introduce errors.

---

### Task 2: Add workspace-scoped paths and atomic storage

**Files:**
- Create: `src/paths.ts`
- Create: `src/storage.ts`

- [ ] **Step 1: Create `src/paths.ts`**

```ts
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { realpath } from "fs/promises";

export function dataHome(): string {
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

export async function workspaceKey(root: string): Promise<string> {
  const resolved = await realpath(root).catch(() => root);
  return createHash("sha256").update(resolved).digest("hex").slice(0, 16);
}

export async function memoryRoot(root: string): Promise<string> {
  return join(dataHome(), "opencode-working-memory", "workspaces", await workspaceKey(root));
}

export async function workspaceMemoryPath(root: string): Promise<string> {
  return join(await memoryRoot(root), "workspace-memory.json");
}

export async function sessionStatePath(root: string, sessionID: string): Promise<string> {
  return join(await memoryRoot(root), "sessions", `${sessionID}.json`);
}
```

- [ ] **Step 2: Create `src/storage.ts`**

```ts
import { existsSync } from "fs";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";

export async function readJSON<T>(path: string, fallback: () => T): Promise<T> {
  if (!existsSync(path)) return fallback();
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback();
  }
}

export async function atomicWriteJSON(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

---

### Task 3: Add extractor tests before implementation

**Files:**
- Create: `tests/extractors.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add test script**

Modify `package.json` scripts:

```json
{
  "scripts": {
    "build": "node -e \"console.log('No build step required: OpenCode loads index.ts directly')\"",
    "typecheck": "tsc --noEmit",
    "test": "node --test --experimental-strip-types tests/*.test.ts"
  }
}
```

- [ ] **Step 2: Write failing tests**

Create `tests/extractors.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractExplicitMemories,
  extractActiveFiles,
  extractErrorsFromBash,
  parseWorkspaceMemoryCandidates,
} from "../src/extractors.ts";

test("extractExplicitMemories captures clear remember instruction", () => {
  const items = extractExplicitMemories("请记住：这个 workspace 的 memory 功能必须默认无感");
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "feedback");
  assert.match(items[0].text, /默认无感/);
});

test("extractExplicitMemories avoids casual negative commands", () => {
  assert.equal(extractExplicitMemories("不要吃这个").length, 0);
  assert.equal(extractExplicitMemories("以后再说").length, 0);
});

test("extractActiveFiles uses tool args before output", () => {
  assert.deepEqual(extractActiveFiles("read", { filePath: "/repo/index.ts" }, "random content"), [
    { path: "/repo/index.ts", action: "read" },
  ]);
});

test("extractErrorsFromBash captures typecheck failure", () => {
  const errors = extractErrorsFromBash("npm run typecheck", "src/index.ts(10,3): error TS2345: bad type");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].category, "typecheck");
  assert.match(errors[0].summary, /TS2345/);
});

test("parseWorkspaceMemoryCandidates parses compaction block", () => {
  const entries = parseWorkspaceMemoryCandidates(`summary
<workspace_memory_candidates>
- [decision] Use JSON as canonical storage because it is easier to validate.
- [reference] External design notes are in Notion.
</workspace_memory_candidates>`);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].type, "decision");
  assert.equal(entries[1].type, "reference");
});
```

- [ ] **Step 3: Run tests and confirm failure**

Run: `npm test`

Expected: FAIL because `src/extractors.ts` does not exist.

---

### Task 4: Implement deterministic extractors

**Files:**
- Create: `src/extractors.ts`

- [ ] **Step 1: Add extractor implementation**

```ts
import { createHash } from "crypto";
import type { ActiveFile, LongTermMemoryEntry, LongTermType, OpenError } from "./types";
import { LONG_TERM_LIMITS } from "./types";

function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function hash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

export function extractExplicitMemories(text: string): LongTermMemoryEntry[] {
  const patterns = [
    /(?:请记住|記住|记住这一点|remember this|commit to memory)[:：]?\s*(.+)$/im,
    /(?:从现在开始|從現在開始|从今以后|從今以後|from now on|always)[:：]?\s*(.+)$/im,
  ];

  const now = new Date().toISOString();
  const entries: LongTermMemoryEntry[] = [];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const body = match?.[1]?.trim();
    if (!body || body.length < 8) continue;
    if (/^(再说|再說|later|next time)$/i.test(body)) continue;

    entries.push({
      id: id("mem"),
      type: classifyExplicitMemory(body),
      text: body.slice(0, LONG_TERM_LIMITS.maxEntryTextChars),
      source: "explicit",
      confidence: 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
      staleAfterDays: staleAfterDaysFor(classifyExplicitMemory(body)),
    });
  }

  return entries;
}

function classifyExplicitMemory(text: string): LongTermType {
  const lower = text.toLowerCase();
  if (/https?:\/\/|linear|slack|notion|dashboard|grafana/.test(lower)) return "reference";
  if (/decide|decision|choose|chosen|决定|決定|选择|選擇/.test(lower)) return "decision";
  if (/project|workspace|repo|项目|專案/.test(lower)) return "project";
  return "feedback";
}

export function staleAfterDaysFor(type: LongTermType): number | undefined {
  if (type === "feedback") return undefined;
  if (type === "decision") return 45;
  if (type === "project") return 60;
  return 90;
}

export function extractActiveFiles(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
): Array<{ path: string; action: ActiveFile["action"] }> {
  if (toolName === "read" && typeof args.filePath === "string") return [{ path: args.filePath, action: "read" }];
  if (toolName === "edit" && typeof args.filePath === "string") return [{ path: args.filePath, action: "edit" }];
  if (toolName === "write" && typeof args.filePath === "string") return [{ path: args.filePath, action: "write" }];
  if (toolName === "grep") return extractGrepPaths(output).map(path => ({ path, action: "grep" as const }));
  return [];
}

function extractGrepPaths(output: string): string[] {
  const matches = output.match(/^(\/[^
  return [...new Set(matches.map(match => match.replace(/:$/, "")))].slice(0, 10);
}

export function extractErrorsFromBash(command: string, output: string): OpenError[] {
  const lines = output.split("\n").filter(line => /error|failed|failure|exception|TS\d{4}|ERR!/i.test(line)).slice(0, 5);
  if (lines.length === 0) return [];

  const category = classifyCommand(command) ?? "runtime";
  const summary = lines.join(" ").slice(0, 280);
  const fingerprint = hash(`${category}:${summary.toLowerCase().replace(/\s+/g, " ")}`);
  const now = Date.now();

  return [{
    id: `err_${fingerprint}`,
    category,
    summary,
    command,
    file: extractFirstPath(summary),
    fingerprint,
    status: "open",
    firstSeen: now,
    lastSeen: now,
    seenCount: 1,
  }];
}

export function classifyCommand(command: string): OpenError["category"] | null {
  const c = command.toLowerCase();
  if (/\b(tsc|typecheck)\b/.test(c)) return "typecheck";
  if (/\b(test|vitest|jest|mocha|pytest|go test|cargo test)\b/.test(c)) return "test";
  if (/\b(lint|eslint|biome)\b/.test(c)) return "lint";
  if (/\b(build|vite build|webpack|tsup)\b/.test(c)) return "build";
  return null;
}

function extractFirstPath(text: string): string | undefined {
  return text.match(/[\w./-]+\.(ts|tsx|js|jsx|json|md|py|go|rs)/)?.[0];
}

export function parseWorkspaceMemoryCandidates(summary: string): LongTermMemoryEntry[] {
  const match = summary.match(/<workspace_memory_candidates>([\s\S]*?)<\/workspace_memory_candidates>/i);
  if (!match) return [];

  const now = new Date().toISOString();
  const entries: LongTermMemoryEntry[] = [];

  for (const line of match[1].split("\n")) {
    const item = line.trim().match(/^-\s*\[(feedback|project|decision|reference)\]\s*(.+)$/i);
    if (!item) continue;
    const type = item[1].toLowerCase() as LongTermType;
    const body = item[2].trim();
    if (body.length < 12) continue;
    entries.push({
      id: id("mem"),
      type,
      text: body.slice(0, LONG_TERM_LIMITS.maxEntryTextChars),
      source: "compaction",
      confidence: 0.75,
      status: "active",
      createdAt: now,
      updatedAt: now,
      staleAfterDays: staleAfterDaysFor(type),
    });
  }

  return entries;
}
```

- [ ] **Step 2: Run extractor tests**

Run: `npm test`

Expected: PASS for extractor tests.

---

### Wave 1 verification checkpoint

- [ ] **Step 1: Run all checks**

Run: `npm test && npm run typecheck`

Expected: PASS.

- [ ] **Step 2: Review wave output**

Confirm: Types, paths, storage helpers, and deterministic extractors exist and tests cover clear remember, false positives, active files, bash errors, and compaction candidates.

- [ ] **Step 3: Commit wave**

```bash
git add package.json src tests
git commit -m "refactor: add memory v2 core primitives"
```

---

## Wave 2 — Workspace Memory and Hot Session State

### Task 5: Implement workspace memory store

**Files:**
- Create: `src/workspace-memory.ts`
- Test: `tests/workspace-memory.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/workspace-memory.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import type { LongTermMemoryEntry } from "../src/types.ts";
import { enforceLongTermLimits, renderWorkspaceMemory } from "../src/workspace-memory.ts";

function entry(text: string, type: LongTermMemoryEntry["type"] = "feedback"): LongTermMemoryEntry {
  const now = new Date().toISOString();
  return { id: text, type, text, source: "explicit", confidence: 1, status: "active", createdAt: now, updatedAt: now };
}

test("enforceLongTermLimits dedupes entries", () => {
  const kept = enforceLongTermLimits([entry("Memory must be invisible"), entry("Memory must be invisible")]);
  assert.equal(kept.length, 1);
});

test("renderWorkspaceMemory includes verify marker for stale decisions", () => {
  const old = entry("Use JSON storage", "decision");
  old.createdAt = "2020-01-01T00:00:00.000Z";
  old.staleAfterDays = 45;
  const rendered = renderWorkspaceMemory({ version: 1, workspace: { root: "/repo", key: "abc" }, limits: { maxRenderedChars: 5200, maxEntries: 28 }, entries: [old], updatedAt: old.createdAt });
  assert.match(rendered, /verify/);
});
```

- [ ] **Step 2: Implement workspace memory functions**

Create `src/workspace-memory.ts` with:

```ts
import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "./types";
import { LONG_TERM_LIMITS } from "./types";
import { workspaceKey, workspaceMemoryPath } from "./paths";
import { atomicWriteJSON, readJSON } from "./storage";

export async function emptyWorkspaceMemory(root: string): Promise<WorkspaceMemoryStore> {
  return {
    version: 1,
    workspace: { root, key: await workspaceKey(root) },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    entries: [],
    updatedAt: new Date().toISOString(),
  };
}

export async function loadWorkspaceMemory(root: string): Promise<WorkspaceMemoryStore> {
  return readJSON(await workspaceMemoryPath(root), () => ({
    version: 1,
    workspace: { root, key: "unknown" },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    entries: [],
    updatedAt: new Date().toISOString(),
  }));
}

export async function saveWorkspaceMemory(root: string, store: WorkspaceMemoryStore): Promise<void> {
  store.workspace = { root, key: await workspaceKey(root) };
  store.entries = enforceLongTermLimits(store.entries);
  store.updatedAt = new Date().toISOString();
  await atomicWriteJSON(await workspaceMemoryPath(root), store);
}

export function enforceLongTermLimits(entries: LongTermMemoryEntry[]): LongTermMemoryEntry[] {
  const byKey = new Map<string, LongTermMemoryEntry>();
  for (const entry of entries.filter(e => e.status === "active")) {
    const text = entry.text.slice(0, LONG_TERM_LIMITS.maxEntryTextChars);
    const key = `${entry.type}:${text.toLowerCase().replace(/\s+/g, " ").trim()}`;
    const existing = byKey.get(key);
    if (!existing || entry.source === "explicit") byKey.set(key, { ...entry, text });
  }
  return [...byKey.values()]
    .sort((a, b) => priority(b) - priority(a))
    .slice(0, LONG_TERM_LIMITS.maxEntries);
}

function priority(entry: LongTermMemoryEntry): number {
  const type = { feedback: 400, decision: 300, project: 200, reference: 100 }[entry.type];
  const source = entry.source === "explicit" ? 1000 : 0;
  return source + type + entry.confidence * 10;
}

export function renderWorkspaceMemory(store: WorkspaceMemoryStore): string {
  const active = enforceLongTermLimits(store.entries);
  if (active.length === 0) return "";
  const lines = [
    "<workspace_memory>",
    "Persistent workspace memory. Use as background; verify stale or code-related claims.",
  ];
  for (const type of ["feedback", "project", "decision", "reference"] as const) {
    const items = active.filter(e => e.type === type);
    if (items.length === 0) continue;
    lines.push(`${type}:`);
    for (const item of items) lines.push(`- ${renderEntry(item)}`);
  }
  lines.push("</workspace_memory>");
  return lines.join("\n").slice(0, store.limits.maxRenderedChars);
}

function renderEntry(entry: LongTermMemoryEntry): string {
  const ageDays = Math.floor((Date.now() - new Date(entry.createdAt).getTime()) / 86_400_000);
  const stale = entry.staleAfterDays && ageDays > entry.staleAfterDays ? ` [${ageDays}d old, verify]` : "";
  const rationale = entry.rationale ? ` Why: ${entry.rationale.slice(0, LONG_TERM_LIMITS.maxRationaleChars)}` : "";
  return `${entry.text}${rationale}${stale}`;
}
```

- [ ] **Step 3: Run tests**

Run: `npm test`

Expected: PASS.

---

### Task 6: Implement session state lifecycle

**Files:**
- Create: `src/session-state.ts`
- Test: `tests/session-state.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/session-state.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createEmptySessionState, touchActiveFile, upsertOpenError, clearErrorsForSuccessfulCommand, renderHotSessionState } from "../src/session-state.ts";
import type { OpenError } from "../src/types.ts";

test("touchActiveFile weights edits above reads", () => {
  const state = createEmptySessionState("s1");
  touchActiveFile(state, "/repo/a.ts", "read");
  touchActiveFile(state, "/repo/b.ts", "edit");
  assert.equal(state.activeFiles[0].path, "/repo/b.ts");
});

test("clearErrorsForSuccessfulCommand clears category", () => {
  const state = createEmptySessionState("s1");
  const err: OpenError = { id: "e", category: "typecheck", summary: "TS error", fingerprint: "f", status: "open", firstSeen: 1, lastSeen: 1, seenCount: 1 };
  upsertOpenError(state, err);
  clearErrorsForSuccessfulCommand(state, "npm run typecheck");
  assert.equal(state.openErrors.length, 0);
});

test("renderHotSessionState includes active files and open errors", () => {
  const state = createEmptySessionState("s1");
  touchActiveFile(state, "/repo/index.ts", "edit");
  upsertOpenError(state, { id: "e", category: "test", summary: "test failed", fingerprint: "f", status: "open", firstSeen: 1, lastSeen: 1, seenCount: 1 });
  const rendered = renderHotSessionState(state, "/repo");
  assert.match(rendered, /index.ts/);
  assert.match(rendered, /test failed/);
});
```

- [ ] **Step 2: Implement session state functions**

Create `src/session-state.ts` with create/load/save/touch/upsert/clear/render functions matching the tests.

- [ ] **Step 3: Run tests**

Run: `npm test`

Expected: PASS.

---

### Wave 2 verification checkpoint

- [ ] **Step 1: Run all checks**

Run: `npm test && npm run typecheck`

Expected: PASS.

- [ ] **Step 2: Review wave output**

Confirm: Long-term store enforces limits and renders staleness. Hot session state ranks active files, stores open errors, and clears category errors on successful validation commands.

- [ ] **Step 3: Commit wave**

```bash
git add src tests
git commit -m "feat: add workspace memory and hot session state"
```

---

## Wave 3 — Plugin Hook Integration

### Task 7: Wire OpenCode helper functions

**Files:**
- Create: `src/opencode.ts`

- [ ] **Step 1: Add SDK wrappers**

Create `src/opencode.ts` with helpers:

```ts
export async function latestUserText(client: any, sessionID: string): Promise<{ id: string; text: string } | null> {
  const result = await client.session.messages({ path: { id: sessionID } });
  const messages = result.data ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info?.role !== "user") continue;
    const text = msg.parts?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") ?? "";
    if (text.trim()) return { id: msg.info.id, text };
  }
  return null;
}

export async function latestCompactionSummary(client: any, sessionID: string): Promise<string | null> {
  const result = await client.session.messages({ path: { id: sessionID } });
  const messages = result.data ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info?.role !== "assistant" || msg.info?.summary !== true) continue;
    const text = msg.parts?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") ?? "";
    if (text.trim()) return text;
  }
  return null;
}

export async function pendingTodos(client: any, sessionID: string): Promise<Array<{ content: string; status: string; priority?: string }>> {
  try {
    const result = await client.session.todo({ path: { id: sessionID } });
    return (result.data ?? []).filter((todo: any) => todo.status !== "completed");
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

---

### Task 8: Implement plugin orchestration

**Files:**
- Create: `src/plugin.ts`
- Modify: `index.ts`

- [ ] **Step 1: Replace `index.ts` entrypoint**

```ts
export { default } from "./src/plugin";
```

- [ ] **Step 2: Implement hooks in `src/plugin.ts`**

Create plugin that:

- caches frozen workspace memory per `sessionID`
- processes explicit memory from latest user text once per message id
- injects frozen workspace memory and dynamic hot session state
- updates session state after tools
- augments compaction context with memory, hot state, todos, and memory candidate instruction
- parses compaction summaries from `session.compacted` event and merges candidates

The compaction instruction must be:

```ts
function memoryCandidateInstruction(): string {
  return `
At the end of the compaction summary, include:

<workspace_memory_candidates>
- [feedback] ...
- [project] ...
- [decision] ...
- [reference] ...
</workspace_memory_candidates>

Only include durable information useful across future sessions in this exact workspace.
Do NOT include active file lists, raw errors, temporary progress, stack traces, code signatures, API docs, git history, or facts easily rediscovered from the repository.
For decisions, include rationale in one sentence.
If nothing qualifies, output an empty block.
`.trim();
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

---

### Wave 3 verification checkpoint

- [ ] **Step 1: Run all checks**

Run: `npm test && npm run typecheck`

Expected: PASS.

- [ ] **Step 2: Manual plugin smoke test**

Run OpenCode with local plugin and verify:

- user message `请记住：这个 workspace 的 memory 功能要默认无感` creates a long-term entry
- reading/editing files updates hot session state
- failed typecheck creates an open error
- successful typecheck clears typecheck errors

- [ ] **Step 3: Commit wave**

```bash
git add index.ts src tests
git commit -m "feat: wire memory v2 plugin hooks"
```

---

## Wave 4 — Documentation and Migration

### Task 9: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/configuration.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update README feature summary**

Describe Memory V2 as:

- workspace-scoped long-term memory
- hot session state
- no default agent-visible memory tools
- no raw tool-output cache
- compaction boundary extraction with no extra LLM call

- [ ] **Step 2: Update architecture doc**

Replace four-tier architecture with:

```text
Layer 1: Stable Workspace Memory
Layer 2: Hot Session State
Layer 3: Native OpenCode State
```

- [ ] **Step 3: Update configuration doc**

Document:

- `LONG_TERM_LIMITS`
- `HOT_STATE_LIMITS`
- storage root under `XDG_DATA_HOME` or `~/.local/share`
- optional future `/memory import`

- [ ] **Step 4: Update AGENTS.md**

Update commands:

```bash
npm test
npm run typecheck
```

Update storage and testing guidance to match Memory V2.

---

### Task 10: Remove obsolete implementation paths

**Files:**
- Modify: `index.ts` if old code remains
- Modify: docs references if any still mention old APIs

- [ ] **Step 1: Remove obsolete references**

Ensure repo no longer advertises default tools:

- `core_memory_update`
- `core_memory_read`
- `working_memory_add`
- `working_memory_clear`
- `working_memory_clear_slot`
- `working_memory_remove`

Unless a debug-only compatibility layer is explicitly retained, these names must not appear in README or architecture docs.

- [ ] **Step 2: Remove obsolete concepts from docs**

Remove or mark deprecated:

- slots/pool/decay
- pressure monitor as core feature
- raw tool-output cache
- smart pruning replacing old tool outputs

- [ ] **Step 3: Run docs grep**

Run: `grep -R "core_memory_update\|working_memory_add\|pressure monitor\|tool-output cache" README.md docs AGENTS.md`

Expected: no matches, or matches only under a clearly marked migration note.

---

### Wave 4 verification checkpoint

- [ ] **Step 1: Run all checks**

Run: `npm test && npm run typecheck`

Expected: PASS.

- [ ] **Step 2: Verify docs match code**

Confirm: README, architecture, configuration, and AGENTS describe Memory V2 and do not promise old tools or old four-tier behavior.

- [ ] **Step 3: Commit wave**

```bash
git add README.md docs AGENTS.md index.ts src tests package.json
git commit -m "docs: document memory v2 design"
```

---

## Verification Strategy

### Automated

- `npm test` validates extractors, long-term merge/render, and hot session lifecycle.
- `npm run typecheck` validates TypeScript imports and plugin entrypoint.

### Manual OpenCode smoke tests

1. Start a session with the plugin enabled.
2. Send: `请记住：这个 workspace 的 memory 功能要默认无感`.
3. Confirm `workspace-memory.json` is written under `~/.local/share/opencode-working-memory/workspaces/<hash>/`.
4. Read and edit a file.
5. Confirm session state active files update.
6. Run a failing typecheck command.
7. Confirm open error appears in hot state.
8. Run a passing typecheck command.
9. Confirm typecheck error clears.
10. Trigger or simulate compaction.
11. Confirm compaction context includes memory candidate instruction and parsed candidates merge after compaction.

---

## Risk Controls

- **False memory extraction:** explicit regex only matches strong remember/from-now-on phrasing; compaction extraction uses explicit “what not to save” boundaries.
- **Token overhead:** no background LLM agent; compaction extraction piggybacks existing compaction call; hot state capped at 1200 chars.
- **Stale memory:** decision/project/reference entries have stale markers during render.
- **Privacy:** storage lives in user data directory, not repo, and writes with `0600` mode.
- **Duplicate todo state:** todos are not stored by the plugin; OpenCode remains source of truth.
- **Error staleness:** errors clear only after successful validation commands and become `maybe_fixed` after related edits.

---

## Self-Review

- Spec coverage: plan implements workspace-scoped cross-session memory, bounded long-term memory, compaction-boundary update, fully automatic hot session memory, and no extra LLM calls.
- Placeholder scan: plan contains no TBD/TODO placeholders; Tasks 8-10 reference exact expected behavior and code boundaries.
- Type consistency: `LongTermMemoryEntry`, `WorkspaceMemoryStore`, `SessionState`, `ActiveFile`, `OpenError`, and `SessionDecision` are defined once in Task 1 and reused consistently.
- Wave coherence: each wave ends with tests/typecheck and a committable checkpoint.
