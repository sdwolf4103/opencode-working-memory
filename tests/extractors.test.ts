import test from "node:test";
import assert from "node:assert/strict";
import { extractErrorsFromBash, extractExplicitMemories } from "../src/extractors.ts";

// ============================================
// Task 1: extractErrorsFromBash tests
// ============================================

test("git log output mentioning errors is ignored", () => {
  const errors = extractErrorsFromBash(
    "cd /repo && rtk git log --oneline -5",
    "4832b38 fix: silence memory load errors in working-memory"
  );
  assert.equal(errors.length, 0);
});

test("cat session json with openErrors is ignored", () => {
  const errors = extractErrorsFromBash(
    "rtk cat ~/.local/share/opencode-working-memory/session.json",
    '"openErrors": []'
  );
  assert.equal(errors.length, 0);
});

test("typecheck failure is captured", () => {
  const errors = extractErrorsFromBash(
    "npm run typecheck",
    "src/index.ts(10,3): error TS2345: bad type"
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].category, "typecheck");
});

test("runtime Error prefix is captured for failed unknown command", () => {
  const errors = extractErrorsFromBash(
    "node script.js",
    "Error: Cannot find module './missing'"
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].category, "runtime");
});

test("unknown command with loose error words is ignored", () => {
  const errors = extractErrorsFromBash(
    "some-unknown-command",
    "this output has errors in it but no clear signal"
  );
  assert.equal(errors.length, 0);
});

test("TypeError prefix is captured", () => {
  const errors = extractErrorsFromBash(
    "node script.js",
    "TypeError: Cannot read property 'x' of undefined"
  );
  assert.equal(errors.length, 1);
});

test("TS error pattern is always captured", () => {
  const errors = extractErrorsFromBash(
    "cat some-file.txt",  // unknown command, but TS error is strong signal
    "src/index.ts(10,3): error TS2345: Argument of type 'string' is not assignable"
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].category, "runtime");
});

// ============================================
// Task 3: extractExplicitMemories tests
// ============================================

test("extractExplicitMemories does not treat always as memory trigger", () => {
  const items = extractExplicitMemories("tests always fail on CI when cache is stale");
  assert.equal(items.length, 0);
});

test("extractExplicitMemories still captures going forward", () => {
  const items = extractExplicitMemories("going forward: use pnpm instead of npm");
  assert.equal(items.length, 1);
  assert.match(items[0].text, /pnpm/);
});

test("extractExplicitMemories captures from now on", () => {
  const items = extractExplicitMemories("from now on: reply in Traditional Chinese");
  assert.equal(items.length, 1);
  assert.match(items[0].text, /Traditional Chinese/);
});

// ============================================
// Task 6: Negative memory request tests
// ============================================

test("extractExplicitMemories ignores Chinese negative request", () => {
  const items = extractExplicitMemories("不要記住：這個 repo 使用 npm cache");
  assert.equal(items.length, 0);
});

test("extractExplicitMemories ignores English negative request", () => {
  const items = extractExplicitMemories("please don't remember this: use npm cache");
  assert.equal(items.length, 0);
});

test("extractExplicitMemories does not false positive on 'not forget'", () => {
  // "remember this" in middle of sentence should NOT match (not a directive)
  const items = extractExplicitMemories("I will not forget to remember this: use pnpm");
  assert.equal(items.length, 0);
});

test("extractExplicitMemories captures remember at line start", () => {
  // "remember this" at line start IS a directive
  const items = extractExplicitMemories("remember this: use pnpm for all packages");
  assert.equal(items.length, 1);
  assert.match(items[0].text, /pnpm/);
});

test("extractExplicitMemories still captures positive request after negative", () => {
  // Ensure negative guard doesn't block positive requests
  const items = extractExplicitMemories("記住：使用 pnpm 來管理套件");
  assert.equal(items.length, 1);
  assert.match(items[0].text, /pnpm/);
});

test("extractExplicitMemories captures multiple memories in same message", () => {
  const items = extractExplicitMemories("請記住：使用 pnpm 管理套件\n記住這點：用 TypeScript 撰寫程式碼");
  assert.equal(items.length, 2);
});

// ============================================
// Task 7: Compaction quality gate tests
// ============================================

import { parseWorkspaceMemoryCandidates } from "../src/extractors.ts";

test("parseWorkspaceMemoryCandidates rejects short text", () => {
  const summary = `
## Memory Candidates
- [decision] short text
`;
  const items = parseWorkspaceMemoryCandidates(summary);
  assert.equal(items.length, 0);
});

test("parseWorkspaceMemoryCandidates rejects git commit hash", () => {
  const summary = `
## Memory Candidates
- [project] abc123def456 is the commit hash
`;
  const items = parseWorkspaceMemoryCandidates(summary);
  assert.equal(items.length, 0);
});

test("parseWorkspaceMemoryCandidates rejects raw error", () => {
  const summary = `
## Memory Candidates
- [feedback] TypeError: Cannot read property 'x' of undefined
`;
  const items = parseWorkspaceMemoryCandidates(summary);
  assert.equal(items.length, 0);
});

test("parseWorkspaceMemoryCandidates rejects stack trace", () => {
  const summary = `
## Memory Candidates
- [reference] at foo (bar.ts:10:5)
`;
  const items = parseWorkspaceMemoryCandidates(summary);
  assert.equal(items.length, 0);
});

test("parseWorkspaceMemoryCandidates rejects commit prefix", () => {
  const summary = `
## Memory Candidates
- [project] fix: add new feature
`;
  const items = parseWorkspaceMemoryCandidates(summary);
  assert.equal(items.length, 0);
});

test("parseWorkspaceMemoryCandidates rejects path-heavy facts", () => {
  const summary = `
## Memory Candidates
- [project] files at /src/a.ts /src/b.ts /src/c.ts are important
`;
  const items = parseWorkspaceMemoryCandidates(summary);
  assert.equal(items.length, 0);
});

test("parseWorkspaceMemoryCandidates accepts valid decision", () => {
  const summary = `
## Memory Candidates
- [decision] Use pnpm instead of npm for package management
`;
  const items = parseWorkspaceMemoryCandidates(summary);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "decision");
  assert.match(items[0].text, /pnpm/);
});

test("parseWorkspaceMemoryCandidates accepts valid project info", () => {
  const summary = `
## Memory Candidates
- [project] This project uses TypeScript for all source files
`;
  const items = parseWorkspaceMemoryCandidates(summary);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "project");
});

test("parseWorkspaceMemoryCandidates accepts plain text label format (no Markdown)", () => {
  const summary = `
Memory candidates:
- [decision] Use plain text labels to avoid purple Markdown headers
- [project] This repo uses pnpm for package management
`;
  const items = parseWorkspaceMemoryCandidates(summary);
  assert.equal(items.length, 2);
  assert.equal(items[0].type, "decision");
  assert.equal(items[1].type, "project");
});