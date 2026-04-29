import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "../src/types.ts";
import { LONG_TERM_LIMITS } from "../src/types.ts";
import { workspaceKey, workspaceMemoryPath } from "../src/paths.ts";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function entry(id: string, text: string, type: LongTermMemoryEntry["type"]): LongTermMemoryEntry {
  const now = new Date().toISOString();
  return {
    id,
    type,
    text,
    source: "compaction",
    confidence: 0.75,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

async function writeWorkspaceStore(root: string, entries: LongTermMemoryEntry[], options: { lastActivityAt?: string; omitLastActivityAt?: boolean } = {}): Promise<void> {
  const key = await workspaceKey(root);
  const path = await workspaceMemoryPath(root);
  const now = new Date().toISOString();
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root, key },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    entries,
    migrations: [],
    updatedAt: now,
  };
  if (!options.omitLastActivityAt) store.lastActivityAt = options.lastActivityAt ?? now;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2), "utf8");
}

async function runMemoryDiagHealth(root: string): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [
    "--experimental-strip-types",
    "scripts/memory-diag.ts",
    "health",
    "--workspace",
    root,
  ], { cwd: repoRoot });

  return stdout;
}

test("memory health reports stored vs rendered retention counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-"));
  try {
    const entries: LongTermMemoryEntry[] = [
      ...Array.from({ length: 17 }, (_, i) => entry(`feedback-${i}`, `Unique feedback preference for memory health ${i}`, "feedback")),
      ...Array.from({ length: 11 }, (_, i) => entry(`decision-${i}`, `Unique durable decision for memory health ${i}`, "decision")),
    ];
    await writeWorkspaceStore(root, entries);

    const stdout = await runMemoryDiagHealth(root);

    assert.match(stdout, /Stored active memories:/);
    assert.match(stdout, /Rendered candidates:/);
    assert.match(stdout, /feedback\s+stored=17\s+rendered=10/);
    assert.match(stdout, /Top rendered candidates:\n\s+- strength=/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory health reports dormancy and retention monitoring alerts", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-"));
  try {
    const lastActivityAt = new Date(Date.now() - 19 * 24 * 60 * 60 * 1000).toISOString();
    const entries = Array.from({ length: 10 }, (_, i) => ({
      ...entry(`monitoring-${i}`, `Unique monitoring memory ${i} for retention health`, i % 2 === 0 ? "feedback" : "decision"),
      userImportance: i < 4 ? "high" as const : "normal" as const,
      safetyCritical: i < 6,
      reinforcementCount: i < 2 ? 6 : 0,
    }));
    await writeWorkspaceStore(root, entries, { lastActivityAt });

    const stdout = await runMemoryDiagHealth(root);

    assert.match(stdout, /Dormancy:/);
    assert.match(stdout, /wall days since activity: 19\.0/);
    assert.match(stdout, /dormant discount active: yes/);
    assert.match(stdout, /dormant days past grace: 5\.0/);
    assert.match(stdout, /high_importance_ratio: 40\.0% .* ALERT/);
    assert.match(stdout, /safety_critical_count: 6 .* ALERT/);
    assert.match(stdout, /max_reinforced_count: 2 \(20\.0%, alert > 10%\) ALERT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory health reports global cap overflow separately from type caps", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-"));
  try {
    const entries: LongTermMemoryEntry[] = [
      ...Array.from({ length: 10 }, (_, i) => entry(`global-feedback-${i}`, `Unique global feedback preference ${i}`, "feedback")),
      ...Array.from({ length: 10 }, (_, i) => entry(`global-decision-${i}`, `Unique global durable decision ${i}`, "decision")),
      ...Array.from({ length: 8 }, (_, i) => entry(`global-project-${i}`, `Unique global project fact ${i}`, "project")),
      ...Array.from({ length: 6 }, (_, i) => entry(`global-reference-${i}`, `Unique global reference fact ${i}`, "reference")),
    ];
    await writeWorkspaceStore(root, entries);

    const stdout = await runMemoryDiagHealth(root);

    assert.match(stdout, /Rendered candidates: 28/);
    assert.match(stdout, /type-capped entries: 0/);
    assert.match(stdout, /global-cap overflow: 6/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory health reports missing dormancy and non-alert monitoring defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-"));
  try {
    await writeWorkspaceStore(root, [], { omitLastActivityAt: true });

    const stdout = await runMemoryDiagHealth(root);

    assert.match(stdout, /lastActivityAt: \(missing\)/);
    assert.match(stdout, /wall days since activity: unknown/);
    assert.match(stdout, /dormant discount active: no/);
    assert.match(stdout, /high_importance_ratio: 0\.0% \(alert > 30%\)\n/);
    assert.match(stdout, /safety_critical_count: 0 \(alert > 5\)\n/);
    assert.match(stdout, /max_reinforced_count: 0 \(alert > 10% active\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
