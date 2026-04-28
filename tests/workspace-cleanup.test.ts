import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyWorkspaceDir,
  cleanupWorkspaceResidues,
  scanWorkspaceResidues,
} from "../src/workspace-cleanup.ts";

async function writeWorkspaceStore(dataHome: string, key: string, root: string): Promise<string> {
  const workspaceDir = join(dataHome, "opencode-working-memory", "workspaces", key);
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    join(workspaceDir, "workspace-memory.json"),
    JSON.stringify({
      version: 1,
      workspace: { root, key },
      limits: { maxRenderedChars: 5200, maxEntries: 28 },
      entries: [],
      updatedAt: "2026-04-28T00:00:00.000Z",
    }, null, 2),
    "utf8",
  );
  return workspaceDir;
}

test("workspace cleanup classifies missing temp test roots as definite residue", async () => {
  const dataHome = await mkdtemp(join(tmpdir(), "wm-cleanup-data-"));
  try {
    const missingTempRoot = join(tmpdir(), "memory-plugin-test-missing-root");
    await rm(missingTempRoot, { recursive: true, force: true });
    const workspaceDir = await writeWorkspaceStore(dataHome, "definite", missingTempRoot);

    const result = await classifyWorkspaceDir(workspaceDir);

    assert.equal(result.classification, "test_temp_definite");
    assert.equal(result.rootExists, false);
    assert.ok(result.reasons.includes("root_missing"));
    assert.ok(result.reasons.some(reason => reason.startsWith("root_under_temp")));
    assert.ok(result.reasons.includes("test_prefix_memory-plugin-test"));
  } finally {
    await rm(dataHome, { recursive: true, force: true });
  }
});

test("workspace cleanup keeps existing temp roots live", async () => {
  const dataHome = await mkdtemp(join(tmpdir(), "wm-cleanup-data-"));
  const liveRoot = await mkdtemp(join(tmpdir(), "wm-quality-live-root-"));
  try {
    const workspaceDir = await writeWorkspaceStore(dataHome, "live", liveRoot);

    const result = await classifyWorkspaceDir(workspaceDir);

    assert.equal(result.classification, "live_or_existing");
    assert.equal(result.rootExists, true);
  } finally {
    await rm(dataHome, { recursive: true, force: true });
    await rm(liveRoot, { recursive: true, force: true });
  }
});

test("workspace cleanup reports missing non-temp roots as unknown orphans", async () => {
  const dataHome = await mkdtemp(join(tmpdir(), "wm-cleanup-data-"));
  try {
    const missingNonTempRoot = `/definitely-not-temp-opencode-working-memory-test-${Date.now()}`;
    const workspaceDir = await writeWorkspaceStore(dataHome, "orphan", missingNonTempRoot);

    const result = await classifyWorkspaceDir(workspaceDir);

    assert.equal(result.classification, "orphan_unknown");
    assert.equal(result.rootExists, false);
    assert.ok(result.reasons.includes("root_missing"));
  } finally {
    await rm(dataHome, { recursive: true, force: true });
  }
});

test("workspace cleanup reports invalid stores without moving them", async () => {
  const dataHome = await mkdtemp(join(tmpdir(), "wm-cleanup-data-"));
  try {
    const workspaceDir = join(dataHome, "opencode-working-memory", "workspaces", "invalid");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, "workspace-memory.json"), "{ invalid", "utf8");

    const result = await classifyWorkspaceDir(workspaceDir);

    assert.equal(result.classification, "invalid_or_unreadable");
    assert.ok(result.reasons.includes("invalid_json"));

    const cleanup = await cleanupWorkspaceResidues({ dataHome, mode: "quarantine" });
    assert.equal(cleanup.quarantined.length, 0);
    assert.equal(existsSync(workspaceDir), true);
  } finally {
    await rm(dataHome, { recursive: true, force: true });
  }
});

test("workspace cleanup dry-run scans definite residue without moving it", async () => {
  const dataHome = await mkdtemp(join(tmpdir(), "wm-cleanup-data-"));
  try {
    const missingTempRoot = join(tmpdir(), "wm-accounting-missing-root");
    await rm(missingTempRoot, { recursive: true, force: true });
    const workspaceDir = await writeWorkspaceStore(dataHome, "dryrun", missingTempRoot);

    const result = await cleanupWorkspaceResidues({ dataHome, minAgeMs: 0 });

    assert.equal(result.mode, "dry-run");
    assert.equal(result.candidates.length, 1);
    assert.equal(result.quarantined.length, 0);
    assert.equal(existsSync(workspaceDir), true);
  } finally {
    await rm(dataHome, { recursive: true, force: true });
  }
});

test("workspace cleanup quarantine moves definite residue and writes manifest", async () => {
  const dataHome = await mkdtemp(join(tmpdir(), "wm-cleanup-data-"));
  try {
    const missingTempRoot = join(tmpdir(), "wm-redact-missing-root");
    await rm(missingTempRoot, { recursive: true, force: true });
    const definiteDir = await writeWorkspaceStore(dataHome, "definite", missingTempRoot);
    const orphanDir = await writeWorkspaceStore(dataHome, "orphan", `/definitely-not-temp-opencode-working-memory-test-${Date.now()}`);

    const result = await cleanupWorkspaceResidues({
      dataHome,
      mode: "quarantine",
      minAgeMs: 0,
      now: new Date("2026-04-28T12:00:00.000Z"),
    });

    assert.equal(result.quarantined.length, 1);
    assert.equal(result.quarantined[0]?.workspaceKey, "definite");
    assert.equal(existsSync(definiteDir), false);
    assert.equal(existsSync(orphanDir), true);
    assert.ok(result.quarantineDir);
    assert.equal(existsSync(join(result.quarantineDir!, "workspaces", "definite", "workspace-memory.json")), true);

    const manifest = await readFile(join(result.quarantineDir!, "manifest.jsonl"), "utf8");
    const event = JSON.parse(manifest.trim());
    assert.equal(event.workspaceKey, "definite");
    assert.equal(event.classification, "test_temp_definite");
    assert.equal(event.root, missingTempRoot);
  } finally {
    await rm(dataHome, { recursive: true, force: true });
  }
});

test("workspace cleanup skips recently updated definite residue", async () => {
  const dataHome = await mkdtemp(join(tmpdir(), "wm-cleanup-data-"));
  try {
    const missingTempRoot = join(tmpdir(), "wm-extraction-missing-root");
    await rm(missingTempRoot, { recursive: true, force: true });
    const workspaceDir = await writeWorkspaceStore(dataHome, "recent", missingTempRoot);

    const stats = await stat(workspaceDir);
    const result = await scanWorkspaceResidues({
      dataHome,
      nowMs: stats.mtimeMs + 1_000,
      minAgeMs: 10 * 60 * 1_000,
    });

    assert.equal(result.candidates.length, 0);
    assert.equal(result.results.find(item => item.workspaceKey === "recent")?.classification, "test_temp_definite");
    assert.ok(result.results.find(item => item.workspaceKey === "recent")?.reasons.includes("recent_workspace_dir"));
  } finally {
    await rm(dataHome, { recursive: true, force: true });
  }
});
