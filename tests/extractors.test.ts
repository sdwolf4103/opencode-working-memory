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