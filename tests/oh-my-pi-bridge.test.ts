import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { syncOhMyPiBridge } from "../src/oh-my-pi-bridge.ts";
import { loadWorkspaceMemory, updateWorkspaceMemory } from "../src/workspace-memory.ts";

function encodeProjectPath(workspace: string): string {
  const resolved = resolve(workspace);
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

async function withBridgeWorkspace<T>(
  fn: (paths: { workspace: string; home: string; memoryDir: string; learnedPath: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "memory-oh-my-pi-bridge-test-"));
  const workspace = join(root, "workspace");
  const home = join(root, "omp-home");
  const agentDir = join(home, "agent");
  const memoryDir = join(agentDir, "memories", encodeProjectPath(workspace));
  const learnedPath = join(memoryDir, "learned.md");
  await mkdir(workspace, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  try {
    return await fn({ workspace, home, memoryDir, learnedPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedMemory(workspace: string): Promise<void> {
  const now = new Date().toISOString();
  await updateWorkspaceMemory(workspace, store => {
    store.entries.push(
      {
        id: "mem_omp_one",
        type: "project",
        text: "OpenCode project fact one.",
        source: "manual",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "mem_omp_two",
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

test("bridge exports OpenCode memories into learned.md without touching oh-my-pi content", async () => {
  await withBridgeWorkspace(async ({ workspace, home, memoryDir, learnedPath }) => {
    await mkdir(memoryDir, { recursive: true });
    const original = [
      "# Lessons",
      "",
      "Some hand-written prose.",
      "",
      "- Use pnpm for this repo. _(context: user preference)_",
      "",
    ].join("\n");
    await writeFile(learnedPath, original, "utf8");
    await writeFile(join(memoryDir, "memory_summary.md"), "oh-my-pi summary stays put.\n", "utf8");
    await seedMemory(workspace);

    const result = await syncOhMyPiBridge(workspace, { homeDir: home });
    assert.equal(result.imported, 1);
    assert.equal(result.exported, 2);
    assert.equal(result.projectDir, memoryDir);

    const store = await loadWorkspaceMemory(workspace);
    assert.ok(store.entries.some(entry => entry.text === "Use pnpm for this repo."));

    const content = await readFile(learnedPath, "utf8");
    assert.match(content, /# Lessons/);
    assert.match(content, /Some hand-written prose\./);
    assert.match(content, /- Use pnpm for this repo\. _\(context: user preference\)_/);
    assert.match(content, /- \[opencode:mem_omp_one\] OpenCode project fact one\./);
    assert.match(content, /- \[opencode:mem_omp_two\] OpenCode feedback fact two\./);

    const proseIndex = content.indexOf("Some hand-written prose.");
    const existingLessonIndex = content.indexOf("- Use pnpm for this repo.");
    const exportedIndex = content.indexOf("- [opencode:mem_omp_one]");
    assert.ok(proseIndex < exportedIndex);
    assert.ok(exportedIndex < existingLessonIndex);

    const summary = await readFile(join(memoryDir, "memory_summary.md"), "utf8");
    assert.equal(summary, "oh-my-pi summary stays put.\n");
  });
});

test("bridge imports edits made to an OpenCode-owned lesson line", async () => {
  await withBridgeWorkspace(async ({ workspace, home, learnedPath }) => {
    await seedMemory(workspace);
    await syncOhMyPiBridge(workspace, { homeDir: home });

    const original = await readFile(learnedPath, "utf8");
    await writeFile(
      learnedPath,
      original.replace("OpenCode project fact one.", "Edited by oh-my-pi."),
      "utf8",
    );

    const result = await syncOhMyPiBridge(workspace, { homeDir: home });
    assert.equal(result.changed, true);
    assert.equal(result.imported, 1);

    const store = await loadWorkspaceMemory(workspace);
    const entry = store.entries.find(item => item.id === "mem_omp_one");
    assert.equal(entry?.text, "Edited by oh-my-pi.");
    assert.equal(entry?.tags?.includes("omp-edited"), true);

    const content = await readFile(learnedPath, "utf8");
    assert.match(content, /- \[opencode:mem_omp_one\] Edited by oh-my-pi\./);
  });
});

test("bridge supersedes an entry when its lesson line is deleted", async () => {
  await withBridgeWorkspace(async ({ workspace, home, learnedPath }) => {
    await seedMemory(workspace);
    await syncOhMyPiBridge(workspace, { homeDir: home });

    const original = await readFile(learnedPath, "utf8");
    const next = original
      .split("\n")
      .filter(line => !line.startsWith("- [opencode:mem_omp_one]"))
      .join("\n");
    await writeFile(learnedPath, next, "utf8");

    const result = await syncOhMyPiBridge(workspace, { homeDir: home });
    assert.equal(result.changed, true);

    const store = await loadWorkspaceMemory(workspace);
    const entry = store.entries.find(item => item.id === "mem_omp_one");
    assert.equal(entry?.status, "superseded");

    const content = await readFile(learnedPath, "utf8");
    assert.doesNotMatch(content, /\[opencode:mem_omp_one\]/);
  });
});

test("bridge imports oh-my-pi lessons and indexes them in the prompt", async () => {
  await withBridgeWorkspace(async ({ workspace, home, memoryDir, learnedPath }) => {
    await mkdir(memoryDir, { recursive: true });
    await writeFile(learnedPath, [
      "- Deploy only through the staging gateway. _(context: production rule)_",
      "- Prefer small, reviewable commits.",
      "",
    ].join("\n"), "utf8");

    const result = await syncOhMyPiBridge(workspace, { homeDir: home });
    assert.equal(result.changed, true);
    assert.equal(result.imported, 2);
    assert.match(result.indexPrompt, /Shared oh-my-pi memory/);
    assert.match(result.indexPrompt, /Deploy only through the staging gateway/);
    assert.match(result.indexPrompt, /memory_summary|learned\.md/);

    const store = await loadWorkspaceMemory(workspace);
    const deploy = store.entries.find(entry => entry.text === "Deploy only through the staging gateway.");
    const commits = store.entries.find(entry => entry.text === "Prefer small, reviewable commits.");
    assert.ok(deploy);
    assert.equal(deploy?.rationale, "production rule");
    assert.equal(deploy?.type, "project");
    assert.deepEqual(deploy?.tags?.slice(0, 2), ["omp", "shared"]);
    assert.equal(commits?.type, "feedback");

    const second = await syncOhMyPiBridge(workspace, { homeDir: home });
    assert.equal(second.imported, 0);
    const after = await loadWorkspaceMemory(workspace);
    assert.equal(after.entries.filter(entry => entry.id.startsWith("omp_")).length, 2);
  });
});

test("bridge mirrors oh-my-pi lesson deletion and re-addition", async () => {
  await withBridgeWorkspace(async ({ workspace, home, memoryDir, learnedPath }) => {
    await mkdir(memoryDir, { recursive: true });
    const lesson = "- Mirror-safe deploys use the staging gateway.";
    await writeFile(learnedPath, `${lesson}\n`, "utf8");

    await syncOhMyPiBridge(workspace, { homeDir: home });
    let store = await loadWorkspaceMemory(workspace);
    const entry = store.entries.find(item => item.text === "Mirror-safe deploys use the staging gateway.");
    assert.ok(entry);
    assert.equal(entry?.status, "active");

    await writeFile(learnedPath, "", "utf8");
    const removed = await syncOhMyPiBridge(workspace, { homeDir: home });
    assert.equal(removed.changed, true);
    store = await loadWorkspaceMemory(workspace);
    assert.equal(store.entries.find(item => item.id === entry?.id)?.status, "superseded");

    await writeFile(learnedPath, `${lesson}\n`, "utf8");
    const restored = await syncOhMyPiBridge(workspace, { homeDir: home });
    assert.equal(restored.changed, true);
    store = await loadWorkspaceMemory(workspace);
    assert.equal(store.entries.find(item => item.id === entry?.id)?.status, "active");
  });
});

test("bridge skips sensitive oh-my-pi lessons unless includeSensitive is enabled", async () => {
  await withBridgeWorkspace(async ({ workspace, home, memoryDir, learnedPath }) => {
    await mkdir(memoryDir, { recursive: true });
    await writeFile(learnedPath, "- The VPS root password lives in the vault.\n", "utf8");

    const safe = await syncOhMyPiBridge(workspace, { homeDir: home });
    assert.equal(safe.imported, 0);
    assert.doesNotMatch(safe.indexPrompt, /VPS root password/);

    const unsafe = await syncOhMyPiBridge(workspace, { homeDir: home, includeSensitive: true });
    assert.equal(unsafe.imported, 1);
    assert.match(unsafe.indexPrompt, /VPS root password/);
  });
});

test("bridge is idempotent and recreates a missing learned.md", async () => {
  await withBridgeWorkspace(async ({ workspace, home, learnedPath }) => {
    await seedMemory(workspace);

    const first = await syncOhMyPiBridge(workspace, { homeDir: home });
    assert.equal(first.exported, 2);
    const content = await readFile(learnedPath, "utf8");

    const second = await syncOhMyPiBridge(workspace, { homeDir: home });
    assert.equal(second.changed, false);
    assert.equal(second.exported, 2);
    assert.equal(await readFile(learnedPath, "utf8"), content);

    await rm(learnedPath, { force: true });
    const third = await syncOhMyPiBridge(workspace, { homeDir: home });
    assert.equal(third.changed, false);
    assert.equal(third.exported, 2);
    assert.equal(await readFile(learnedPath, "utf8"), content);
  });
});

test("bridge leaves oh-my-pi alone when its home directory is absent", async () => {
  await withBridgeWorkspace(async ({ workspace, home }) => {
    await seedMemory(workspace);
    await rm(home, { recursive: true, force: true });

    const result = await syncOhMyPiBridge(workspace, { homeDir: home });
    assert.equal(result.changed, false);
    assert.equal(result.exported, 0);
    assert.equal(result.indexPrompt, "");
  });
});
