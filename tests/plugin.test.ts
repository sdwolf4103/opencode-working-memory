import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryV2Plugin } from "../src/plugin.ts";
import { loadSessionState, saveSessionState } from "../src/session-state.ts";
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