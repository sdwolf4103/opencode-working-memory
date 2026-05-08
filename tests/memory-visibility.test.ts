import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { EvidenceEventInput } from "../src/evidence-log.ts";
import { appendEvidenceEvents } from "../src/evidence-log.ts";
import { appendPendingMemories } from "../src/pending-journal.ts";
import { saveSessionState } from "../src/session-state.ts";
import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "../src/types.ts";
import { workspaceMemoryPath } from "../src/paths.ts";
import { saveWorkspaceMemory } from "../src/workspace-memory.ts";
import {
  formatMemoryActivity,
  formatMemoryHelp,
  formatMemoryStatus,
  getMemoryActivity,
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

function evidence(overrides: Partial<EvidenceEventInput> = {}): EvidenceEventInput {
  return {
    type: "promotion_promoted",
    phase: "promotion",
    outcome: "promoted",
    reasonCodes: ["new_workspace_entry"],
    memory: { memoryId: "mem-a", type: "decision", source: "compaction", status: "active" },
    textPreview: "Use npm test before release",
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
    assert.match(output, /Active memories: 2/);
    assert.match(output, /Rendered in prompt: 1/);
    assert.match(output, /Pending in this session: 1/);
    assert.match(output, /Pending journal memories: 1/);
    assert.match(output, /Open errors: 1/);
    assert.match(output, /Recent decisions: 1/);
    assert.match(output, /Local only: no LLM request was made\./);
    assert.equal(output.includes("sushi"), false, "credential-like previews should be redacted");
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

    assert.match(output, /Active memories: 1/);
    assert.equal(output.includes("sushi"), false, "status output should redact credential-like previews");
    assert.equal(after, before, "status display must not persist normalization, migration, or redaction changes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formats recent memory activity newest first with reason summaries", async () => {
  const root = await tempRoot();
  try {
    await appendEvidenceEvents(root, [
      evidence({
        type: "render_omitted",
        phase: "render",
        outcome: "omitted",
        reasonCodes: ["char_budget"],
        memory: { memoryId: "old-render", type: "reference", source: "compaction", status: "active" },
        textPreview: "Older preview",
      }),
      evidence({
        type: "promotion_promoted",
        phase: "promotion",
        outcome: "promoted",
        reasonCodes: ["new_workspace_entry"],
        memory: { memoryId: "new-memory", type: "decision", source: "explicit", status: "active" },
        textPreview: "Newest password: sushi preview",
      }),
    ]);

    const output = formatMemoryActivity(await getMemoryActivity(root, { limit: 2 }));

    assert.match(output, /^## Recent memory activity/);
    assert.ok(output.indexOf("promoted") < output.indexOf("omitted"), "newest event should be formatted first");
    assert.match(output, /new_workspace_entry/);
    assert.match(output, /char_budget/);
    assert.equal(output.includes("sushi"), false, "activity previews should be redacted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formats empty activity state", () => {
  const output = formatMemoryActivity({ events: [], limit: 10 });
  assert.match(output, /^## Recent memory activity/);
  assert.match(output, /No retained memory activity exists/);
});

test("formats help text for available display commands", () => {
  const output = formatMemoryHelp();
  assert.match(output, /^## Memory help/);
  assert.match(output, /\/memory status/);
  assert.match(output, /\/memory activity/);
  assert.match(output, /\/memory last/);
  assert.match(output, /\/memory help/);
  assert.match(output, /Future commands such as \/memory delete and \/memory edit are not available in v1\.6\.1\./);
  assert.match(output, /does not call the LLM/);
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
