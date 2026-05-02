import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../scripts/memory-diag/cli.ts";

test("help returns usage without exposing hidden or removed commands", () => {
  const parsed = parseArgs(["--help"]);

  assert.equal(parsed.ok, true);
  assert.equal("help" in parsed && parsed.help, true);
  assert.match(parsed.usage, /Usage:/);
  assert.match(parsed.usage, /memory-diag \[status\]/);
  for (const command of ["health", "quality", "rejections", "disappearances", "trace", "coverage", "audit"]) {
    assert.doesNotMatch(parsed.usage, new RegExp(command));
  }
});

test("status defaults when no subcommand", () => {
  const parsed = parseArgs([]);

  assert.equal(parsed.ok, true);
  assert.equal("command" in parsed && parsed.command, "status");
  assert.deepEqual("options" in parsed && parsed.options, { raw: false, positional: [] });
});

test("unknown command returns usage error", () => {
  const parsed = parseArgs(["unknown"]);

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.message, "Unknown subcommand: unknown");
  assert.equal(parsed.exitCode, 1);
  assert.match(parsed.usage, /Usage:/);
});

test("removed legacy aliases are ordinary unknown subcommands", () => {
  for (const command of ["health", "quality", "rejections", "disappearances", "trace"]) {
    const parsed = parseArgs([command]);

    assert.equal(parsed.ok, false, command);
    if (parsed.ok) continue;
    assert.equal(parsed.message, `Unknown subcommand: ${command}`);
    assert.match(parsed.usage, /Usage:/);
  }
});

test("hidden maintainer commands are accepted with neutral notices", () => {
  const coverage = parseArgs(["coverage"]);
  assert.equal(coverage.ok, true);
  assert.equal("command" in coverage && coverage.command, "coverage");
  assert.equal("deprecationNotice" in coverage && coverage.deprecationNotice, "Note: 'coverage' is a maintainer-only diagnostic and is not part of the public CLI surface.");

  const audit = parseArgs(["audit"]);
  assert.equal(audit.ok, true);
  assert.equal("command" in audit && audit.command, "audit");
  assert.equal("deprecationNotice" in audit && audit.deprecationNotice, "Note: 'audit' is a maintainer-only diagnostic and is not part of the public CLI surface.");
});

test("current command flag validation messages are preserved", () => {
  const cases: Array<{ args: string[]; message: string }> = [
    { args: ["status", "--all"], message: "status does not accept --all" },
    { args: ["coverage", "--all"], message: "coverage does not accept --all" },
    { args: ["missing", "--all"], message: "missing does not accept --all" },
    { args: ["rejected", "--all"], message: "rejected does not accept --all" },
    { args: ["audit", "--workspace", "/tmp/workspace"], message: "audit does not accept --all or --workspace" },
    { args: ["explain", "--all"], message: "explain does not accept --all" },
    { args: ["status", "--since", "forever"], message: "status does not accept rejection filters" },
    { args: ["status", "--reason", "bad_decision"], message: "status does not accept rejection filters" },
    { args: ["status", "--quality"], message: "Unknown option: --quality" },
    { args: ["rejected", "--unique"], message: "Unknown option: --unique" },
  ];

  for (const item of cases) {
    const parsed = parseArgs(item.args);
    assert.equal(parsed.ok, false, item.args.join(" "));
    if (parsed.ok) continue;
    assert.equal(parsed.message, item.message);
    assert.match(parsed.usage, /Usage:/);
  }
});

test("rejected invalid since value returns current error", () => {
  const parsed = parseArgs(["rejected", "--since", "forever"]);

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.message, "Invalid --since value: forever");
  assert.match(parsed.usage, /Usage:/);
});

test("explain accepts positional memory id", () => {
  const parsed = parseArgs(["explain", "mem-1", "--workspace", "/tmp/workspace"]);

  assert.equal(parsed.ok, true);
  assert.equal("command" in parsed && parsed.command, "explain");
  assert.equal("options" in parsed && parsed.options.memory, "mem-1");
  assert.deepEqual("options" in parsed && parsed.options.positional, ["mem-1"]);
});

test("explain with both positional and memory flag errors", () => {
  const parsed = parseArgs(["explain", "mem-1", "--memory", "mem-2"]);

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.message, "Use either explain <memory-id> or --memory, not both");
});
