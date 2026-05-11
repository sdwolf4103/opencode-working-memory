#!/usr/bin/env node
const { execFileSync } = require("child_process");
const { existsSync } = require("fs");
const path = require("path");

function isSupportedNodeVersion(version) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(part => Number(part));
  void patch;
  return major > 22 || (major === 22 && minor >= 6);
}

if (!isSupportedNodeVersion(process.versions.node)) {
  process.stderr.write(`memory-diag requires Node >=22.6.0 per opencode-working-memory package engines. Current Node: v${process.versions.node}.\n`);
  process.exit(1);
}

const binDir = __dirname;
const compiledScript = path.join(binDir, "..", "dist", "scripts", "memory-diag.js");

if (!existsSync(compiledScript)) {
  process.stderr.write("memory-diag package is missing dist/scripts/memory-diag.js. Reinstall opencode-working-memory or run npm run build before using the local package.\n");
  process.exit(1);
}

const args = [compiledScript, ...process.argv.slice(2)];
try {
  execFileSync(process.execPath, args, { stdio: "inherit" });
  process.exit(0);
} catch (e) {
  process.exit(e.status || 1);
}
