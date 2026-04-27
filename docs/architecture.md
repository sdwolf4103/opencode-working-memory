# Architecture Documentation

## Overview

The Working Memory Plugin implements a **three-layer memory architecture** designed to preserve context across OpenCode session compactions.

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1: WORKSPACE MEMORY (Long-term, cross-session)      │
│  • Persistent storage: ~/.local/share/opencode-working-...  │
│  • Types: feedback | project | decision | reference        │
│  • Sources: explicit | compaction | manual                  │
│  • Limits: 5200 chars / 28 entries                          │
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
    limits: { maxRenderedChars: 5200, maxEntries: 28 },
    entries: LongTermMemoryEntry[],
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

During compaction, the plugin scans for `Memory candidates:` sections:

```
Memory candidates:
- [decision] Use npm cache for plugin loading
- [project] This repo uses TypeScript with strict mode
```

**Legacy Format**: The plugin also accepts `<workspace_memory_candidates>` XML blocks for backward compatibility, but this format is deprecated.

**Quality Gate**: Not all candidates become memories. The plugin rejects:
- Git commit hashes (e.g., `abc1234`)
- Raw errors (e.g., `Error: something failed`)
- Stack traces
- Path-heavy facts (>50% paths)
- Very short text (<20 chars)

### Deduplication

Memories are deduplicated using **canonical text matching**:
1. Normalize: lowercase, strip punctuation, collapse whitespace
2. Hash the canonical text
3. Keep the entry with highest confidence

### System Prompt Injection

Workspace memory is injected at the top of every message:

```
<workspace_memory>
- [decision] Use npm cache for plugin loading, not npm link
- [project] This repo uses opencode-agenthub plugin system
- [reference] Storage: ~/.local/share/opencode-working-memory/...
</workspace_memory>
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

The plugin hooks into OpenCode lifecycle events:

### `experimental.chat.system.transform`

Injects workspace memory and hot session state into system prompt.

### `tool.execute.after`

- Tracks active files (read, grep, edit, write actions)
- Tracks open errors from failed commands
- Clears errors when commands succeed
- Ignores `exitCode === undefined` (successful commands without explicit exit codes)

### `experimental.session.compacting`

Extracts workspace memory candidates from conversation.
Applies quality gate, deduplication, and source priority.

### `event` (session.compacted, session.deleted)

- `session.compacted`: Promote session decisions to workspace memory
- `session.deleted`: Clean up session state files

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

## Performance Considerations

### Memory Budgets

| Layer | Max Chars | Max Entries |
|-------|-----------|-------------|
| Workspace Memory | 5200 | 28 |
| Hot Session State | 1200 | 8 files, 3 errors |

### Injection Overhead

- Workspace memory: ~200-500 chars per message
- Hot session state: ~200-400 chars per message
- Total: ~400-900 chars per message (minimal)

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

The plugin automatically migrates old format files to the new three-layer architecture. No manual intervention needed.

---

**Last Updated**: April 2026  
**Implementation**: `src/plugin.ts`, `src/extractors.ts`, `src/workspace-memory.ts`, `src/session-state.ts`