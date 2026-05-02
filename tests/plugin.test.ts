import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryV2Plugin } from "../src/plugin.ts";
import { loadSessionState, saveSessionState } from "../src/session-state.ts";
import { parseWorkspaceMemoryCandidates } from "../src/extractors.ts";
import type { OpenError } from "../src/types.ts";
import { PROMOTION_RETRY_LIMITS, WORKSPACE_MEMORY_CACHE_LIMITS } from "../src/types.ts";
import { sessionStatePath, workspaceMemoryPath, workspacePendingJournalPath } from "../src/paths.ts";
import { loadPendingJournal, savePendingJournal, memoryKey } from "../src/pending-journal.ts";
import { loadWorkspaceMemory, updateWorkspaceMemory } from "../src/workspace-memory.ts";
import { queryEvidenceEvents } from "../src/evidence-log.ts";

// Mock client for root session (not a sub-agent)
function mockRootClient() {
  return {
    session: {
      get: async () => ({ data: { parentID: null } }),
      messages: async () => ({ data: [] }),
      todo: async () => ({ data: [] }),
    },
  };
}

function mockClientWithLatestUser(text: string, messageID: string) {
  return {
    session: {
      get: async () => ({ data: { parentID: null } }),
      messages: async () => ({
        data: [
          {
            info: { role: "user", id: messageID },
            parts: [{ type: "text", text }],
          },
        ],
      }),
      todo: async () => ({ data: [] }),
    },
  };
}

function mockClientWithCompactionSummary(summary: string) {
  return {
    session: {
      get: async () => ({ data: { parentID: null } }),
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", summary: true },
            parts: [{ type: "text", text: summary }],
          },
        ],
      }),
      todo: async () => ({ data: [] }),
    },
  };
}

// Helper: create session state with pre-populated open error
function createSessionWithError(sessionID: string, error: OpenError) {
  return {
    version: 1 as const,
    sessionID,
    turn: 0,
    updatedAt: new Date().toISOString(),
    activeFiles: [],
    openErrors: [error],
    recentDecisions: [],
    pendingMemories: [],
  };
}

test("tool.execute.after: undefined exitCode does NOT create open error", async () => {
  // 1. Temp directory for isolated file I/O
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    // 2. Mock client — root session, no user messages
    const client = mockRootClient();

    // 3. Instantiate plugin
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

    // 4. Simulate bash output with NO exitCode, but output contains TS error
    //    This would create an open error if exitCode was non-zero
    //    Using STRONG error signal (TS2345) to catch the bug where undefined !== 0
    await (plugin as Record<string, Function>)["tool.execute.after"](
      {
        tool: "bash",
        sessionID: "test-session-1",
        args: { command: "npm run typecheck" },
      },
      {
        // exitCode deliberately absent (undefined !== 0 is the bug we're testing)
        output: "src/index.ts(10,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'",
      }
    );

    // 5. Assert: session state has ZERO open errors
    const state = await loadSessionState(tmpDir, "test-session-1");
    assert.equal(state.openErrors.length, 0,
      "exitCode === undefined must not create open errors even with strong error signal");

  } finally {
    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("tool.execute.after: undefined exitCode does NOT clear existing open error", async () => {
  // 1. Temp directory
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    // 2. Pre-populate session state with a real open error
    const preExistingError: OpenError = {
      id: "err_critical_abc",
      category: "typecheck",
      summary: "TS2345: Argument of type 'string' is not assignable to parameter of type 'number'",
      command: "npm run typecheck",
      fingerprint: "ee7b3f9a1c2d",
      status: "open",
      firstSeen: Date.now() - 3600000,
      lastSeen: Date.now() - 3600000,
      seenCount: 3,
    };

    await saveSessionState(tmpDir, createSessionWithError("test-session-2", preExistingError));

    // 3. Mock client
    const client = mockRootClient();

    // 4. Instantiate plugin
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

    // 5. Simulate bash output with NO exitCode (inspection command)
    //    Using STRONG error signal (TS error) to verify undefined exitCode doesn't clear
    await (plugin as Record<string, Function>)["tool.execute.after"](
      {
        tool: "bash",
        sessionID: "test-session-2",
        args: { command: "rtk cat ~/.local/share/opencode-working-memory/session.json" },
      },
      {
        // exitCode deliberately absent (undefined)
        // Even with TS error in output, should NOT clear existing error
        output: "src/other.ts(5,10): error TS2794: Expected 0 arguments, but got 1",
      }
    );

    // 6. Assert: pre-existing open error is PRESERVED
    const state = await loadSessionState(tmpDir, "test-session-2");
    assert.equal(state.openErrors.length, 1,
      "exitCode === undefined must not clear pre-existing open errors");
    assert.equal(state.openErrors[0].fingerprint, "ee7b3f9a1c2d",
      "The original open error must remain intact");

  } finally {
    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("tool.execute.after: exitCode 0 clears errors for same category", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    // Pre-populate session with a typecheck error
    const preExistingError: OpenError = {
      id: "err_test",
      category: "typecheck",
      summary: "TS2345: some error",
      command: "npm run typecheck",
      fingerprint: "abc123",
      status: "open",
      firstSeen: Date.now() - 3600000,
      lastSeen: Date.now() - 3600000,
      seenCount: 1,
    };

    await saveSessionState(tmpDir, createSessionWithError("test-session-3", preExistingError));

    const client = mockRootClient();
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

    // Simulate successful typecheck (exitCode 0)
    await (plugin as Record<string, Function>)["tool.execute.after"](
      {
        tool: "bash",
        sessionID: "test-session-3",
        args: { command: "npm run typecheck" },
      },
      {
        exitCode: 0,
        output: "",
      }
    );

    const state = await loadSessionState(tmpDir, "test-session-3");
    assert.equal(state.openErrors.length, 0,
      "exitCode 0 should clear typecheck errors");

  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("tool.execute.after: exitCode non-zero creates open error", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const client = mockRootClient();
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

    // Simulate failed typecheck (exitCode 1)
    await (plugin as Record<string, Function>)["tool.execute.after"](
      {
        tool: "bash",
        sessionID: "test-session-4",
        args: { command: "npm run typecheck" },
      },
      {
        exitCode: 1,
        output: "src/index.ts(10,3): error TS2345: Argument of type 'string' is not assignable",
      }
    );

    const state = await loadSessionState(tmpDir, "test-session-4");
    assert.equal(state.openErrors.length, 1,
      "exitCode non-zero should create open error");
    assert.equal(state.openErrors[0].category, "typecheck");

  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("compaction hook sets output.prompt with ---free template", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const client = mockRootClient();
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

    // Create a session state with some data
    await saveSessionState(tmpDir, {
      version: 1,
      sessionID: "test-session-compaction",
      turn: 1,
      updatedAt: new Date().toISOString(),
      activeFiles: [{ path: "/src/index.ts", action: "edit", count: 5, lastSeen: Date.now() }],
      openErrors: [],
      recentDecisions: [{ text: "Test decision", rationale: "Testing", source: "user", createdAt: Date.now() }],
    });

    // Call the compaction hook
    const output = { context: [] as string[] };
    await (plugin as Record<string, Function>)["experimental.session.compacting"](
      { sessionID: "test-session-compaction" },
      output
    );

    // Should set output.prompt and clear output.context
    const prompt = (output as Record<string, unknown>).prompt as string | undefined;
    assert.ok(prompt, "output.prompt should be set");
    assert.equal(typeof prompt, "string", "output.prompt should be a string");
    assert.equal(output.context.length, 0, "output.context should be cleared after setting prompt");

    // Should NOT contain YAML frontmatter separators (--- at start)
    assert.equal(prompt!.includes("\n---"), false,
      "Prompt should not contain --- separators on their own line");

    // Should NOT contain XML-like tags
    assert.equal(prompt!.includes("<workspace_memory>"), false);
    assert.equal(prompt!.includes("</workspace_memory>"), false);
    assert.equal(prompt!.includes("<hot_session_state>"), false);
    assert.equal(prompt!.includes("<pending_todos>"), false);

    // Should NOT contain HTML comments
    assert.equal(prompt!.includes("<!--"), false);

    // Should contain the ---free template heading
    assert.equal(prompt!.includes("## Goal"), true,
      "Prompt should use ## Goal heading, not --- separators");

    // Should contain formatting rules that explicitly forbid ---
    assert.equal(prompt!.includes("Do not output YAML frontmatter"), true,
      "Prompt should explicitly forbid YAML frontmatter");
    assert.equal(prompt!.includes("horizontal rules"), true,
      "Prompt should explicitly forbid horizontal rules");

    // Should contain Memory candidates format
    assert.equal(prompt!.includes("Memory candidates:"), true,
      "Prompt should include Memory candidates: label");
    assert.equal(prompt!.includes("Good memory examples:"), true,
      "Prompt should include concrete positive memory examples");
    assert.equal(prompt!.includes("Bad memory examples to skip:"), true,
      "Prompt should include concrete negative memory examples");
    assert.equal(prompt!.includes("180 tests passed"), true,
      "Prompt should explicitly reject test-count snapshots");
    assert.equal(prompt!.includes("Commit a762e86"), true,
      "Prompt should explicitly reject commit-hash snapshots");

    // Should contain our context data (hot session state)
    assert.equal(prompt!.includes("Hot session state"), true,
      "Prompt should include hot session state context");

    // Verify: prompt starts with plain text, not a markup delimiter
    assert.equal(prompt!.startsWith("---"), false,
      "Prompt should not start with --- (YAML frontmatter)");
    assert.equal(prompt!.startsWith("##"), false,
      "Prompt should start with plain instructions, not a heading");

  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("compaction prompt forbids progress and session-internal memory candidates", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-prompt-"));
  try {
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    const output = { prompt: "", context: [] as string[] };

    await (plugin as Record<string, Function>)["experimental.session.compacting"](
      { sessionID: "prompt-session", model: {} },
      output,
    );

    assert.match(output.prompt, /CRITICAL MEMORY RULES/);
    assert.match(output.prompt, /NO completion or progress statements/i);
    assert.match(output.prompt, /NO session-internal implementation notes/i);
    assert.match(output.prompt, /feedback ONLY/i);
    assert.match(output.prompt, /Most compactions should produce ZERO memories/i);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("compaction prompt includes existing-memory wording reuse guidance", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-prompt-"));
  try {
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    const output = { prompt: "", context: [] as string[] };

    await (plugin as Record<string, Function>)["experimental.session.compacting"](
      { sessionID: "prompt-wording-reuse-session", model: {} },
      output,
    );

    assert.match(output.prompt, /Existing workspace memory may already contain durable facts/);
    assert.match(output.prompt, /do not create a rephrased duplicate/);
    assert.match(output.prompt, /reuse the existing memory wording exactly whenever possible/);
    assert.match(output.prompt, /new, materially corrected, or materially more specific/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("compaction prompt does not introduce CRUD memory directives", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-prompt-"));
  try {
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    const output = { prompt: "", context: [] as string[] };

    await (plugin as Record<string, Function>)["experimental.session.compacting"](
      { sessionID: "prompt-no-crud-session", model: {} },
      output,
    );

    assert.doesNotMatch(output.prompt, /\bREPLACE\b/);
    assert.doesNotMatch(output.prompt, /\bDROP\b/);
    assert.doesNotMatch(output.prompt, /\bREINFORCE\s+\[M/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("compaction prompt preserves Memory candidates output format", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-prompt-"));
  try {
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    const output = { prompt: "", context: [] as string[] };

    await (plugin as Record<string, Function>)["experimental.session.compacting"](
      { sessionID: "prompt-format-session", model: {} },
      output,
    );

    assert.match(
      output.prompt,
      /Format when there ARE durable memories:\nMemory candidates:\n- \[feedback\|decision\|project\|reference\] future-facing durable fact/,
    );
    assert.match(
      output.prompt,
      /Format when there are NO durable memories:\nMemory candidates:\n\(none\)/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("compaction hook merges existing output.context from other plugins", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const client = mockRootClient();
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

    // Simulate another plugin having pushed context first
    const output = { context: ["Other plugin context data"] };
    await (plugin as Record<string, Function>)["experimental.session.compacting"](
      { sessionID: "test-merge-context" },
      output
    );

    const prompt = (output as Record<string, unknown>).prompt as string | undefined;
    assert.ok(prompt, "output.prompt should be set");
    assert.equal(output.context.length, 0, "output.context should be cleared");

    // Should contain the other plugin's context
    assert.equal(prompt!.includes("Other plugin context data"), true,
      "Prompt should preserve context from other plugins");

  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("parseWorkspaceMemoryCandidates accepts Markdown section format", async () => {
  const summary = `
## Summary
Progress made on testing.

## Memory Candidates
- [decision] Use Markdown sections for candidates
- [project] This repo uses Markdown for docs

Next steps: continue development.
`;

  const candidates = parseWorkspaceMemoryCandidates(summary);
  assert.equal(candidates.length, 2, "Should parse Markdown section format");
  assert.equal(candidates[0].type, "decision");
  assert.equal(candidates[1].type, "project");
});

test("parseWorkspaceMemoryCandidates accepts legacy Workspace Memory Candidates section", async () => {
  const summary = `
## Summary
Progress made on testing.

## Workspace Memory Candidates
- [reference] Check docs at README.md

## Next Steps
Continue development.
`;

  const candidates = parseWorkspaceMemoryCandidates(summary);
  assert.equal(candidates.length, 1, "Should parse legacy section format");
  assert.equal(candidates[0].type, "reference");
});

test("parseWorkspaceMemoryCandidates still accepts legacy XML format", async () => {
  const summary = `
## Summary
Progress made on testing.

<workspace_memory_candidates>
- [feedback] Users prefer darker themes
</workspace_memory_candidates>

Next steps: continue development.
`;

  const candidates = parseWorkspaceMemoryCandidates(summary);
  assert.equal(candidates.length, 1, "Should parse legacy XML format");
  assert.equal(candidates[0].type, "feedback");
});

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

test("chat system transform degrades gracefully when workspace memory JSON is corrupt", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const path = await workspaceMemoryPath(tmpDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ invalid json", "utf8");

    const plugin = await MemoryV2Plugin({
      directory: tmpDir,
      client: mockRootClient(),
    });
    const output = { system: ["base header"] };

    await assert.doesNotReject(async () => {
      await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
        { sessionID: "corrupt-json-session", model: {} },
        output,
      );
    });

    assert.deepEqual(output.system, ["base header"]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("hook failure emits hook_failed evidence without raw tool output", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const statePath = await sessionStatePath(tmpDir, "hook-failure-session");
    await mkdir(dirname(statePath), { recursive: true });
    await mkdir(statePath, { recursive: true });

    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    await (plugin as Record<string, Function>)["tool.execute.after"](
      {
        tool: "bash",
        sessionID: "hook-failure-session",
        args: { command: "cat secret-output.txt" },
      },
      { output: "raw tool output password: sushi should not be in evidence", exitCode: 1 },
    );

    const events = await queryEvidenceEvents(tmpDir, { types: ["hook_failed"] });
    const raw = JSON.stringify(events);
    assert.equal(events.length, 1);
    assert.equal(events[0].reasonCodes.includes("tool.execute.after"), true);
    assert.equal(raw.includes("raw tool output"), false);
    assert.equal(raw.includes("sushi"), false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("no compaction: owned explicit memory is not promoted by unrelated next session start", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const firstClient = mockClientWithLatestUser("remember this: Prefer boring cache boundaries.", "msg-remember-1");
    const firstPlugin = await MemoryV2Plugin({ directory: tmpDir, client: firstClient });

    await (firstPlugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "session-without-compaction", model: {} },
      { system: ["base header"] },
    );

    const secondPlugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    const output = { system: ["base header"] };

    await (secondPlugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "new-session", model: {} },
      output,
    );

    const workspacePrompt = output.system.find((part: string) => part.startsWith("Workspace memory"));
    assert.doesNotMatch(workspacePrompt ?? "", /Prefer boring cache boundaries/);

    const pending = await loadPendingJournal(tmpDir);
    assert.equal(pending.entries.length, 1);
    assert.equal(pending.entries[0].pendingOwnerSessionID, "session-without-compaction");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("explicit memory appended from user message is owned by session and not promoted before current snapshot", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const plugin = await MemoryV2Plugin({
      directory: tmpDir,
      client: mockClientWithLatestUser("remember this: Prefer Traditional Chinese.", "msg-a"),
    });
    const output = { system: ["base header"] };

    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "session-a", model: {} },
      output,
    );

    const pending = await loadPendingJournal(tmpDir);
    assert.equal(pending.entries.length, 1);
    assert.equal(pending.entries[0].pendingOwnerSessionID, "session-a");
    assert.equal(pending.entries[0].pendingMessageID, "msg-a");

    const workspace = await loadWorkspaceMemory(tmpDir);
    assert.equal(
      workspace.entries.some(entry => /Prefer Traditional Chinese/.test(entry.text)),
      false,
      "current-turn explicit memory should remain pending until compaction/promotion",
    );
    assert.match(output.system.join("\n"), /Prefer Traditional Chinese/,
      "current-turn explicit memory should still appear in hot session state");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("session promotion does not clear another session's same-key pending journal entry", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const now = new Date().toISOString();
    const pendingA = {
      id: "mem_same_key_a",
      type: "feedback" as const,
      text: "Prefer owner-scoped pending cleanup.",
      source: "explicit" as const,
      confidence: 1,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
      pendingOwnerSessionID: "session-a",
      pendingMessageID: "msg-a",
    };
    const pendingB = {
      ...pendingA,
      id: "mem_same_key_b",
      pendingOwnerSessionID: "session-b",
      pendingMessageID: "msg-b",
    };

    await saveSessionState(tmpDir, {
      version: 1,
      sessionID: "session-a",
      turn: 0,
      updatedAt: now,
      activeFiles: [],
      openErrors: [],
      recentDecisions: [],
      pendingMemories: [pendingA],
    });
    await saveSessionState(tmpDir, {
      version: 1,
      sessionID: "session-b",
      turn: 0,
      updatedAt: now,
      activeFiles: [],
      openErrors: [],
      recentDecisions: [],
      pendingMemories: [pendingB],
    });
    await savePendingJournal(tmpDir, {
      version: 1,
      workspace: { root: tmpDir, key: "test" },
      updatedAt: now,
      entries: [pendingA, pendingB],
    });

    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    await (plugin as Record<string, Function>)["event"]({
      event: { type: "session.compacted", properties: { sessionID: "session-a" } },
    });

    const journal = await loadPendingJournal(tmpDir);
    assert.equal(journal.entries.length, 1);
    assert.equal(journal.entries[0].pendingOwnerSessionID, "session-b",
      "session-a promotion must not clear session-b's same-key journal entry");

    const stateB = await loadSessionState(tmpDir, "session-b");
    assert.equal(stateB.pendingMemories.length, 1);
    assert.equal(memoryKey(stateB.pendingMemories[0]), memoryKey(pendingB));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("session.deleted promotes pending memories before deleting session state", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const client = mockClientWithLatestUser("remember this: Promote pending memories before delete.", "msg-delete-1");
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

test("session.deleted clears caches even when session state file is already gone", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const now = new Date().toISOString();
    await updateWorkspaceMemory(tmpDir, store => {
      store.entries.push({
        id: "mem_before_delete_cache",
        type: "project",
        text: "Workspace memory before delete cleanup.",
        source: "compaction",
        confidence: 0.9,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return store;
    });

    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    const beforeOutput = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "deleted-missing-state-session", model: {} },
      beforeOutput,
    );
    assert.match(beforeOutput.system.join("\n"), /Workspace memory before delete cleanup/);

    const ownedPending = {
      id: "mem_delete_owned_journal",
      type: "decision" as const,
      text: "Owned journal memory promotes during delete cleanup.",
      source: "explicit" as const,
      confidence: 1,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
      pendingOwnerSessionID: "deleted-missing-state-session",
      pendingMessageID: "msg-delete-owned",
    };
    await savePendingJournal(tmpDir, {
      version: 1,
      workspace: { root: tmpDir, key: "test" },
      updatedAt: now,
      entries: [ownedPending],
    });

    await (plugin as Record<string, Function>)["event"]({
      event: {
        type: "session.deleted",
        properties: { sessionID: "deleted-missing-state-session" },
      },
    });

    const pendingAfter = await loadPendingJournal(tmpDir);
    assert.equal(pendingAfter.entries.length, 0,
      "clearable owned journal entry should be removed even when session state file is absent");

    const afterOutput = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "deleted-missing-state-session", model: {} },
      afterOutput,
    );
    const workspacePrompt = afterOutput.system.find((part: string) => part.startsWith("Workspace memory"));
    assert.match(workspacePrompt ?? "", /Owned journal memory promotes during delete cleanup/,
      "session.deleted should clear frozen cache after successful promotion");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("duplicate explicit memories dedupe by normalized type and text, not generated id", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const pluginA = await MemoryV2Plugin({
      directory: tmpDir,
      client: mockClientWithLatestUser("remember this: Prefer stable cache boundaries.", "msg-a"),
    });
    await (pluginA as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "dedupe-session", model: {} },
      { system: ["base header"] },
    );

    const pluginB = await MemoryV2Plugin({
      directory: tmpDir,
      client: mockClientWithLatestUser("remember this: prefer   stable cache boundaries.", "msg-b"),
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

    const workspace = await loadWorkspaceMemory(tmpDir);
    const promoted = workspace.entries.find(entry => entry.id === "mem_pending_1");
    assert.ok(typeof promoted?.retentionClock === "number",
      "legacy pending memory should receive a retention clock when promoted");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("session.compacted reinforces existing exact workspace memory", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const now = new Date().toISOString();
    const oldRetentionClock = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await updateWorkspaceMemory(tmpDir, store => {
      store.entries.push({
        id: "existing-memory",
        type: "decision",
        text: "Use frozen rendered snapshots for cache stability.",
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
        retentionClock: oldRetentionClock,
      });
      return store;
    });

    await saveSessionState(tmpDir, {
      version: 1,
      sessionID: "reinforce-existing-session",
      turn: 1,
      updatedAt: now,
      activeFiles: [],
      openErrors: [],
      recentDecisions: [],
      pendingMemories: [{
        id: "pending-duplicate",
        type: "decision",
        text: "Use frozen rendered snapshots for cache stability.",
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }],
    });

    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    await (plugin as Record<string, Function>)["event"]({
      event: { type: "session.compacted", properties: { sessionID: "reinforce-existing-session" } },
    });

    const workspace = await loadWorkspaceMemory(tmpDir);
    const existing = workspace.entries.find(entry => entry.id === "existing-memory");
    assert.equal(workspace.entries.filter(entry => /frozen rendered/.test(entry.text)).length, 1);
    assert.equal(existing?.reinforcementCount, 1);
    assert.equal(existing?.lastReinforcedSessionID, "reinforce-existing-session");
    assert.ok((existing?.retentionClock ?? 0) > oldRetentionClock);
    assert.equal((await loadSessionState(tmpDir, "reinforce-existing-session")).pendingMemories.length, 0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("integration: explicit memory flows from user message through pending journal into workspace", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const plugin = await MemoryV2Plugin({
      directory: tmpDir,
      client: mockClientWithLatestUser("remember this: Prefer deterministic consolidation accounting.", "msg-explicit-flow"),
    });

    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "explicit-flow-session", model: {} },
      { system: ["base header"] },
    );

    assert.equal((await loadSessionState(tmpDir, "explicit-flow-session")).pendingMemories.length, 1);
    assert.equal((await loadPendingJournal(tmpDir)).entries.length, 1);

    await (plugin as Record<string, Function>)["event"]({
      event: { type: "session.compacted", properties: { sessionID: "explicit-flow-session" } },
    });

    assert.equal((await loadSessionState(tmpDir, "explicit-flow-session")).pendingMemories.length, 0);
    assert.equal((await loadPendingJournal(tmpDir)).entries.length, 0);

    const output = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "explicit-flow-session", model: {} },
      output,
    );

    assert.match(output.system.join("\n"), /Prefer deterministic consolidation accounting/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("explicit memory lifecycle emits detected appended and promoted evidence", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const plugin = await MemoryV2Plugin({
      directory: tmpDir,
      client: mockClientWithLatestUser("remember this: Prefer evidence-backed lifecycle tests.", "msg-evidence-life"),
    });

    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "evidence-life-session", model: {} },
      { system: ["base header"] },
    );

    await (plugin as Record<string, Function>)["event"]({
      event: { type: "session.compacted", properties: { sessionID: "evidence-life-session" } },
    });

    const events = await queryEvidenceEvents(tmpDir, { newestFirst: false });
    const eventTypes = events.map(event => event.type);

    assert.ok(eventTypes.includes("explicit_memory_detected"));
    assert.ok(eventTypes.includes("pending_memory_appended"));
    assert.ok(eventTypes.includes("promotion_promoted"));

    const output = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "evidence-life-session", model: {} },
      output,
    );

    const finalEvents = await queryEvidenceEvents(tmpDir, { newestFirst: false });
    assert.ok(finalEvents.map(event => event.type).includes("render_selected"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("session.compacted promotes first-time explicit memory without self-reinforcement", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const plugin = await MemoryV2Plugin({
      directory: tmpDir,
      client: mockClientWithLatestUser(
        "remember this: Prefer no self reinforcement during first promotion.",
        "msg-no-self-reinforce",
      ),
    });

    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "no-self-reinforce-session", model: {} },
      { system: ["base header"] },
    );

    await (plugin as Record<string, Function>)["event"]({
      event: {
        type: "session.compacted",
        properties: { sessionID: "no-self-reinforce-session" },
      },
    });

    const workspace = await loadWorkspaceMemory(tmpDir);
    const promoted = workspace.entries.find(entry =>
      /Prefer no self reinforcement/.test(entry.text)
    );

    assert.ok(promoted, "explicit memory should be promoted");
    assert.equal(promoted.reinforcementCount ?? 0, 0);
    assert.equal(promoted.lastReinforcedSessionID, undefined);

    const state = await loadSessionState(tmpDir, "no-self-reinforce-session");
    assert.equal(state.pendingMemories.length, 0);
    assert.equal((await loadPendingJournal(tmpDir)).entries.length, 0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("integration: compaction candidate flows through journal promotion and clears pending journal", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const summary = `
## Goal
Continue durable memory work.

## Memory Candidates
- [decision] Use accounting events to classify promoted absorbed superseded and rejected memories.
`;
    const plugin = await MemoryV2Plugin({
      directory: tmpDir,
      client: mockClientWithCompactionSummary(summary),
    });

    await (plugin as Record<string, Function>)["event"]({
      event: { type: "session.compacted", properties: { sessionID: "compaction-flow-session" } },
    });

    assert.equal((await loadPendingJournal(tmpDir)).entries.length, 0,
      "compaction candidate should be promoted and then cleared from pending journal");

    const output = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "after-compaction-flow", model: {} },
      output,
    );

    assert.match(output.system.join("\n"), /accounting events to classify promoted absorbed superseded and rejected memories/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("integration: next session promotes prior unowned journal and leaves journal clean", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const now = new Date().toISOString();
    await savePendingJournal(tmpDir, {
      version: 1,
      workspace: { root: tmpDir, key: "test" },
      updatedAt: now,
      entries: [{
        id: "mem_unowned_cross_session",
        type: "feedback",
        text: "Cross-session unowned promotion keeps the journal clean.",
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }],
    });

    assert.equal((await loadPendingJournal(tmpDir)).entries.length, 1);

    const secondPlugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    const output = { system: ["base header"] };
    await (secondPlugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "second-cross-session", model: {} },
      output,
    );

    assert.equal((await loadPendingJournal(tmpDir)).entries.length, 0);
    assert.match(output.system.join("\n"), /Cross-session unowned promotion keeps the journal clean/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("same-session explicit memory does not mutate frozen system[1]", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    // 1. Seed workspace memory so system[1] exists before explicit memory is added.
    const now = new Date().toISOString();
    await updateWorkspaceMemory(tmpDir, store => {
      store.entries.push({
        id: "mem_existing_stable",
        type: "project",
        text: "Existing stable workspace memory.",
        source: "compaction",
        confidence: 0.9,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return store;
    });

    // 2. Use one plugin instance with a mutable mock client so the in-memory
    // frozen cache is preserved across turns while the latest user message changes.
    let latestMessages: Array<Record<string, unknown>> = [];
    const client = {
      session: {
        get: async () => ({ data: { parentID: null } }),
        messages: async () => ({ data: latestMessages }),
        todo: async () => ({ data: [] }),
      },
    };
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

    const output1 = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "frozen-cache-session", model: {} },
      output1,
    );

    const firstSystem1 = output1.system.find((part: string) => part.startsWith("Workspace memory"));
    assert.match(firstSystem1 ?? "", /Existing stable workspace memory/,
      "first transform should create a frozen workspace memory system[1]");

    // 3. User says "remember X" in the same session.
    latestMessages = [{
      info: { role: "user", id: "msg-explicit-1" },
      parts: [{ type: "text", text: "remember this: Same-session memory stays ephemeral." }],
    }];

    const output2 = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "frozen-cache-session", model: {} },
      output2,
    );

    // 4. Assert: workspace system[1] unchanged (frozen snapshot).
    const secondSystem1 = output2.system.find((part: string) => part.startsWith("Workspace memory"));
    assert.equal(secondSystem1, firstSystem1,
      "frozen system[1] must not change after explicit memory in same session");

    // 5. Assert: hot state (system[2+]) contains the pending memory.
    const hotState = output2.system.find((part: string) => part.includes("Hot session state"));
    assert.ok(hotState, "hot session state should be rendered");
    assert.match(hotState, /pending_memories:/,
      "hot state should contain pending_memories section");
    assert.match(hotState, /Same-session memory stays ephemeral/,
      "hot state should contain the explicit memory text");

  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("chat system transform reloads frozen workspace snapshot after cache TTL expires", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;

  try {
    const timestamp = new Date().toISOString();
    await updateWorkspaceMemory(tmpDir, store => {
      store.entries.push({
        id: "mem_cache_ttl_old",
        type: "project",
        text: "Workspace memory before TTL expiry.",
        source: "compaction",
        confidence: 0.9,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return store;
    });

    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    const output1 = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "ttl-session", model: {} },
      output1,
    );
    assert.match(output1.system.join("\n"), /Workspace memory before TTL expiry/);

    await updateWorkspaceMemory(tmpDir, store => {
      store.entries.push({
        id: "mem_cache_ttl_new",
        type: "project",
        text: "Workspace memory after TTL expiry.",
        source: "compaction",
        confidence: 0.9,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return store;
    });

    now += WORKSPACE_MEMORY_CACHE_LIMITS.frozenTtlMs + 1;

    const output2 = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "ttl-session", model: {} },
      output2,
    );

    assert.match(output2.system.join("\n"), /Workspace memory after TTL expiry/);
  } finally {
    Date.now = originalNow;
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("chat system transform evicts oldest frozen snapshots when cache exceeds session limit", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const timestamp = new Date().toISOString();
    await updateWorkspaceMemory(tmpDir, store => {
      store.entries.push({
        id: "mem_cache_size_old",
        type: "project",
        text: "Workspace memory before cache pressure.",
        source: "compaction",
        confidence: 0.9,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return store;
    });

    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    for (let i = 0; i <= WORKSPACE_MEMORY_CACHE_LIMITS.maxFrozenSessions; i += 1) {
      await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
        { sessionID: `cache-size-session-${i}`, model: {} },
        { system: ["base header"] },
      );
    }

    await updateWorkspaceMemory(tmpDir, store => {
      store.entries.push({
        id: "mem_cache_size_new",
        type: "project",
        text: "Workspace memory after cache pressure.",
        source: "compaction",
        confidence: 0.9,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return store;
    });

    const output = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "cache-size-session-0", model: {} },
      output,
    );

    assert.match(output.system.join("\n"), /Workspace memory after cache pressure/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("processed user message cache keeps only the latest message IDs per session", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    let latestMessages: Array<Record<string, unknown>> = [];
    const client = {
      session: {
        get: async () => ({ data: { parentID: null } }),
        messages: async () => ({ data: latestMessages }),
        todo: async () => ({ data: [] }),
      },
    };
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

    for (let i = 0; i <= WORKSPACE_MEMORY_CACHE_LIMITS.maxProcessedMessagesPerSession; i += 1) {
      latestMessages = [{
        info: { role: "user", id: `msg-${i}` },
        parts: [{ type: "text", text: `remember this: Processed cache filler memory ${i}.` }],
      }];
      await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
        { sessionID: "processed-cache-session", model: {} },
        { system: ["base header"] },
      );
    }

    latestMessages = [{
      info: { role: "user", id: "msg-0" },
      parts: [{ type: "text", text: "remember this: Evicted processed message id can be reused." }],
    }];
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "processed-cache-session", model: {} },
      { system: ["base header"] },
    );

    const state = await loadSessionState(tmpDir, "processed-cache-session");
    assert.ok(
      state.pendingMemories.some(memory => /Evicted processed message id can be reused/.test(memory.text)),
      "oldest processed message id should be evicted and accepted again",
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("processed user message cache evicts oldest session ID sets", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const latestBySession = new Map<string, Array<Record<string, unknown>>>();
    const client = {
      session: {
        get: async () => ({ data: { parentID: null } }),
        messages: async ({ path }: { path?: { id?: string } } = {}) => ({
          data: latestBySession.get(path?.id ?? "") ?? [],
        }),
        todo: async () => ({ data: [] }),
      },
    };
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

    for (let i = 0; i <= WORKSPACE_MEMORY_CACHE_LIMITS.maxProcessedSessionIDs; i += 1) {
      const sessionID = `processed-session-${i}`;
      latestBySession.set(sessionID, [{
        info: { role: "user", id: `msg-${i}` },
        parts: [{ type: "text", text: `remember this: Session cache filler memory ${i}.` }],
      }]);
      await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
        { sessionID, model: {} },
        { system: ["base header"] },
      );
    }

    latestBySession.set("processed-session-0", [{
      info: { role: "user", id: "msg-0" },
      parts: [{ type: "text", text: "remember this: Evicted processed session set can process again." }],
    }]);
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "processed-session-0", model: {} },
      { system: ["base header"] },
    );

    const state = await loadSessionState(tmpDir, "processed-session-0");
    assert.ok(
      state.pendingMemories.some(memory => /Evicted processed session set can process again/.test(memory.text)),
      "oldest processed session set should be evicted and accept the same message id again",
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("compaction intentionally refreshes frozen system[1] with promoted memories", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    // 1. Seed workspace memory, then first transform creates non-empty frozen system[1].
    const now = new Date().toISOString();
    await updateWorkspaceMemory(tmpDir, store => {
      store.entries.push({
        id: "mem_old_stable",
        type: "project",
        text: "Old stable memory.",
        source: "compaction",
        confidence: 0.9,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return store;
    });

    const client = mockRootClient();
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

    const output1 = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "compaction-refresh-session", model: {} },
      output1,
    );

    const firstSystem1 = output1.system.find((part: string) => part.startsWith("Workspace memory"));
    assert.match(firstSystem1 ?? "", /Old stable memory/,
      "first transform should create a non-empty frozen system[1]");

    // 2. Add pending memory to session state
    await saveSessionState(tmpDir, {
      version: 1,
      sessionID: "compaction-refresh-session",
      turn: 1,
      updatedAt: new Date().toISOString(),
      activeFiles: [],
      openErrors: [],
      recentDecisions: [],
      pendingMemories: [{
        id: "mem_compaction_test",
        type: "decision",
        text: "Compaction refreshes frozen snapshot.",
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    });

    // 3. Fire session.compacted event
    await (plugin as Record<string, Function>)["event"]({
      event: {
        type: "session.compacted",
        properties: { sessionID: "compaction-refresh-session" },
      },
    });

    // 4. Next transform same session - system[1] should be refreshed
    const output2 = { system: ["base header"] };
    await (plugin as Record<string, Function>)["experimental.chat.system.transform"](
      { sessionID: "compaction-refresh-session", model: {} },
      output2,
    );

    const secondSystem1 = output2.system.find((part: string) => part.startsWith("Workspace memory"));

    // 5. Assert: system[1] changed (compaction started new cache epoch)
    assert.notEqual(secondSystem1, firstSystem1,
      "frozen system[1] should change after compaction (new cache epoch)");

    // 6. Assert: old stable memory is preserved and promoted memory is now in system[1]
    assert.match(secondSystem1 ?? "", /Old stable memory/,
      "refreshed system[1] should preserve existing workspace memory");
    assert.match(secondSystem1 ?? "", /Compaction refreshes frozen snapshot/,
      "promoted memory should appear in refreshed system[1]");

    // 7. Assert: pending memory cleared from hot state
    const hotState = output2.system.find((part: string) => part.includes("Hot session state"));
    if (hotState) {
      assert.equal(hotState.includes("pending_memories:"), false,
        "pending_memories should be cleared after promotion");
    }

  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

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

test("session.compacted promotes pending memory when exact existing entry is only superseded", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const now = new Date().toISOString();
    await updateWorkspaceMemory(tmpDir, store => {
      store.entries.push({
        id: "mem_superseded_duplicate",
        type: "decision",
        text: "Revive superseded exact memories when remembered again.",
        source: "explicit",
        confidence: 1,
        status: "superseded",
        createdAt: now,
        updatedAt: now,
      });
      return store;
    });

    await saveSessionState(tmpDir, {
      version: 1,
      sessionID: "superseded-boundary-session",
      turn: 0,
      updatedAt: now,
      activeFiles: [],
      openErrors: [],
      recentDecisions: [],
      pendingMemories: [{
        id: "mem_pending_revive",
        type: "decision",
        text: "Revive superseded exact memories when remembered again.",
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }],
    });

    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    await (plugin as Record<string, Function>)["event"]({
      event: { type: "session.compacted", properties: { sessionID: "superseded-boundary-session" } },
    });

    const state = await loadSessionState(tmpDir, "superseded-boundary-session");
    assert.equal(state.pendingMemories.length, 0,
      "revived pending memory should be cleared after successful promotion");

    const workspace = await loadWorkspaceMemory(tmpDir);
    const activeMatches = workspace.entries.filter(entry =>
      entry.status === "active" && /Revive superseded exact memories/.test(entry.text)
    );
    assert.equal(activeMatches.length, 1,
      "pending memory should become active even when only matching prior entry is superseded");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("session.compacted clears pending memory absorbed by existing workspace identity", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const now = new Date().toISOString();
    await updateWorkspaceMemory(tmpDir, store => {
      store.entries.push({
        id: "mem_existing_parser_formats",
        type: "decision",
        text: "Parser supports 2 candidate formats.",
        source: "compaction",
        confidence: 0.9,
        status: "active",
        createdAt: "2026-04-27T10:00:00.000Z",
        updatedAt: "2026-04-27T10:00:00.000Z",
      });
      return store;
    });

    await saveSessionState(tmpDir, {
      version: 1,
      sessionID: "absorbed-identity-session",
      turn: 0,
      updatedAt: now,
      activeFiles: [],
      openErrors: [],
      recentDecisions: [],
      pendingMemories: [{
        id: "mem_pending_parser_formats",
        type: "decision",
        text: "Parser supports 3 candidate formats.",
        source: "compaction",
        confidence: 0.75,
        status: "active",
        createdAt: "2026-04-27T09:00:00.000Z",
        updatedAt: "2026-04-27T09:00:00.000Z",
      }],
    });

    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    await (plugin as Record<string, Function>)["event"]({
      event: { type: "session.compacted", properties: { sessionID: "absorbed-identity-session" } },
    });

    const state = await loadSessionState(tmpDir, "absorbed-identity-session");
    assert.equal(state.pendingMemories.length, 0,
      "same-identity pending memory should be cleared after workspace normalization keeps an equivalent entry");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("session.compacted clears compaction pending memory rejected by workspace entry cap", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const now = new Date().toISOString();
    await updateWorkspaceMemory(tmpDir, store => {
      for (let i = 0; i < 10; i += 1) {
        store.entries.push({
          id: `mem_high_feedback_${i}`,
          type: "feedback",
          text: `High priority user feedback memory ${i} that should outrank low priority references.`,
          source: "explicit",
          confidence: 1,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
      for (let i = 0; i < 10; i += 1) {
        store.entries.push({
          id: `mem_high_decision_${i}`,
          type: "decision",
          text: `High priority decision memory ${i} that should outrank low priority references.`,
          source: "explicit",
          confidence: 1,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
      for (let i = 0; i < 8; i += 1) {
        store.entries.push({
          id: `mem_high_project_${i}`,
          type: "project",
          text: `High priority project memory ${i} that should outrank low priority references.`,
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
    assert.equal(state.pendingMemories.length, 0,
      "compaction pending memory rejected by workspace cap should be terminal and clearable");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("session.compacted keeps explicit pending memory rejected by workspace entry cap", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const now = new Date().toISOString();
    await updateWorkspaceMemory(tmpDir, store => {
      for (let i = 0; i < 10; i += 1) {
        store.entries.push({
          id: `mem_high_explicit_reject_feedback_${i}`,
          type: "feedback",
          text: `Pinned high priority feedback for explicit reject ${i}.`,
          source: "explicit",
          confidence: 1,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
      for (let i = 0; i < 10; i += 1) {
        store.entries.push({
          id: `mem_high_explicit_reject_decision_${i}`,
          type: "decision",
          text: `Pinned high priority decision for explicit reject ${i}.`,
          source: "explicit",
          confidence: 1,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
      for (let i = 0; i < 8; i += 1) {
        store.entries.push({
          id: `mem_high_explicit_reject_project_${i}`,
          type: "project",
          text: `Pinned high priority project for explicit reject ${i}.`,
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
      sessionID: "explicit-rejected-cap-session",
      turn: 0,
      updatedAt: now,
      activeFiles: [],
      openErrors: [],
      recentDecisions: [],
      pendingMemories: [{
        id: "mem_explicit_low_priority_reference",
        type: "reference",
        text: "Explicit reference should remain pending when capacity rejected.",
        source: "explicit",
        confidence: 0.1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }],
    });

    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    await (plugin as Record<string, Function>)["event"]({
      event: { type: "session.compacted", properties: { sessionID: "explicit-rejected-cap-session" } },
    });

    const state = await loadSessionState(tmpDir, "explicit-rejected-cap-session");
    assert.equal(state.pendingMemories.length, 1,
      "explicit pending memory rejected by workspace cap should remain pending for retry");
    assert.match(state.pendingMemories[0].text, /Explicit reference/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("explicit capacity rejection records bounded retry metadata", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const now = new Date().toISOString();
    await updateWorkspaceMemory(tmpDir, store => {
      for (let i = 0; i < 10; i += 1) {
        store.entries.push({
          id: `mem_high_bounded_reject_feedback_${i}`,
          type: "feedback",
          text: `Pinned high priority feedback for bounded rejection ${i}.`,
          source: "explicit",
          confidence: 1,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
      for (let i = 0; i < 10; i += 1) {
        store.entries.push({
          id: `mem_high_bounded_reject_decision_${i}`,
          type: "decision",
          text: `Pinned high priority decision for bounded rejection ${i}.`,
          source: "explicit",
          confidence: 1,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
      for (let i = 0; i < 8; i += 1) {
        store.entries.push({
          id: `mem_high_bounded_reject_project_${i}`,
          type: "project",
          text: `Pinned high priority project for bounded rejection ${i}.`,
          source: "explicit",
          confidence: 1,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
      return store;
    });

    const rejectedMemory = {
      id: "mem_explicit_bounded_reject",
      type: "reference" as const,
      text: "Explicit reference should retry only a bounded number of times.",
      source: "explicit" as const,
      confidence: 0.1,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
      pendingOwnerSessionID: "bounded-reject-session",
      pendingMessageID: "msg-bounded-reject",
    };
    await saveSessionState(tmpDir, {
      version: 1,
      sessionID: "bounded-reject-session",
      turn: 0,
      updatedAt: now,
      activeFiles: [],
      openErrors: [],
      recentDecisions: [],
      pendingMemories: [rejectedMemory],
    });
    await savePendingJournal(tmpDir, {
      version: 1,
      workspace: { root: tmpDir, key: "test" },
      updatedAt: now,
      entries: [rejectedMemory],
    });

    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    for (let attempt = 1; attempt < PROMOTION_RETRY_LIMITS.maxExplicitAttempts; attempt += 1) {
      await (plugin as Record<string, Function>)["event"]({
        event: { type: "session.compacted", properties: { sessionID: "bounded-reject-session" } },
      });

      const journal = await loadPendingJournal(tmpDir);
      assert.equal(journal.entries.length, 1,
        "explicit rejection should not silently clear before retry exhaustion");
      assert.equal(journal.entries[0].promotionAttempts, attempt);
      assert.equal(journal.entries[0].lastPromotionFailureReason, "rejected_capacity");

      const state = await loadSessionState(tmpDir, "bounded-reject-session");
      assert.equal(state.pendingMemories.length, 1,
        "hot session state should keep retryable explicit memory visible before exhaustion");
    }

    await (plugin as Record<string, Function>)["event"]({
      event: { type: "session.compacted", properties: { sessionID: "bounded-reject-session" } },
    });

    const journal = await loadPendingJournal(tmpDir);
    assert.equal(journal.entries.length, 0,
      "explicit pending journal entry should clear after max retry attempts");

    const state = await loadSessionState(tmpDir, "bounded-reject-session");
    assert.equal(state.pendingMemories.length, 0,
      "explicit hot session state should clear after retry exhaustion");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("session.compacted clears compaction pending memories when all rejected by workspace cap", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const now = new Date().toISOString();
    await updateWorkspaceMemory(tmpDir, store => {
      for (let i = 0; i < 10; i += 1) {
        store.entries.push({
          id: `mem_high_all_rejected_feedback_${i}`,
          type: "feedback",
          text: `Pinned high priority feedback ${i} that keeps the workspace entry cap full.`,
          source: "explicit",
          confidence: 1,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
      for (let i = 0; i < 10; i += 1) {
        store.entries.push({
          id: `mem_high_all_rejected_decision_${i}`,
          type: "decision",
          text: `Pinned high priority decision ${i} that keeps the workspace entry cap full.`,
          source: "explicit",
          confidence: 1,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
      for (let i = 0; i < 8; i += 1) {
        store.entries.push({
          id: `mem_high_all_rejected_project_${i}`,
          type: "project",
          text: `Pinned high priority project ${i} that keeps the workspace entry cap full.`,
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
    assert.equal(state.pendingMemories.length, 0,
      "compaction session pending memory should clear when rejected by capacity accounting");

    const pendingAfter = await loadPendingJournal(tmpDir);
    assert.equal(pendingAfter.entries.length, 0,
      "compaction journal pending memories should clear when rejected by capacity accounting");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("session.compacted clears stale rejected compaction journal memories", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const old = new Date(Date.now() - 90 * 86400000).toISOString();
    const journal = await loadPendingJournal(tmpDir);
    journal.entries = [{
      id: "mem_stale_journal_rejected",
      type: "reference",
      text: "Stale journal pending reference should remain pending after pruning rejects it.",
      source: "compaction",
      confidence: 0.75,
      status: "active",
      createdAt: old,
      updatedAt: old,
      staleAfterDays: 1,
    }];
    await savePendingJournal(tmpDir, journal);

    const plugin = await MemoryV2Plugin({ directory: tmpDir, client: mockRootClient() });
    await (plugin as Record<string, Function>)["event"]({
      event: { type: "session.compacted", properties: { sessionID: "stale-journal-rejected-session" } },
    });

    const pendingAfter = await loadPendingJournal(tmpDir);
    assert.equal(pendingAfter.entries.length, 0,
      "stale rejected compaction journal memory should be terminal and clearable");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("promotion failure does not clear pending memories in session or journal", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    const client = mockRootClient();
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

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

    let didThrow = false;
    try {
      await (plugin as Record<string, Function>)["event"]({
        event: {
          type: "session.compacted",
          properties: { sessionID: "failure-session" },
        },
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
