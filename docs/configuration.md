# Configuration Guide

## Overview

OpenCode Working Memory works out-of-the-box with sensible defaults. Configuration is defined in `src/types.ts` as constants.

## Workspace Memory Limits

```typescript
const LONG_TERM_LIMITS = {
  maxRenderedChars: 5200,    // Maximum characters in system prompt
  targetRenderedChars: 4200, // Target characters (leave buffer)
  maxEntries: 28,            // Maximum number of entries
  maxEntryTextChars: 260,    // Maximum characters per entry text
  maxRationaleChars: 180,    // Maximum characters per entry rationale
};
```

**Recommendations**:
- Keep `maxRenderedChars` under 5500 to avoid context bloat
- `maxEntries` of 28 provides good coverage without overwhelming
- Entry text limits ensure entries stay concise

## Hot Session State Limits

```typescript
const HOT_STATE_LIMITS = {
  maxRenderedChars: 1200,       // Maximum characters in system prompt
  maxActiveFilesStored: 20,    // Maximum files tracked in state
  maxActiveFilesRendered: 8,   // Maximum files shown in prompt
  maxOpenErrorsStored: 5,      // Maximum errors tracked
  maxOpenErrorsRendered: 3,    // Maximum errors shown in prompt
  maxRecentDecisionsStored: 8, // Maximum decisions tracked
};
```

**Recommendations**:
- Keep `maxRenderedChars` under 1500 for fast prompts
- `maxActiveFilesRendered` of 8 provides good context coverage
- `maxOpenErrorsRendered` of 3 avoids overwhelming error lists

## Memory Types

### Long-Term Memory Types

| Type | Purpose | Stale After (days) |
|------|---------|---------------------|
| `feedback` | User preferences for workspace | 90 |
| `project` | Project-level information | 60 |
| `decision` | Important decisions | 45 |
| `reference` | Key references | 90 |

### Memory Sources

| Source | Confidence | Description |
|--------|------------|-------------|
| `explicit` | 1.0 | User explicitly said "remember this" |
| `compaction` | 0.75 | Extracted during conversation compaction |
| `manual` | varies | Added programmatically |

## Active File Scoring

Files are ranked by action type:

| Action | Weight | Description |
|--------|--------|-------------|
| `write` | 4 | File created/overwritten |
| `edit` | 3 | File modified |
| `read` | 2 | File read |
| `grep` | 1 | Grep searched in file |

Score formula: `count * action_weight * recency_decay`

## Error Categories

| Category | Recognition Pattern |
|----------|---------------------|
| `typecheck` | TS errors, TypeScript failures |
| `test` | Test failures |
| `lint` | ESLint warnings/errors |
| `build` | Build failures |
| `runtime` | Uncaught errors, Node exceptions |
| `tool` | Tool execution failures |

## Storage Paths

```
~/.local/share/opencode-working-memory/
└── workspaces/
    └── {workspaceKey}/
        ├── workspace-memory.json      # Long-term memory
        └── sessions/
            └── {hashedSessionID}.json # Session state (hashed)
```

### Workspace Key

```typescript
// First 16 characters of SHA-256 hash
const workspaceKey = sha256(realpath(workspaceRoot)).slice(0, 16);
```

### Session ID

```typescript
// Hashed session ID for privacy
const hashedSessionID = sha256(sessionID).slice(0, 32);
```

## Customization

To customize limits, edit the constants in `src/types.ts`:

```typescript
// Example: Increase workspace memory limit
export const LONG_TERM_LIMITS = {
  maxRenderedChars: 6000,  // Increased from 5200
  maxEntries: 35,          // Increased from 28
  // ...
};
```

**Note**: After customization, rebuild the plugin:
```bash
npm run build
```

## Performance Tuning

### High-Frequency Sessions (500+ messages)

```typescript
// Reduce memory overhead
const HOT_STATE_LIMITS = {
  maxRenderedChars: 800,        // Reduced
  maxActiveFilesRendered: 5,    // Reduced
  maxOpenErrorsRendered: 2,     // Reduced
};
```

### Long-Running Sessions (Multi-day)

```typescript
// Preserve more context
const LONG_TERM_LIMITS = {
  maxEntries: 40,              // Increased
  targetRenderedChars: 5000,    // Increased
};
```

### Memory-Constrained Environments

```typescript
// Strict limits
const LONG_TERM_LIMITS = {
  maxRenderedChars: 3000,
  maxEntries: 15,
};

const HOT_STATE_LIMITS = {
  maxRenderedChars: 600,
  maxActiveFilesRendered: 4,
};
```

## Debugging

### Inspect Memory Files

```bash
# Workspace memory
cat ~/.local/share/opencode-working-memory/workspaces/*/workspace-memory.json | jq

# Session state
cat ~/.local/share/opencode-working-memory/workspaces/*/sessions/*.json | jq
```

### Clear Workspace Memory

```bash
# Remove workspace memory (start fresh)
rm ~/.local/share/opencode-working-memory/workspaces/*/workspace-memory.json
```

### Clear Session State

```bash
# Remove all session states
rm ~/.local/share/opencode-working-memory/workspaces/*/sessions/*.json
```

## Best Practices

1. **Workspace Memory Hygiene**:
   - Let OpenCode Working Memory extract memories automatically
   - Use explicit "remember this" for important information
   - Don't manually edit memory files unless testing

2. **Session State**:
   - Let OpenCode Working Memory track active files automatically
   - Errors are cleared when commands succeed
   - No manual intervention needed

3. **Memory Extraction**:
   - Use `Memory candidates:` during compaction
   - Follow the pattern: `- [type] text`
   - Quality gate rejects invalid candidates

---

**Last Updated**: April 2026  
**Configuration File**: `src/types.ts`
