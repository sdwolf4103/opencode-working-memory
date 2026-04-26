# Workspace Memory Cleanup Migration Plan (v2)

## Status: APPROVED (v3)

## Problem Statement

Audit of recent workspace memories found quality issues in pre-v1.2.1 stores:

### Issue 1: Snapshot Violations (P0)

| Workspace | Entry | Type |
|-----------|-------|------|
| opencode-record | `測試套件：1237 tests pass, 226 suites` | Test count |
| opencode-record | `USB 同步：37 個文件（...）` | File count (Chinese) |
| opencode-record | `pathology-playground...已完成 Phase 1-4` | Phase progress |
| pathology-agent-reports | `Waves 1-5, 7 已完成，Wave 6 deferred` | Wave progress |

**Root Cause**: These entries were created before P0c/P0d fix (08:02:32). Current code would reject them.

**Risk**: Medium. Pollutes long-term memory, wastes tokens.

### Issue 2: Sensitive Credentials (P0)

| Workspace | Entry | Risk |
|-----------|-------|------|
| opencode-record | `Admin PIN 是 456123` | **High** - Raw credential |
| Pre-cancer-atlas | `測試用戶名：shihlab，密碼：sushi` | **High** - Raw credential |

**Root Cause**: No credential redaction in compaction extraction or storage normalization.

**Risk**: High. Credentials sent to model in every compaction prompt.

### Issue 3: Wave/Sprint Not Filtered (P0)

| Pattern | Status |
|---------|--------|
| `Phase 1-4 已完成` | ✅ Filtered by P0c |
| `Wave 1-5 已完成` | ❌ Not filtered |

**Root Cause**: P0c filter only covers `Phase`, not `Wave/Sprint/Milestone/Task`.

**Risk**: Medium. New snapshots still enter memory.

### Issue 4: Duplicates (P1)

| Workspace | Entry | Issue |
|-----------|-------|-------|
| Pre-cancer-atlas | `認證使用 Basic Auth...` x2 | Exact duplicate |
| Pre-cancer-atlas | `IP 隱私...` x2 | Semantic duplicate |
| Pre-cancer-atlas | `Cloud Run...` project + reference | Cross-type duplicate |

**Root Cause**: `extractEntityKey()` only recognizes `opencode-agenthub`. Natural canonical dedup handles exact duplicates.

**Risk**: Low. Wastes tokens but not dangerous.

---

## Architect Review Failures (v1, v2)

### v1 Failures

| Issue | Problem |
|-------|---------|
| Regex | `Waves` not matched, Chinese `\b` unreliable |
| Superseded entries | Would be deleted by `enforceLongTermLimits()` |
| Credential redaction | Was migration-gated, must be always-on |
| Wave filter | Deferred to future, must be now |
| Over-broad | `Upload limit is 10 files` would be flagged |
| Rationale | Only redacted `text`, not `rationale` |

### v2 Failures

| Issue | Problem |
|-------|---------|
| File context | `upload` matches `Upload limit`, false positive |
| Explicit check | Missing `source === "explicit"` check before marking |
| Credential regex | `\S+` captures through Chinese comma tail |
| Filter location | Don't filter in `getFrozenWorkspaceMemory()` |

---

## Proposed Solution (v3)

### Architecture Principle

```
                    ┌─────────────────────────────────┐
                    │ normalizeWorkspaceMemory()      │
                    │                                 │
                    │  1. ALWAYS redact credentials  │
                    │     (not migration-gated)       │
                    │                                 │
                    │  2. Mark legacy snapshots as    │
                    │     superseded (migration-gated)│
                    │                                 │
                    │  3. Preserve superseded entries │
                    │     in storage, exclude from    │
                    │     render                       │
                    └─────────────────────────────────┘
```

### Key Design Decisions

1. **Credential redaction is always-on** - runs on every normalize, independent of migration ID
2. **Snapshot marking is migration-gated** - one-time cleanup for legacy entries
3. **Superseded entries preserved in storage** - but excluded from render
4. **Type restriction for snapshots** - only `project` type, avoid false positives
5. **Wave/Sprint/Milestone filter added now** - not deferred

---

## Implementation

### 1. Add Migration Tracking to Type

```typescript
// src/types.ts

interface WorkspaceMemoryStore {
  version: number;
  workspace: { root: string; key: string };
  limits: { maxRenderedChars: number; maxEntries: number };
  entries: LongTermMemoryEntry[];
  migrations?: string[];  // NEW: track applied migrations
  updatedAt: string;
}

const MIGRATION_ID = "2026-04-26-p0-cleanup";
```

### 2. Snapshot Detection (Revised Regex)

```typescript
// src/workspace-memory.ts

/**
 * Detect snapshot violations in text.
 * Only apply to 'project' type entries with source !== 'explicit'.
 */
function isProjectSnapshotViolation(text: string): boolean {
  // Test/suite counts
  if (/\d+\s+tests?\s+pass(?:ed)?/i.test(text)) return true;
  if (/\d+\s+suites?\s+(?:pass|fail)/i.test(text)) return true;
  
  // File counts (Chinese/English) - require sync/completion context
  // And must NOT be a limit/maximum statement
  if (/\d+\s*(?:個|个)?\s*(?:files?|文件)/i.test(text)) {
    const hasSnapshotContext = /同步|synced|uploaded|downloaded|completed|generated|created|modified|processed|完成/i.test(text);
    const hasLimitContext = /limit|max|maximum|min|minimum|supports?|allowed|per\s+(?:batch|request|upload)/i.test(text);
    if (hasSnapshotContext && !hasLimitContext) return true;
  }
  
  // Phase/Wave/Sprint/Milestone progress
  // English: Phase 1-4 completed, Waves 1-5 done
  if (/(?:phases?|waves?|sprints?|milestones?|tasks?)\s*\d+(?:\s*[-–]\s*\d+)?/i.test(text)) {
    if (/completed|done|finished|完成/i.test(text)) return true;
  }
  // Chinese: 已完成 Phase 1-4
  if (/(?:已完成|完成).{0,30}(?:phases?|waves?|sprints?|milestones?|tasks?)/i.test(text)) return true;
  
  return false;
}
```

### 3. Credential Redaction (Always-On)

```typescript
// src/workspace-memory.ts

/**
 * Bounded secret value pattern - stops at delimiters and Chinese punctuation.
 * Avoids capturing through Chinese commas: 密碼：sushi，用於測試
 */
const SECRET_VALUE = String.raw`[^` + "`" + String.raw`'",，,\s]+`;

/**
 * Multilingual credential labels.
 * These are used in both detection and redaction patterns.
 */
const PASSWORD_LABELS = /password|passwd|pwd|密碼|密码|パスワード|비밀번호|contraseña|mot de passe|passwort/i;
const USERNAME_LABELS = /username|user name|用戶名|用户名|ユーザー名|사용자명|usuario|utilisateur|benutzer/i;

/**
 * Prefix patterns that capture label + delimiter together.
 * This preserves the delimiter in output: 密碼：secret → 密碼：[REDACTED]
 */
const PASSWORD_PREFIX = String.raw`(${PASSWORD_LABELS.source}\s*(?:是|=|:|：)?\s*)`;
const USERNAME_PREFIX = String.raw`(${USERNAME_LABELS.source}\s*(?:是|=|:|：)?\s*)`;

/**
 * Redact sensitive credentials from text.
 * This runs on EVERY normalize, not just migration.
 * Idempotent - [REDACTED] doesn't match patterns again.
 * 
 * Order matters:
 * 1. PIN (standalone)
 * 2. Username+password pairs (must run before standalone password)
 * 3. Standalone password
 */
function redactCredentials(text: string): string {
  let result = text;
  
  // 1. PIN patterns (language-neutral, supports 是, =, :, ：)
  result = result.replace(
    new RegExp(String.raw`\b(PIN|pin)\s*(?:是|=|:|：)?\s*[`'"]?(${SECRET_VALUE})`, 'gi'),
    '$1 [REDACTED]'
  );
  
  // 2. Username+Password pairs (multilingual)
  // Must run BEFORE standalone password to match full pairs.
  // 測試用戶名：xxx，密碼：yyy
  // username: xxx, password: yyy
  result = result.replace(
    new RegExp(
      String.raw`${USERNAME_PREFIX}[\`'"]?(${SECRET_VALUE})((?:，|,)\s*)${PASSWORD_PREFIX}[\`'"]?(${SECRET_VALUE})`,
      'gi'
    ),
    '$1[REDACTED]$3$4[REDACTED]'
  );
  
  // 3. Standalone password patterns (multilingual)
  // Matches: password: secret, 密碼：secret, パスワード: secret, etc.
  result = result.replace(
    new RegExp(String.raw`${PASSWORD_PREFIX}[\`'"]?(${SECRET_VALUE})`, 'gi'),
    '$1[REDACTED]'
  );
  
  return result;
}
```

### 4. Migration Function (One-Time)

```typescript
// src/workspace-memory.ts

function runMigrationP0Cleanup(
  store: WorkspaceMemoryStore,
  nowIso: string
): WorkspaceMemoryStore {
  // Check if already run
  if (store.migrations?.includes(MIGRATION_ID)) {
    return store;
  }
  
  const entries = store.entries.map(entry => {
    // Skip explicit entries - user-added memories are preserved
    if (entry.source === "explicit") {
      return entry;
    }
    
    // Skip non-project types for snapshot marking
    // (Only project entries had snapshot pollution)
    if (entry.type !== "project") {
      return entry;
    }
    
    // Mark legacy snapshot violations as superseded
    if (isProjectSnapshotViolation(entry.text)) {
      return {
        ...entry,
        status: "superseded" as const,
        updatedAt: nowIso,
      };
    }
    
    return entry;
  });
  
  return {
    ...store,
    entries,
    migrations: [...(store.migrations || []), MIGRATION_ID],
    updatedAt: nowIso,
  };
}
```

### 5. Normalize with Always-On Credential Redaction

```typescript
// src/workspace-memory.ts

// Preserve existing normalization behavior
async function normalizeWorkspaceMemory(
  root: string,
  store: WorkspaceMemoryStore,
): Promise<WorkspaceMemoryStore> {
  const nowIso = new Date().toISOString();
  
  // Start with existing store normalization
  let result: WorkspaceMemoryStore = {
    ...store,
    workspace: { root, key: await workspaceKey(root) },
    limits: {
      maxRenderedChars: store.limits?.maxRenderedChars ?? LONG_TERM_LIMITS.maxRenderedChars,
      maxEntries: store.limits?.maxEntries ?? LONG_TERM_LIMITS.maxEntries,
    },
    entries: Array.isArray(store.entries) ? store.entries : [],
    updatedAt: nowIso,
  };
  
  // ALWAYS-ON: Redact credentials in all entries
  // This must run regardless of migration status
  result.entries = result.entries.map(entry => {
    const text = redactCredentials(entry.text);
    const rationale = entry.rationale 
      ? redactCredentials(entry.rationale) 
      : undefined;
    
    if (text === entry.text && rationale === entry.rationale) {
      return entry;
    }
    
    return {
      ...entry,
      text,
      rationale,
      updatedAt: nowIso,
    };
  });
  
  // ONE-TIME: Mark legacy snapshots as superseded
  result = runMigrationP0Cleanup(result, nowIso);
  
  // Remove superseded from active rendering
  const activeEntries = result.entries.filter(e => e.status !== "superseded");
  
  // Apply dedup and limits to active entries only
  const processed = enforceLongTermLimits(activeEntries);
  
  // Merge back: active entries + superseded entries (preserved in storage)
  const superseded = result.entries.filter(e => e.status === "superseded");
  
  return {
    ...result,
    entries: [...processed, ...superseded],
    updatedAt: nowIso,
  };
}
```

### 6. Extend P0c Snapshot Filter (Not Deferred)

```typescript
// src/extractors.ts

// Add to isProjectSnapshotViolation() or equivalent filter

// File counts - require snapshot context AND NOT limit context
const FILE_COUNT_PATTERN = /\d+\s*(?:個|个)?\s*(?:files?|文件)/i;
const FILE_SNAPSHOT_CONTEXT = /同步|synced|uploaded|downloaded|completed|generated|created|modified|processed|完成/i;
const FILE_LIMIT_CONTEXT = /limit|max|maximum|min|minimum|supports?|allowed|per\s+(?:batch|request|upload)/i;

if (FILE_COUNT_PATTERN.test(text)) {
  if (FILE_SNAPSHOT_CONTEXT.test(text) && !FILE_LIMIT_CONTEXT.test(text)) {
    return true; // snapshot violation
  }
}

// Test/suite counts
if (/\d+\s+tests?\s+pass(?:ed)?/i.test(text)) return true;
if (/\d+\s+suites?\s+(?:pass|fail)/i.test(text)) return true;

// Phase/Wave/Sprint/Milestone progress
if (/(?:phases?|waves?|sprints?|milestones?|tasks?)\s*\d+(?:\s*[-–]\s*\d+)?/i.test(text)) {
  if (/completed|done|finished|完成/i.test(text)) return true;
}
if (/(?:已完成|完成).{0,30}(?:phases?|waves?|sprints?|milestones?|tasks?)/i.test(text)) return true;
```

**Note**: Do NOT use bare `upload|download` as context. Use past-tense verbs or process states.

---

## Test Cases

### Credential Redaction (Always-On)

| Input | Expected Output |
|-------|-----------------|
| `Admin PIN 是 456123` | `Admin PIN 是 [REDACTED]` |
| `Admin PIN = 456123` | `Admin PIN = [REDACTED]` |
| `Admin PIN 456123` | `Admin PIN [REDACTED]` |
| `密碼：sushi` | `密碼：[REDACTED]` |
| `密码：sushi` | `密码：[REDACTED]` |
| `password: abc-123!` | `password: [REDACTED]` |
| `パスワード：secret` | `パスワード：[REDACTED]` |
| `비밀번호: secret` | `비밀번호: [REDACTED]` |
| `測試用戶名：shihlab，密碼：sushi` | `測試用戶名：[REDACTED]，密碼：[REDACTED]` |
| `密碼：sushi，用於測試` | `密碼：[REDACTED]，用於測試` |
| Credential in rationale | Redacted in both text and rationale |
| Explicit entry with PIN | Redacted, preserved |
| `[REDACTED]` in text | No change (idempotent) |

### Snapshot Detection

| Input | type | source | Is Violation? |
|-------|------|--------|---------------|
| `1237 tests pass, 226 suites` | project | compaction | ✅ Yes |
| `USB 同步：37 個文件` | project | compaction | ✅ Yes |
| `Phase 1-4 已完成` | project | compaction | ✅ Yes |
| `Waves 1-5 已完成` | project | compaction | ✅ Yes |
| `Upload limit is 10 files` | project | compaction | ❌ No (has "limit" context) |
| `Project supports 5 test suites` | project | compaction | ❌ No (no pass/fail) |
| `Phase 1-4 已完成` | project | explicit | ❌ No (explicit preserved) |
| Snapshot text | feedback | compaction | ❌ No (only project type) |
| Snapshot text | decision | compaction | ❌ No (only project type) |

### Migration Behavior

| Test | Description |
|------|-------------|
| Run once | Migration ID added |
| Run twice | No duplicate ID, entries unchanged |
| Non-project entry | Not marked superseded |
| Project snapshot | Marked superseded |
| Explicit project snapshot | Not marked (source check before type) |
| Credential in snapshot | Redacted, then marked superseded |

### Integration Tests

| Test | Description |
|------|-------------|
| `saveWorkspaceMemory()` | Superseded entries preserved in JSON |
| `updateWorkspaceMemory()` | Credential redaction runs on second normalize |
| New entry with PIN | Redacted on save (always-on) |
| `normalizeWorkspaceMemory()` | Preserves workspace root/key, limits, updatedAt |
| Memory render | Superseded entries excluded via `enforceLongTermLimits()` |

### Extractor Tests

| Input | Expected |
|-------|----------|
| `Upload limit is 10 files` | NOT a snapshot violation (has "limit" context) |
| `USB uploaded 37 files` | Snapshot violation (has "uploaded" process context) |
| `Project supports 5 test suites` | NOT a snapshot violation (no pass/fail context) |
| `1237 tests passed` | Snapshot violation (test count with pass) |

---

## Edge Cases

| Case | Handling |
|------|----------|
| Entry is explicit + snapshot | Not marked (source check before type check) |
| Entry has both snapshot + credential | Credential redacted, snapshot marked |
| Entry is already superseded | Keep status, still redact credentials |
| Migration runs twice | Skip if ID present |
| Store has no migrations field | Create empty array |
| `Upload limit is 10 files` | Not marked (has "limit" context) |
| Password with punctuation `abc-123!` | Captured by bounded pattern |
| Chinese comma after credential `密碼：sushi，用於測試` | Redact preserves `，用於測試` |
| Simplified Chinese `密码` | Preserved as `密码：[REDACTED]` |

---

## Implementation Order

1. Add `migrations` field to `WorkspaceMemoryStore` type
2. Add snapshot patterns to `src/extractors.ts` (not deferred)
3. Add `isProjectSnapshotViolation()` to `src/workspace-memory.ts`
4. Add `redactCredentials()` to `src/workspace-memory.ts`
5. Add `runMigrationP0Cleanup()` to `src/workspace-memory.ts`
6. Update `normalizeWorkspaceMemory()` with always-on redaction + migration
7. Do NOT add filtering to `getFrozenWorkspaceMemory()` - filtering happens in `enforceLongTermLimits()`
8. Add test cases for all patterns

---

## What We Will NOT Do

### Do NOT Add Project-Specific Entity Keys

Cloud Run, Basic Auth, IP privacy — these are project-specific. Natural canonical dedup handles exact duplicates.

### Do NOT Delete Superseded Entries

Mark as `status: "superseded"`, preserve in storage, exclude from render.

### Do NOT Gate Credential Redaction on Migration

Credential redaction is always-on. Migration only marks legacy snapshots.

---

## Summary

| Issue | Priority | Solution |
|-------|----------|----------|
| Sensitive credentials | P0 | Always-on redaction |
| Snapshot violations | P0 | Migration-gated marking (project type only) |
| Wave progress not filtered | P0 | Add to extractors.ts now |
| Project-specific duplicates | N/A | Natural dedup |

**Credential redaction runs on every normalize.**

**Snapshot marking is one-time migration for legacy entries.**

**Superseded entries preserved in storage, excluded from render.**

**Wave/Sprint/Milestone filter added now, not deferred.**

---

## Multilingual Scope

### Snapshot Detection: Chinese + English Only

Do **not** add Japanese/Korean/Spanish/French/German snapshot regexes now.

Reasons:
- False positives silently suppress valid durable memories
- Audit evidence only shows Chinese and English pollution
- Words like "completed", "terminé", "abgeschlossen" can appear in durable process descriptions
- Extraction is always-on, so every false positive becomes permanent blind spot

Add languages only after seeing real polluted memories in those languages.

### Credential Redaction: Add Multilingual Labels

For credentials, false negatives leak secrets. Add high-signal multilingual labels now.

**Password labels:**

```typescript
const PASSWORD_LABELS =
  /password|passwd|pwd|密碼|密码|パスワード|비밀번호|contraseña|mot de passe|passwort/i;
```

**Username labels:**

```typescript
const USERNAME_LABELS =
  /username|user name|用戶名|用户名|ユーザー名|사용자명|usuario|utilisateur|benutzer/i;
```

PIN remains language-neutral: `/\bPIN\b/i`

### Memory Trigger Patterns: Add Chinese Expansion + Japanese + Korean

#### Chinese Expansion

Add common phrases:

```typescript
// Current: 记住/記住
// Add: 记得/記得, 记下来/記下來

/(?:^|\n)\s*(?:请|請)?(?:帮我|幫我)?(?:记住|記住|记得|記得|记下来|記下來)(?:这一点|這一點|这点|這點|这个|這個)?[:：,，]?\s*(.+)$/gim
```

#### Japanese Positive Triggers

```typescript
/(?:^|\n)\s*(?:覚えておいて|覚えて|忘れないで|メモして)[:：,，]?\s*(.+)$/gim
```

Note: `覚えておいて` must come before `覚えて` to prevent partial match in body.
Note: `忘れないで` ("don't forget") is a positive memory request despite negative morphology.

#### Japanese Negation

```typescript
/(?:覚えないで|記憶しないで|メモしないで)\s*$/u
```

#### Korean Positive Triggers

```typescript
/(?:^|\n)\s*(?:기억해줘|기억해|잊지 마|잊지마|메모해줘|메모해)[:：,，]?\s*(.+)$/gim
```

Note: `기억해줘` must come before `기억해`, `메모해줘` must come before `메모해` to prevent partial match in body.
Note: `잊지 마` ("don't forget") is a positive memory request despite negative morphology.

#### Korean Negation

```typescript
/(?:기억하지\s*마|기억하지마|메모하지\s*마|메모하지마)\s*$/u
```

#### Priority

1. Chinese: `记得/記得`, `记下来/記下來` (small expansion)
2. Japanese (full patterns + negation)
3. Korean (full patterns + negation)
4. Defer: Spanish/German/French (higher collision risk with normal text)

### Tests Required

**Credential redaction:**

```text
パスワード：secret → [REDACTED]
비밀번호: secret → [REDACTED]
contraseña: secret → [REDACTED]
mot de passe: secret → [REDACTED]
Passwort: secret → [REDACTED]
```

**Memory triggers (positive):**

```text
记得：这个项目使用 pnpm
記下來：这个项目使用 pnpm
覚えて: このプロジェクトは pnpm を使う
覚えておいて: このプロジェクトは pnpm を使う
忘れないで: このプロジェクトは pnpm を使う
メモして: このプロジェクトは pnpm を使う
기억해: 이 프로젝트는 pnpm을 사용한다
기억해줘: 이 프로젝트는 pnpm을 사용한다
잊지 마: 이 프로젝트는 pnpm을 사용한다
메모해: 이 프로젝트는 pnpm을 사용한다
메모해줘: 이 프로젝트는 pnpm을 사용한다
```

**Memory triggers (body extraction - must not include trigger suffix):**

```text
覚えておいて: このプロジェクトは pnpm を使う
→ body is "このプロジェクトは pnpm を使う" (not "おいて: この...")

기억해줘: 이 프로젝트는 pnpm을 사용한다
→ body is "이 프로젝트는 pnpm을 사용한다" (not "줘: 이...")

메모해줘: 이 프로젝트는 pnpm을 사용한다
→ body is "이 프로젝트는 pnpm을 사용한다" (not "줘: 이...")
```

**Memory triggers (negation - should NOT trigger):**

```text
覚えないで 覚えて: temporary note only
メモしないで メモして: temporary note only
기억하지 마 기억해: temporary note only
메모하지 마 메모해: temporary note only
```

---

## Memory Quality Bar (Prompt Improvement)

### Problem

Current extraction accepts "facts that were mentioned" instead of "facts that will change future behavior."

Examples of low-value trivia:
- `Cloud Run revision: pre-cancer-atlas-website-00066-j8c` — transient deployment state
- `UI 要統一風格：兩個表格都要 scrollable，約 20 rows` — local implementation detail
- Paths observed from code/logs without stable contract

### Solution: Prompt Quality Bar

Add to compaction memory extraction prompt:

```text
Memory quality bar:
Extract only durable facts that will change future behavior: user preferences, decisions with rationale, stable constraints, or hard-to-rediscover references.

Do not extract trivia: transient IDs/revisions, task progress, test/file counts, bare status updates, local UI details, or facts easily rediscovered from the repo.

When unsure, skip it. Fewer high-signal memories are better than many low-value ones.
```

### Example Pair (Optional)

If model still stores junk, add one example:

```text
Bad: Cloud Run revision: xyz-00066
Good: Revision xyz-00066 is the last known good deploy before the auth regression.
```

### What This Captures

| Keep | Reject |
|------|--------|
| User preferences | Transient IDs/revisions |
| Decisions with rationale | Task progress, test/file counts |
| Stable constraints | Bare status updates |
| Hard-to-rediscover references | Local UI details |
| | Rediscoverable facts |

### Why Prompt Instead of Code Filters

- Context matters: "Cloud Run revision" might be useful if framed as "last known good before regression"
- Avoid regex whack-a-mole for every trivia pattern
- Model can judge wording and context
- Easier to iterate on prompt than code

### Code Filters (Stay Minimal)

Keep only hard invariants:
- Credentials (security)
- Obvious snapshots (test counts, phase progress)

Do NOT add new filters for deployment revisions, status updates, or UI trivia. Let prompt handle those.

---

## Summary