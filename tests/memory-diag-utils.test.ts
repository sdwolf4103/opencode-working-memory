import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalMemoryText, cleanText, countBy, sortedCounts, truncate } from "../scripts/memory-diag/text.ts";
import { readJSONLFile } from "../scripts/memory-diag/io.ts";

test("cleanText redacts credentials and absolute paths unless raw", () => {
  const text = "Use password: sushi and api_key=abc123 in /Users/alice/project/config.json";

  const cleaned = cleanText(text, false);

  assert.match(cleaned, /password: \[REDACTED\]/);
  assert.match(cleaned, /api_key=\[REDACTED\]/);
  assert.match(cleaned, /<path>/);
  assert.doesNotMatch(cleaned, /sushi/);
  assert.doesNotMatch(cleaned, /\/Users\/alice/);
  assert.equal(cleanText(text, true), text);
});

test("truncate collapses whitespace and applies ellipsis at max length", () => {
  assert.equal(truncate("  hello\n\tworld   "), "hello world");
  assert.equal(truncate("abcdef", 5), "abcd…");
});

test("canonicalMemoryText normalizes punctuation and case", () => {
  assert.equal(canonicalMemoryText("Hello, WORLD!!!　Path?"), "hello world path");
});

test("sortedCounts sorts by count descending then key ascending", () => {
  const counts = new Map<string, number>([["b", 2], ["a", 2], ["c", 3]]);

  assert.deepEqual(sortedCounts(counts), [["c", 3], ["a", 2], ["b", 2]]);
});

test("countBy counts string items", () => {
  assert.deepEqual([...countBy(["beta", "alpha", "beta"]).entries()], [["beta", 2], ["alpha", 1]]);
});

test("readJSONLFile returns valid records and invalid line count", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-utils-"));
  try {
    const path = join(root, "records.jsonl");
    await writeFile(path, '{"id":"one"}\nnot-json\n\n{"id":"two"}\n', "utf8");

    const result = await readJSONLFile<{ id: string }>(path);

    assert.deepEqual(result.records, [{ id: "one" }, { id: "two" }]);
    assert.equal(result.invalidLines, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
