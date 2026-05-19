import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { atomicWriteJSON, readJSON, updateJSON } from "../src/storage.ts";
import { queryEvidenceEvents } from "../src/evidence-log.ts";
import { workspaceMemoryPath } from "../src/paths.ts";

test("updateJSON serializes concurrent increments", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-storage-"));
  try {
    const path = join(root, "counter.json");
    await Promise.all(Array.from({ length: 25 }, () =>
      updateJSON(path, () => ({ count: 0 }), current => ({ count: current.count + 1 })),
    ));

    const final = await updateJSON(path, () => ({ count: 0 }), current => current);
    assert.equal(final.count, 25);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomicWriteJSON is a full-state overwrite primitive", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-storage-atomic-overwrite-"));
  try {
    const path = join(root, "store.json");

    await atomicWriteJSON(path, { retained: true, removed: true });
    await atomicWriteJSON(path, { retained: true });

    const raw = await readFile(path, "utf8");
    assert.deepEqual(JSON.parse(raw), { retained: true });
    assert.equal(raw.includes("removed"), false, "atomic overwrite should not merge with previous state");
    assert.equal(existsSync(`${path}.lock`), false, "atomic overwrite should not create the RMW lock file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateJSON does not replace corrupt JSON with fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-storage-corrupt-"));
  try {
    const path = join(root, "bad.json");
    await writeFile(path, "{not json", "utf8");

    await assert.rejects(
      updateJSON(path, () => ({ ok: true }), current => current),
      /Invalid JSON/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readJSON quarantines corrupt JSON and returns fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wm-storage-corrupt-"));
  const path = join(dir, "store.json");

  try {
    await writeFile(path, "{ invalid json", "utf8");

    const loaded = await readJSON(path, () => ({ ok: true }));

    assert.deepEqual(loaded, { ok: true });

    const files = await readdir(dir);
    assert.equal(files.includes("store.json"), false);
    assert.equal(files.some(file => file.startsWith("store.json.corrupt-")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readJSON emits corrupt JSON quarantine evidence for workspace stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-storage-evidence-corrupt-"));
  try {
    const path = await workspaceMemoryPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ invalid json", "utf8");

    const loaded = await readJSON(path, () => ({ ok: true }));
    const events = await queryEvidenceEvents(root, { types: ["storage_corrupt_json_quarantined"] });

    assert.deepEqual(loaded, { ok: true });
    assert.equal(events.length, 1);
    assert.equal(events[0].reasonCodes.includes("invalid_json"), true);
    assert.equal(JSON.stringify(events).includes("invalid json"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateJSON recovers stale lock files left by crashed process", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-storage-stale-lock-"));
  try {
    const path = join(root, "locked.json");
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, `999999\n0\n`, "utf8");

    const updated = await updateJSON(path, () => ({ count: 0 }), current => ({ count: current.count + 1 }));
    assert.equal(updated.count, 1);
    assert.equal(existsSync(lockPath), false, "stale lock file should be removed after update");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateJSON emits stale lock recovery evidence for workspace stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-storage-evidence-stale-lock-"));
  try {
    const path = await workspaceMemoryPath(root);
    const lockPath = `${path}.lock`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(lockPath, `999999\n0\n`, "utf8");

    await updateJSON(path, () => ({ count: 0 }), current => ({ count: current.count + 1 }));
    const events = await queryEvidenceEvents(root, { types: ["storage_stale_lock_recovered"] });

    assert.equal(events.length, 1);
    assert.equal(events[0].reasonCodes.includes("stale_lock"), true);
    assert.equal(JSON.stringify(events).includes("999999"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateJSON emits lock timeout evidence and still throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-storage-evidence-timeout-"));
  try {
    const path = await workspaceMemoryPath(root);
    const lockPath = `${path}.lock`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(lockPath, `${process.pid}\n${Date.now()}\n`, "utf8");

    await assert.rejects(
      updateJSON(path, () => ({ count: 0 }), current => current),
      /Timed out waiting for lock/,
    );
    const events = await queryEvidenceEvents(root, { types: ["storage_lock_timeout"] });

    assert.equal(events.length, 1);
    assert.equal(events[0].reasonCodes.includes("lock_wait_timeout"), true);
    assert.equal(JSON.stringify(events).includes(String(process.pid)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateJSON serializes writes across separate node processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-storage-xproc-"));
  try {
    const path = join(root, "counter.json");
    const worker = `
      import { updateJSON } from ${JSON.stringify(new URL("../src/storage.ts", import.meta.url).href)};
      const path = process.argv[1];
      await Promise.all(Array.from({ length: 20 }, () => updateJSON(path, () => ({ count: 0 }), async current => {
        await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 5)));
        return { count: current.count + 1 };
      })));
    `;

    await Promise.all(Array.from({ length: 5 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", worker, path],
        { stdio: "inherit" },
      );
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
      child.on("error", reject);
    })));

    const final = await updateJSON(path, () => ({ count: 0 }), current => current);
    assert.equal(final.count, 100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateJSON waits for a live cross-process lock and preserves both updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-storage-live-lock-"));
  try {
    const path = join(root, "counter.json");
    const worker = `
      import { updateJSON } from ${JSON.stringify(new URL("../src/storage.ts", import.meta.url).href)};
      const path = process.argv[1];
      await updateJSON(path, () => ({ count: 0, order: [] }), async current => {
        await new Promise(resolve => setTimeout(resolve, 250));
        return { count: current.count + 1, order: [...current.order, "child"] };
      });
    `;

    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", worker, path],
      { stdio: "inherit" },
    );

    await new Promise(resolve => setTimeout(resolve, 50));

    await updateJSON(path, () => ({ count: 0, order: [] as string[] }), current => ({
      count: current.count + 1,
      order: [...current.order, "parent"],
    }));

    await new Promise<void>((resolve, reject) => {
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
      child.on("error", reject);
    });

    const final = await updateJSON(path, () => ({ count: 0, order: [] as string[] }), current => current);
    assert.equal(final.count, 2);
    assert.deepEqual(new Set(final.order), new Set(["child", "parent"]));
    assert.equal(existsSync(`${path}.lock`), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
