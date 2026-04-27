import test from "node:test";
import assert from "node:assert/strict";
import { parseWorkspaceMemoryCandidates } from "../src/extractors.ts";

const acceptedCases = [
  {
    name: "durable user language preference",
    line: "- [feedback] User prefers architecture reviews in Traditional Chinese",
    expectedType: "feedback",
    expectedText: /Traditional Chinese/,
  },
  {
    name: "stable cache architecture decision",
    line: "- [decision] Use frozen workspace memory snapshots plus ephemeral hot state for cache stability",
    expectedType: "decision",
    expectedText: /frozen workspace memory/,
  },
  {
    name: "stable zero API call constraint",
    line: "- [project] The plugin piggybacks memory extraction on OpenCode compaction and should not add extra LLM calls",
    expectedType: "project",
    expectedText: /extra LLM calls/,
  },
  {
    name: "hard to rediscover reference",
    line: "- [reference] Workspace memory uses a frozen system[1] snapshot and pending memories remain in hot session state until compaction",
    expectedType: "reference",
    expectedText: /system\[1\]/,
  },
  {
    name: "short stable config reference",
    line: "- [reference] Config parser supports bracketless format",
    expectedType: "reference",
    expectedText: /bracketless/,
  },
] as const;

const rejectedCases = [
  {
    name: "test count snapshot",
    line: "- [project] 42 tests passed after the latest implementation",
  },
  {
    name: "suite count snapshot",
    line: "- [project] 3 suites pass and 0 suites fail right now",
  },
  {
    name: "phase progress snapshot",
    line: "- [project] Wave 2 completed successfully",
  },
  {
    name: "commit hash",
    line: "- [reference] Commit 4309cb8 contains the promotion accounting fix",
  },
  {
    name: "raw transient error",
    line: "- [feedback] TypeError: Cannot read properties of undefined",
  },
  {
    name: "path heavy rediscoverable fact",
    line: "- [project] Important files are /src/plugin.ts /src/workspace-memory.ts /src/session-state.ts",
  },
  {
    name: "temporary pending task",
    line: "- [decision] currently: run npm test before the next reply",
  },
] as const;

for (const item of acceptedCases) {
  test(`memory quality accepts ${item.name}`, () => {
    const summary = `
Memory candidates:
${item.line}
`;
    const entries = parseWorkspaceMemoryCandidates(summary);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, item.expectedType);
    assert.match(entries[0].text, item.expectedText);
  });
}

for (const item of rejectedCases) {
  test(`memory quality rejects ${item.name}`, () => {
    const summary = `
Memory candidates:
${item.line}
`;
    const entries = parseWorkspaceMemoryCandidates(summary);

    assert.equal(entries.length, 0);
  });
}
