import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

test("packed memory-diag bin runs from a temp consumer project", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencode-memory-diag-packaging-"));
  const packDir = join(tempRoot, "pack");
  const consumerDir = join(tempRoot, "consumer");

  try {
    await mkdir(packDir, { recursive: true });
    await mkdir(consumerDir, { recursive: true });

    const packResult = await execFileAsync(executable("npm"), [
      "pack",
      repoRoot,
      "--pack-destination",
      packDir,
      "--silent",
    ], { cwd: tempRoot, maxBuffer });
    const tarballName = packResult.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    assert.ok(tarballName, `npm pack did not report a tarball name. stdout:\n${packResult.stdout}\nstderr:\n${packResult.stderr}`);

    const tarballPath = join(packDir, tarballName);
    const runResult = await execFileAsync(executable("npx"), [
      "--yes",
      "--package",
      tarballPath,
      "memory-diag",
      "--help",
    ], { cwd: consumerDir, maxBuffer });

    assert.match(runResult.stdout, /Usage:/);
    assert.match(runResult.stdout, /memory-diag \[status\]/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
