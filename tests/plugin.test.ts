import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryV2Plugin } from "../src/plugin.ts";
import { loadSessionState, saveSessionState } from "../src/session-state.ts";
import { parseWorkspaceMemoryCandidates } from "../src/extractors.ts";
import type { OpenError } from "../src/types.ts";

// Mock client for root session (not a sub-agent)
function mockRootClient() {
  return {
    session: {
      get: async () => ({ data: { parentID: null } }),
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
