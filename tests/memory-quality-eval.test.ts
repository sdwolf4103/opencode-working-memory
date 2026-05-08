import test from "node:test";
import assert from "node:assert/strict";
import { extractExplicitMemories, parseWorkspaceMemoryCandidates } from "../src/extractors.ts";
import { assessMemoryQuality, isHardQualityReason } from "../src/memory-quality.ts";
import { expectedAcceptedFixtureIds, reviewerCurrent28Fixture } from "./fixtures/memory-quality-current-28.ts";

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
  {
    name: "stable URL query reference",
    line: "- [reference] Memory diagnostics dashboard URL is https://example.test/search?q=memory&view=summary",
    expectedType: "reference",
    expectedText: /search\?q=memory/,
  },
  {
    name: "bilingual stable rule",
    line: "- [decision] 使用 durable evidence records 保持 memory command auditability",
    expectedType: "decision",
    expectedText: /保持 memory command auditability/,
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
  {
    name: "misclassified feedback completion snapshot",
    line: "- [feedback] Wave 1 completed successfully and all tests passed",
  },
  {
    name: "misclassified decision implementation note",
    line: "- [decision] Implemented owner-aware cleanup in plugin.ts",
  },
  {
    name: "session internal review note",
    line: "- [feedback] The assistant reviewed the code reviewer feedback and updated the plan",
  },
  {
    name: "unresolved question suffix",
    line: "- [project] Should we add semantic merge to workspace memory?",
  },
  {
    name: "unresolved question prefix",
    line: "- [reference] TODO: decide whether to keep this migration path",
  },
  {
    name: "unresolved Chinese question",
    line: "- [decision] 需要決定是否要增加新的記憶壓縮策略",
  },
  {
    name: "transient bug state",
    line: "- [project] Tests are failing and the next step is to fix the retry path",
  },
  {
    name: "Chinese transient bug state",
    line: "- [reference] 目前正在 debug storage lock failure，暫時 workaround 待修",
  },
  {
    name: "deployment snapshot",
    line: "- [reference] Latest deployed revision is rev-a8F3kL9pQ2xZ7bN4",
  },
  {
    name: "Chinese deployment snapshot",
    line: "- [project] 目前部署版本 build-9f8A7c6D5e4F3g2H 是 active release",
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

test("reviewer current-28 fixture keeps durable memories and rejects pseudo memories", () => {
  for (const entry of reviewerCurrent28Fixture) {
    const result = assessMemoryQuality(entry);
    assert.equal(
      result.accepted,
      expectedAcceptedFixtureIds.has(entry.id),
      `${entry.id}: ${entry.text} -> ${result.reasons.join(",")}`,
    );
  }
});

test("progress snapshot rejection is type independent", () => {
  for (const type of ["feedback", "project", "decision", "reference"] as const) {
    const result = assessMemoryQuality({ type, text: "Wave 2 completed successfully", source: "compaction" });
    assert.equal(result.accepted, false, `${type} progress snapshots must reject`);
    assert.ok(result.reasons.includes("progress_snapshot"));
  }
});

test("new v1.6 hard quality reasons are emitted by concrete heuristics", () => {
  const cases = [
    {
      reason: "unresolved_question",
      entry: { type: "reference" as const, text: "Open question: whether to keep legacy prompt rendering", source: "compaction" as const },
    },
    {
      reason: "unresolved_question",
      entry: { type: "project" as const, text: "We need to decide storage migration order?", source: "compaction" as const },
    },
    {
      reason: "transient_bug_state",
      entry: { type: "project" as const, text: "Currently debugging memory replacement and tests are failing", source: "compaction" as const },
    },
    {
      reason: "deployment_snapshot",
      entry: { type: "reference" as const, text: "Current active release build is build-X9kLmN42pQ7rT6z", source: "compaction" as const },
    },
  ];

  for (const { reason, entry } of cases) {
    const result = assessMemoryQuality(entry);
    assert.equal(result.accepted, false, `${entry.text} should reject`);
    assert.ok(result.reasons.includes(reason), `${entry.text} -> ${result.reasons.join(",")}`);
  }
});

test("unresolved question guardrails preserve stable URL queries and durable rules", () => {
  const urlResult = assessMemoryQuality({
    type: "reference",
    text: "Memory dashboard URL is https://example.test/search?q=memory&view=summary",
    source: "compaction",
  });
  assert.equal(urlResult.reasons.includes("unresolved_question"), false, urlResult.reasons.join(","));
  assert.equal(urlResult.accepted, true);

  const durableRule = assessMemoryQuality({
    type: "decision",
    text: "Use verifier questions only when acceptance evidence is missing?",
    source: "compaction",
  });
  assert.equal(durableRule.reasons.includes("unresolved_question"), false, durableRule.reasons.join(","));
});

test("terse_label is diagnostic only and does not block quality acceptance", () => {
  const result = assessMemoryQuality({ type: "reference", text: "Cache key", source: "compaction" });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.reasons, []);
  assert.ok(result.diagnostics?.includes("terse_label"));
});

test("feedback must be stable user preference or instruction", () => {
  assert.equal(assessMemoryQuality({ type: "feedback", text: "User prefers concise architecture reviews", source: "compaction" }).accepted, true);
  assert.equal(assessMemoryQuality({ type: "feedback", text: "Implemented owner-aware cleanup in plugin.ts", source: "compaction" }).accepted, false);
});

test("decision must be future-facing rule, not completed implementation note", () => {
  assert.equal(assessMemoryQuality({ type: "decision", text: "Do not add semantic merge to memory dedupe", source: "compaction" }).accepted, true);
  assert.equal(assessMemoryQuality({ type: "decision", text: "Use the cache boundary that was chosen in ADR-2 for future memory rendering", source: "compaction" }).accepted, true);
  assert.equal(assessMemoryQuality({ type: "decision", text: "Added semantic merge tests in the previous wave", source: "compaction" }).accepted, false);
});

test("bad_decision 3-tier gate: architecture-like decisions accepted without future-rule imperative", () => {
  const architectureLikeCases = [
    { text: "Rule 不在記憶系統 schema 內，歸用戶（agent.md / claude.md），系統最多到 Preference + Suggestion", type: "decision" as const },
    { text: "Ghost memory root cause: normalization 把 capacity losers 從 store 移除時沒有 emit terminal evidence", type: "decision" as const },
    { text: "BASE_HALF_LIFE_DAYS 應從 60 降低到 45", type: "decision" as const },
    { text: "採用 decay-rate 模型取代 priority+penalty 模型", type: "decision" as const },
    { text: "從 scoring 移除 confidence，目前是固定值無意義", type: "decision" as const },
  ];

  const stillRejectedCases = [
    { text: "Implemented phase 2 and updated tests", type: "decision" as const },
    { text: "Implemented CI_SCHEMA_UPDATE for compatibility run 42", type: "decision" as const },
    { text: "Session reviewed the architecture model changes", type: "decision" as const },
    { text: "Some random text with no architecture keywords or future rules", type: "decision" as const },
  ];

  for (const entry of architectureLikeCases) {
    const result = assessMemoryQuality({ ...entry, source: "compaction" });
    assert.equal(result.reasons.includes("bad_decision"), false, `${entry.text} -> ${result.reasons.join(",")}`);
  }

  for (const entry of stillRejectedCases) {
    const result = assessMemoryQuality({ ...entry, source: "compaction" });
    assert.equal(result.reasons.includes("bad_decision"), true, `${entry.text} -> ${result.reasons.join(",")}`);
  }
});

test("shared quality gate owns extractor low-quality syntax rejections", () => {
  const rejected = [
    { type: "project" as const, text: "fix: add new feature" },
    { type: "reference" as const, text: "modified src/plugin.ts" },
    { type: "reference" as const, text: "function buildCompactionPrompt(privateContext: string): string" },
    { type: "reference" as const, text: "GET /api/sessions" },
  ];

  for (const entry of rejected) {
    assert.equal(
      assessMemoryQuality({ ...entry, source: "compaction" }).accepted,
      false,
      `${entry.type}: ${entry.text}`,
    );
  }
});

test("explicit memories bypass extraction quality gate", () => {
  const entries = extractExplicitMemories("remember: Wave 1 completed successfully and all tests passed");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "explicit");
  assert.match(entries[0].text, /Wave 1 completed/);
});

test("hard quality reasons exclude soft whitelist failures", () => {
  assert.equal(isHardQualityReason("progress_snapshot"), true);
  assert.equal(isHardQualityReason("raw_error"), true);
  assert.equal(isHardQualityReason("commit_or_ci_snapshot"), true);
  assert.equal(isHardQualityReason("temporary_status"), true);
  assert.equal(isHardQualityReason("active_file_snapshot"), true);
  assert.equal(isHardQualityReason("code_or_api_signature"), true);
  assert.equal(isHardQualityReason("path_heavy"), true);
  assert.equal(isHardQualityReason("empty"), true);
  assert.equal(isHardQualityReason("unresolved_question"), true);
  assert.equal(isHardQualityReason("transient_bug_state"), true);
  assert.equal(isHardQualityReason("deployment_snapshot"), true);

  assert.equal(isHardQualityReason("bad_feedback"), false);
  assert.equal(isHardQualityReason("bad_decision"), false);
  assert.equal(isHardQualityReason("terse_label"), false);
});
