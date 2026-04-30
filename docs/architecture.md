# Architecture Documentation

## Overview

OpenCode Working Memory implements a **three-layer memory architecture** designed to preserve context across OpenCode session compactions.

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1: WORKSPACE MEMORY (Long-term, cross-session)      │
│  • Persistent storage: ~/.local/share/opencode-working-...  │
│  • Types: feedback | project | decision | reference        │
│  • Sources: explicit | compaction | manual                  │
│  • Render limits: 3600 chars / 28 entries                    │
│  • Survives: session reset, compaction (same workspace)    │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  LAYER 2: HOT SESSION STATE (Short-term, per-session)        │
│  • Session-scoped tracking: active files, open errors       │
│  • Storage: sessions/{sessionID}.json                       │
│  • Auto-extracted from tool usage patterns                  │
│  • Cleared: on new session start                             │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  LAYER 3: NATIVE OPENCODE STATE                             │
│  • Uses OpenCode's built-in todos during compaction          │
│  • No additional storage required                            │
│  • Delegated to OpenCode's native features                   │
└─────────────────────────────────────────────────────────────┘
```

## Layer 1: Workspace Memory

### Purpose

Long-term memory that persists across sessions within the same workspace. Perfect for:
- Project conventions and patterns
- Important decisions that span sessions
- User preferences for this codebase

### Storage

- **Location**: `~/.local/share/opencode-working-memory/workspaces/{workspaceKey}/workspace-memory.json`
- **Workspace Key**: First 16 chars of `sha256(realpath(workspaceRoot))`
- **Schema**:
  ```typescript
  {
    version: 1,
    workspace: { root: string, key: string },
    limits: { maxRenderedChars: 3600, maxEntries: 28 },
    entries: LongTermMemoryEntry[],
    lastActivityAt?: string,
    updatedAt: string
  }
  ```

### Entry Types

| Type | Purpose | Example |
|------|---------|---------|
| `feedback` | User preferences | "User prefers functional React components" |
| `project` | Project-level info | "This monorepo uses turborepo" |
| `decision` | Important decisions | "Use PostgreSQL for primary database" |
| `reference` | Key references | "API endpoints defined in `src/api/`" |

### Entry Sources

| Source | Confidence | How Added |
|--------|------------|-----------|
| `explicit` | 1.0 | User said "remember this" |
| `compaction` | 0.75 | Extracted during compaction |
| `manual` | varies | Programmatically added |

### Memory Extraction

During compaction, OpenCode Working Memory scans for `Memory candidates:` sections:

```
Memory candidates:
- [decision] Use npm cache for plugin loading
- [project] This repo uses TypeScript with strict mode
```

**Legacy Format**: OpenCode Working Memory also accepts `<workspace_memory_candidates>` XML blocks for backward compatibility, but this format is deprecated.

**Quality Gate**: Not all candidates become memories. OpenCode Working Memory rejects:
- Git commit hashes (e.g., `abc1234`)
- Raw errors (e.g., `Error: something failed`)
- Stack traces
- Path-heavy facts (>50% paths)
- Very short text (<20 chars)

### Consolidation, Deduplication, and Retention

Memories are deduplicated and consolidated with accounting:

1. Normalize exact text: lowercase, strip punctuation, collapse whitespace.
2. Group project/reference entries by identity where possible.
3. Keep decision and feedback entries on exact canonical matching to avoid broad semantic merges.
4. Keep the best surviving entry by source, confidence, specificity, and freshness tie-breakers.
5. Emit accounting events so pending memories can be classified as promoted, absorbed, superseded, or rejected.

This prevents absorbed or superseded pending memories from retrying forever while still preserving the active surviving memory.

Retention then decides which active memories are rendered into prompt context. It does not hard-delete old memories by age.

```typescript
strength = initialStrength * 2 ** (-effectiveAgeDays / effectiveHalfLifeDays)
```

Initial strength is based on memory type, source, optional user importance, and safety-critical status. Confidence remains stored for compatibility but is not part of retention scoring.

Rendered candidates are selected in this order:

1. Exclude `status: "superseded"` entries.
2. Compute current retention strength.
3. Sort by strength descending.
4. Apply per-type caps, with safety-critical entries exempt from type caps.
5. Keep the top 28 rendered entries under the workspace memory character budget.

Default type caps:

| Type | Rendered cap |
|------|--------------|
| `feedback` | 10 |
| `decision` | 10 |
| `project` | 8 |
| `reference` | 6 |

The type-cap total is 34, intentionally above the global 28-entry cap. These are maximums, not quotas.

Dormant workspaces age more slowly: after 14 inactive days, additional dormant time counts at 0.25x for retention decay. Repeated duplicate memories reinforce the surviving entry and slow future decay, but same-session and under-one-hour repeats do not stack reinforcement.

### System Prompt Injection

Workspace memory is injected at the top of every message:

```
Workspace memory (cross-session, verify if stale):
decision:
- Use npm cache for plugin loading, not npm link
project:
- This repo uses the opencode-agenthub plugin system
reference:
- Storage: ~/.local/share/opencode-working-memory/...
```

## Layer 2: Hot Session State

### Purpose

Track current session context automatically:
- What files are you working on?
- What errors are currently open?
- What decisions were made recently?

### Storage

- **Location**: `~/.local/share/opencode-working-memory/workspaces/{workspaceKey}/sessions/{hashedSessionID}.json`
- **Schema**:
  ```typescript
  {
    version: 1,
    sessionID: string,
    turn: number,
    updatedAt: string,
    activeFiles: ActiveFile[],
    openErrors: OpenError[],
    recentDecisions: SessionDecision[]
  }
  ```

### Active Files

Automatically tracked from `tool.execute.after` events:

| Action | Weight |
|--------|--------|
| `edit` | 50 |
| `write` | 45 |
| `grep` | 30 |
| `read` | 20 |

Files are ranked by: `ACTION_WEIGHT[action] + count * 3`

### Open Errors

Tracked from `tool.execute.after` events when `exitCode !== 0`:

| Category | Trigger Pattern |
|----------|-----------------|
| `typecheck` | `TS####:` or TypeScript errors |
| `test` | Test failures |
| `lint` | ESLint warnings/errors |
| `build` | Build failures |
| `runtime` | `Error:`, `TypeError:`, etc. |

**False Positive Guards**:
- Commands like `git log`, `cat` with "error" in output are ignored
- Only actual command failures (`exitCode !== 0`) trigger errors
- `exitCode === undefined` is ignored (no error created, no error cleared)

### Error Fingerprinting

Errors are fingerprinted by:
1. Extract error message summary
2. Generate fingerprint: `first 12 chars of sha256(summary)`
3. Group similar errors by fingerprint

### recentDecisions

Short-term decisions made this session. Candidates for promotion to workspace memory during compaction.

### System Prompt Injection

Hot session state is injected after workspace memory:

```
---

Hot session state (current session):

active_files:
- src/plugin.ts (edit, 18x)
- tests/plugin.test.ts (edit, 5x)

open_errors: (none)

recent_decisions:
- Use frozen workspace memory snapshots for cache stability

pending_memories:
- [decision] Parser supports 3 candidate formats
```

## Layer 3: Native OpenCode State

### Purpose

Delegate task tracking to OpenCode's native features.

### Behavior

- Uses OpenCode's built-in `todos` during compaction
- No additional storage or injection required
- Allows the agent to manage task lists natively

## Plugin Hooks

OpenCode Working Memory hooks into OpenCode lifecycle events:

### `experimental.chat.system.transform`

Injects workspace memory and hot session state into system prompt.

### `tool.execute.after`

- Tracks active files (read, grep, edit, write actions)
- Tracks open errors from failed commands
- Clears errors when commands succeed
- Ignores `exitCode === undefined` (successful commands without explicit exit codes)

### `experimental.session.compacting`

Extracts workspace memory candidates from conversation.
Applies quality gate, redaction, migration, consolidation accounting, deduplication, and source priority.

### `event` (session.compacted, session.deleted)

- `session.compacted`: Promote session decisions to workspace memory
- `session.deleted`: Clean up session state files

Promotion uses accounting results from workspace memory normalization. Pending memories that are kept are promoted; duplicate memories are absorbed; exact decision replacements can be superseded; over-capacity compaction memories are rejected. Stale-marked memories are not hard-pruned by age; they lose rendered space through retention strength and cap competition.

## Quality Guarantees

### No False Positive Errors

```typescript
// Bad: Would create false positive
"Error: something failed" in output

// Good: Actually failed
exitCode === 1 && output.includes("Error")

// Good: Actually succeeded
exitCode === 0 (clears errors for that category)

// Good: Ignore ambiguous cases
exitCode === undefined → skip error tracking
```

### Negative Memory Filtering

```typescript
// Correctly interpreted
"don't remember this" → NOT added to memory
"不要記住這個" → NOT added to memory
"remember this" → added to memory candidates
```

### Canonical Deduplication

```typescript
// Same memory (after normalization)
"Use npm cache for plugins"
"USE NPM CACHE for plugins!!"
"use npm cache for plugins."

// All map to same canonical key
canonical("Use npm cache for plugins") === "use npm cache for plugins"
```

### Compaction Quality Gate

```typescript
// Rejected (not valuable as long-term memory)
"4832b38 fix: something"  // git hash
"Error: something failed"  // raw error
"at Object.method (file.ts:42)"  // stack trace
"/Users/x/project/file.ts /Users/x/project/other.ts"  // path-heavy

// Accepted
"[decision] Use npm cache for plugin loading"  // good pattern
```

## File System Layout

```
~/.local/share/opencode-working-memory/
└── workspaces/
    └── {workspaceKey}/
        ├── workspace-memory.json      # Long-term memory
        └── sessions/
            └── {hashedSessionID}.json  # Session state
```

### Workspace Key

```typescript
// First 16 chars of SHA-256 hash of workspace root realpath
const workspaceKey = sha256(realpath(workspaceRoot)).slice(0, 16)
```

### Storage Safety

All read-modify-write updates go through `updateJSON()`, which combines an in-process promise queue with an on-disk `.lock` file. The lock file uses exclusive creation, heartbeat refreshes while held, stale-lock recovery after 30 seconds, and a 5 second wait timeout for live contention. Direct `readJSON()` is fallback-oriented and does not mutate data except when corrupt JSON is quarantined.

## Performance Considerations

### Memory Budgets

| Layer | Max Chars | Max Entries |
|-------|-----------|-------------|
| Workspace Memory | 3600 | 28 |
| Hot Session State | 700 | 8 files, 3 errors |

### Injection Overhead

- Workspace memory: usually under ~2000 chars in observed rendered output
- Hot session state: usually under ~500 chars in observed rendered output
- Total: typically well below the configured maximums

### Storage Footprint

- Workspace memory: ~2-5 KB per workspace
- Session state: ~1-3 KB per session
- Auto-cleanup on workspace/session deletion

## Extension Points

### Custom Memory Types

Add new types in `src/types.ts`:
```typescript
export type LongTermType = "feedback" | "project" | "decision" | "reference" | "custom";
```

### Custom Error Categories

Add new categories in `src/types.ts`:
```typescript
export type ErrorCategory = "typecheck" | "test" | "lint" | "build" | "runtime" | "custom";
```

### Custom Extraction Patterns

Modify `src/extractors.ts` to add new extraction patterns.

## Migration Notes

### Memory V1 to V2

OpenCode Working Memory automatically migrates old format files to the new three-layer architecture. No manual intervention needed.

---

**Last Updated**: April 2026  
**Implementation**: `src/plugin.ts`, `src/extractors.ts`, `src/workspace-memory.ts`, `src/session-state.ts`
