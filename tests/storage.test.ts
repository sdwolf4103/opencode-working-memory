import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { readJSON, updateJSON } from "../src/storage.ts";

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
