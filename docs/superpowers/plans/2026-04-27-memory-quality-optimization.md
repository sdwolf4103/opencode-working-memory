# Memory Quality Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workspace memory promotion and extraction safer by distinguishing promoted/absorbed/rejected pending memories, adding offline memory-quality evals, and tightening the compaction extraction prompt with concrete negative examples.

**Architecture:** Keep the current three-layer memory architecture unchanged: frozen workspace snapshot, hot session state, and OpenCode todos. Add deterministic promotion accounting around the existing `updateWorkspaceMemory(...)` flow, add parser-level quality eval fixtures with no extra LLM calls, and make the compaction prompt more explicit about what must not become durable memory.

**Tech Stack:** TypeScript ESM, OpenCode plugin hooks, Node `node:test`, existing JSON storage helpers, existing workspace memory normalization/dedup logic.

---

## Goal

- Prevent pending memories from staying in `SessionState.pendingMemories` or `workspace-pending-journal.json` forever when they were successfully absorbed by existing workspace memory through deduplication or supersession.
- Preserve the recent retained-keys safety fix: memories rejected by caps, pruning, or failed I/O must remain pending for retry instead of being silently lost.
- Add a repeatable memory-quality eval suite so future prompt/parser changes can be checked against durable-fact and noise examples.
- Tighten the compaction prompt so the model has concrete examples of what to extract and what to skip.

## Non-Goals

- Do not add semantic similarity, embeddings, or extra LLM calls.
- Do not add cross-workspace shared memory.
- Do not add manual `forget/list` commands in this P0 plan.
- Do not redesign storage layout or change workspace memory file paths.
- Do not change OpenCode core behavior.

## Current System Map

```text
normal chat turn
    │
    ├── experimental.chat.system.transform
    │       ├── promote old pending journal before first frozen snapshot
    │       ├── process latest explicit user memory
    │       ├── push frozen workspace memory into system[1]
    │       └── push hot session state into system[2+]
    │
    ├── tool.execute.after
    │       ├── update active files / open errors
    │       └── process latest explicit user memory once per message id
    │
    └── session.compacted event
            ├── parse compaction summary memory candidates
            ├── append candidates to pending journal
            ├── promote session pending + journal pending into workspace memory
            └── clear only pending memories that are safe to clear
```

Current weak point:

```text
pending memory
    │
    ├── exact retained in workspace memory        -> clear today
    ├── absorbed by existing duplicate/topic      -> NOT cleared today, can retry forever
    ├── rejected by caps/pruning                  -> should stay pending
    └── I/O failure                               -> should stay pending
```

Target behavior:

```text
pending memory
    │
    ├── promoted   exact key appears after normalization        -> clear
    ├── absorbed   same identity/topic already represented      -> clear
    ├── rejected   no equivalent active entry survived          -> keep pending
    └── failed     updateWorkspaceMemory threw                  -> keep pending
```

## File Structure

### Modify

- `src/workspace-memory.ts`
  - Export a deterministic `workspaceMemoryIdentityKey(entry)` helper derived from the existing dedup/supersession identity rules.
  - Reuse that helper inside `enforceLongTermLimits(...)` so promotion accounting and normalization agree on identity semantics.
- `src/plugin.ts`
  - Capture workspace entries before promotion.
  - Use promotion accounting to compute clearable pending keys.
  - Keep rejected pending memories in session state and journal.
  - Add concrete negative/positive examples to `buildCompactionPrompt(...)`.
- `tests/plugin.test.ts`
  - Add regression tests for absorbed duplicate pending memories and rejected overflow pending memories.
  - Add prompt test assertions for negative examples.

### Create

- `src/promotion-accounting.ts`
  - Small pure helper for classifying pending memories as `promoted`, `absorbed`, or `rejected` after workspace normalization.
- `tests/promotion-accounting.test.ts`
  - Unit tests for exact promotion, exact duplicate absorption, same-topic absorption, and rejected overflow.
- `tests/memory-quality-eval.test.ts`
  - Offline eval fixtures for durable facts vs noise using `parseWorkspaceMemoryCandidates(...)`.

### Existing verification commands

```bash
npm test
npm run typecheck
```

Expected final result: both commands pass.

---

## Wave 1 — Promotion Accounting

### Task 1: Add shared workspace-memory identity keys

**Objective:** Make dedup/supersession identity explicit and reusable. Promotion accounting must use the same identity semantics as `enforceLongTermLimits(...)`; otherwise the plugin will clear the wrong pending memories.

**Files:**
- Modify: `src/workspace-memory.ts:338-383`
- Test: `tests/promotion-accounting.test.ts` in Task 2

- [ ] **Step 1: Export `workspaceMemoryIdentityKey(...)` from `src/workspace-memory.ts`**

Add this function after `feedbackTopicKey(...)` and before `isPrunableByAge(...)`:

```ts
export function workspaceMemoryIdentityKey(entry: Pick<LongTermMemoryEntry, "type" | "text">): string {
  if (entry.type === "project" || entry.type === "reference") {
    return `${entry.type}:${extractEntityKey(entry.text) ?? canonicalMemoryText(entry.text)}`;
  }

  if (entry.type === "feedback") {
    return `${entry.type}:${feedbackTopicKey(entry.text) ?? canonicalMemoryText(entry.text)}`;
  }

  return `decision:${decisionTopicKey(entry.text) ?? canonicalMemoryText(entry.text)}`;
}
```

- [ ] **Step 2: Replace duplicated key construction in `enforceLongTermLimits(...)`**

In the project/reference/feedback loop, replace:

```ts
const entityKey = entry.type === "project" || entry.type === "reference"
  ? extractEntityKey(entry.text)
  : feedbackTopicKey(entry.text);
const key = entityKey ? `${entry.type}:${entityKey}` : `${entry.type}:${canonicalMemoryText(entry.text)}`;
```

with:

```ts
const key = workspaceMemoryIdentityKey(entry);
const hasTopicIdentity = key !== `${entry.type}:${canonicalMemoryText(entry.text)}`;
```

Then replace:

```ts
const mode = entry.type === "feedback" && entityKey ? "supersession" as const : "entity" as const;
```

with:

```ts
const mode = entry.type === "feedback" && hasTopicIdentity ? "supersession" as const : "entity" as const;
```

In the decision loop, replace:

```ts
const topic = decisionTopicKey(entry.text);
const key = topic ? `decision:${topic}` : `decision:${canonicalMemoryText(entry.text)}`;
```

with:

```ts
const key = workspaceMemoryIdentityKey(entry);
```

- [ ] **Step 3: Run the existing workspace-memory tests**

Run:

```bash
node --test --experimental-strip-types tests/workspace-memory.test.ts
```

Expected: PASS. Existing dedup behavior must not change.

**Risks and boundaries:**

- Do not export `chooseBetterMemory(...)` unless a later task truly needs it. Identity is enough for P0 accounting.
- `workspaceMemoryIdentityKey(...)` must stay deterministic and must not depend on timestamps.
- This function intentionally mirrors current heuristic topic keys. It is not semantic similarity.

### Task 2: Add pure promotion accounting helper

**Objective:** Separate accounting from plugin I/O. The plugin should ask a pure function which pending keys are safe to clear after workspace normalization.

**Files:**
- Create: `src/promotion-accounting.ts`
- Create: `tests/promotion-accounting.test.ts`

- [ ] **Step 1: Write failing tests for promotion accounting**

Create `tests/promotion-accounting.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import type { LongTermMemoryEntry } from "../src/types.ts";
import { accountPendingPromotions } from "../src/promotion-accounting.ts";
import { memoryKey } from "../src/pending-journal.ts";

function mem(
  id: string,
  text: string,
  opts: Partial<LongTermMemoryEntry> = {},
): LongTermMemoryEntry {
  const now = opts.createdAt ?? new Date().toISOString();
  return {
    id,
    type: opts.type ?? "decision",
    text,
    source: opts.source ?? "compaction",
    confidence: opts.confidence ?? 0.75,
    status: opts.status ?? "active",
    createdAt: now,
    updatedAt: opts.updatedAt ?? now,
    staleAfterDays: opts.staleAfterDays,
    rationale: opts.rationale,
    supersedes: opts.supersedes,
    tags: opts.tags,
  };
}

test("accountPendingPromotions marks exact retained pending memory as promoted", () => {
  const pending = [mem("pending", "Use frozen rendered snapshots for cache stability.")];
  const before: LongTermMemoryEntry[] = [];
  const after = [pending[0]];

  const result = accountPendingPromotions({ pending, before, after });

  assert.deepEqual([...result.promotedKeys], [memoryKey(pending[0])]);
  assert.equal(result.absorbedKeys.size, 0);
  assert.equal(result.rejectedKeys.size, 0);
  assert.deepEqual([...result.clearableKeys], [memoryKey(pending[0])]);
});

test("accountPendingPromotions marks exact duplicate already represented before promotion as absorbed", () => {
  const existing = mem("existing", "Prefer stable cache boundaries.", { source: "explicit" });
  const pending = [mem("pending", "prefer stable cache boundaries.", { source: "explicit" })];
  const before = [existing];
  const after = [existing];

  const result = accountPendingPromotions({ pending, before, after });

  assert.equal(result.promotedKeys.size, 0);
  assert.deepEqual([...result.absorbedKeys], [memoryKey(pending[0])]);
  assert.equal(result.rejectedKeys.size, 0);
  assert.deepEqual([...result.clearableKeys], [memoryKey(pending[0])]);
});

test("accountPendingPromotions marks same exact key present before promotion as absorbed, not promoted", () => {
  const existing = mem("existing", "Use stable cache boundaries.", { source: "explicit" });
  const pending = [mem("pending", "Use stable cache boundaries.", { source: "explicit" })];
  const before = [existing];
  const after = [existing];

  const result = accountPendingPromotions({ pending, before, after });

  assert.equal(result.promotedKeys.size, 0,
    "a pending memory whose exact key already existed before promotion is absorbed, not newly promoted");
  assert.deepEqual([...result.absorbedKeys], [memoryKey(pending[0])]);
  assert.equal(result.rejectedKeys.size, 0);
});

test("accountPendingPromotions marks same-topic decision represented after normalization as absorbed", () => {
  const existing = mem("existing", "Parser supports 2 candidate formats.", {
    type: "decision",
    source: "compaction",
    confidence: 0.9,
    createdAt: "2026-04-27T10:00:00.000Z",
    updatedAt: "2026-04-27T10:00:00.000Z",
  });
  const pending = [mem("pending", "Parser supports 3 candidate formats.", {
    type: "decision",
    source: "compaction",
    confidence: 0.75,
    createdAt: "2026-04-27T09:00:00.000Z",
    updatedAt: "2026-04-27T09:00:00.000Z",
  })];
  const before = [existing];
  const after = [existing];

  const result = accountPendingPromotions({ pending, before, after });

  assert.equal(result.promotedKeys.size, 0);
  assert.deepEqual([...result.absorbedKeys], [memoryKey(pending[0])]);
  assert.equal(result.rejectedKeys.size, 0);
});

test("accountPendingPromotions keeps pending memory rejected when no equivalent survived", () => {
  const pending = [mem("pending", "Low priority memory that did not fit the workspace cap.", {
    type: "reference",
    source: "compaction",
  })];
  const before: LongTermMemoryEntry[] = [];
  const after: LongTermMemoryEntry[] = [];

  const result = accountPendingPromotions({ pending, before, after });

  assert.equal(result.promotedKeys.size, 0);
  assert.equal(result.absorbedKeys.size, 0);
  assert.deepEqual([...result.rejectedKeys], [memoryKey(pending[0])]);
  assert.equal(result.clearableKeys.size, 0);
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
node --test --experimental-strip-types tests/promotion-accounting.test.ts
```

Expected: FAIL with module not found for `../src/promotion-accounting.ts`.

- [ ] **Step 3: Implement `src/promotion-accounting.ts`**

Create `src/promotion-accounting.ts`:

```ts
import type { LongTermMemoryEntry } from "./types.ts";
import { memoryKey } from "./pending-journal.ts";
import { workspaceMemoryIdentityKey } from "./workspace-memory.ts";

export type PendingPromotionAccounting = {
  promotedKeys: Set<string>;
  absorbedKeys: Set<string>;
  rejectedKeys: Set<string>;
  clearableKeys: Set<string>;
};

export function accountPendingPromotions(input: {
  pending: LongTermMemoryEntry[];
  before: LongTermMemoryEntry[];
  after: LongTermMemoryEntry[];
}): PendingPromotionAccounting {
  const beforeExactKeys = new Set(input.before.map(entry => memoryKey(entry)));
  const afterExactKeys = new Set(input.after.map(entry => memoryKey(entry)));
  const afterIdentityKeys = new Set(input.after.map(entry => workspaceMemoryIdentityKey(entry)));

  const promotedKeys = new Set<string>();
  const absorbedKeys = new Set<string>();
  const rejectedKeys = new Set<string>();

  for (const memory of input.pending) {
    const key = memoryKey(memory);
    const identityKey = workspaceMemoryIdentityKey(memory);

    if (beforeExactKeys.has(key)) {
      absorbedKeys.add(key);
      continue;
    }

    if (afterExactKeys.has(key)) {
      promotedKeys.add(key);
      continue;
    }

    if (afterIdentityKeys.has(identityKey)) {
      absorbedKeys.add(key);
      continue;
    }

    rejectedKeys.add(key);
  }

  return {
    promotedKeys,
    absorbedKeys,
    rejectedKeys,
    clearableKeys: new Set([...promotedKeys, ...absorbedKeys]),
  };
}
```

- [ ] **Step 4: Run the new accounting tests**

Run:

```bash
node --test --experimental-strip-types tests/promotion-accounting.test.ts
```

Expected: PASS.

**Risks and boundaries:**

- The helper deliberately works with keys, not entry ids. Pending journal dedup already uses `memoryKey(...)`, so clearing by key preserves current storage semantics.
- If the exact pending key already existed before promotion, classify it as absorbed, not promoted. It is safe to clear, but the classification must not imply a new write occurred.
- If `after` contains the same identity but no exact key, that means normalization kept a representative memory. For P0, this is treated as absorbed and safe to clear.
- Do not classify failed writes here. Failures are represented by `updateWorkspaceMemory(...)` throwing before this helper is called.

### Task 3: Wire promotion accounting into `promotePendingMemories(...)`

**Objective:** Clear pending memories when they were either exactly promoted or absorbed by an equivalent workspace memory. Keep rejected memories pending.

**Files:**
- Modify: `src/plugin.ts:34-45`, `src/plugin.ts:222-261`
- Modify: `tests/plugin.test.ts`

- [ ] **Step 1: Add failing plugin regression tests**

Append these tests to `tests/plugin.test.ts`:

These snippets use imports that already exist in the current `tests/plugin.test.ts`: `mkdir`, `mkdtemp`, `rm`, `dirname`, `join`, `workspaceMemoryPath`, `workspacePendingJournalPath`, `loadPendingJournal`, `savePendingJournal`, `updateWorkspaceMemory`, `loadSessionState`, `saveSessionState`, and `MemoryV2Plugin`. If `promotion failure does not clear pending memories in session or journal` already exists, keep the existing test and verify it still passes instead of adding a duplicate with the same body.

```ts
test("session.compacted clears pending memory absorbed by existing workspace duplicate", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const now = new Date().toISOString();
    await updateWorkspaceMemory(tmpDir, store => {
      store.entries.push({
        id: "mem_existing_duplicate",
        type: "decision",
        text: "Prefer stable cache boundaries.",
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return store;
    });

    await saveSessionState(tmpDir, {
      version: 1,
      sessionID: "absorbed-duplicate-session",
      turn: 0,
      updatedAt: now,
      activeFiles: [],
      openErrors: [],
      recentDecisions: [],
      pendingMemories: [{
        id: "mem_pending_duplicate",
        type: "decision",
        text: "prefer stable cache boundaries.",
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }],
    });

    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    await (plugin as Record<string, Function>)["event"]({
      event: { type: "session.compacted", properties: { sessionID: "absorbed-duplicate-session" } },
    });

    const state = await loadSessionState(tmpDir, "absorbed-duplicate-session");
    assert.equal(state.pendingMemories.length, 0,
      "duplicate pending memory should be cleared after it is absorbed by existing workspace memory");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("session.compacted keeps pending memory rejected by workspace entry cap", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const now = new Date().toISOString();
    await updateWorkspaceMemory(tmpDir, store => {
      for (let i = 0; i < 28; i += 1) {
        store.entries.push({
          id: `mem_high_${i}`,
          type: "feedback",
          text: `High priority user feedback memory ${i} that should outrank low priority references.`,
          source: "explicit",
          confidence: 1,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
      return store;
    });

    await saveSessionState(tmpDir, {
      version: 1,
      sessionID: "rejected-cap-session",
      turn: 0,
      updatedAt: now,
      activeFiles: [],
      openErrors: [],
      recentDecisions: [],
      pendingMemories: [{
        id: "mem_low_priority_reference",
        type: "reference",
        text: "Low priority reference memory that should not fit when the workspace cap is full.",
        source: "compaction",
        confidence: 0.1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }],
    });

    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    await (plugin as Record<string, Function>)["event"]({
      event: { type: "session.compacted", properties: { sessionID: "rejected-cap-session" } },
    });

    const state = await loadSessionState(tmpDir, "rejected-cap-session");
    assert.equal(state.pendingMemories.length, 1,
      "pending memory rejected by workspace cap should remain pending for retry");
    assert.match(state.pendingMemories[0].text, /Low priority reference/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("session.compacted keeps pending memories when all rejected by workspace cap", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const now = new Date().toISOString();
    await updateWorkspaceMemory(tmpDir, store => {
      for (let i = 0; i < 28; i += 1) {
        store.entries.push({
          id: `mem_high_all_rejected_${i}`,
          type: "feedback",
          text: `Pinned high priority feedback ${i} that keeps the workspace entry cap full.`,
          source: "explicit",
          confidence: 1,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
      return store;
    });

    await saveSessionState(tmpDir, {
      version: 1,
      sessionID: "all-rejected-session",
      turn: 0,
      updatedAt: now,
      activeFiles: [],
      openErrors: [],
      recentDecisions: [],
      pendingMemories: [{
        id: "mem_session_rejected",
        type: "reference",
        text: "Session pending reference should remain when every pending memory is rejected by cap.",
        source: "compaction",
        confidence: 0.1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }],
    });

    const journal = await loadPendingJournal(tmpDir);
    journal.entries = [{
      id: "mem_journal_rejected_other_session",
      type: "reference",
      text: "Journal pending reference from another session should not be cleared by an empty clearable set.",
      source: "compaction",
      confidence: 0.1,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }];
    await savePendingJournal(tmpDir, journal);

    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    await (plugin as Record<string, Function>)["event"]({
      event: { type: "session.compacted", properties: { sessionID: "all-rejected-session" } },
    });

    const state = await loadSessionState(tmpDir, "all-rejected-session");
    assert.equal(state.pendingMemories.length, 1,
      "session pending memory must remain when all pending memories are rejected");

    const pendingAfter = await loadPendingJournal(tmpDir);
    assert.equal(pendingAfter.entries.length, 1,
      "journal pending memories must not be cleared when accounting.clearableKeys is empty");
    assert.match(pendingAfter.entries[0].text, /another session/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("promotion failure does not clear pending memories in session or journal", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const now = new Date().toISOString();
    await saveSessionState(tmpDir, {
      version: 1,
      sessionID: "failure-session",
      turn: 0,
      updatedAt: now,
      activeFiles: [],
      openErrors: [],
      recentDecisions: [],
      pendingMemories: [{
        id: "mem_pending_failure",
        type: "decision",
        text: "Keep pending when promotion fails",
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }],
    });

    const journalPath = await workspacePendingJournalPath(tmpDir);
    await mkdir(dirname(journalPath), { recursive: true });
    const journal = await loadPendingJournal(tmpDir);
    journal.entries = [{
      id: "mem_pending_failure_journal",
      type: "decision",
      text: "Keep pending when promotion fails",
      source: "explicit",
      confidence: 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }];
    await savePendingJournal(tmpDir, journal);

    const wmPath = await workspaceMemoryPath(tmpDir);
    await rm(wmPath, { force: true }).catch(() => undefined);
    await mkdir(wmPath, { recursive: true });

    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    let didThrow = false;
    try {
      await (plugin as Record<string, Function>)["event"]({
        event: { type: "session.compacted", properties: { sessionID: "failure-session" } },
      });
    } catch {
      didThrow = true;
    }

    assert.equal(didThrow, false,
      "promotion failure should not throw from session.compacted handler");
    const state = await loadSessionState(tmpDir, "failure-session");
    assert.equal(state.pendingMemories.length, 1,
      "session pending memories should remain when promotion fails");
    const pendingAfter = await loadPendingJournal(tmpDir);
    assert.equal(pendingAfter.entries.length, 1,
      "journal pending memories should remain when promotion fails");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
node --test --experimental-strip-types tests/plugin.test.ts
```

Expected: FAIL on at least these two regressions before implementation:

- `session.compacted clears pending memory absorbed by existing workspace duplicate`, because absorbed duplicate pending memory is not cleared yet.
- `session.compacted keeps pending memories when all rejected by workspace cap`, because calling `clearPendingMemories(directory, emptySet)` currently clears the whole pending journal.

- [ ] **Step 3: Import accounting helper in `src/plugin.ts`**

Add near the existing imports:

```ts
import { accountPendingPromotions } from "./promotion-accounting.ts";
```

- [ ] **Step 4: Capture `beforeEntries` and compute clearable keys**

Replace the current `promotePendingMemories(...)` body from the `updateWorkspaceMemory(...)` call through clearing logic with this structure:

```ts
    let beforeEntries: Awaited<ReturnType<typeof loadWorkspaceMemory>>["entries"] = [];

    const updatedWorkspaceMemory = await updateWorkspaceMemory(directory, workspaceMemory => {
      beforeEntries = [...workspaceMemory.entries];
      const existingKeys = new Set(workspaceMemory.entries.map(memory => memoryKey(memory)));

      for (const memory of pending) {
        const key = memoryKey(memory);
        if (!existingKeys.has(key)) {
          workspaceMemory.entries.push(memory);
          existingKeys.add(key);
        }
      }

      return workspaceMemory;
    });

    const accounting = accountPendingPromotions({
      pending,
      before: beforeEntries,
      after: updatedWorkspaceMemory.entries,
    });

    if (sessionID) {
      await updateSessionState(directory, sessionID, state => {
        state.pendingMemories = state.pendingMemories.filter(memory => !accounting.clearableKeys.has(memoryKey(memory)));
        return state;
      });
      clearFrozenWorkspaceMemoryCache(sessionID);
    }

    if (accounting.clearableKeys.size > 0) {
      await clearPendingMemories(directory, accounting.clearableKeys);
    }
```

Keep the existing `try/catch` behavior in event handlers unchanged. If `updateWorkspaceMemory(...)` throws, this code is never reached, so nothing is cleared.

- [ ] **Step 5: Run plugin tests**

Run:

```bash
node --test --experimental-strip-types tests/plugin.test.ts
```

Expected: PASS.

**Risks and boundaries:**

- Do not call `clearPendingMemories(...)` with no argument or an empty set in this flow. Its current contract treats `undefined` and `size === 0` as "clear all pending journal entries".
- The `if (accounting.clearableKeys.size > 0)` guard is data-loss protection. Do not remove it unless `clearPendingMemories(...)` gets a new contract.
- `beforeEntries` must be captured inside the `updateWorkspaceMemory(...)` callback after the store has been loaded and normalized.
- Keep cache invalidation only for the session being compacted/deleted. Do not clear all session caches.

### Wave 1 verification checkpoint

- [ ] **Step 1: Run targeted tests**

Run:

```bash
node --test --experimental-strip-types tests/promotion-accounting.test.ts tests/plugin.test.ts tests/workspace-memory.test.ts
```

Expected: PASS.

Confirm these regression tests are present and passing:

- `session.compacted clears pending memory absorbed by existing workspace duplicate`
- `session.compacted keeps pending memory rejected by workspace entry cap`
- `session.compacted keeps pending memories when all rejected by workspace cap`
- `promotion failure does not clear pending memories in session or journal`

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit Wave 1**

```bash
git add src/workspace-memory.ts src/promotion-accounting.ts src/plugin.ts tests/promotion-accounting.test.ts tests/plugin.test.ts
git commit -m "fix: account for absorbed pending memories"
```

---

## Wave 2 — Memory Quality Eval

### Task 4: Add offline memory-quality fixture evals

**Objective:** Create a zero-API-call quality gate for memory extraction. This catches regressions where parser/gate changes start accepting noisy compaction facts or rejecting useful durable facts.

**Files:**
- Create: `tests/memory-quality-eval.test.ts`
- Modify only if tests expose a real gap: `src/extractors.ts:229-275`

- [ ] **Step 1: Create fixture eval test file**

Create `tests/memory-quality-eval.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseWorkspaceMemoryCandidates } from "../src/extractors.ts";

const acceptedCases = [
  {
    name: "durable user language preference",
    line: "- [feedback] User prefers architecture reviews in Traditional Chinese",
    expectedType: "feedback",
    expectedText: /Traditional Chinese/,
  },
  {
    name: "stable cache architecture decision",
    line: "- [decision] Use frozen workspace memory snapshots plus ephemeral hot state for cache stability",
    expectedType: "decision",
    expectedText: /frozen workspace memory/,
  },
  {
    name: "stable zero API call constraint",
    line: "- [project] The plugin piggybacks memory extraction on OpenCode compaction and should not add extra LLM calls",
    expectedType: "project",
    expectedText: /extra LLM calls/,
  },
  {
    name: "hard to rediscover reference",
    line: "- [reference] Workspace memory uses a frozen system[1] snapshot and pending memories remain in hot session state until compaction",
    expectedType: "reference",
    expectedText: /system\[1\]/,
  },
  {
    name: "short stable config reference",
    line: "- [reference] Config parser supports bracketless format",
    expectedType: "reference",
    expectedText: /bracketless/,
  },
] as const;

const rejectedCases = [
  {
    name: "test count snapshot",
    line: "- [project] 42 tests passed after the latest implementation",
  },
  {
    name: "suite count snapshot",
    line: "- [project] 3 suites pass and 0 suites fail right now",
  },
  {
    name: "phase progress snapshot",
    line: "- [project] Wave 2 completed successfully",
  },
  {
    name: "commit hash",
    line: "- [reference] Commit 4309cb8 contains the promotion accounting fix",
  },
  {
    name: "raw transient error",
    line: "- [feedback] TypeError: Cannot read properties of undefined",
  },
  {
    name: "path heavy rediscoverable fact",
    line: "- [project] Important files are /src/plugin.ts /src/workspace-memory.ts /src/session-state.ts",
  },
  {
    name: "temporary pending task",
    line: "- [decision] currently: run npm test before the next reply",
  },
] as const;

for (const item of acceptedCases) {
  test(`memory quality accepts ${item.name}`, () => {
    const summary = `
Memory candidates:
${item.line}
`;
    const entries = parseWorkspaceMemoryCandidates(summary);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, item.expectedType);
    assert.match(entries[0].text, item.expectedText);
  });
}

for (const item of rejectedCases) {
  test(`memory quality rejects ${item.name}`, () => {
    const summary = `
Memory candidates:
${item.line}
`;
    const entries = parseWorkspaceMemoryCandidates(summary);

    assert.equal(entries.length, 0);
  });
}
```

- [ ] **Step 2: Run the eval test**

Run:

```bash
node --test --experimental-strip-types tests/memory-quality-eval.test.ts
```

Expected: likely FAIL if any new rejected case exposes a missing quality gate.

- [ ] **Step 3: Tighten `shouldAcceptWorkspaceMemoryCandidate(...)` only for failing rejected cases**

If the `temporary pending task` case fails, add this near the existing temporary progress checks in `src/extractors.ts:259-260`:

```ts
  if (/^(currently|now|pending|in progress|todo|wip)\b[:：]?/i.test(text)) return false;
```

If the `commit hash` case fails because uppercase `Commit 4309cb8` is accepted, replace:

```ts
  if (/\b[0-9a-f]{7,40}\b/.test(text)) return false;
```

with:

```ts
  if (/\b[0-9a-f]{7,40}\b/i.test(text)) return false;
```

If all cases pass, do not change `src/extractors.ts`.

- [ ] **Step 4: Re-run eval and extractor tests**

Run:

```bash
node --test --experimental-strip-types tests/memory-quality-eval.test.ts tests/extractors.test.ts
```

Expected: PASS.

**Risks and boundaries:**

- These are parser/gate evals, not live LLM evals. That is intentional for P0 because it preserves zero extra API calls.
- Do not over-tighten length limits. Short stable config references are already special-cased.
- If a rejected fixture seems useful, change the fixture, not the product, but document why in the test name.

### Wave 2 verification checkpoint

- [ ] **Step 1: Run targeted quality tests**

Run:

```bash
node --test --experimental-strip-types tests/memory-quality-eval.test.ts tests/extractors.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit Wave 2**

```bash
git add tests/memory-quality-eval.test.ts src/extractors.ts
git commit -m "test: add memory quality eval fixtures"
```

If `src/extractors.ts` did not change, use:

```bash
git add tests/memory-quality-eval.test.ts
git commit -m "test: add memory quality eval fixtures"
```

---

## Wave 3 — Compaction Prompt Negative Examples

### Task 5: Tighten compaction extraction prompt

**Objective:** Reduce memory pollution at the source. The prompt already says to skip noise, but concrete examples give the model a sharper boundary between durable facts and session snapshots.

**Files:**
- Modify: `src/plugin.ts:107-130`
- Modify: `tests/plugin.test.ts:221-292`

- [ ] **Step 1: Add failing prompt assertions**

In `tests/plugin.test.ts`, inside `test("compaction hook sets output.prompt with ---free template", ...)`, after the existing memory candidate assertions, add:

```ts
    assert.equal(prompt!.includes("Good memory examples:"), true,
      "Prompt should include concrete positive memory examples");
    assert.equal(prompt!.includes("Bad memory examples to skip:"), true,
      "Prompt should include concrete negative memory examples");
    assert.equal(prompt!.includes("42 tests passed"), true,
      "Prompt should explicitly reject test-count snapshots");
    assert.equal(prompt!.includes("commit 4309cb8"), true,
      "Prompt should explicitly reject commit-hash snapshots");
```

- [ ] **Step 2: Run the prompt test and verify it fails**

Run:

```bash
node --test --experimental-strip-types tests/plugin.test.ts
```

Expected: FAIL because the prompt does not yet include these exact example headings/strings.

- [ ] **Step 3: Update `buildCompactionPrompt(...)` in `src/plugin.ts`**

Insert the following lines after the existing line:

```ts
"When unsure, skip it. Fewer high-signal memories are better than many low-value ones.",
```

Add:

```ts
"",
"Good memory examples:",
"- [feedback] User prefers architecture reviews in Traditional Chinese.",
"- [decision] Use frozen workspace memory snapshots plus ephemeral hot state for cache stability.",
"- [project] The plugin should piggyback memory extraction on OpenCode compaction and avoid extra LLM calls.",
"- [reference] Workspace memory appears in frozen system[1]; pending memories appear in hot session state until compaction.",
"",
"Bad memory examples to skip:",
"- 42 tests passed.",
"- Wave 2 completed successfully.",
"- Modified 5 files.",
"- commit 4309cb8 contains the latest fix.",
"- TypeError: Cannot read properties of undefined.",
"- Currently running npm test.",
"",
"A memory should still be useful if a new agent opens this workspace next week.",
```

Keep the existing candidate format section unchanged:

```ts
"Memory candidates:",
"- [feedback] content",
"- [project] content",
"- [decision] content",
"- [reference] content",
```

- [ ] **Step 4: Run the prompt test**

Run:

```bash
node --test --experimental-strip-types tests/plugin.test.ts
```

Expected: PASS.

**Risks and boundaries:**

- Do not change the candidate output format in this wave. Parser compatibility depends on it.
- Keep examples short. The compaction prompt grows every compaction, so avoid turning this into a long policy document.
- Do not include secrets or real private project details in examples.

### Wave 3 verification checkpoint

- [ ] **Step 1: Run prompt and quality tests**

Run:

```bash
node --test --experimental-strip-types tests/plugin.test.ts tests/memory-quality-eval.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit Wave 3**

```bash
git add src/plugin.ts tests/plugin.test.ts
git commit -m "docs: sharpen compaction memory extraction prompt"
```

---

## Final Verification

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected: all `tests/*.test.ts` pass.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: TypeScript exits with code 0.

- [ ] **Step 3: Inspect changed files**

```bash
git diff --stat
git diff -- src/plugin.ts src/workspace-memory.ts src/promotion-accounting.ts src/extractors.ts tests/plugin.test.ts tests/promotion-accounting.test.ts tests/memory-quality-eval.test.ts
```

Expected:

- `src/plugin.ts` only changes promotion accounting and prompt examples.
- `src/workspace-memory.ts` only exports/reuses identity-key logic.
- `src/promotion-accounting.ts` is pure and has no filesystem or OpenCode client dependency.
- `tests/memory-quality-eval.test.ts` has no live API dependency.

- [ ] **Step 4: Manual sanity check for no data-loss regression**

Use the existing tests as the source of truth:

```bash
node --test --experimental-strip-types tests/plugin.test.ts
```

Confirm these existing behaviors still pass:

- `promotion failure does not clear pending memories in session or journal`
- `session.compacted promotes pending memories to workspace memory and clears pending list`
- `compaction intentionally refreshes frozen system[1] with promoted memories`

## Test Coverage Diagram

```text
PROMOTION ACCOUNTING
====================
[+] src/promotion-accounting.ts
    │
    └── accountPendingPromotions()
        ├── [★★★ TESTED] exact pending retained after normalization -> promoted -> clear
        ├── [★★★ TESTED] exact duplicate represented before/after -> absorbed -> clear
        ├── [★★★ TESTED] exact key present before promotion -> absorbed, not promoted -> clear
        ├── [★★★ TESTED] same-topic represented after normalization -> absorbed -> clear
        └── [★★★ TESTED] no equivalent survived -> rejected -> keep pending

[+] src/plugin.ts promotePendingMemories()
    │
    ├── [★★★ TESTED] normal promotion clears pending
    ├── [★★★ TESTED] absorbed duplicate clears pending
    ├── [★★★ TESTED] cap-rejected memory stays pending
    ├── [★★★ TESTED] all rejected with empty clearable set preserves pending journal
    └── [★★★ TESTED] update failure keeps session + journal pending

MEMORY QUALITY
=============
[+] src/extractors.ts parseWorkspaceMemoryCandidates()
    │
    ├── [★★★ TESTED] accepts durable user preference
    ├── [★★★ TESTED] accepts stable architecture decision
    ├── [★★★ TESTED] accepts stable project constraint
    ├── [★★★ TESTED] accepts hard to rediscover reference
    ├── [★★★ TESTED] accepts short stable config reference
    ├── [★★★ TESTED] rejects test/suite counts
    ├── [★★★ TESTED] rejects phase/wave progress
    ├── [★★★ TESTED] rejects commit hashes
    ├── [★★★ TESTED] rejects raw errors
    ├── [★★★ TESTED] rejects path-heavy rediscoverable facts
    └── [★★★ TESTED] rejects temporary pending task

COMPACTION PROMPT
=================
[+] src/plugin.ts buildCompactionPrompt()
    │
    ├── [★★★ TESTED] preserves ---free formatting rules
    ├── [★★★ TESTED] includes candidate output format
    ├── [★★★ TESTED] includes positive examples
    └── [★★★ TESTED] includes negative examples
```

## Risks and Edge Cases

### Risk: clearing absorbed memories too aggressively

If `workspaceMemoryIdentityKey(...)` is too broad, pending memory could be cleared even though the surviving workspace memory is not actually equivalent.

Mitigation:

- P0 uses only existing narrow topic heuristics and canonical text.
- No semantic similarity is introduced.
- Tests cover exact duplicate and known same-topic behavior only.

### Risk: rejected memories retry forever

This is already possible today. This plan intentionally keeps cap-rejected memories pending to avoid data loss.

Mitigation:

- Keep this behavior for P0.
- P1 should add manual forget/list and better rejected-state visibility.

### Risk: prompt gets too long

The prompt examples add roughly 15 short lines.

Mitigation:

- Keep examples compact.
- Do not add rationale/topic schema in P0.
- Do not add a long policy section.

### Risk: offline eval gives false confidence

The eval verifies parser/gate behavior, not live model behavior.

Mitigation:

- Name it an offline eval.
- Use it as a regression guard, not a quality guarantee.
- Future P1/P2 can add live evals if cost is acceptable.

## Future Work, Not in This Plan

- Candidate rationale parsing: use the existing `LongTermMemoryEntry.rationale` field and parse `Why: ...` from candidates.
- Topic-aware dedup: add optional model-supplied `topic="..."` without embeddings.
- Manual `memory list` and `memory forget` operations.
- Superseded storage cap for old inactive entries.
- Live LLM eval suite for extraction prompt quality.

## Completion Criteria

This plan is complete when:

- Pending memories have explicit promoted/absorbed/rejected accounting.
- Absorbed duplicates no longer remain stuck in session state or the pending journal.
- Rejected/cap-dropped pending memories remain pending.
- Memory quality fixtures run without live API calls.
- The compaction prompt includes concrete good/bad memory examples.
- `npm test` passes.
- `npm run typecheck` passes.
