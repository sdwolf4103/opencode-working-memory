# AGENTS.md - OpenCode Working Memory Plugin Development Guide

## Project Overview

The **OpenCode Working Memory Plugin** provides a **three-layer memory architecture** for AI agents:

1. **Workspace Memory** - Long-term memory that persists across sessions (decisions, project info, references)
2. **Hot Session State** - Automatic tracking of active files, open errors, and recent decisions
3. **Native OpenCode State** - Delegated to OpenCode's built-in todos during compaction

Written in **TypeScript** for the OpenCode agent environment.

## Installation

```bash
# For development
git clone https://github.com/sdwolf4103/opencode-working-memory.git
cd opencode-working-memory
npm install
npm test
npm run typecheck

# For usage (see README.md)
```

## Build & Development Commands

### Type Checking
```bash
# TypeScript strict mode - fix all type errors before committing
npx tsc --noEmit
```

### Testing
```bash
# Run all tests
npm test

# Run specific test file
npx node --test --experimental-strip-types tests/plugin.test.ts
```

Tests verify:
- Error extraction false positive guards
- Explicit memory trigger patterns
- Negative memory request filtering
- Compaction candidate quality gate
- Workspace memory rendering
- Session state tracking

### File Structure
```
opencode-working-memory/
├── index.ts               # Plugin entry point (exports PluginModule)
├── src/
│   ├── plugin.ts           # Main plugin implementation
│   ├── extractors.ts       # Memory extraction logic
│   ├── workspace-memory.ts # Workspace memory management
│   ├── session-state.ts    # Session state tracking
│   ├── storage.ts          # File storage utilities
│   ├── paths.ts            # Path utilities
│   ├── opencode.ts         # OpenCode SDK types
│   └── types.ts            # Type definitions
├── tests/
│   ├── plugin.test.ts      # Plugin hook tests
│   ├── extractors.test.ts  # Extractor tests
│   └── workspace-memory.test.ts # Workspace memory tests
├── package.json            # Plugin manifest
├── tsconfig.json           # TypeScript config
├── LICENSE                 # MIT license
├── README.md               # User documentation
├── AGENTS.md               # This file (developer guide)
└── docs/                   # Detailed documentation
    ├── installation.md
    ├── architecture.md
    └── configuration.md
```

## Code Style Guidelines

### TypeScript Strict Mode

```typescript
// ✅ REQUIRED: Full type annotations, no implicit any
async function loadWorkspaceMemory(
  workspaceKey: string
): Promise<WorkspaceMemoryStore | null>

// ❌ AVOID: Implicit any types
async function loadWorkspaceMemory(workspaceKey) { }
```

### Type Definitions

```typescript
// ✅ REQUIRED: Define types at module top
export type LongTermMemoryEntry = {
  id: string;
  type: LongTermType;
  text: string;
  source: LongTermSource;
  confidence: number;
  status: "active" | "superseded";
  createdAt: string;
  updatedAt: string;
};

// ✅ USE: Union types for variants (not enums)
export type LongTermType = "feedback" | "project" | "decision" | "reference";
export type LongTermSource = "explicit" | "compaction" | "manual";

// ✅ USE: const assertions for limits
export const LONG_TERM_LIMITS = {
  maxRenderedChars: 5200,
  maxEntries: 28,
} as const;
```

### Imports & Module Organization

```typescript
// ✅ REQUIRED: Group and order imports
// 1. Node.js built-ins
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

// 2. Third-party (OpenCode SDK)
import type { Plugin } from "@opencode-ai/plugin";

// 3. Local modules
import { loadWorkspaceMemory } from "./storage.js";
```

### Naming Conventions

```typescript
// ✅ REQUIRED: camelCase for variables & functions
const maxEntries = 28;
async function loadWorkspaceMemory() { }

// ✅ REQUIRED: SCREAMING_SNAKE_CASE for constants
const LONG_TERM_LIMITS = { maxRenderedChars: 5200, maxEntries: 28 };
const HOT_STATE_LIMITS = { maxRenderedChars: 1200 };

// ✅ REQUIRED: PascalCase for types
type WorkspaceMemoryStore = { ... };
type SessionState = { ... };

// ✅ REQUIRED: get*/load*/save* naming for file operations
function getWorkspaceMemoryPath(workspaceKey: string): string { }
async function loadWorkspaceMemory(workspaceKey: string): Promise<WorkspaceMemoryStore | null> { }
async function saveWorkspaceMemory(memory: WorkspaceMemoryStore): Promise<void> { }
```

### Function Signatures & Organization

```typescript
// ✅ REQUIRED: Parameters on separate lines if > 80 chars
async function extractWorkspaceMemoryCandidates(
  content: string
): Promise<WorkspaceMemoryCandidate[]> {
  // ...
}

// ✅ REQUIRED: Explicit return types (no inference)
function renderWorkspaceMemory(
  entries: LongTermMemoryEntry[],
  maxChars: number
): string {
  // ...
}

// ✅ REQUIRED: Async for file/network I/O
async function saveWorkspaceMemory(memory: WorkspaceMemoryStore): Promise<void> {
  // ...
}
```

### Error Handling

```typescript
// ✅ REQUIRED: Try-catch with graceful degradation
async function loadWorkspaceMemory(workspaceKey: string): Promise<WorkspaceMemoryStore | null> {
  const path = getWorkspaceMemoryPath(workspaceKey);
  if (!existsSync(path)) return null;

  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as WorkspaceMemoryStore;
  } catch (error) {
    // Plugin should never block agent - return null and continue
    return null;
  }
}

// ✅ REQUIRED: Validate JSON before use
const data = JSON.parse(content);
const typedData = data as WorkspaceMemoryStore;  // Explicit cast after validation
```

### Comments & Documentation

```typescript
// ✅ REQUIRED: Section headers for major sections
// ============================================================================
// Workspace Memory: Long-term cross-session storage
// ============================================================================

// ✅ REQUIRED: Block comments for complex logic
// Quality gate: Reject candidates that are git hashes, errors, or path-heavy
function shouldAcceptWorkspaceMemoryCandidate(candidate: string): boolean {
  // ...
}

// ✅ USE: Inline comments sparingly for non-obvious logic
const canonical = normalizeText(text);  // Lowercase, strip punctuation, collapse whitespace
```

## Key Implementation Details

### Plugin Entry Point

```typescript
// index.ts
import { MemoryV2Plugin } from "./src/plugin.ts";

export default {
  id: "working-memory",
  server: MemoryV2Plugin,
};
```

### Workspace Memory Files

- **Location**: `~/.local/share/opencode-working-memory/workspaces/{workspaceKey}/workspace-memory.json`
- **Workspace Key**: First 16 chars of `sha256(realpath(workspaceRoot))`
- **Schema**: See `src/types.ts:WorkspaceMemoryStore`
- **Limits**: 5200 chars, 28 entries max

### Session State Files

- **Location**: `~/.local/share/opencode-working-memory/workspaces/{workspaceKey}/sessions/{sessionID}.json`
- **Session ID**: Hash of session ID from OpenCode
- **Schema**: See `src/types.ts:SessionState`

### Memory Types

| Type | Purpose | Stale After |
|------|---------|-------------|
| `feedback` | User preferences | 90 days |
| `project` | Project info | 60 days |
| `decision` | Important decisions | 45 days |
| `reference` | Key references | 90 days |

### Quality Guards

1. **False Positive Error Prevention**: Commands with "error" in output but `exitCode === undefined` are not tracked as errors
2. **Negative Memory Filtering**: "don't remember" patterns are correctly interpreted
3. **Compaction Quality Gate**: Rejects git hashes, stack traces, path-heavy facts

## Plugin Hooks

### `experimental.chat.system.transform`

Injects workspace memory and hot session state into system prompt.

### `tool.execute.after`

- Tracks active files (read, grep, edit, write actions)
- Tracks open errors from failed commands
- Clears errors when commands succeed
- Ignores `exitCode === undefined`

### `experimental.session.compacting`

Extracts workspace memory candidates from conversation, applies quality gate and deduplication.

### `event`

- `session.compacted`: Promote session decisions to workspace memory
- `session.deleted`: Clean up session state files

## Debugging & Testing

### Manual Testing Steps

1. **Workspace Memory**: Check `~/.local/share/opencode-working-memory/workspaces/*/workspace-memory.json` after compaction
2. **Session State**: Check `~/.local/share/opencode-working-memory/workspaces/*/sessions/*.json` after tool usage
3. **Error Tracking**: Run failing commands, verify errors appear in session state
4. **Error Clearing**: Run successful commands, verify errors are cleared

### Common Issues

- **File not found**: Ensure `~/.local/share/opencode-working-memory/` exists and is writable
- **Type errors**: Check all imports use `import type { ... }` for types
- **Memory not persisting**: Verify workspace key is consistent (same workspace = same key)
- **False positive errors**: Check `exitCode` handling in `plugin.ts`

## Performance Considerations

- **Workspace memory budget**: 5200 chars injected into system prompt
- **Session state budget**: 1200 chars injected into system prompt
- **Total overhead**: ~1500-6000 chars per message (minimal)
- **Storage footprint**: ~2-5 KB per workspace for memory, ~1-3 KB per session

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes following the code style guidelines above
4. Run tests: `npm test && npm run typecheck`
5. Commit with descriptive message: `git commit -m "feat: add ..."`
6. Push to your fork: `git push origin feature/my-feature`
7. Open a pull request

## Architecture Documentation

See `docs/architecture.md` for detailed technical documentation including:
- Three-layer memory architecture
- Memory extraction and quality gates
- Error fingerprinting
- Deduplication strategies

---

**Last Updated**: April 2026  
**Plugin Status**: Production (Memory V2 architecture)