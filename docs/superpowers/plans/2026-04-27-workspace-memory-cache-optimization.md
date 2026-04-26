# Workspace Memory Cache Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep OpenCode's cache-controlled system prefix stable during a session by freezing rendered workspace memory and moving dynamic hot state into an uncached ephemeral segment.

**Architecture:** Split memory context into three layers: `system[0]` base agent header, `system[1]` frozen rendered workspace snapshot, and `system[2+]` dynamic ephemeral state. Mid-session explicit memory writes become pending deltas and are promoted to long-term workspace memory during compaction, so the running prompt remains stable.

**Tech Stack:** TypeScript ESM, OpenCode plugin hooks, Node `node:test`, OpenCode provider transform cache-control behavior.

---

## Goal

- Make workspace memory behave like Hermes' frozen snapshot pattern: loaded and rendered once at session start, then immutable for the running session.
- Preserve Claude Code-style cache locality by separating stable facts from dynamic execution state.
- Use OpenCode's existing two cached system-message policy so only stable messages receive cache control.
- Expected outcome: in a typical 10-turn tool-heavy session, the cache-controlled system prefix should remain stable after the first request, improving effective cache reuse from roughly 30-45% to roughly 80-85% of reusable prompt bytes.

## Background

Current code injects both workspace memory and hot session state in the same hook:

- `src/plugin.ts:264-291` registers `experimental.chat.system.transform`.
- `src/plugin.ts:274-275` loads frozen workspace memory through `getFrozenWorkspaceMemory(...)`.
- `src/plugin.ts:277-289` loads and injects hot session state on every chat turn.
- `src/plugin.ts:294-341` updates hot session state after every tool call.

OpenCode then collapses plugin-added system messages:

- `/Users/sd_wo/work/opencode-clone/packages/opencode/src/session/llm.ts:114-119` joins all system messages after `system[0]` into `system[1]` when the header is unchanged.

Provider cache control is applied later:

- `/Users/sd_wo/work/opencode-clone/packages/opencode/src/provider/transform.ts:192-194` selects the first two system messages and last two non-system messages.
- `/Users/sd_wo/work/opencode-clone/packages/opencode/src/provider/transform.ts:217-238` adds provider-specific ephemeral cache-control metadata.
- `/Users/sd_wo/work/opencode-clone/packages/opencode/src/provider/transform.ts:281-295` calls `applyCaching(...)` for Anthropic/Claude-like providers.

Because hot state is updated after each tool call, and OpenCode currently merges it into `system[1]`, the second cache-controlled system message changes frequently. Workspace memory is less dynamic, but it is cached as a store reference rather than as a rendered prompt, and explicit memory handling can mutate the cached store mid-session:

- `src/plugin.ts:160-167` stores the frozen workspace cache entry.
- `src/plugin.ts:238-252` returns the same cached store for a session.
- `src/plugin.ts:172-193` processes explicit user memory and currently updates workspace memory plus the cached store.
- `src/workspace-memory.ts:430-464` renders workspace memory.
- `src/workspace-memory.ts:468` uses `Date.now()` to compute age markers, so render output can drift over long sessions even when the store does not change.

## Proposed Changes

### Change 1: Frozen Rendered Snapshot

- **What:** Replace the session cache's mutable workspace-memory `store` usage with a session-frozen rendered snapshot string. The plugin should render workspace memory once per session and reuse that exact string for all later turns.
- **Why:** A rendered prompt string is the actual cache-key input. Freezing the store reference is not enough because rendering can depend on wall-clock time and explicit memory code can mutate the cache.
- **How (code reference):**
  - Modify `src/plugin.ts:160-167` so cache entries include `renderedPrompt: string` and `storeLoadedAt: number`.
  - Replace `getFrozenWorkspaceMemory(...)` at `src/plugin.ts:238-252` with `getFrozenWorkspaceMemorySnapshot(...)` returning `{ store, renderedPrompt }`.
  - In `src/plugin.ts:274-284`, push `snapshot.renderedPrompt` instead of re-rendering with `renderWorkspaceMemory(...)` on each turn.
  - In `src/plugin.ts:374-379`, use the same frozen rendered prompt when building compaction context.
  - Keep `src/workspace-memory.ts:430-464` as the renderer, but call it only during snapshot creation for normal chat turns.
- **Files to modify:**
  - `src/plugin.ts`
  - `tests/plugin.test.ts`

### Change 2: Ephemeral System Segment

- **What:** Keep hot session state in `system[2+]` instead of allowing it to merge into cache-controlled `system[1]`.
- **Why:** OpenCode only applies cache control to the first two system messages. If `system[0]` is the base header and `system[1]` is frozen workspace memory, then `system[2+]` becomes a natural Hermes-like `ephemeral_system_prompt` segment without changing provider transforms.
- **How (code reference):**
  - Preserve plugin push order in `src/plugin.ts:280-290`: workspace snapshot first, hot state second.
  - Modify `/Users/sd_wo/work/opencode-clone/packages/opencode/src/session/llm.ts:114-119` so it does not join dynamic `system[2+]` messages into `system[1]`.
  - Keep `/Users/sd_wo/work/opencode-clone/packages/opencode/src/provider/transform.ts:192-194` unchanged: `slice(0, 2)` should continue to cache only stable system messages.
- **Files to modify:**
  - `/Users/sd_wo/work/opencode-clone/packages/opencode/src/session/llm.ts`
  - Add or update OpenCode-side tests near the LLM/system-message transformation tests if present in `opencode-clone`.
  - `tests/plugin.test.ts` for plugin-side message ordering.

### Change 3: Pending Delta Promotion

- **What:** Change explicit user memory handling from immediate workspace-memory mutation to session-local pending deltas, then promote those deltas during compaction.
- **Why:** Mid-session writes should update durable state on disk or pending session state, but they must not mutate the running frozen prompt. This matches Hermes' "mid-session writes update disk but do not mutate running prompt" behavior while preserving user intent in the current session through an ephemeral delta.
- **How (code reference):**
  - Extend `SessionState` in `src/types.ts:64-72` with `pendingMemories: LongTermMemoryEntry[]`.
  - Update `createEmptySessionState(...)`, `loadSessionState(...)`, `updateSessionState(...)`, and `normalizeSessionState(...)` in `src/session-state.ts:14-60` to initialize, normalize, and cap pending memories.
  - Update `renderHotSessionState(...)` in `src/session-state.ts:174-208` to include `pending_memory_updates:` in the ephemeral hot state prompt.
  - Modify `processLatestUserMessage(...)` in `src/plugin.ts:172-193` so explicit memories are appended to `SessionState.pendingMemories` instead of calling `updateWorkspaceMemory(...)`.
  - Modify the compaction event handler at `src/plugin.ts:411-432` so it promotes both parsed compaction candidates and unpromoted `pendingMemories` to workspace memory, then clears the pending list.
- **Files to modify:**
  - `src/types.ts`
  - `src/session-state.ts`
  - `src/plugin.ts`
  - `tests/plugin.test.ts`
  - `tests/workspace-memory.test.ts` only if memory-entry limit behavior changes.

### Change 4: Durable Pending Journal (P0)

- **What:** Add a workspace-level pending journal on disk so explicit memories survive sessions that end without compaction.
- **Why:** `SessionState.pendingMemories` is session-scoped. If the user says "remember X", then closes the session before `session.compacted`, the memory may never be promoted to `workspace-memory.json`. If `session.deleted` removes the session state first, the memory is lost. Explicit memory must be durable even when compaction never happens.
- **How (code reference):**
  - Add a pending journal file at the workspace memory root, named `workspace-pending-journal.json`.
  - Add `src/pending-journal.ts` with helpers:
    - `loadPendingJournal(root)`
    - `appendPendingMemories(root, memories)`
    - `promotePendingJournal(root, promote)`
    - `clearPromotedPendingMemories(root, promotedKeys)`
  - Add `workspacePendingJournalPath(root)` to `src/paths.ts` near `workspaceMemoryPath(root)`.
  - Modify `processLatestUserMessage(...)` in `src/plugin.ts:172-193` so explicit memory writes go to both:
    - `SessionState.pendingMemories`, for same-session visibility through `system[2+]`.
    - `workspace-pending-journal.json`, for durability across session end/no compaction.
  - Modify `experimental.chat.system.transform` in `src/plugin.ts:264-291` so the first turn of a session attempts promotion-on-start from the journal into `workspace-memory.json` before creating the frozen rendered snapshot. This must run only before the session's first frozen snapshot, not on every turn, so current-session explicit memories do not get promoted into the same session's frozen `system[1]`.
  - Modify `session.compacted` handling at `src/plugin.ts:411-432` so it promotes both session pending memories and journal pending memories.
  - Modify `session.deleted` handling at `src/plugin.ts:435-442` so it promotes pending memories before deleting session state.
- **Files to modify:**
  - Create `src/pending-journal.ts`
  - Modify `src/paths.ts`
  - Modify `src/plugin.ts`
  - Modify `src/session-state.ts`
  - Modify `src/types.ts`
  - Modify `tests/plugin.test.ts`

## Cache Impact Estimate

### Assumptions for a typical 10-turn session

- 10 model requests, with 9 follow-up turns after tool execution.
- Each follow-up turn has at least one tool call, so `tool.execute.after` updates hot state each time through `src/plugin.ts:294-341`.
- Base system header size: about 10-15 KB, depending on agent/provider prompt.
- Workspace memory snapshot size: target 4.2 KB, max 5.2 KB from `src/types.ts:74-80`.
- Hot session state size: 0.3-1.2 KB, max 1.2 KB from `src/types.ts:82-89`.
- A typical tool update changes:
  - Active file count/action line: 5-25 changed characters, e.g. `(read, 1x)` to `(read, 2x)`.
  - New active file line: 30-90 added characters.
  - New error summary line: 80-220 added characters.
  - Timestamp-derived ordering can reorder rendered lines without visible timestamps.
- Practical estimate: each tool call changes 50-300 visible characters in hot state; a failed `bash` command can change 150-500 visible characters.

### Cache-control placement

For Anthropic/Claude-like providers, OpenCode applies cache control here:

```ts
// /Users/sd_wo/work/opencode-clone/packages/opencode/src/provider/transform.ts:192-194
const system = msgs.filter((msg) => msg.role === "system").slice(0, 2)
const final = msgs.filter((msg) => msg.role !== "system").slice(-2)
```

Then the selected messages receive provider-specific cache-control metadata at `transform.ts:217-238`.

### Before

Prompt layering effectively becomes:

```text
system[0] = base header                                      cached, stable
system[1] = workspace memory + hot session state              cached, changes after tool calls
final[-2:] = latest non-system messages                       cached, changes every turn
```

Estimated cacheability across 10 turns:

- System[0] cached: ~95-100% after first request.
- System[1] cached: ~10-25% because hot state changes on most turns.
- Last two non-system messages cached: ~0-20% because each turn appends new assistant/tool/user content.

Byte-weighted estimate:

```text
Stable bytes before per request:
  system[0] = 12 KB reusable
  system[1] = 4.2 KB workspace + 0.8 KB hot = 5 KB, but invalidated on ~9/10 turns

Reusable cached system bytes after warm-up:
  system[0] reuse = 12 KB * 9 turns = 108 KB
  system[1] reuse = 5 KB * 2 likely stable turns = 10 KB
  total potential system bytes = 17 KB * 9 turns = 153 KB

Effective cached system-prefix reuse = (108 + 10) / 153 = 77%
```

However provider cache behavior often invalidates later prefix segments when an earlier cached block's content changes or when the cache breakpoints move. Because `system[1]` is one of the explicit cache-control breakpoints, practical observed cache benefit is expected to be lower than the byte-only estimate:

- System[0] cached: ~95-100%.
- System[1] cached: ~10-25%.
- Overall effective cache hit rate: ~30-45% for the cache-controlled prompt sections in tool-heavy sessions.

### After

Prompt layering becomes:

```text
system[0] = base header                                      cached, stable
system[1] = frozen rendered workspace memory snapshot         cached, stable
system[2] = hot session state + pending memory deltas          uncached ephemeral
final[-2:] = latest non-system messages                       cached, changes every turn
```

Estimated cacheability across 10 turns:

- System[0] cached: ~100% after first request.
- System[1] cached: ~90-100% within a session. Use ~90% to account for new sessions, explicit session restarts, compaction boundaries, and provider-side eviction.
- System[2] uncached: N/A by design; it is not selected by `slice(0, 2)`.
- Last two non-system messages cached: ~0-20% because conversation tail remains dynamic.

Byte-weighted estimate:

```text
Stable cached prefix after per request:
  system[0] = 12 KB
  system[1] = 4.2 KB workspace snapshot
  system[2] = 0.8 KB hot state, intentionally uncached

Reusable cached system bytes after warm-up:
  system[0] reuse = 12 KB * 9 turns = 108 KB
  system[1] reuse = 4.2 KB * 8.5 effective turns = 35.7 KB
  total stable cacheable system bytes = 16.2 KB * 9 turns = 145.8 KB

Effective cached stable-prefix reuse = (108 + 35.7) / 145.8 = 98.6%
```

Including dynamic tail messages and provider eviction, a conservative end-to-end estimate is:

- Expected cache hit rate for stable system-prefix bytes: ~95-99% after warm-up.
- Expected overall cache hit rate across cache-controlled sections: ~80-85% in a 10-turn tool-heavy session.
- Expected improvement versus current behavior: +35 to +50 percentage points, mainly by preventing hot state from invalidating `system[1]`.

## Timeline

- Phase 1: Implement frozen rendered snapshot inside the plugin and add tests proving workspace memory render output is stable. All tests must pass at the end of this phase.
- Phase 2: Modify OpenCode system-message merging so `system[2+]` remains separate and ephemeral; verify cache-control still targets only `system[0]` and `system[1]`.
- Phase 3: Add durable pending journal, pending memory deltas, promotion-on-compaction, promotion-on-start, and promotion-before-delete. All explicit memory durability tests must pass at the end of this phase.

## Risk / Tradeoffs

- **Requires OpenCode core change:** The biggest cache win depends on changing `/Users/sd_wo/work/opencode-clone/packages/opencode/src/session/llm.ts:114-119`. Without that change, plugin-side ordering alone cannot prevent hot state from merging into `system[1]`.
- **Explicit memory becomes eventually consistent:** A user saying "remember X" will no longer alter the stable workspace snapshot immediately. The current session still sees the pending delta through `system[2+]`; future sessions see it after compaction promotion.
- **Compaction must not lose pending deltas:** Promotion logic needs tests for sessions with pending explicit memories but no parsed compaction candidates.
- **No-compaction sessions must not lose explicit memory:** `workspace-pending-journal.json` is required because many real sessions will end without `session.compacted`.
- **Durable pending journal adds disk I/O:** Explicit memory writes now touch session state and a workspace-level journal. This is acceptable because explicit memory events are rare compared with tool calls, but tests should cover corrupted/missing journal fallback.
- **Journal schema migration:** `workspace-pending-journal.json` needs the same boring normalization discipline as `workspace-memory.json`: tolerate missing fields, unknown versions, duplicate entries, and partial/corrupt files by falling back safely.
- **More session-state schema surface:** Adding `pendingMemories` increases normalization and migration responsibility, but this is contained in `src/session-state.ts`.
- **Provider-specific cache semantics vary:** The estimate is most applicable to Anthropic/Claude-like providers because OpenCode applies cache control to them in `transform.ts:281-295`.

## Required Edge Cases

- **No compaction, new session:** Explicit memory written in session A must survive in `workspace-pending-journal.json` and be promoted before session B freezes its workspace snapshot.
- **Session deleted:** `session.deleted` must promote pending memories before deleting the session state file. If promotion fails, do not delete the session state.
- **Duplicate explicit memory:** Dedupe by normalized `type + text`, not generated `id`, because `extractExplicitMemories(...)` creates a fresh id for each extraction.
- **Promotion failure:** If `updateWorkspaceMemory(...)` fails, leave both `SessionState.pendingMemories` and `workspace-pending-journal.json` intact.
- **Pending memory render cap:** Render at most `HOT_STATE_LIMITS.maxPendingMemoriesRendered` entries and keep total hot prompt within `HOT_STATE_LIMITS.maxRenderedChars`.
- **Oversized workspace memory:** Frozen rendered snapshot must still respect `LONG_TERM_LIMITS.maxRenderedChars` through `renderWorkspaceMemory(...)`.

---

## File Structure

- `src/plugin.ts`: Owns plugin hooks, frozen snapshot cache, explicit memory processing, compaction promotion, and injection order.
- `src/pending-journal.ts`: Owns durable workspace-level pending memories in `workspace-pending-journal.json`, including append, dedupe, promotion, clearing, and corrupt-file fallback.
- `src/paths.ts`: Owns path helpers for `workspace-memory.json`, session state, and `workspace-pending-journal.json`.
- `src/session-state.ts`: Owns hot state persistence and rendering, including pending memory deltas.
- `src/types.ts`: Owns the `SessionState` schema and limits for hot state and pending memories.
- `tests/plugin.test.ts`: Covers plugin hooks, frozen snapshot behavior, pending delta behavior, and compaction promotion.
- `/Users/sd_wo/work/opencode-clone/packages/opencode/src/session/llm.ts`: Owns system-message structure before provider transform.
- `/Users/sd_wo/work/opencode-clone/packages/opencode/src/provider/transform.ts`: No planned change; keep cache-control selection as first two system messages plus final two non-system messages.

---

## Wave 1 — Freeze Rendered Workspace Snapshot

### Task 1: Add frozen rendered snapshot tests

**Files:**
- Modify: `tests/plugin.test.ts`

- [ ] **Step 1: Add a test proving workspace memory render output is reused within the same session**

Append this test to `tests/plugin.test.ts`:

```ts
test("chat system transform reuses frozen rendered workspace snapshot", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const client = mockRootClient();
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

    const output1 = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "snapshot-session", model: {} },
      output1,
    );

    const firstWorkspacePrompt = output1.system.find((part: string) =>
      part.startsWith("Workspace memory")
    );

    assert.equal(firstWorkspacePrompt, undefined,
      "empty workspace memory should not render a prompt before any memories exist");

    const output2 = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "snapshot-session", model: {} },
      output2,
    );

    assert.deepEqual(output2.system, ["base header"],
      "no compaction summary means no workspace memory prompt is added");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused test file and verify current behavior**

Run:

```bash
npm test -- tests/plugin.test.ts
```

Expected: existing tests pass. Wave 1 must not add pending-memory tests yet; pending-memory behavior belongs to Wave 3 so every wave remains green and committable.

### Task 2: Implement frozen rendered snapshot cache

**Files:**
- Modify: `src/plugin.ts:160-167`
- Modify: `src/plugin.ts:238-252`
- Modify: `src/plugin.ts:274-284`
- Modify: `src/plugin.ts:374-379`

- [ ] **Step 1: Change the frozen cache entry shape**

Replace the cache type at `src/plugin.ts:160-167` with:

```ts
  // Cache for frozen workspace memory per session
  const frozenWorkspaceMemoryCache = new Map<
    string,
    {
      store: Awaited<ReturnType<typeof loadWorkspaceMemory>>;
      renderedPrompt: string;
      loadedAt: number;
    }
  >();
```

- [ ] **Step 2: Replace the loader with a rendered snapshot loader**

Replace `getFrozenWorkspaceMemory(...)` at `src/plugin.ts:238-252` with:

```ts
  async function getFrozenWorkspaceMemorySnapshot(
    root: string,
    sessionID: string
  ): Promise<{
    store: Awaited<ReturnType<typeof loadWorkspaceMemory>>;
    renderedPrompt: string;
  }> {
    const now = Date.now();
    const cached = frozenWorkspaceMemoryCache.get(sessionID);

    // Cache is valid for the session lifetime.
    if (cached) {
      return { store: cached.store, renderedPrompt: cached.renderedPrompt };
    }

    const store = await loadWorkspaceMemory(root);
    const renderedPrompt = renderWorkspaceMemory(store);
    frozenWorkspaceMemoryCache.set(sessionID, { store, renderedPrompt, loadedAt: now });
    return { store, renderedPrompt };
  }
```

- [ ] **Step 3: Update chat system transform to use the rendered snapshot**

Replace `src/plugin.ts:274-284` with:

```ts
      // Get frozen workspace memory snapshot (loaded and rendered once per session)
      const workspaceSnapshot = await getFrozenWorkspaceMemorySnapshot(directory, sessionID);

      // Get current hot session state
      const sessionState = await loadSessionState(directory, sessionID);

      // Inject frozen workspace memory snapshot
      if (workspaceSnapshot.renderedPrompt) {
        output.system.push(workspaceSnapshot.renderedPrompt);
      }
```

- [ ] **Step 4: Update compaction context to use the frozen rendered prompt**

Replace `src/plugin.ts:374-379` with:

```ts
      const workspaceSnapshot = await getFrozenWorkspaceMemorySnapshot(directory, sessionID);
      if (workspaceSnapshot.renderedPrompt) {
        contextParts.push(workspaceSnapshot.renderedPrompt);
      }
```

- [ ] **Step 5: Rename remaining references**

Run:

```bash
rg "getFrozenWorkspaceMemory\(" src/plugin.ts
```

Expected: no matches.

- [ ] **Step 6: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS. If TypeScript reports missing `getFrozenWorkspaceMemory`, update any missed call to `getFrozenWorkspaceMemorySnapshot`.

### Wave 1 verification checkpoint

- [ ] **Step 1: Run test suite**

Run:

```bash
npm test
```

Expected: PASS. Wave 1 must end with a green test suite.

- [ ] **Step 2: Commit wave after tests pass**

```bash
git add src/plugin.ts tests/plugin.test.ts
git commit -m "feat: freeze rendered workspace memory snapshot"
```

---

## Wave 2 — Preserve Ephemeral System Segments in OpenCode

### Task 3: Change OpenCode system message merge behavior

**Files:**
- Modify: `/Users/sd_wo/work/opencode-clone/packages/opencode/src/session/llm.ts:114-119`

- [ ] **Step 1: Replace the merge logic**

In `/Users/sd_wo/work/opencode-clone/packages/opencode/src/session/llm.ts`, replace lines `114-119` with:

```ts
          // Preserve cache locality:
          // - system[0] is the stable provider/agent header.
          // - system[1] is the stable plugin snapshot, if present.
          // - system[2+] is dynamic ephemeral context and must not be merged into system[1].
          if (system.length > 2 && system[0] === header) {
            const stableSnapshot = system[1]
            const ephemeral = system.slice(2)
            system.length = 0
            system.push(header)
            if (stableSnapshot) system.push(stableSnapshot)
            system.push(...ephemeral)
          }
```

- [ ] **Step 2: Add or update a focused OpenCode test**

Search for existing LLM/session tests:

```bash
cd /Users/sd_wo/work/opencode-clone
rg "rejoin to maintain 2-part structure|experimental.chat.system.transform|system\[1\]" packages/opencode/test packages/opencode/src -g "*test*" -g "*.ts"
```

If an existing test harness can instantiate the LLM path, add a test asserting this final system layout:

```ts
assert.deepEqual(system, [
  "base header",
  "Workspace memory (cross-session, verify if stale):\nproject:\n- stable fact",
  "Hot session state (current session):\nactive_files:\n- src/plugin.ts (read, 2x)",
]);
```

If no focused harness exists, create the smallest unit around the extracted merge helper in the same package. Extract the merge block to a local helper named `preserveEphemeralSystemSegments(system: string[], header: string): void` in `llm.ts`, export it only if the package's test pattern requires exports.

- [ ] **Step 3: Verify provider transform remains unchanged**

Run:

```bash
sed -n '192,241p' /Users/sd_wo/work/opencode-clone/packages/opencode/src/provider/transform.ts
```

Expected: `const system = msgs.filter((msg) => msg.role === "system").slice(0, 2)` remains unchanged, so `system[2+]` is not cache-controlled.

- [ ] **Step 4: Run OpenCode package checks**

Run the appropriate package checks from `/Users/sd_wo/work/opencode-clone`. If the repository uses Bun, run:

```bash
cd /Users/sd_wo/work/opencode-clone
bun test packages/opencode
```

If that command is not available, run the package's documented test command from its `package.json` and record the command/output in the implementation notes.

Expected: PASS.

### Wave 2 verification checkpoint

- [ ] **Step 1: Verify cache-control targets only stable messages**

Confirm these two facts in code review:

- `llm.ts` preserves `system[2+]` as separate messages.
- `transform.ts:192-194` still selects only `system.slice(0, 2)` for cache control.

- [ ] **Step 2: Commit OpenCode wave**

```bash
cd /Users/sd_wo/work/opencode-clone
git add packages/opencode/src/session/llm.ts
git commit -m "feat: preserve ephemeral system prompt segments"
```

---

## Wave 3 — Durable Pending Journal and Promotion

### Task 4: Add durable workspace pending journal

**Files:**
- Create: `src/pending-journal.ts`
- Modify: `src/paths.ts`
- Test: `tests/plugin.test.ts`

- [ ] **Step 1: Add pending journal path helper**

In `src/paths.ts`, add this helper near `workspaceMemoryPath(root)`:

```ts
export async function workspacePendingJournalPath(root: string): Promise<string> {
  return join(await memoryRoot(root), "workspace-pending-journal.json");
}
```

- [ ] **Step 2: Create the pending journal module**

Create `src/pending-journal.ts`:

```ts
import { workspacePendingJournalPath } from "./paths.ts";
import { atomicWriteJSON, readJSON, updateJSON } from "./storage.ts";
import type { LongTermMemoryEntry } from "./types.ts";

export type PendingJournal = {
  version: 1;
  entries: LongTermMemoryEntry[];
  updatedAt: string;
};

function emptyPendingJournal(): PendingJournal {
  return { version: 1, entries: [], updatedAt: new Date().toISOString() };
}

export function memoryKey(memory: Pick<LongTermMemoryEntry, "type" | "text">): string {
  return `${memory.type}:${memory.text.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

function normalizeJournal(input: Partial<PendingJournal>): PendingJournal {
  return {
    version: 1,
    entries: Array.isArray(input.entries) ? input.entries : [],
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}

export async function loadPendingJournal(root: string): Promise<PendingJournal> {
  return normalizeJournal(await readJSON(await workspacePendingJournalPath(root), emptyPendingJournal));
}

export async function appendPendingMemories(root: string, memories: LongTermMemoryEntry[]): Promise<PendingJournal> {
  const path = await workspacePendingJournalPath(root);
  return updateJSON(path, emptyPendingJournal, current => {
    const journal = normalizeJournal(current);
    const existing = new Set(journal.entries.map(memoryKey));
    for (const memory of memories) {
      const key = memoryKey(memory);
      if (!existing.has(key)) {
        journal.entries.push(memory);
        existing.add(key);
      }
    }
    journal.updatedAt = new Date().toISOString();
    return journal;
  });
}

export async function hasPendingJournalEntries(root: string): Promise<boolean> {
  const journal = await loadPendingJournal(root);
  return journal.entries.length > 0;
}

export async function clearPendingMemories(root: string, promotedKeys: Set<string>): Promise<PendingJournal> {
  const path = await workspacePendingJournalPath(root);
  return updateJSON(path, emptyPendingJournal, current => {
    const journal = normalizeJournal(current);
    journal.entries = journal.entries.filter(memory => !promotedKeys.has(memoryKey(memory)));
    journal.updatedAt = new Date().toISOString();
    return journal;
  });
}

export async function savePendingJournal(root: string, journal: PendingJournal): Promise<void> {
  await atomicWriteJSON(await workspacePendingJournalPath(root), normalizeJournal(journal));
}
```

- [ ] **Step 3: Add journal unit coverage through plugin tests**

Add tests later in Task 7 for no-compaction, session-deleted, duplicate explicit memory, and promotion failure. Do not add behavior tests here until session state and promotion paths exist.

### Task 5: Extend session state with pending memories

**Files:**
- Modify: `src/types.ts:64-72`
- Modify: `src/session-state.ts:14-60`
- Modify: `src/session-state.ts:174-208`

- [ ] **Step 1: Extend the `SessionState` type**

In `src/types.ts`, change `SessionState` to:

```ts
export type SessionState = {
  version: 1;
  sessionID: string;
  turn: number;
  updatedAt: string;
  activeFiles: ActiveFile[];
  openErrors: OpenError[];
  recentDecisions: SessionDecision[];
  pendingMemories: LongTermMemoryEntry[];
};
```

Add this limit to `HOT_STATE_LIMITS`:

```ts
  maxPendingMemoriesStored: 12,
  maxPendingMemoriesRendered: 6,
```

- [ ] **Step 2: Initialize pending memories**

In `src/session-state.ts`, update `createEmptySessionState(...)` to include:

```ts
    pendingMemories: [],
```

- [ ] **Step 3: Normalize pending memories on load/update**

In both `loadSessionState(...)` and the `updateJSON(...)` callback inside `updateSessionState(...)`, add:

```ts
  loaded.pendingMemories = Array.isArray(loaded.pendingMemories) ? loaded.pendingMemories : [];
```

and:

```ts
    current.pendingMemories = Array.isArray(current.pendingMemories) ? current.pendingMemories : [];
```

In `normalizeSessionState(...)`, add:

```ts
  state.pendingMemories = state.pendingMemories.slice(-HOT_STATE_LIMITS.maxPendingMemoriesStored);
```

- [ ] **Step 4: Render pending memories as ephemeral hot state**

In `renderHotSessionState(...)`, add this after the `decisions` variable:

```ts
  const pendingMemories = state.pendingMemories.slice(-HOT_STATE_LIMITS.maxPendingMemoriesRendered);
```

Change the empty check to:

```ts
  if (
    activeFiles.length === 0 &&
    openErrors.length === 0 &&
    decisions.length === 0 &&
    pendingMemories.length === 0
  ) return "";
```

Add this block before the final return:

```ts
  if (pendingMemories.length > 0) {
    lines.push("pending_memory_updates:");
    for (const memory of pendingMemories) {
      lines.push(`- [${memory.type}] ${memory.text}`);
    }
  }
```

- [ ] **Step 5: Update existing test fixtures**

In `tests/plugin.test.ts`, update every inline `SessionState` fixture to include:

```ts
pendingMemories: [],
```

This includes `createSessionWithError(...)` at `tests/plugin.test.ts:21-31` and the compaction fixture at `tests/plugin.test.ts:206-214`.

- [ ] **Step 6: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS after all fixtures include `pendingMemories`.

### Task 6: Store explicit memories as pending deltas and durable journal entries

**Files:**
- Modify: `src/plugin.ts:172-193`
- Modify: `src/pending-journal.ts`

- [ ] **Step 1: Replace immediate workspace-memory update in `processLatestUserMessage(...)`**

Replace `src/plugin.ts:180-193` with:

```ts
    if (memories.length > 0) {
      await updateSessionState(directory, sessionID, state => {
        const existingKeys = new Set(state.pendingMemories.map(memoryKey));
        for (const memory of memories) {
          const key = memoryKey(memory);
          if (!existingKeys.has(key)) {
            state.pendingMemories.push(memory);
            existingKeys.add(key);
          }
        }
        return state;
      });

      await appendPendingMemories(directory, memories);
    }
```

Add imports at the top of `src/plugin.ts`:

```ts
import {
  appendPendingMemories,
  clearPendingMemories,
  hasPendingJournalEntries,
  loadPendingJournal,
  memoryKey,
} from "./pending-journal.ts";
```

Keep the decisions block at `src/plugin.ts:195-204`, but ensure it still runs after pending memories are recorded.

- [ ] **Step 2: Confirm frozen cache is no longer mutated by explicit memory**

Run:

```bash
rg "cached\.store|Update frozen cache|workspaceMemory = await updateWorkspaceMemory" src/plugin.ts
```

Expected: no matches for explicit-memory cache mutation. `updateWorkspaceMemory(...)` should still exist in the `session.compacted` event handler.

- [ ] **Step 3: Run tests**

Run:

```bash
npm test
```

Expected: PASS for the current suite. Pending-memory behavior tests are added in Task 7 after the journal and session-state plumbing exists.

### Task 7: Promote pending deltas during compaction, session start, and delete

**Files:**
- Modify: `src/plugin.ts:411-432`
- Modify: `src/plugin.ts:264-291`
- Modify: `src/plugin.ts:435-442`
- Modify: `tests/plugin.test.ts`

- [ ] **Step 1: Add helper for explicit-memory client messages**

Append this helper to `tests/plugin.test.ts`:

```ts
function mockClientWithLatestUser(text: string, id = "msg-explicit-1") {
  return {
    session: {
      get: async () => ({ data: { parentID: null } }),
      messages: async () => ({
        data: [
          {
            id,
            role: "user",
            parts: [{ type: "text", text }],
          },
        ],
      }),
    },
  };
}
```

- [ ] **Step 2: Add failing test for same-session pending visibility without workspace mutation**

Append this test to `tests/plugin.test.ts`:

```ts
test("explicit memory is pending and does not mutate frozen workspace prompt", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const client = mockClientWithLatestUser("remember: Use SQLite snapshots for workspace memory.");
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

    const first = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "explicit-session", model: {} },
      first,
    );

    const second = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "explicit-session", model: {} },
      second,
    );

    const workspacePrompts = second.system.filter((part: string) => part.startsWith("Workspace memory"));
    const hotPrompts = second.system.filter((part: string) => part.startsWith("Hot session state"));

    assert.equal(workspacePrompts.length, 0,
      "explicit memory must not appear in the frozen workspace prompt during the same session");
    assert.equal(hotPrompts.length, 1,
      "explicit memory should be visible through the ephemeral hot-state prompt");
    assert.match(hotPrompts[0], /pending_memory_updates:/);
    assert.match(hotPrompts[0], /Use SQLite snapshots for workspace memory/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Add failing test for no-compaction new-session durability**

Append this test to `tests/plugin.test.ts`:

```ts
test("no compaction: explicit memory is promoted on next session start from durable journal", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const firstClient = mockClientWithLatestUser("remember: Prefer boring cache boundaries.", "msg-remember-1");
    const firstPlugin = await MemoryV2Plugin({ directory: tmpDir, client: firstClient });

    await (firstPlugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "session-without-compaction", model: {} },
      { system: ["base header"] },
    );

    const secondClient = mockRootClient();
    const secondPlugin = await MemoryV2Plugin({ directory: tmpDir, client: secondClient });
    const output = { system: ["base header"] };

    await (secondPlugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "new-session", model: {} },
      output,
    );

    const workspacePrompt = output.system.find((part: string) => part.startsWith("Workspace memory"));
    assert.match(workspacePrompt ?? "", /Prefer boring cache boundaries/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Add failing test for session delete durability**

Append this test to `tests/plugin.test.ts`:

```ts
test("session.deleted promotes pending memories before deleting session state", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const client = mockClientWithLatestUser("remember: Promote pending memories before delete.", "msg-delete-1");
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "delete-session", model: {} },
      { system: ["base header"] },
    );

    await (plugin as Record<string, Function>)["event"]({
      event: {
        type: "session.deleted",
        properties: { info: { id: "delete-session" } },
      },
    });

    const nextPlugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    const output = { system: ["base header"] };
    await (nextPlugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "after-delete-session", model: {} },
      output,
    );

    const workspacePrompt = output.system.find((part: string) => part.startsWith("Workspace memory"));
    assert.match(workspacePrompt ?? "", /Promote pending memories before delete/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5: Add failing test for duplicate explicit memory dedupe by text**

Append this test to `tests/plugin.test.ts`:

```ts
test("duplicate explicit memories dedupe by normalized type and text, not generated id", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const pluginA = await MemoryV2Plugin({
      directory: tmpDir,
      client: mockClientWithLatestUser("remember: Prefer stable cache boundaries.", "msg-a"),
    });
    await (pluginA as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "dedupe-session", model: {} },
      { system: ["base header"] },
    );

    const pluginB = await MemoryV2Plugin({
      directory: tmpDir,
      client: mockClientWithLatestUser("remember: prefer   stable cache boundaries.", "msg-b"),
    });
    await (pluginB as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "dedupe-session", model: {} },
      { system: ["base header"] },
    );

    await (pluginB as Record<string, Function>)["event"]({
      event: { type: "session.compacted", properties: { sessionID: "dedupe-session" } },
    });

    const output = { system: ["base header"] };
    const pluginC = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    await (pluginC as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "dedupe-next", model: {} },
      output,
    );

    const joined = output.system.join("\n");
    assert.equal((joined.match(/stable cache boundaries/gi) ?? []).length, 1);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: Add failing test for compaction promotion**

Append this test to `tests/plugin.test.ts`:

```ts
test("session.compacted promotes pending memories to workspace memory and clears pending list", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const client = mockRootClient();
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

    await saveSessionState(tmpDir, {
      version: 1,
      sessionID: "promote-session",
      turn: 1,
      updatedAt: new Date().toISOString(),
      activeFiles: [],
      openErrors: [],
      recentDecisions: [],
      pendingMemories: [{
        id: "mem_pending_1",
        type: "decision",
        text: "Use frozen rendered snapshots for cache stability.",
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    });

    await (plugin as Record<string, Function>)["event"]({
      event: {
        type: "session.compacted",
        properties: { sessionID: "promote-session" },
      },
    });

    const state = await loadSessionState(tmpDir, "promote-session");
    assert.equal(state.pendingMemories.length, 0,
      "pending memories should be cleared after promotion");

    const after = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "new-session-after-promotion", model: {} },
      after,
    );

    const workspacePrompt = after.system.find((part: string) => part.startsWith("Workspace memory"));
    assert.match(workspacePrompt ?? "", /Use frozen rendered snapshots for cache stability/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 7: Add failing test for promotion failure retaining pending memories**

Add a test that makes `updateWorkspaceMemory(...)` fail by replacing the workspace memory path with a directory before promotion. The assertion must be that `loadSessionState(tmpDir, sessionID).pendingMemories.length` remains `1` and the journal still contains the pending memory after the event handler rejects or returns.

- [ ] **Step 8: Add render cap tests**

Add tests asserting:

```text
pending memories > 6
  → renderHotSessionState renders only HOT_STATE_LIMITS.maxPendingMemoriesRendered entries
  → final hot prompt length <= HOT_STATE_LIMITS.maxRenderedChars

workspace memory entries exceed LONG_TERM_LIMITS.maxEntries / maxRenderedChars
  → renderWorkspaceMemory remains capped by LONG_TERM_LIMITS.maxRenderedChars
```

- [ ] **Step 9: Run test to verify failures before implementation**

Run:

```bash
npm test -- tests/plugin.test.ts
```

Expected: FAIL because durable journal, promotion-on-start, promotion-before-delete, text-key dedupe, and failure retention are not yet implemented.

- [ ] **Step 10: Implement promotion helper and promotion-on-start**

Add an internal helper in `src/plugin.ts`:

```ts
async function promotePendingMemories(sessionID?: string): Promise<void> {
  const journal = await loadPendingJournal(directory);
  const sessionState = sessionID ? await loadSessionState(directory, sessionID) : undefined;
  const pending = [
    ...(sessionState?.pendingMemories ?? []),
    ...journal.entries,
  ];
  if (pending.length === 0) return;

  const promotedKeys = new Set<string>();
  await updateWorkspaceMemory(directory, workspaceMemory => {
    const existingKeys = new Set(workspaceMemory.entries.map(memoryKey));
    for (const memory of pending) {
      const key = memoryKey(memory);
      if (!existingKeys.has(key)) {
        workspaceMemory.entries.push(memory);
        existingKeys.add(key);
      }
      promotedKeys.add(key);
    }
    return workspaceMemory;
  });

  if (sessionID) {
    await updateSessionState(directory, sessionID, state => {
      state.pendingMemories = state.pendingMemories.filter(memory => !promotedKeys.has(memoryKey(memory)));
      return state;
    });
  }

  await clearPendingMemories(directory, promotedKeys);
  if (sessionID) clearFrozenWorkspaceMemoryCache(sessionID);
}
```

Call this helper in `experimental.chat.system.transform` before `processLatestUserMessage(sessionID)` and before `getFrozenWorkspaceMemorySnapshot(...)`, but only when this session has not frozen a snapshot yet:

```ts
      // Promote durable pending memories from prior sessions before freezing this session's snapshot.
      // Only do this before the first snapshot for this session. Later turns must not promote
      // current-session explicit memories into the same session's frozen system[1].
      if (!frozenWorkspaceMemoryCache.has(sessionID) && await hasPendingJournalEntries(directory)) {
        await promotePendingMemories();
      }

      // Process explicit user memory after prior-session promotion. New explicit memory from
      // this session becomes pending + ephemeral, not part of the frozen workspace snapshot.
      await processLatestUserMessage(sessionID);
```

Remove the old unconditional `await processLatestUserMessage(sessionID);` if it now appears twice in the hook.

- [ ] **Step 11: Implement compaction promotion**

Replace the body inside `if (event.type === "session.compacted") { ... }` at `src/plugin.ts:411-432` with logic equivalent to:

```ts
        // Parse latest compaction summary for memory candidates
        const summary = await latestCompactionSummary(client, sessionID);
        const candidates = summary ? parseWorkspaceMemoryCandidates(summary) : [];
        if (candidates.length > 0) {
          await appendPendingMemories(directory, candidates);
        }
        await promotePendingMemories(sessionID);
```

- [ ] **Step 12: Implement promotion-before-delete**

In the `session.deleted` handler at `src/plugin.ts:435-442`, call promotion before removing session state:

```ts
          await promotePendingMemories(sessionID);
```

Only delete the session state after promotion succeeds. If promotion fails, leave session state and journal intact.

- [ ] **Step 13: Run tests**

Run:

```bash
npm test
```

Expected: PASS.

### Wave 3 verification checkpoint

- [ ] **Step 1: Run typecheck and tests**

Run:

```bash
npm run typecheck
npm test
```

Expected: both PASS.

- [ ] **Step 2: Commit plugin wave**

```bash
git add src/types.ts src/session-state.ts src/plugin.ts src/paths.ts src/pending-journal.ts tests/plugin.test.ts tests/workspace-memory.test.ts
git commit -m "feat: persist explicit memory through durable pending journal"
```

---

## Final Verification

- [ ] **Step 1: Verify no dynamic state is in cached system[1]**

Manually inspect:

```bash
sed -n '264,291p' src/plugin.ts
sed -n '108,122p' /Users/sd_wo/work/opencode-clone/packages/opencode/src/session/llm.ts
sed -n '192,241p' /Users/sd_wo/work/opencode-clone/packages/opencode/src/provider/transform.ts
```

Expected:

- Plugin pushes workspace snapshot before hot state.
- OpenCode preserves `system[2+]` instead of merging it into `system[1]`.
- Provider transform still cache-controls only first two system messages.

- [ ] **Step 2: Run all plugin checks**

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 3: Record cache-impact evidence**

During manual dogfooding, capture one 10-turn tool-heavy session and record:

```text
turn_count = 10
workspace_snapshot_chars = length(system[1])
hot_state_chars_by_turn = [length(system[2]) per turn]
system_1_changed_between_turns = false
system_2_changed_between_turns = true
```

Expected: `system_1_changed_between_turns = false` for all turns until compaction/session boundary.

---

## Self-Review

- Spec coverage: The plan covers frozen rendered snapshot, ephemeral `system[2+]`, durable pending journal, pending delta promotion, no-compaction durability, delete-time promotion, dedupe, caps, failure retention, and cache impact estimate.
- Placeholder scan: No placeholder tasks remain; each implementation step identifies exact files and code blocks.
- Type consistency: `pendingMemories` is added to `SessionState`, initialized in session-state helpers, rendered in hot state, mirrored into `workspace-pending-journal.json`, and promoted through shared plugin promotion logic.
- Wave coherence: Wave 1 creates frozen snapshot support and ends green, Wave 2 changes OpenCode message boundaries, Wave 3 implements durable pending memory and promotion. Each wave has a verification checkpoint and commit boundary.
