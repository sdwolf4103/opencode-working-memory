import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const maxBuffer = 10 * 1024 * 1024;

function executable(name: "npm" | "npx"): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function binPath(root: string, name: string): string {
  return join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

test("packed memory-diag bin runs from a temp consumer project", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencode-memory-diag-packaging-"));
  const packDir = join(tempRoot, "pack");
  const consumerDir = join(tempRoot, "consumer");
  const cacheDir = join(tempRoot, "npm-cache");

  try {
    await mkdir(packDir, { recursive: true });
    await mkdir(consumerDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });

    const packResult = await execFileAsync(executable("npm"), [
      "pack",
      repoRoot,
      "--cache",
      cacheDir,
      "--pack-destination",
      packDir,
      "--silent",
    ], { cwd: tempRoot, maxBuffer });
    const tarballName = packResult.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    assert.ok(tarballName, `npm pack did not report a tarball name. stdout:\n${packResult.stdout}\nstderr:\n${packResult.stderr}`);

    const tarballPath = join(packDir, tarballName);
    await execFileAsync(executable("npm"), [
      "install",
      "--cache",
      cacheDir,
      tarballPath,
      "--legacy-peer-deps",
      "--prefix",
      consumerDir,
      "--silent",
    ], { cwd: tempRoot, maxBuffer });

    const runResult = await execFileAsync(binPath(consumerDir, "memory-diag"), [
      "--help",
    ], { cwd: consumerDir, maxBuffer });

    assert.match(runResult.stdout, /Usage:/);
    assert.match(runResult.stdout, /memory-diag \[status\]/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("packed plugin runtime imports from node_modules JavaScript entries", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencode-working-memory-packaging-"));
  const packDir = join(tempRoot, "pack");
  const consumerDir = join(tempRoot, "consumer");
  const cacheDir = join(tempRoot, "npm-cache");

  try {
    await mkdir(packDir, { recursive: true });
    await mkdir(consumerDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });

    const packResult = await execFileAsync(executable("npm"), [
      "pack",
      repoRoot,
      "--cache",
      cacheDir,
      "--pack-destination",
      packDir,
      "--silent",
    ], { cwd: tempRoot, maxBuffer });
    const tarballName = packResult.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    assert.ok(tarballName, `npm pack did not report a tarball name. stdout:\n${packResult.stdout}\nstderr:\n${packResult.stderr}`);

    const tarballPath = join(packDir, tarballName);
    await execFileAsync(executable("npm"), [
      "install",
      "--cache",
      cacheDir,
      "--prefix",
      consumerDir,
      tarballPath,
      "--legacy-peer-deps",
      "--silent",
    ], { cwd: tempRoot, maxBuffer });

    const packageJsonPath = join(consumerDir, "node_modules", "opencode-working-memory", "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      main?: unknown;
      exports?: Record<string, unknown>;
    };

    assert.equal(packageJson.main, "dist/index.js");
    assert.equal(packageJson.exports?.["."], "./dist/index.js");
    assert.equal(packageJson.exports?.["./server"], "./dist/index.js");
    assert.equal(packageJson.exports?.["./tui"], "./dist/src/tui-plugin.js");

    const importResult = await execFileAsync(process.execPath, [
      "-e",
      [
        "const plugin = await import('opencode-working-memory');",
        "const server = await import('opencode-working-memory/server');",
        "const tui = await import('opencode-working-memory/tui');",
        "console.log([plugin.default.id, server.default.id, tui.default.id].join('\\n'));",
      ].join(" "),
    ], { cwd: consumerDir, maxBuffer });

    assert.deepEqual(importResult.stdout.trim().split(/\r?\n/), [
      "working-memory",
      "working-memory",
      "working-memory-tui",
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
