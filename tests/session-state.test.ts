import test from "node:test";
import assert from "node:assert/strict";
import * as sessionStateModule from "../src/session-state.ts";
import type { HotSessionStateRenderAccounting } from "../src/session-state.ts";
import type { ActiveFile, LongTermMemoryEntry, OpenError, SessionDecision, SessionState } from "../src/types.ts";
import { HOT_STATE_LIMITS } from "../src/types.ts";

type AccountHotSessionStateRender = (state: SessionState, workspaceRoot: string) => HotSessionStateRenderAccounting;

const accountHotSessionStateRender = (
  sessionStateModule as typeof sessionStateModule & { accountHotSessionStateRender: AccountHotSessionStateRender }
).accountHotSessionStateRender;

const { createEmptySessionState, renderHotSessionState } = sessionStateModule;

const root = "/repo";

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    version: 1,
    sessionID: "session-state-test",
    turn: 0,
    updatedAt: "2026-05-05T00:00:00.000Z",
    activeFiles: [],
    openErrors: [],
    recentDecisions: [],
    pendingMemories: [],
    ...overrides,
  };
}

function activeFile(path: string, action: ActiveFile["action"], count: number, lastSeen: number): ActiveFile {
  return { path, action, count, lastSeen };
}

function openError(id: string, summary: string, lastSeen: number): OpenError {
  return {
    id,
    category: "test",
    summary,
    fingerprint: `fingerprint-${id}`,
    status: "open",
    firstSeen: lastSeen - 1,
    lastSeen,
    seenCount: 1,
  };
}

function decision(id: string, text: string, createdAt: number): SessionDecision {
  return { id, text, source: "assistant", createdAt };
}

function memory(id: string, text: string, type: LongTermMemoryEntry["type"] = "decision"): LongTermMemoryEntry {
  return {
    id,
    type,
    text,
    source: "compaction",
    confidence: 0.75,
    status: "active",
    createdAt: "2026-05-05T00:00:00.000Z",
    updatedAt: "2026-05-05T00:00:00.000Z",
  };
}

test("accountHotSessionStateRender returns empty prompt and no omissions for empty state", () => {
  const accounting = accountHotSessionStateRender(createEmptySessionState("empty-session"), root);

  assert.equal(accounting.prompt, "");
  assert.deepEqual(accounting.omitted, []);
  assert.equal(accounting.maxRenderedChars, HOT_STATE_LIMITS.maxRenderedChars);
});

test("accountHotSessionStateRender renders hot-state sections in stable order", () => {
  const accounting = accountHotSessionStateRender(state({
    activeFiles: [activeFile("/repo/src/a.ts", "read", 1, 1)],
    openErrors: [openError("err-1", "one failing test", 2)],
    recentDecisions: [decision("dec-1", "Keep renderer simple", 3)],
    pendingMemories: [memory("mem-1", "Promote useful fact")],
  }), root);

  assert.ok(accounting.prompt.startsWith("Hot session state (current session):"));
  assert.ok(accounting.prompt.indexOf("active_files:") < accounting.prompt.indexOf("open_errors:"));
  assert.ok(accounting.prompt.indexOf("open_errors:") < accounting.prompt.indexOf("recent_decisions:"));
  assert.ok(accounting.prompt.indexOf("recent_decisions:") < accounting.prompt.indexOf("pending_memories:"));
});

test("accountHotSessionStateRender ranks active files by score then lastSeen descending", () => {
  const accounting = accountHotSessionStateRender(state({
    activeFiles: [
      activeFile("/repo/src/edit.ts", "edit", 1, 400),
      activeFile("/repo/src/write.ts", "write", 5, 200),
      activeFile("/repo/src/grep.ts", "grep", 10, 300),
      activeFile("/repo/src/read.ts", "read", 12, 100),
    ],
  }), root);

  const lines = accounting.prompt.split("\n");
  const activeLines = lines.filter(line => line.startsWith("- src/"));
  assert.deepEqual(activeLines, [
    "- src/grep.ts (grep, 10x)",
    "- src/write.ts (write, 5x)",
    "- src/read.ts (read, 12x)",
    "- src/edit.ts (edit, 1x)",
  ]);
});

test("accountHotSessionStateRender reports section-cap omissions for every capped section", () => {
  const accounting = accountHotSessionStateRender(state({
    activeFiles: Array.from({ length: 9 }, (_, index) => activeFile(`/repo/a${index}.ts`, "read", 1, 100 - index)),
    openErrors: Array.from({ length: 4 }, (_, index) => openError(`err-${index}`, `e${index}`, 100 - index)),
    recentDecisions: Array.from({ length: 9 }, (_, index) => decision(`dec-${index}`, `d${index}`, index)),
    pendingMemories: Array.from({ length: 7 }, (_, index) => memory(`mem-${index}`, `m${index}`)),
  }), root);

  const sectionCapOmissions = accounting.omitted.filter(item => item.reason === "section_cap");
  assert.deepEqual(
    sectionCapOmissions.map(item => item.section).sort(),
    ["active_files", "open_errors", "pending_memories", "recent_decisions"].sort(),
  );
  assert.equal(sectionCapOmissions.find(item => item.section === "pending_memories")?.memoryId, "mem-0");
});

test("accountHotSessionStateRender omits over-budget entries without cutting rendered lines", () => {
  const longPath = `/repo/${"x".repeat(650)}.ts`;
  const accounting = accountHotSessionStateRender(state({
    activeFiles: [
      activeFile("/repo/src/short.ts", "read", 1, 20),
      activeFile(longPath, "read", 1, 10),
    ],
  }), root);

  assert.equal(accounting.prompt, [
    "Hot session state (current session):",
    "active_files:",
    "- src/short.ts (read, 1x)",
  ].join("\n"));
  assert.equal(accounting.omitted.length, 1);
  assert.equal(accounting.omitted[0]?.reason, "char_budget");
  assert.equal(accounting.omitted[0]?.section, "active_files");
  assert.ok(!accounting.prompt.includes("x".repeat(20)));
});

test("accountHotSessionStateRender includes exact 700-char prompt but omits one additional character", () => {
  const fixedPrompt = [
    "Hot session state (current session):",
    "pending_memories:",
    "- [decision] ",
  ].join("\n");
  const exactText = "x".repeat(HOT_STATE_LIMITS.maxRenderedChars - fixedPrompt.length);
  const exactAccounting = accountHotSessionStateRender(state({
    pendingMemories: [memory("mem-exact", exactText)],
  }), root);

  assert.equal(exactAccounting.prompt.length, HOT_STATE_LIMITS.maxRenderedChars);
  assert.equal(exactAccounting.omitted.length, 0);

  const overAccounting = accountHotSessionStateRender(state({
    pendingMemories: [memory("mem-over", `${exactText}y`)],
  }), root);

  assert.equal(overAccounting.prompt, "");
  assert.equal(overAccounting.omitted.length, 1);
  assert.equal(overAccounting.omitted[0]?.reason, "char_budget");
  assert.equal(overAccounting.omitted[0]?.memoryId, "mem-over");
});

test("accountHotSessionStateRender suppresses header-only sections when no entries fit", () => {
  const accounting = accountHotSessionStateRender(state({
    activeFiles: [activeFile(`/repo/${"z".repeat(720)}.ts`, "read", 1, 1)],
  }), root);

  assert.equal(accounting.prompt, "");
  assert.equal(accounting.omitted.length, 1);
  assert.equal(accounting.omitted[0]?.reason, "char_budget");
  assert.ok(!accounting.prompt.includes("active_files:"));
});

test("renderHotSessionState delegates to accounted renderer prompt for empty and seeded states", () => {
  const empty = createEmptySessionState("compat-empty");
  const seeded = state({
    activeFiles: [activeFile("/repo/src/a.ts", "edit", 2, 1)],
    pendingMemories: [memory("mem-compat", "Compatibility prompt")],
  });

  assert.equal(renderHotSessionState(empty, root), accountHotSessionStateRender(empty, root).prompt);
  assert.equal(renderHotSessionState(seeded, root), accountHotSessionStateRender(seeded, root).prompt);
});

test("accountHotSessionStateRender counts newline separators in the 700-char budget", () => {
  const fixedPrompt = [
    "Hot session state (current session):",
    "recent_decisions:",
    "- ",
  ].join("\n");
  const exactText = "n".repeat(HOT_STATE_LIMITS.maxRenderedChars - fixedPrompt.length);

  const exactAccounting = accountHotSessionStateRender(state({
    recentDecisions: [decision("dec-exact", exactText, 1)],
  }), root);
  assert.equal(exactAccounting.prompt.length, HOT_STATE_LIMITS.maxRenderedChars);
  assert.equal(exactAccounting.omitted.length, 0);

  const overAccounting = accountHotSessionStateRender(state({
    recentDecisions: [decision("dec-over", `${exactText}!`, 1)],
  }), root);
  assert.equal(overAccounting.prompt, "");
  assert.equal(overAccounting.omitted.length, 1);
  assert.equal(overAccounting.omitted[0]?.reason, "char_budget");
});
