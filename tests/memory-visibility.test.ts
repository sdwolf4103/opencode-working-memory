import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { appendPendingMemories } from "../src/pending-journal.ts";
import { saveSessionState } from "../src/session-state.ts";
import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "../src/types.ts";
import { workspaceMemoryPath } from "../src/paths.ts";
import { saveWorkspaceMemory } from "../src/workspace-memory.ts";
import {
  formatMemoryHelp,
  formatMemoryList,
  formatMemoryStatus,
  getMemoryList,
  getMemoryStatus,
  renderMemoryCommand,
} from "../src/memory-visibility.ts";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "memory-visibility-test-"));
}

function memory(id: string, text: string, overrides: Partial<LongTermMemoryEntry> = {}): LongTermMemoryEntry {
  const now = new Date().toISOString();
  return {
    id,
    type: "decision",
    text,
    source: "compaction",
    confidence: 0.8,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("formats status counts from workspace, session, and pending journal stores", async () => {
  const root = await tempRoot();
  try {
    const now = new Date().toISOString();
    const store: WorkspaceMemoryStore = {
      version: 1,
      workspace: { root, key: "test" },
      limits: { maxRenderedChars: 115, maxEntries: 28 },
      entries: [
        memory("mem-short", "Keep tests focused."),
        memory("mem-long", "Long memory with password: sushi ".repeat(20), { type: "reference" }),
        memory("mem-old", "Superseded memory should not be active.", { status: "superseded" }),
      ],
      migrations: [],
      updatedAt: now,
    };
    await saveWorkspaceMemory(root, store);
    await saveSessionState(root, {
      version: 1,
      sessionID: "ses_status",
      turn: 1,
      updatedAt: now,
      activeFiles: [],
      openErrors: [{
        id: "err-1",
        category: "typecheck",
        summary: "Typecheck failed",
        fingerprint: "typecheck",
        status: "open",
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        seenCount: 1,
      }],
      recentDecisions: [{ id: "dec-1", text: "Prefer local rendering", source: "user", createdAt: Date.now() }],
      pendingMemories: [memory("pending-session", "Pending for this session", { source: "explicit", pendingOwnerSessionID: "ses_status" })],
      compactionMemoryRefs: [],
    });
    await appendPendingMemories(root, [memory("pending-journal", "Pending in durable journal", { source: "explicit", pendingOwnerSessionID: "ses_status" })]);

    const output = formatMemoryStatus(await getMemoryStatus(root, "ses_status"));

    assert.match(output, /^## Memory status/);
    assert.match(output, /Workspace:/);
    assert.match(output, /- Active memories: 2/);
    assert.match(output, /- Rendered in prompt: 1/);
    assert.match(output, /- Omitted active memories: 1/);
    assert.match(output, /- Superseded memories: 1/);
    assert.match(output, /Pending:/);
    assert.match(output, /- Pending in this session: 1/);
    assert.match(output, /- Pending journal memories: 1/);
    assert.match(output, /Session:/);
    assert.match(output, /- Open errors: 1/);
    assert.match(output, /- Recent decisions: 1/);
    assert.match(output, /Use \/memory-list to view current \[M1\]-\[M28\] memory refs\./);
    assert.match(output, /Local only: no LLM request was made\./);
    assert.equal(output.includes("Recent active memory previews"), false);
    assert.equal(output.includes("sushi"), false, "status output should not include memory previews");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("getMemoryStatus redacts previews without rewriting workspace memory", async () => {
  const root = await tempRoot();
  try {
    const now = new Date().toISOString();
    const path = await workspaceMemoryPath(root);
    await mkdir(dirname(path), { recursive: true });
    const store: WorkspaceMemoryStore = {
      version: 1,
      workspace: { root, key: "test" },
      limits: { maxRenderedChars: 3600, maxEntries: 28 },
      entries: [memory("mem-secret", "Remember password: sushi for the fake test fixture.", { createdAt: now, updatedAt: now })],
      migrations: [],
      updatedAt: now,
    };
    const before = JSON.stringify(store, null, 2);
    await writeFile(path, before, "utf8");

    const output = formatMemoryStatus(await getMemoryStatus(root, "ses_readonly"));
    const after = await readFile(path, "utf8");

    assert.match(output, /- Active memories: 1/);
    assert.equal(output.includes("Recent active memory previews"), false);
    assert.equal(output.includes("sushi"), false, "status output should not include memory previews");
    assert.equal(after, before, "status display must not persist normalization, migration, or redaction changes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formats current workspace memories grouped by type with display-local refs", async () => {
  const root = await tempRoot();
  try {
    const now = new Date().toISOString();
    await saveWorkspaceMemory(root, {
      version: 1,
      workspace: { root, key: "test" },
      limits: { maxRenderedChars: 3600, maxEntries: 28 },
      entries: [
        memory("mem-feedback", "Remember password: sushi for the fake test.", { type: "feedback" }),
        memory("mem-project", "Project memory should render in its own group.", { type: "project" }),
        memory("mem-decision", "Decision memory should render in its own group.", { type: "decision" }),
        memory("mem-reference", "Reference memory should render in its own group.", { type: "reference" }),
        memory("mem-superseded", "Superseded memory should not be active", { type: "reference", status: "superseded" }),
      ],
      migrations: [],
      updatedAt: now,
    });

    const output = formatMemoryList(await getMemoryList(root));

    assert.match(output, /^## Current workspace memories/);
    assert.match(output, /Display refs are local to this output/);
    assert.match(output, /feedback:\n- \[M\d+\]/);
    assert.match(output, /project:\n- \[M\d+\]/);
    assert.match(output, /decision:\n- \[M\d+\]/);
    assert.match(output, /reference:\n- \[M\d+\]/);
    assert.match(output, /Shown: \d+ of \d+ active memories\./);
    assert.match(output, /Shown: 4 of 4 active memories\./);
    assert.match(output, /Omitted active memories: 0\./);
    assert.equal(output.includes("[M1]"), true, "at least one display-local ref should render");
    assert.equal(output.includes("sushi"), false, "list previews should redact credential-like text");
    assert.equal(output.includes("Superseded memory should not be active"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formats empty memory list state", () => {
  const output = formatMemoryList({
    activeMemories: 0,
    renderedMemories: 0,
    omittedActiveMemories: 0,
    groups: { feedback: [], project: [], decision: [], reference: [] },
  });
  assert.match(output, /^## Current workspace memories/);
  assert.match(output, /No active workspace memories are stored yet\./);
  assert.match(output, /Local only: no LLM request was made\./);
  assert.equal(output.includes("feedback:"), false);
});

test("formats help text for available display commands", () => {
  const output = formatMemoryHelp();
  assert.match(output, /^## Memory help/);
  assert.match(output, /\/memory-status/);
  assert.match(output, /\/memory-list/);
  assert.match(output, /\/memory-help/);
  assert.equal(output.includes("/memory activity"), false);
  assert.equal(output.includes("/memory last"), false);
  assert.equal(output.includes("/memory status"), false);
  assert.equal(output.includes("/memory help"), false);
  assert.match(output, /do not call the LLM/);
});

test("renderMemoryCommand routes list output", async () => {
  const root = await tempRoot();
  try {
    const output = await renderMemoryCommand(root, "ses_list", "list");
    assert.match(output, /^## Current workspace memories/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renderMemoryCommand falls back to help for unknown command values", async () => {
  const root = await tempRoot();
  try {
    const output = await renderMemoryCommand(root, "ses_unknown", "unknown" as never);
    assert.match(output, /^## Memory help/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
