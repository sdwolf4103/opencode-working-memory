import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryV2Plugin } from "../src/plugin.ts";
import { loadSessionState, saveSessionState } from "../src/session-state.ts";
import { parseWorkspaceMemoryCandidates } from "../src/extractors.ts";
import type { OpenError } from "../src/types.ts";
import { workspaceMemoryPath, workspacePendingJournalPath } from "../src/paths.ts";
import { loadPendingJournal, savePendingJournal } from "../src/pending-journal.ts";
import { updateWorkspaceMemory } from "../src/workspace-memory.ts";

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

test("no compaction: explicit memory is promoted on next session start from durable journal", async () => {
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
    assert.match(workspacePrompt ?? "", /Prefer boring cache boundaries/);
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
