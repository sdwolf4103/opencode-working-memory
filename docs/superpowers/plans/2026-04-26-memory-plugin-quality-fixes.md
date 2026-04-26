# Memory Plugin Quality Fixes Plan

## 概述

修復 Memory Plugin 的 false positive 問題和去重機制。

## Baseline 數據

執行任何修改前，先收集目前狀態：

```bash
# Workspace memory 數量
find ~/.local/share/opencode-working-memory/workspaces -name workspace-memory.json \
  -print -exec jq '.entries | length' {} \;

# Open errors false positive
find ~/.local/share/opencode-working-memory/workspaces -path '*/sessions/*.json' \
  -print -exec jq '.openErrors' {} \;
```

---

## PR-1: P0 Bug Fix

### Task 1: 修復 Bash error false positive

#### 目標

避免 `exitCode === undefined` 被當成失敗，並收窄 error extraction 避免誤判。

#### 檔案

- `src/plugin.ts` - inline 修復 exitCode 判斷
- `src/extractors.ts` - 收窄 `extractErrorsFromBash`
- `tests/plugin.test.ts` - **新增** plugin hook regression test

#### 實作步驟

**1. 修改 `src/plugin.ts`** - inline exitCode 判斷

把：

```ts
if (exitCode === 0 && command) {
  clearErrorsForSuccessfulCommand(state, command);
} else if (exitCode !== 0) {
  const errors = extractErrorsFromBash(command, outputText);
  for (const error of errors) {
    upsertOpenError(state, error);
  }
}
```

改成：

```ts
if (typeof exitCode !== "number") {
  // Unknown exit status: do not extract and do not clear
} else if (exitCode === 0 && command) {
  clearErrorsForSuccessfulCommand(state, command);
} else if (command) {
  const errors = extractErrorsFromBash(command, outputText);
  for (const error of errors) {
    upsertOpenError(state, error);
  }
}
```

**不新增 `bash-policy.ts`** - 直接 inline，邏輯簡單且只在一處使用。

**2. 修改 `src/extractors.ts`** - 收窄 error line 判斷

新增 `isErrorLine` 函數：

```ts
function isErrorLine(line: string, knownValidationCommand: boolean): boolean {
  // 無條件捕捉的強訊號
  if (/TS\d{4}|ERR!|Traceback \(most recent call last\):|panic:/i.test(line)) return true;

  // Error 類型前綴（獨立行）
  if (/^\s*(Error|TypeError|ReferenceError|SyntaxError|Exception):/i.test(line)) {
    return true;
  }

  // 已知 validation command 才用寬鬆匹配
  if (knownValidationCommand) {
    return /\b(error|failed|failure|exception)\b/i.test(line);
  }

  return false;
}
```

修改 `extractErrorsFromBash()`：

```ts
export function extractErrorsFromBash(command: string, output: string): OpenError[] {
  const category = classifyCommand(command);
  const knownValidationCommand = category !== null;

  const lines = output
    .split("\n")
    .filter(line => isErrorLine(line, knownValidationCommand))
    .slice(0, 5);

  if (lines.length === 0) return [];

  const finalCategory = category ?? "runtime";

  // ... rest of function
}
```

**不新增 `isInspectionCommand`** - 依靠 `exitCode` guard + 收窄的 regex，後續有需要再加。

#### 測試

新增 `tests/extractors.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { extractErrorsFromBash } from "../src/extractors.ts";

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
```

**新增 `tests/plugin.test.ts`** - Plugin hook regression test：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryV2Plugin } from "../src/plugin.ts";
import { loadSessionState, saveSessionState } from "../src/session-state.ts";
import type { OpenError } from "../src/types.ts";

// Mock client for root session (not a sub-agent)
function mockRootClient() {
  return {
    session: {
      get: async () => ({ data: { parentID: null } }),
      messages: async () => ({ data: [] }),
    },
  };
}

// Helper: create session state with pre-populated open error
function createSessionWithError(sessionID: string, error: OpenError) {
  return {
    version: 1 as const,
    sessionID,
    turn: 0,
    updatedAt: new Date().toISOString(),
    activeFiles: [],
    openErrors: [error],
    recentDecisions: [],
  };
}

test("tool.execute.after: undefined exitCode does NOT create open error", async () => {
  // 1. Temp directory for isolated file I/O
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    // 2. Mock client — root session, no user messages
    const client = mockRootClient();

    // 3. Instantiate plugin
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

    // 4. Simulate bash output with NO exitCode, but output contains TS error
    //    This would create an open error if exitCode was non-zero
    //    Using STRONG error signal to catch the bug where undefined !== 0
    await (plugin as Record<string, Function>)["tool.execute.after"](
      {
        tool: "bash",
        sessionID: "test-session-1",
        args: { command: "npm run typecheck" },
      },
      {
        // exitCode deliberately absent (undefined !== 0 is the bug we're testing)
        output: "src/index.ts(10,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'",
      }
    );

    // 5. Assert: session state has ZERO open errors
    const state = await loadSessionState(tmpDir, "test-session-1");
    assert.equal(state.openErrors.length, 0,
      "exitCode === undefined must not create open errors even with strong error signal");

  } finally {
    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("tool.execute.after: undefined exitCode does NOT clear existing open error", async () => {
  // 1. Temp directory
  const tmpDir = await mkdtemp(join(tmpdir(), "memory-plugin-test-"));

  try {
    // 2. Pre-populate session state with a real open error
    const preExistingError: OpenError = {
      id: "err_critical_abc",
      category: "typecheck",
      summary: "TS2345: Argument of type 'string' is not assignable to parameter of type 'number'",
      command: "npm run typecheck",
      fingerprint: "ee7b3f9a1c2d",
      status: "open",
      firstSeen: Date.now() - 3600000,
      lastSeen: Date.now() - 3600000,
      seenCount: 3,
    };

    await saveSessionState(tmpDir, createSessionWithError("test-session-2", preExistingError));

    // 3. Mock client
    const client = mockRootClient();

    // 4. Instantiate plugin
    const plugin = await MemoryV2Plugin({ directory: tmpDir, client });

    // 5. Simulate bash output with NO exitCode (inspection command)
    //    Using STRONG error signal (TS error) to verify undefined exitCode doesn't clear
    await (plugin as Record<string, Function>)["tool.execute.after"](
      {
        tool: "bash",
        sessionID: "test-session-2",
        args: { command: "rtk cat ~/.local/share/opencode-working-memory/session.json" },
      },
      {
        // exitCode deliberately absent (undefined)
        // Even with TS error in output, should NOT clear existing error
        output: "src/other.ts(5,10): error TS2794: Expected 0 arguments, but got 1",
      }
    );

    // 6. Assert: pre-existing open error is PRESERVED
    const state = await loadSessionState(tmpDir, "test-session-2");
    assert.equal(state.openErrors.length, 1,
      "exitCode === undefined must not clear pre-existing open errors");
    assert.equal(state.openErrors[0].fingerprint, "ee7b3f9a1c2d",
      "The original open error must remain intact");

  } finally {
    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  }
});
```

#### 驗收標準

- `exitCode === undefined` 不產生 open error
- `git log`、`cat` 等輸出不因 `errors` 字樣被誤判
- `npm run typecheck` 失敗仍產生 typecheck error
- Plugin hook regression test 通過
- `npm test && npm run typecheck` 通過

---

### Task 2: 修復 Workspace Memory XML 截斷

#### 目標

移除 `renderWorkspaceMemory()` 的 `.slice()` 截斷，改用 budget-aware 逐行 render，確保輸出永遠包含完整 `</workspace_memory>` closing tag。

#### 檔案

- `src/workspace-memory.ts` - 修改 render 邏輯
- `tests/workspace-memory.test.ts` - 新增截斷測試

#### 實作步驟

1. 新增 `wouldFit` helper：

```ts
function wouldFit(
  lines: string[],
  nextLine: string,
  closingLine: string,
  maxChars: number
): boolean {
  return [...lines, nextLine, closingLine].join("\n").length <= maxChars;
}
```

2. 定義最小 envelope 長度：

```ts
const MIN_ENVELOPE_LENGTH = 120; // <workspace_memory>\n...\n</workspace_memory> 的最小長度
```

3. 修改 `renderWorkspaceMemory()` - 逐行加入直到超過 budget：

```ts
export function renderWorkspaceMemory(store: WorkspaceMemoryStore): string {
  const active = enforceLongTermLimits(store.entries);
  if (active.length === 0) return "";

  const maxChars = Math.min(
    store.limits.maxRenderedChars,
    LONG_TERM_LIMITS.maxRenderedChars
  );

  // 如果 maxChars 小於最小 envelope，返回空字串
  if (maxChars < MIN_ENVELOPE_LENGTH) return "";

  const closing = "</workspace_memory>";
  const lines: string[] = [
    "<workspace_memory>",
    "Persistent workspace memory. Use as background; verify stale or code-related claims.",
  ];

  for (const type of ["feedback", "project", "decision", "reference"] as const) {
    const items = active.filter(entry => entry.type === type);
    if (items.length === 0) continue;

    const sectionLines: string[] = [`${type}:`];

    for (const item of items) {
      const line = `- ${renderEntry(item)}`;
      if (wouldFit([...lines, ...sectionLines], line, closing, maxChars)) {
        sectionLines.push(line);
      }
    }

    if (sectionLines.length > 1 && wouldFit(lines, sectionLines[0], closing, maxChars)) {
      lines.push(...sectionLines);
    }
  }

  lines.push(closing);
  return lines.join("\n");
}
```

#### 測試

新增 `tests/workspace-memory.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "../src/types.ts";
import { renderWorkspaceMemory } from "../src/workspace-memory.ts";

function entry(id: string, text: string): LongTermMemoryEntry {
  const now = new Date().toISOString();
  return {
    id,
    type: "decision",
    text,
    source: "compaction",
    confidence: 0.75,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

test("renderWorkspaceMemory never truncates closing XML tag", () => {
  const entries = Array.from({ length: 28 }, (_, i) =>
    entry(`mem_${i}`, `Long durable memory entry ${i} `.repeat(20))
  );

  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root: "/repo", key: "abc" },
    limits: { maxRenderedChars: 700, maxEntries: 28 },
    entries,
    updatedAt: new Date().toISOString(),
  };

  const rendered = renderWorkspaceMemory(store);

  assert.ok(rendered.endsWith("</workspace_memory>"));
  assert.ok(rendered.length <= 700);
});

test("renderWorkspaceMemory returns empty string when maxChars too small", () => {
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root: "/repo", key: "abc" },
    limits: { maxRenderedChars: 50, maxEntries: 28 },
    entries: [entry("test", "test memory")],
    updatedAt: new Date().toISOString(),
  };

  const rendered = renderWorkspaceMemory(store);
  assert.equal(rendered, "");
});
```

#### 驗收標準

- 輸出永遠包含完整 closing tag
- 長 memory 不會截斷半行
- `maxChars` 小於最小 envelope 時返回空字串
- `npm test && npm run typecheck` 通過

---

### Task 3: 移除裸 `always` trigger

#### 目標

移除 `always` trigger，避免 "tests always fail" 被誤判為 explicit memory。

#### 檔案

- `src/extractors.ts` - 修改 `extractExplicitMemories`

#### 實作步驟

把：

```ts
/(?:从现在开始|從現在開始|从今以后|從今以後|from now on|always)[:：]?\s*(.+)$/im
```

改為：

```ts
/(?:从现在开始|從現在開始|从今以后|從今以後|from now on|going forward)[:：,，]?\s*(.+)$/gim
```

**注意**：所有 pattern 都必須有 `g` flag，因為後續使用 `matchAll()`。

#### 測試

新增到 `tests/extractors.test.ts`（需要補上 `extractExplicitMemories` import）：

```ts
// 注意：需要在文件開頭補上 import
// import { extractErrorsFromBash, extractExplicitMemories } from "../src/extractors.ts";

test("extractExplicitMemories does not treat always as memory trigger", () => {
  const items = extractExplicitMemories("tests always fail on CI when cache is stale");
  assert.equal(items.length, 0);
});

test("extractExplicitMemories still captures going forward", () => {
  const items = extractExplicitMemories("going forward: use pnpm instead of npm");
  assert.equal(items.length, 1);
  assert.match(items[0].text, /pnpm/);
});
```

#### 驗收標準

- `always` 不再是 memory trigger
- `going forward` 仍可正常記憶
- `npm test && npm run typecheck` 通過

---

### Task 4: 整體驗證與清理

#### 實作步驟

1. 執行完整測試：

```bash
npm test
npm run typecheck
```

2. 手動測試：

```bash
cd /Users/sd_wo/work/opencode-working-memory
rtk git log --oneline -5
rtk cat ~/.local/share/opencode-working-memory/workspaces/*/sessions/*.json
```

確認不產生新的 false positive open errors。

3. 清理既有的 false positive open errors：

備份後清理：

```bash
# 備份
cp ~/.local/share/opencode-working-memory/workspaces/*/sessions/*.json /tmp/sessions-backup/

# 清理（手動編輯或用腳本）
# 把 openErrors 設為 []
```

#### 驗收標準

- P0 所有單元測試通過
- 實際 session 中不再出現 false positive
- Hot Session State 的 open errors 只保留真實 validation/runtime error

---

## PR-2: 行為改善

### Task 5: Canonical exact dedupe (Phase 1)

#### 目標

升級 exact dedupe 為 canonical exact dedupe，解決標點、大小寫、空白差異。

**注意**：這是 phase 1，不涉及 Jaccard similarity。真正處理「OpenCode 用 npm cache 載入 plugin」和「OpenCode 載入 plugin 時使用 npm cache」這類語意相似但文字不同的情況，是 phase 2（延後到收集數據後再決定）。

#### 檔案

- `src/workspace-memory.ts` - 修改 canonical key 計算
- `tests/workspace-memory.test.ts` - 新增 dedupe 測試

#### 實作步驟

**1. 新增 source priority 函數**：

```ts
function sourcePriority(source: LongTermMemoryEntry["source"]): number {
  if (source === "explicit") return 3;
  if (source === "manual") return 2;
  return 1;
}
```

**2. 新增 canonical text 函數**：

```ts
function canonicalMemoryText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, " ")
    .trim();
}
```

**3. 修改 `enforceLongTermLimits()`**：

```ts
export function enforceLongTermLimits(entries: LongTermMemoryEntry[]): LongTermMemoryEntry[] {
  const byKey = new Map<string, LongTermMemoryEntry>();

  for (const entry of entries.filter(entry => entry.status === "active")) {
    const text = entry.text.slice(0, LONG_TERM_LIMITS.maxEntryTextChars);
    const key = `${entry.type}:${canonicalMemoryText(text)}`;

    const existing = byKey.get(key);
    
    // Source priority: explicit > manual > compaction
    // Same source: higher confidence wins
    if (!existing) {
      byKey.set(key, { ...entry, text });
    } else if (sourcePriority(entry.source) > sourcePriority(existing.source)) {
      byKey.set(key, { ...entry, text });
    } else if (sourcePriority(entry.source) === sourcePriority(existing.source)) {
      if (entry.confidence > existing.confidence) {
        byKey.set(key, { ...entry, text });
      }
    }
  }

  return [...byKey.values()]
    .sort((a, b) => priority(b) - priority(a))
    .slice(0, LONG_TERM_LIMITS.maxEntries);
}
```

#### 測試

```ts
test("enforceLongTermLimits dedupes with canonical text", () => {
  const now = new Date().toISOString();

  const a: LongTermMemoryEntry = {
    id: "a",
    type: "decision",
    text: "OpenCode uses NPM CACHE for plugin loading",
    source: "compaction",
    confidence: 0.75,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const b: LongTermMemoryEntry = {
    id: "b",
    type: "decision",
    text: "opencode uses npm cache for plugin loading!!!",
    source: "compaction",
    confidence: 0.8,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const kept = enforceLongTermLimits([a, b]);

  assert.equal(kept.length, 1);
  assert.equal(kept[0].confidence, 0.8);
});

test("enforceLongTermLimits preserves explicit over compaction", () => {
  const now = new Date().toISOString();

  const explicit: LongTermMemoryEntry = {
    id: "explicit",
    type: "decision",
    text: "Use pnpm for this project",
    source: "explicit",
    confidence: 0.5,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const compaction: LongTermMemoryEntry = {
    id: "compaction",
    type: "decision",
    text: "Use pnpm for this project",
    source: "compaction",
    confidence: 0.9,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const kept = enforceLongTermLimits([explicit, compaction]);

  assert.equal(kept.length, 1);
  assert.equal(kept[0].source, "explicit");
  assert.equal(kept[0].confidence, 0.5); // explicit 優先，即使 confidence 較低
});

test("enforceLongTermLimits same source higher confidence wins", () => {
  const now = new Date().toISOString();

  const a: LongTermMemoryEntry = {
    id: "a",
    type: "decision",
    text: "Project uses TypeScript",
    source: "compaction",
    confidence: 0.7,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const b: LongTermMemoryEntry = {
    id: "b",
    type: "decision",
    text: "Project uses TypeScript",
    source: "compaction",
    confidence: 0.9,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const kept = enforceLongTermLimits([a, b]);

  assert.equal(kept.length, 1);
  assert.equal(kept[0].confidence, 0.9);
});
```

#### 驗收標準

- 大小寫、標點、空白差不影響 dedupe
- explicit 永遠優先於 compaction（即使 confidence 較低）
- 同 source 時 higher confidence 勝出
- `npm test && npm run typecheck` 通過

---

### Task 6: Structured negative guard

#### 目標

避免「不要記住」「don't remember」被存入長期記憶，使用結構化 adjacency 判斷。

#### 檔案

- `src/extractors.ts` - 修改 `extractExplicitMemories`

#### 實作步驟

**1. 確認所有 pattern 都有 `g` flag**

```ts
const patterns = [
  // 注意：所有pattern必須有 g flag，因為使用 matchAll()
  /(?:请|請)?(?:帮我|幫我)?(?:记住|記住)(?:这一点|這一點|这点|這點|这个|這個)?[:：,，]?\s*(.+)$/gim,
  /\bremember\s+(?:this|that)?[:：,，]?\s*(.+)$/gim,
  /\b(?:save|add)\s+(?:this|that)?\s*(?:to|in)\s+memory[:：,，]?\s*(.+)$/gim,
  /\bcommit\s+(?:this|that)?\s*to memory[:：,，]?\s*(.+)$/gim,
  /(?:从现在开始|從現在開始|从今以后|從今以後|from now on|going forward)[:：,，]?\s*(.+)$/gim,
  /(?:我的偏好是|我偏好|以后请|以後請|以后都|以後都)[:：,，]?\s*(.+)$/gim,
  /\b(?:my preference is|i prefer)[:：,，]?\s*(.+)$/gim,
];
```

**2. 新增 `isNegatedMemoryRequest` 函數**：

```ts
function isNegatedMemoryRequest(text: string, matchIndex: number): boolean {
  const prefix = text.slice(Math.max(0, matchIndex - 30), matchIndex);

  // 中文負向：不要/別/不用 + 可選「幫我」，必須緊鄰 trigger
  if (/(?:不要|別|别|不用|不需要|勿)\s*(?:幫我|帮我)?\s*$/u.test(prefix)) {
    return true;
  }

  // 英文負向：do not / don't / never / not + 可選「please」，必須緊鄰 trigger
  if (/(?:do\s+not|don't|dont|never|not)\s+(?:please\s+)?$/i.test(prefix)) {
    return true;
  }

  return false;
}
```

**3. 在 `extractExplicitMemories()` 中使用**：

```ts
const seen = new Set<string>();

for (const pattern of patterns) {
  // 注意：pattern 必須有 g flag
  for (const match of text.matchAll(pattern)) {
    const body = match[1]?.trim();
    if (!body || body.length < 8) continue;

    // 檢查是否為負向請求
    if (isNegatedMemoryRequest(text, match.index ?? 0)) continue;

    // 檢查是否為「再說/下次」類的延遲
    if (/^(再说|再說|later|next time)$/i.test(body)) continue;

    // Dedupe by canonical body
    const key = body.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);

    // ...rest of function
  }
}
```

#### 測試

```ts
test("extractExplicitMemories ignores Chinese negative request", () => {
  const items = extractExplicitMemories("不要記住：這個 repo 使用 npm cache");
  assert.equal(items.length, 0);
});

test("extractExplicitMemories ignores English negative request", () => {
  const items = extractExplicitMemories("please don't remember this: use npm cache");
  assert.equal(items.length, 0);
});

test("extractExplicitMemories does not false positive on 'not forget'", () => {
  const items = extractExplicitMemories("I will not forget to remember this");
  assert.equal(items.length, 0);
});

test("extractExplicitMemories still captures positive request", () => {
  const items = extractExplicitMemories("from now on: reply in Traditional Chinese");
  assert.equal(items.length, 1);
});

test("extractExplicitMemories captures multiple memories in same message", () => {
  const items = extractExplicitMemories("請記住：使用 pnpm\n記住這點：用 TypeScript");
  assert.equal(items.length, 2);
});
```

#### 驗收標準

- 「不要記住」不產生 memory
- `don't remember` 不產生 memory
- `I will not forget to remember` 不被誤判
- `from now on` 仍可正常記憶
- 所有 pattern 都有 `g` flag
- `npm test && npm run typecheck` 通過

---

### Task 7: Compaction quality gate

#### 目標

避免低品質 candidate 被寫入 Workspace Memory。

#### 檔案

- `src/extractors.ts` - 在 `parseWorkspaceMemoryCandidates()` 內部套用 `shouldAcceptWorkspaceMemoryCandidate()`
- `tests/extractors.test.ts` - 透過 `parseWorkspaceMemoryCandidates()` 驗證 reject/accept 行為

#### 實作要點

**1. 明確的 predicate（放在 extractors.ts 內部）**：

```ts
function shouldAcceptWorkspaceMemoryCandidate(entry: {
  type: LongTermType;
  text: string;
}): boolean {
  const text = entry.text.trim();

  // 太短
  if (text.length < 20) return false;

  // Git history / commit hash
  if (/\b[0-9a-f]{7,40}\b/.test(text)) return false;
  if (/^(fix|feat|chore|docs|refactor|test):/i.test(text)) return false;

  // Raw error / stack trace
  if (/^\s*(Error|TypeError|ReferenceError|SyntaxError):/i.test(text)) return false;
  if (/at \S+ \([^)]+:\d+:\d+\)/.test(text)) return false;

  // Active file list
  if (/^(modified|created|deleted|renamed)\s+\S+\.\S+$/i.test(text)) return false;

  // Temporary progress
  if (/^(currently|now|pending|in progress|todo|wip):/i.test(text)) return false;

  // Code signature / API doc
  if (/^(function|class|interface|type|const|let|var)\s+\w+/.test(text)) return false;
  if (/^(GET|POST|PUT|DELETE|PATCH)\s+\//.test(text)) return false;

  // Path-heavy facts (rediscoverable from repo)
  const pathCount = (text.match(/\/[\w.-]+(\/[\w.-]+)+/g) || []).length;
  if (pathCount > 2) return false;

  return true;
}
```

**2. 更新 `memoryCandidateInstruction()`**：

```ts
function memoryCandidateInstruction(): string {
  return `
At the end of the compaction summary, include:

<workspace_memory_candidates>
- [feedback] ...
- [project] ...
- [decision] ...
- [reference] ...
</workspace_memory_candidates>

Only include durable information useful across future sessions in this exact workspace.
Do NOT include:
- Active file lists or temporary progress
- Raw errors, stack traces, or git history
- Code signatures, function names, or API docs
- Facts easily rediscovered from the repository

Write candidates in the same dominant language as existing workspace memory or the user's current language.
Keep code identifiers, paths, commands, package names, and product names unchanged.
Do not rephrase existing workspace memory as a new candidate, even if worded differently.

For decisions, include rationale in one sentence.
If nothing qualifies, output an empty block.
`.trim();
}
```

#### 測試矩陣

```ts
const QUALITY_GATE_TESTS = [
  // Reject
  { text: "fix: update plugin config", expected: false },
  { text: "Error: Cannot find module", expected: false },
  { text: "at Plugin.run (plugin.ts:42:15)", expected: false },
  { text: "modified src/index.ts", expected: false },
  { text: "currently working on tests", expected: false },
  { text: "function processMemory()", expected: false },
  { text: "GET /api/users", expected: false },
  { text: "Path: /Users/foo/bar/baz/qux.ts", expected: false },
  
  // Accept
  { text: "Use pnpm for this project", expected: true },
  { text: "OpenCode loads plugins from npm cache, not npm link", expected: true },
  { text: "Workspace memory stored at ~/.local/share/opencode-working-memory", expected: true },
];

for (const { text, expected } of QUALITY_GATE_TESTS) {
  test(`shouldAcceptWorkspaceMemoryCandidate: "${text.slice(0, 30)}..."`, () => {
    const result = shouldAcceptWorkspaceMemoryCandidate({ type: "decision", text });
    assert.equal(result, expected);
  });
}
```

#### 驗收標準

- Git history / commit hash 被拒絕
- Raw error / stack trace 被拒絕
- Active file list 被拒絕
- Temporary progress 被拒絕
- Code signature 被拒絕
- Path-heavy facts 被拒絕
- Durable facts 被接受
- `npm test && npm run typecheck` 通過

---

### Task 8: Stale cleanup / penalty (未來)

#### 目標

讓 `staleAfterDays` 不只是 render marker，而會影響排序與保留。

#### 延後原因

需要先收集 production 數據，確認有多少 stale memory 實際存在。

---

### Task 9: Per-type quota (未來)

#### 目標

避免單一類型擠掉其他類型。

#### 延後原因

目前尚未達到 28 entries 上限，需先收集數據。

---

## 執行順序

### 本週：PR-1

1. Baseline snapshot
2. Task 1: inline exitCode + 收窄 extractErrorsFromBash + **plugin hook regression test** ✅ DONE
3. Task 2: budget-aware render + **min envelope handling** ✅ DONE
4. Task 3: remove bare `always` + **ensure all patterns have `g` flag** ✅ DONE
5. Manual verification
6. Cleanup false positives

### Hotfix: 紫色斜體渲染問題

**問題**：Plugin compaction context 輸出在 OpenCode UI 中顯示為紫色斜體。

**根因分析**：
1. 第一次嘗試：XML 標籤 `<workspace_memory>` → 紫色斜體
2. 第二次嘗試：HTML 註釋 `<!-- workspace_memory_candidates -->` → 仍然紫色斜體
3. 第三次嘗試：Markdown 標題 `## Memory Candidates` → 紫色（無斜體）
4. 第四次嘗試：純文本標籤 `Memory candidates:` → 無特殊渲染 ✅

**解決方案**：架構師建議使用純文本標籤，避免所有 Markdown/XML/HTML 語法。

**修改內容**：
- `src/plugin.ts`: `compactionContextHeader()` 改用 `Memory candidates:` 標籤
- `src/plugin.ts`: `renderTodosForCompaction()` 改用 `Pending todos:` 標籤
- `src/extractors.ts`: `extractCandidateBlock()` 支援純文本格式解析（primary）
- `src/workspace-memory.ts`: `renderWorkspaceMemory()` 使用純文本 `Workspace memory:` 標籤
- `src/session-state.ts`: `renderHotSessionState()` 使用純文本 `Hot session state:` 標籤
- 移除 `stripXmlTags()` 函數（不再需要）

**測試**：42 個測試全部通過。

### 下週：PR-2

5. Task 5: canonical exact dedupe + **source priority**
6. Task 6: structured negative guard + **all patterns with `g` flag**
7. Task 7: compaction quality gate + **predicate + test matrix**

### 未來（視數據決定）

8. Task 8: stale cleanup
9. Task 9: per-type quota
10. Near-duplicate Jaccard (write-time, not render-time)

---

## 測試覆蓋清單

### PR-1 Coverage

| 測試項目 | 狀態 |
|----------|------|
| git log output mentioning errors ignored | ★★★ planned |
| cat session json with openErrors ignored | ★★★ planned |
| typecheck failure captured | ★★★ planned |
| unknown command loose errors ignored | ★★★ planned |
| **plugin hook with exitCode undefined** | **★★★ CRITICAL** |
| render ends with closing tag | ★★★ planned |
| render respects maxChars limit | ★★★ planned |
| **min envelope returns empty** | **★★★ planned** |
| `always` not a trigger | ★★★ planned |
| `going forward` still works | ★★★ planned |

### PR-2 Coverage

| 測試項目 | 狀態 |
|----------|------|
| canonical text dedupes | ★★★ planned |
| **explicit beats compaction** | **★★★ planned** |
| **same source higher confidence wins** | **★★★ planned** |
| Chinese negative ignored | ★★★ planned |
| English negative ignored | ★★★ planned |
| "not forget" not misjudged | ★★★ planned |
| **all patterns have `g` flag** | **★★★ planned** |
| quality gate rejects git history | ★★★ planned |
| quality gate rejects stack trace | ★★★ planned |
| quality gate accepts durable facts | ★★★ planned |