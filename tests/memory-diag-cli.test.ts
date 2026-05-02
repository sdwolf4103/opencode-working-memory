import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../scripts/memory-diag/cli.ts";

test("help returns usage without exiting", () => {
  const parsed = parseArgs(["--help"]);

  assert.equal(parsed.ok, true);
  assert.equal("help" in parsed && parsed.help, true);
  assert.match(parsed.usage, /Usage:/);
  assert.match(parsed.usage, /memory-diag \[status\]/);
  assert.doesNotMatch(parsed.usage, /health/);
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

test("current command flag validation messages are preserved", () => {
  const cases: Array<{ args: string[]; message: string }> = [
    { args: ["health", "--json", "--all"], message: "health --json does not support --all" },
    { args: ["quality", "--all"], message: "quality does not accept --all" },
    { args: ["coverage", "--all"], message: "coverage does not accept --all" },
    { args: ["disappearances", "--all"], message: "disappearances does not accept --all" },
    { args: ["rejections", "--all"], message: "rejections does not accept --all" },
    { args: ["audit", "--workspace", "/tmp/workspace"], message: "audit does not accept --all or --workspace" },
    { args: ["explain", "--all"], message: "explain does not accept --all" },
    { args: ["trace", "--all", "--memory", "mem-1"], message: "trace does not accept --all" },
    { args: ["quality", "--since", "forever"], message: "quality does not accept rejection filters" },
  ];

  for (const item of cases) {
    const parsed = parseArgs(item.args);
    assert.equal(parsed.ok, false, item.args.join(" "));
    if (parsed.ok) continue;
    assert.equal(parsed.message, item.message);
    assert.match(parsed.usage, /Usage:/);
  }
});

test("trace without memory returns current required id error", () => {
  const parsed = parseArgs(["trace"]);

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.message, "--memory requires an id");
  assert.match(parsed.usage, /Usage:/);
});

test("health with all and workspace returns current conflict error", () => {
  const parsed = parseArgs(["health", "--all", "--workspace", "/tmp/workspace"]);

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.message, "Use either --all or --workspace, not both");
  assert.match(parsed.usage, /Usage:/);
});

test("rejections invalid since value returns current error", () => {
  const parsed = parseArgs(["rejections", "--since", "forever"]);

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.message, "Invalid --since value: forever");
  assert.match(parsed.usage, /Usage:/);
});

test("legacy health alias emits deprecation notice and maps to status", () => {
  const parsed = parseArgs(["health"]);

  assert.equal(parsed.ok, true);
  assert.equal("command" in parsed && parsed.command, "status");
  assert.equal("options" in parsed && parsed.options.legacyCommand, "health");
  assert.equal("deprecationNotice" in parsed && parsed.deprecationNotice, "Note: 'health' is now 'status'. This alias will be removed in v2.0.");
});

test("legacy quality alias sets verbose and emits deprecation notice", () => {
  const parsed = parseArgs(["quality"]);

  assert.equal(parsed.ok, true);
  assert.equal("command" in parsed && parsed.command, "status");
  assert.equal("options" in parsed && parsed.options.verbose, true);
  assert.equal("options" in parsed && parsed.options.legacyCommand, "quality");
  assert.equal("deprecationNotice" in parsed && parsed.deprecationNotice, "Note: 'quality' is now 'status --verbose'. This alias will be removed in v2.0.");
});

test("legacy rejections alias emits deprecation notice", () => {
  const parsed = parseArgs(["rejections"]);

  assert.equal(parsed.ok, true);
  assert.equal("command" in parsed && parsed.command, "rejected");
  assert.equal("options" in parsed && parsed.options.legacyCommand, "rejections");
  assert.equal("deprecationNotice" in parsed && parsed.deprecationNotice, "Note: 'rejections' is now 'rejected'. This alias will be removed in v2.0.");
});

test("legacy disappearances alias emits deprecation notice", () => {
  const parsed = parseArgs(["disappearances"]);

  assert.equal(parsed.ok, true);
  assert.equal("command" in parsed && parsed.command, "missing");
  assert.equal("options" in parsed && parsed.options.legacyCommand, "disappearances");
  assert.equal("deprecationNotice" in parsed && parsed.deprecationNotice, "Note: 'disappearances' is now 'missing'. This alias will be removed in v2.0.");
});

test("legacy trace alias emits deprecation notice", () => {
  const parsed = parseArgs(["trace", "--memory", "mem-1"]);

  assert.equal(parsed.ok, true);
  assert.equal("command" in parsed && parsed.command, "explain");
  assert.equal("options" in parsed && parsed.options.legacyCommand, "trace");
  assert.equal("options" in parsed && parsed.options.memory, "mem-1");
  assert.equal("deprecationNotice" in parsed && parsed.deprecationNotice, "Note: 'trace --memory <id>' is now 'explain <memory-id>'. This alias will be removed in v2.0.");
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
