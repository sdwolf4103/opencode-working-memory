# AGENTS.md - OpenCode Working Memory Plugin Development Guide

## Project Overview

The **OpenCode Working Memory Plugin** provides a four-tier memory architecture for AI agents:
- **Core Memory** - Persistent blocks (goal/progress/context) that survive compaction
- **Working Memory** - Session-scoped context with slots (error/decision/todo/dependency) and memory pool
- **Smart Pruning** - Automatic filtering of tool outputs before adding to context
- **Pressure Monitoring** - Tracks context usage and triggers interventions at thresholds

Written in **TypeScript** for the OpenCode agent environment.

## Installation

```bash
# For development
git clone https://github.com/yourusername/opencode-working-memory.git
cd opencode-working-memory
npm install

# For usage (see README.md)
```

## Build & Development Commands

### Type Checking
```bash
# TypeScript strict mode - fix all type errors before committing
npx tsc --noEmit
```

### Testing
Tests are manually verified through OpenCode sessions:
```bash
# 1. Load plugin in OpenCode session
# 2. Run commands that trigger hooks (e.g., tool execution, compaction)
# 3. Inspect .opencode/memory-core/ and .opencode/memory-working/
# 4. Verify memory blocks appear in system prompts
```

### File Structure
```
opencode-working-memory/
├── index.ts               # Main plugin (1700+ lines)
├── package.json           # Plugin manifest
├── tsconfig.json          # TypeScript config
├── LICENSE                # MIT license
├── README.md              # User documentation
├── AGENTS.md              # This file (developer guide)
└── docs/                  # Detailed documentation
    ├── installation.md
    ├── architecture.md
    └── configuration.md
```

## Code Style Guidelines

### TypeScript Strict Mode

```typescript
// ✅ REQUIRED: Full type annotations, no implicit any
async function loadCoreMemory(
  directory: string,
  sessionID: string
): Promise<CoreMemory | null>

// ❌ AVOID: Implicit any types
async function loadCoreMemory(directory, sessionID) { }
```

### Type Definitions

```typescript
// ✅ REQUIRED: Define types at module top
type CoreMemory = {
  sessionID: string;
  blocks: {
    goal: CoreBlock;
    progress: CoreBlock;
    context: CoreBlock;
  };
  updatedAt: string;
};

// ✅ USE: Union types for variants (not enums)
type PressureLevel = "safe" | "moderate" | "high" | "critical";

// ✅ USE: Record<> for keyed configs
const SLOT_CONFIG: Record<SlotType, number> = {
  error: 3,
  decision: 5,
  todo: 3,
  dependency: 3,
};
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
import { tool } from "@opencode-ai/plugin";

// 3. Local modules (if any)
// (none currently)
```

### Naming Conventions

```typescript
// ✅ REQUIRED: camelCase for variables & functions
const maxItems = 50;
async function loadCoreMemory() { }

// ✅ REQUIRED: SCREAMING_SNAKE_CASE for constants
const CORE_MEMORY_LIMITS = { goal: 1000, progress: 2000, context: 1500 };
const SLOT_CONFIG = { error: 3, decision: 5, todo: 3, dependency: 3 };

// ✅ REQUIRED: PascalCase for types
type CoreMemory = { ... };
type WorkingMemoryItem = { ... };

// ✅ REQUIRED: get*/set*/load*/save* naming for file operations
function getCoreMemoryPath(directory: string, sessionID: string): string { }
async function loadCoreMemory(directory: string, sessionID: string): Promise<CoreMemory | null> { }
async function saveCoreMemory(directory: string, memory: CoreMemory): Promise<void> { }

// ✅ REQUIRED: ensure*/validate* for pre-checks
async function ensureCoreMemoryDir(directory: string): Promise<void> { }

// ✅ REQUIRED: Prefix private/internal functions with _
function _compressPath(filePath: string): string { }
```

### Function Signatures & Organization

```typescript
// ✅ REQUIRED: Parameters on separate lines if > 80 chars
async function loadWorkingMemory(
  directory: string,
  sessionID: string
): Promise<WorkingMemory | null> {
  // ...
}

// ✅ REQUIRED: Explicit return types (no inference)
function getCompactionLogPath(directory: string, sessionID: string): string {
  return join(directory, ".opencode", "memory-working", `${sessionID}_compaction.json`);
}

// ✅ REQUIRED: Async for file/network I/O
async function saveCoreMemory(directory: string, memory: CoreMemory): Promise<void> {
  // ...
}
```

### Error Handling

```typescript
// ✅ REQUIRED: Try-catch with descriptive console.error
async function loadCoreMemory(directory: string, sessionID: string): Promise<CoreMemory | null> {
  const path = getCoreMemoryPath(directory, sessionID);
  if (!existsSync(path)) return null;

  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as CoreMemory;
  } catch (error) {
    console.error("Failed to load core memory:", error);
    return null;  // Graceful degradation
  }
}

// ✅ REQUIRED: Type guards for runtime safety
if (!existsSync(path)) {
  return null;
}

// ✅ REQUIRED: Validate JSON before use
const data = JSON.parse(content);
const typedData = data as CoreMemory;  // Explicit cast after validation
```

### Comments & Documentation

```typescript
// ✅ REQUIRED: Section headers for major sections
// ============================================================================
// Phase 1: Core Memory Foundation
// ============================================================================

// ✅ REQUIRED: Block comments for complex logic
// Migration: Convert old format (items array) to new format (slots + pool)
if (data.items && !data.slots) {
  // ... migration logic
}

// ✅ USE: Inline comments sparingly
const gamma = 0.85;  // Exponential decay rate (15% per event)

// ✅ AVOID: Over-commenting obvious code
const name = "test";  // Set name to test ❌ (obvious)
```

### Code Organization

```typescript
// ✅ REQUIRED: Organize plugin file by phase/feature
// 1. Header & module documentation
// 2. Imports
// 3. Types & schemas (grouped by phase)
// 4. Constants & configs
// 5. Helper functions (private first, public after)
// 6. Main plugin export
// 7. Hook implementations

export default {
  // Plugin definition
} as Plugin;
```

### Working with OpenCode Plugin SDK

```typescript
// ✅ REQUIRED: Use proper hook signatures
import { tool, type Plugin } from "@opencode-ai/plugin";

export default {
  id: "working-memory",
  name: "Working Memory Plugin",
  
  // ✅ Core hooks
  hooks: {
    "tool.execute.after": async (ctx) => {
      // Tool just executed
    },
    "experimental.chat.system.transform": async (ctx) => {
      // Transform system prompt before sending
    },
    "experimental.session.compacting": async (ctx) => {
      // Session is being compacted (clearing old messages)
    },
  },
  
  // ✅ Exposed tools
  tools: [
    tool({
      id: "core_memory_update",
      name: "Update Core Memory",
      description: "Update goal/progress/context blocks",
      // ... schema & execute
    }),
  ],
} as Plugin;
```

## Key Implementation Details

### Core Memory Files
- Location: `.opencode/memory-core/<sessionID>.json`
- Schema: `{ sessionID, blocks: { goal, progress, context }, updatedAt }`
- Limits: goal (1000 chars), progress (2000 chars), context (1500 chars)

### Working Memory Files
- Location: `.opencode/memory-working/<sessionID>.json`
- Schema: `{ sessionID, slots, pool, eventCounter, updatedAt }`
- Slot limits: error (3), decision (5), todo (3), dependency (3)
- Pool decay: γ=0.85 per event

### Pressure Monitoring
- Triggers at: 70% (safe→moderate), 85% (moderate→high), 95% (high→critical)
- Files: `.opencode/memory-working/<sessionID>_pressure.json`
- Intervention: Sends `promptAsync()` with complete visible prompt

### Storage Governance (Layer 1 & 2)
- **Layer 1**: Session deletion cleanup - removes orphaned memory files
- **Layer 2**: Tool output cache sweep - maintains 300 most recent files, 7-day TTL
- Triggered at `eventCounter % 500 === 0` (automatic maintenance)

## Debugging & Testing

### Manual Testing Steps
1. **Phase 1 (Core Memory)**: Check `.opencode/memory-core/` after `core_memory_update`
2. **Phase 2 (Smart Pruning)**: Verify tool outputs are filtered before context injection
3. **Phase 3 (Working Memory)**: Check `.opencode/memory-working/` for slot/pool items
4. **Phase 4 (Pressure Monitoring)**: Monitor pressure % in system prompts, verify interventions
5. **Phase 4.5 (Storage Governance)**: Run 500+ events, check sweep logs

### Common Issues
- **File not found**: Ensure `.opencode/` directory exists and is writable
- **Type errors**: Check all imports use `import type { ... }` for types
- **Lost memory**: Verify `.opencode/memory-*/` is in `.gitignore` (not committed)
- **Sweep not running**: Check `eventCounter` in `<sessionID>.json`, should trigger at multiples of 500

## Performance Considerations

- **Memory budgets**: Core (5.5k chars total), Working (1.6k chars for system prompt)
- **Pruning**: Hyper-aggressive mode activates at ≥85% pressure
- **Compaction**: Preserves most recent 10 items when space-constrained
- **Decay**: Pool items scored by exponential decay (γ=0.85) + mention count
- **Storage sweep**: Limits cache to 300 files, removes files older than 7 days

## File Path References

When referencing code locations in documentation/comments, use:
```
path/to/file.ts:L123  or  path/to/file.ts:Line 123
```

Example: `Function sendPressureInterventionMessage() @ index.ts:L1286`

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes following the code style guidelines above
4. Test manually in OpenCode session
5. Commit with descriptive message: `git commit -m "Add feature: ..."`
6. Push to your fork: `git push origin feature/my-feature`
7. Open a pull request

## Architecture Documentation

See `docs/architecture.md` for detailed technical documentation including:
- Memory tier hierarchy
- Pruning algorithms
- Decay formulas
- Pressure monitoring logic
- Storage governance policies

---

**Last Updated**: February 2026  
**Plugin Status**: Production (Phases 1-4.5 complete)
