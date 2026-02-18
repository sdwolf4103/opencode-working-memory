# Configuration Guide

## Overview

The Working Memory Plugin works out-of-the-box with sensible defaults. Advanced users can customize behavior by modifying constants in `index.ts`.

## Core Memory Limits

```typescript
const CORE_MEMORY_LIMITS = {
  goal: 1000,      // ONE specific task (not project-wide goals)
  progress: 2000,  // Checklist format (✅ done, ⏳ in-progress, ❌ blocked)
  context: 1500,   // Current working files + key patterns
};
```

**Recommendations**:
- Keep **goal** focused on current task (clear when completed)
- Use **progress** for checklists (avoid line numbers, commit hashes, API signatures)
- Use **context** for files you're actively editing (avoid type definitions, function signatures)

## Working Memory Configuration

### Slot Limits

```typescript
const SLOT_CONFIG: Record<SlotType, number> = {
  error: 3,       // Recent errors needing fixes
  decision: 5,    // Important decisions made
  todo: 3,        // Current task checklist
  dependency: 3,  // File/package dependencies
};
```

**Tuning**:
- Increase slot limits if you need more items tracked
- Decrease for stricter memory budgets
- Total overhead: ~100-200 chars per item

### Memory Pool Decay

```typescript
const POOL_DECAY_GAMMA = 0.85;  // Exponential decay rate (15% per event)
const POOL_MIN_SCORE = 0.01;    // Items below this score are pruned
```

**Formula**: `score = exp(-γ * age) + mentionCount`

**Tuning**:
- Lower `γ` (e.g., 0.75) → faster decay, more aggressive pruning
- Higher `γ` (e.g., 0.90) → slower decay, items stay longer
- Lower `POOL_MIN_SCORE` (e.g., 0.005) → more items retained

### Pool Size Limits

```typescript
const POOL_MAX_ITEMS = 50;  // Hard limit on pool size
```

**Tuning**:
- Increase for longer sessions with more context
- Decrease for stricter memory budgets
- Each item adds ~50-150 chars to system prompt

## Pressure Monitoring

### Thresholds

```typescript
const PRESSURE_THRESHOLDS = {
  moderate: 75,  // Warning appears in system prompt
  high: 90,      // Aggressive pruning activates + intervention sent
};
```

**Tuning**:
- Increase thresholds for more relaxed monitoring
- Decrease for earlier warnings and interventions

### Context Limit Estimate

```typescript
const ESTIMATED_CONTEXT_LIMIT = 180000;  // Conservative estimate (chars)
```

**Note**: OpenCode actual limit varies by model. Adjust based on your observations.

## Smart Pruning

### Line Thresholds

```typescript
// Normal mode (pressure < 75%)
const PRUNE_THRESHOLD_NORMAL = 50;

// Aggressive mode (75% ≤ pressure < 90%)
const PRUNE_THRESHOLD_AGGRESSIVE = 30;

// Hyper-aggressive mode (pressure ≥ 90%)
const PRUNE_THRESHOLD_HYPER = 15;
```

**Tuning**:
- Increase thresholds to keep more tool output
- Decrease for more aggressive pruning

### Keep Lines

```typescript
// Normal mode
const KEEP_LINES_NORMAL = 30;  // Keep first/last 30 lines

// Aggressive mode
const KEEP_LINES_AGGRESSIVE = 20;  // Keep first/last 20 lines

// Hyper-aggressive mode
const KEEP_LINES_HYPER = 10;  // Keep first/last 10 lines
```

**Tuning**:
- Increase to preserve more context from tool outputs
- Decrease for stricter truncation

## Storage Governance

### Session Cleanup

Automatically triggered on `experimental.session.deleted` hook. No configuration needed.

### Tool Output Cache Sweep

```typescript
const SWEEP_INTERVAL = 500;        // Trigger every N events
const SWEEP_MAX_FILES = 300;       // Keep most recent N files
const SWEEP_TTL_DAYS = 7;          // Delete files older than N days
```

**Tuning**:
- Increase `SWEEP_INTERVAL` for less frequent sweeps (lower overhead)
- Increase `SWEEP_MAX_FILES` to cache more tool outputs (more disk usage)
- Increase `SWEEP_TTL_DAYS` to keep older files longer

## Compaction Behavior

### Item Preservation

```typescript
const COMPACTION_KEEP_ITEMS = 10;  // Preserve N most recent items on compaction
```

**Tuning**:
- Increase to preserve more working memory across compactions
- Decrease for stricter memory reset on compaction

## System Prompt Injection

### Core Memory Format

```typescript
// Injected as:
<core_memory>
<goal chars="87/1000">...</goal>
<progress chars="560/2000">...</progress>
<context chars="479/1500">...</context>
</core_memory>
```

**Customization**: Modify `formatCoreMemoryForPrompt()` in `index.ts` to change format.

### Working Memory Format

```typescript
// Injected as:
<working_memory>
Recent session context (auto-managed, sorted by relevance):

⚠️ Errors:
  - item content

📁 Key Files:
  - file path

(N items shown, updated: HH:MM:SS AM)
</working_memory>
```

**Customization**: Modify `formatWorkingMemoryForPrompt()` in `index.ts` to change:
- Section emoji/icons
- Display format
- Item ordering

### Pressure Warning Format

```typescript
// Injected as:
[Memory Pressure: 87% (high) - 156,600/180,000 chars]
⚠️ High memory pressure detected. Consider:
- Action item 1
- Action item 2
```

**Customization**: Modify `formatPressureWarning()` in `index.ts`.

## Auto-Extraction Heuristics

### File Path Detection

```typescript
// Detects:
- Absolute paths: /users/name/project/file.ts
- Relative paths: src/components/Button.tsx
- Dot paths: ./utils/helpers.ts
- Tilde paths: ~/project/file.ts
```

**Customization**: Modify regex in `extractFilePaths()`.

### Error Detection

```typescript
// Detects:
- "Error:", "ERROR:", "error:"
- Stack traces with "at " prefix
- TypeScript errors with "TS####:"
```

**Customization**: Modify `extractErrors()` heuristics.

### Decision Detection

```typescript
// Detects:
- "decided to...", "decision:", "chose to..."
- "using X instead of Y"
- "will use X approach"
```

**Customization**: Modify `extractDecisions()` heuristics.

## Environment Variables

Currently, the plugin does not support environment variables. All configuration is done via constants in `index.ts`.

**Future Enhancement**: Consider adding `.env` support for:
```
OPENCODE_WM_CORE_GOAL_LIMIT=1000
OPENCODE_WM_POOL_DECAY_GAMMA=0.85
OPENCODE_WM_SWEEP_INTERVAL=500
```

## Performance Tuning

### High-Frequency Sessions (500+ messages)

```typescript
// Aggressive pruning
const PRUNE_THRESHOLD_NORMAL = 30;
const PRUNE_THRESHOLD_AGGRESSIVE = 20;

// Faster decay
const POOL_DECAY_GAMMA = 0.75;

// More frequent sweeps
const SWEEP_INTERVAL = 250;
```

### Long-Running Sessions (Multi-day)

```typescript
// Preserve more context
const POOL_MAX_ITEMS = 100;
const COMPACTION_KEEP_ITEMS = 20;

// Slower decay
const POOL_DECAY_GAMMA = 0.90;

// Longer TTL
const SWEEP_TTL_DAYS = 14;
```

### Memory-Constrained Environments

```typescript
// Strict limits
const CORE_MEMORY_LIMITS = {
  goal: 500,
  progress: 1000,
  context: 800,
};

const POOL_MAX_ITEMS = 20;

// Aggressive pruning
const PRUNE_THRESHOLD_NORMAL = 20;
```

## Debugging Configuration

### Enable Verbose Logging

Add `console.log()` statements in key functions:

```typescript
// In loadCoreMemory()
console.log("[Core Memory] Loaded:", memory);

// In applyDecay()
console.log("[Pool Decay] Pruned items:", prunedCount);

// In sweepToolOutputCache()
console.log("[Sweep] Deleted files:", deletedCount);
```

### Inspect Memory Files

```bash
# Core memory
cat .opencode/memory-core/<sessionID>.json | jq

# Working memory
cat .opencode/memory-working/<sessionID>.json | jq

# Pressure state
cat .opencode/memory-working/<sessionID>_pressure.json | jq

# Sweep log
cat .opencode/memory-working/<sessionID>_sweep.json | jq
```

## Migration Notes

### Upgrading from Pre-Phase 3

Old format files are automatically migrated:

```typescript
// Old format
{ items: Array<Item> }

// New format (auto-migrated)
{ slots: { error: [], decision: [], ... }, pool: [...] }
```

No manual intervention required.

### Upgrading from Phase 3 to Phase 4.5

Storage governance is backward compatible. No migration needed.

## Best Practices

1. **Core Memory Discipline**:
   - Clear `goal` immediately after task completion
   - Keep `progress` concise (use checklist format)
   - Only put actively edited files in `context`

2. **Working Memory Hygiene**:
   - Clear `error` slot after fixing all errors (`working_memory_clear_slot`)
   - Let pool decay naturally (avoid manual removal unless necessary)
   - Review working memory periodically (use `working_memory_read`)

3. **Pressure Management**:
   - Respond to "moderate" warnings proactively
   - Compress core memory at "high" pressure
   - Clear working memory at "critical" pressure

4. **Storage Maintenance**:
   - Let sweep run automatically (no manual intervention)
   - Delete old session files manually if needed
   - Monitor `.opencode/` directory size periodically

---

**Last Updated**: February 2026  
**Configuration File**: `index.ts` (constants section)
