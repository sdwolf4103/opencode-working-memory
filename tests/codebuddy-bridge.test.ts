import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { syncCodeBuddyBridge } from "../src/codebuddy-bridge.ts";
import { loadWorkspaceMemory, updateWorkspaceMemory } from "../src/workspace-memory.ts";

function compressed(path: string): string {
  return resolve(path)
    .replace(/[/\\:]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/-+/g, "-");
}

async function withBridgeWorkspace<T>(
  fn: (paths: { workspace: string; home: string; memoryDir: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "memory-codebuddy-bridge-test-"));
  const workspace = join(root, "workspace");
  const home = join(root, "codebuddy-home");
  const memoryDir = join(home, "projects", compressed(workspace), "memory");
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  try {
    return await fn({ workspace, home, memoryDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedMemory(workspace: string): Promise<void> {
  const now = new Date().toISOString();
  await updateWorkspaceMemory(workspace, store => {
    store.entries.push(
      {
        id: "mem_bridge_one",
        type: "project",
        text: "OpenCode project fact one.",
        source: "manual",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "mem_bridge_two",
        type: "feedback",
        text: "OpenCode feedback fact two.",
        source: "manual",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    );
    return store;
  });
}

test("bridge exports OpenCode memories as CodeBuddy markdown and maintains an index block", async () => {
  await withBridgeWorkspace(async ({ workspace, home, memoryDir }) => {
    await seedMemory(workspace);

    const first = await syncCodeBuddyBridge(workspace, { homeDir: home });
    assert.equal(first.imported, 0);
    assert.equal(first.exported, 2);

    const projectFact = await readFile(join(memoryDir, "opencode-mem_bridge_one.md"), "utf8");
    assert.match(projectFact, /^---\n/);
    assert.match(projectFact, /name: "OpenCode: OpenCode project fact one\."/);
    assert.match(projectFact, /type: project/);
    assert.match(projectFact, /opencode_id: mem_bridge_one/);
    assert.match(projectFact, /OpenCode project fact one\./);

    const feedbackFact = await readFile(join(memoryDir, "opencode-mem_bridge_two.md"), "utf8");
    assert.match(feedbackFact, /type: feedback/);

    const index = await readFile(join(memoryDir, "MEMORY.md"), "utf8");
    assert.match(index, /<!-- opencode-working-memory:start -->/);
    assert.match(index, /OpenCode project fact one\./);
    assert.match(index, /\[project\]/);
  });
});

test("bridge imports edits made to an OpenCode-owned markdown file", async () => {
  await withBridgeWorkspace(async ({ workspace, home, memoryDir }) => {
    await seedMemory(workspace);
    await syncCodeBuddyBridge(workspace, { homeDir: home });

    const path = join(memoryDir, "opencode-mem_bridge_one.md");
    const original = await readFile(path, "utf8");
    await writeFile(
      path,
      original.replace(/\nOpenCode project fact one\.\n/, "\nEdited by CodeBuddy.\n"),
      "utf8",
    );

    const result = await syncCodeBuddyBridge(workspace, { homeDir: home });
    assert.equal(result.changed, true);
    assert.equal(result.imported, 1);

    const store = await loadWorkspaceMemory(workspace);
    const entry = store.entries.find(item => item.id === "mem_bridge_one");
    assert.equal(entry?.text, "Edited by CodeBuddy.");
    assert.equal(entry?.tags?.includes("codebuddy-edited"), true);
  });
});

test("bridge imports CodeBuddy-owned files marked shared", async () => {
  await withBridgeWorkspace(async ({ workspace, home, memoryDir }) => {
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, "shared_fact.md"), [
      "---",
      "name: Shared CodeBuddy fact",
      "description: A fact shared with OpenCode",
      "type: project",
      "shared: true",
      "---",
      "",
      "CodeBuddy shared memory body.",
      "",
    ].join("\n"), "utf8");

    const result = await syncCodeBuddyBridge(workspace, { homeDir: home });
    assert.equal(result.changed, true);
    assert.equal(result.imported, 1);

    const store = await loadWorkspaceMemory(workspace);
    const entry = store.entries.find(item => item.text === "CodeBuddy shared memory body.");
    assert.ok(entry);
    assert.equal(entry?.type, "project");
    assert.equal(entry?.tags?.includes("cb:project:shared_fact.md"), true);
  });
});

test("bridge index excludes OpenCode exports and includes CodeBuddy entries", async () => {
  await withBridgeWorkspace(async ({ workspace, home, memoryDir }) => {
    await seedMemory(workspace);
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, "codebuddy_topic.md"), [
      "---",
      "name: CodeBuddy topic",
      "description: Indexed topic description",
      "type: reference",
      "---",
      "",
      "Topic body.",
      "",
    ].join("\n"), "utf8");

    const result = await syncCodeBuddyBridge(workspace, { homeDir: home });
    assert.match(result.indexPrompt, /Shared CodeBuddy memory/);
    assert.match(result.indexPrompt, /CodeBuddy topic/);
    assert.match(result.indexPrompt, /Indexed topic description/);
    assert.doesNotMatch(result.indexPrompt, /OpenCode project fact one/);
  });
});

test("bridge is idempotent when nothing changed", async () => {
  await withBridgeWorkspace(async ({ workspace, home }) => {
    await seedMemory(workspace);
    await syncCodeBuddyBridge(workspace, { homeDir: home });

    const before = await loadWorkspaceMemory(workspace);
    const second = await syncCodeBuddyBridge(workspace, { homeDir: home });
    const after = await loadWorkspaceMemory(workspace);

    assert.equal(second.changed, false);
    assert.equal(second.imported, 0);
    assert.deepEqual(after.entries, before.entries);
  });
});

test("bridge skips sensitive files unless includeSensitive is enabled", async () => {
  await withBridgeWorkspace(async ({ workspace, home, memoryDir }) => {
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, "vps_access.md"), [
      "---",
      "name: VPS access",
      "description: Server access details",
      "type: reference",
      "---",
      "",
      "host and credentials",
      "",
    ].join("\n"), "utf8");

    const safe = await syncCodeBuddyBridge(workspace, { homeDir: home });
    assert.doesNotMatch(safe.indexPrompt, /VPS access/);

    const unsafe = await syncCodeBuddyBridge(workspace, { homeDir: home, includeSensitive: true });
    assert.match(unsafe.indexPrompt, /VPS access/);
  });
});

test("bridge supersedes an entry when its OpenCode markdown file is deleted", async () => {
  await withBridgeWorkspace(async ({ workspace, home, memoryDir }) => {
    await seedMemory(workspace);
    await syncCodeBuddyBridge(workspace, { homeDir: home });

    await rm(join(memoryDir, "opencode-mem_bridge_one.md"), { force: true });
    const result = await syncCodeBuddyBridge(workspace, { homeDir: home });
    assert.equal(result.changed, true);

    const store = await loadWorkspaceMemory(workspace);
    const entry = store.entries.find(item => item.id === "mem_bridge_one");
    assert.equal(entry?.status, "superseded");
  });
});
