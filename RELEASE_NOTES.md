# Release Notes

## 1.2.0 (2026-04-26)

### Memory V2 Architecture

This release introduces a complete architectural redesign from the previous four-tier memory system to a streamlined three-layer architecture:

```
┌──────────────────────────────────────────────────────────────────┐
│  LAYER 1: WORKSPACE MEMORY                                       │
│  Persists across sessions in same workspace (survives restart)  │
│  Extracted during compaction - NO EXTRA API CALL                │
└──────────────────────────────────────────────────────────────────┘
          ↑
┌──────────────────────────────────────────────────────────────────┐
│  LAYER 2: HOT SESSION STATE                                      │
│  Per-session, auto-tracked, resets on new session                │
│  Tracks: Active files, Open errors, Recent decisions            │
└──────────────────────────────────────────────────────────────────┘
          ↑
┌──────────────────────────────────────────────────────────────────┐
│  LAYER 3: NATIVE OPENCODE STATE                                  │
│  Uses OpenCode's built-in todos - No plugin storage needed       │
└──────────────────────────────────────────────────────────────────┘
```

### Key Features

- **Cross-session memory**: Workspace memory persists between sessions in the same workspace
- **No extra API calls**: Memory extraction piggybacks on OpenCode's existing compaction summary
- **Zero configuration**: Works out of the box with sensible defaults
- **Zero tools**: No manual memory management needed - fully automatic

### Added

- **Workspace Memory**: Long-term memory that survives restarts and compactions
  - Types: `feedback`, `project`, `decision`, `reference`
  - Sources: `explicit` (user), `compaction`, `manual`
  - Limits: 5200 chars / 28 entries

- **Hot Session State**: Automatic tracking for current session
  - Active files with action-based ranking
  - Open errors with fingerprinting
  - Recent decisions for compaction promotion

- **Quality Gates**:
  - Canonical deduplication of workspace memories
  - Negative memory request filtering ("don't remember")
  - Compaction quality gate (rejects git hashes, stack traces, path-heavy facts)

### Fixed

- **False positive error tracking**: `exitCode === undefined` no longer creates spurious errors from commands like `git log` or `cat`
- **XML truncation**: Workspace memory rendering never truncates closing `</workspace_memory>` tag
- **Negative memory filtering**: Correctly interprets "don't remember this" and "不要記住"
- **"always" trigger removed**: No longer treats "always" as a memory trigger keyword

### Changed

- **Storage location**: `~/.local/share/opencode-working-memory/workspaces/{workspaceKey}/`
- **No manual tools**: Removed `core_memory_update`, `core_memory_read` - memory is fully automatic
- **Hook-based extraction**: Memory is extracted during `experimental.session.compacting` hook

### Breaking Changes

- Previous four-tier architecture is replaced with three-layer architecture
- Core Memory blocks (goal/progress/context) removed in favor of typed entries
- Working Memory slots and pool replaced with Hot Session State
- Pressure monitoring and smart pruning removed (not needed with new architecture)

### Migration

- Old memory files (`.opencode/memory-core/`, `.opencode/memory-working/`) are not migrated
- New storage location is used (`~/.local/share/opencode-working-memory/`)
- No action required - plugin starts fresh with new architecture

### Technical Details

- **Plugin entry**: `index.ts` exports `{ id: "working-memory", server: MemoryV2Plugin }`
- **Hooks implemented**:
  - `experimental.chat.system.transform` - Inject workspace memory and hot session state
  - `tool.execute.after` - Track active files and open errors
  - `experimental.session.compacting` - Extract workspace memory candidates
  - `event` - Handle session lifecycle events

### Files in Package

```
index.ts
src/extractors.ts
src/opencode.ts
src/paths.ts
src/plugin.ts
src/session-state.ts
src/storage.ts
src/types.ts
src/workspace-memory.ts
README.md
LICENSE
```

---

## 1.1.2 (Previous Version)

- Four-tier memory architecture
- Core Memory blocks (goal/progress/context)
- Working Memory with slots and pool
- Pressure monitoring with interventions
- Smart pruning of tool outputs