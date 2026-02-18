# Architecture Documentation

## Overview

The Working Memory Plugin implements a **four-tier memory architecture** designed to maximize context efficiency for AI agents in OpenCode sessions.

```
┌─────────────────────────────────────────────────────────────┐
│                    TIER 1: CORE MEMORY                       │
│  Persistent blocks: goal (1000) | progress (2000) | context (1500) │
│  Survives compaction, always visible in system prompt       │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                  TIER 2: WORKING MEMORY                      │
│  Session-scoped slots + memory pool                         │
│  Slots: error(3) | decision(5) | todo(3) | dependency(3)   │
│  Pool: Exponential decay (γ=0.85) + mention tracking        │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                   TIER 3: SMART PRUNING                      │
│  Filters tool outputs before adding to conversation         │
│  Removes: file lists, verbose logs, repetitive content      │
│  Modes: normal → aggressive → hyper-aggressive               │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                 TIER 4: PRESSURE MONITORING                  │
│  Tracks context usage: safe → moderate → high → critical    │
│  Thresholds: 70% | 85% | 95%                                │
│  Intervention: Sends promptAsync() with full visible prompt │
└─────────────────────────────────────────────────────────────┘
```

## Phase 1: Core Memory Foundation

### Purpose
Provide persistent memory blocks that survive conversation compaction and are always injected into the system prompt.

### Storage
- **Location**: `.opencode/memory-core/<sessionID>.json`
- **Schema**:
  ```typescript
  {
    sessionID: string;
    blocks: {
      goal: { content: string; chars: number; maxChars: 1000; updatedAt: string };
      progress: { content: string; chars: number; maxChars: 2000; updatedAt: string };
      context: { content: string; chars: number; maxChars: 1500; updatedAt: string };
    };
    updatedAt: string;
  }
  ```

### Character Limits
- **goal**: 1000 chars (ONE specific task)
- **progress**: 2000 chars (done/in-progress/blocked checklist)
- **context**: 1500 chars (current working files + key patterns)

### Operations
- **replace**: Completely replace block content
- **append**: Add content to end (auto-adds newline)

### Tools
- `core_memory_update`: Update or append to blocks
- `core_memory_read`: Read current state of all blocks

### System Prompt Injection
Blocks are injected into every agent message as:
```
<core_memory>
<goal chars="87/1000">...</goal>
<progress chars="560/2000">...</progress>
<context chars="479/1500">...</context>
</core_memory>
```

## Phase 2: Smart Pruning

### Purpose
Reduce context bloat by filtering tool outputs before they enter the conversation history.

### Pruning Modes

#### Normal Mode (Pressure < 85%)
- Remove file/directory listings > 50 lines
- Truncate verbose tool outputs
- Keep first/last 30 lines of long outputs
- Preserve error messages and key information

#### Aggressive Mode (85% ≤ Pressure < 95%)
- Threshold drops to 30 lines
- More aggressive truncation (first/last 20 lines)
- Filter repetitive content

#### Hyper-Aggressive Mode (Pressure ≥ 95%)
- Threshold drops to 15 lines
- Keep only first/last 10 lines
- Maximum compression

### Pruning Heuristics

1. **File Listings**: Detect `ls`, `find`, `glob` outputs
2. **Directory Trees**: Detect tree-like structures with `/`
3. **Log Files**: Detect timestamp patterns, stack traces
4. **Repetitive Content**: Detect similar consecutive lines
5. **Synthetic Content**: Preserve `synthetic: true` markers

### Implementation
Pruning happens in `tool.execute.after` hook before tool output enters conversation.

## Phase 3: Working Memory

### Purpose
Provide session-scoped memory with structured slots and a general-purpose pool with intelligent decay.

### Storage
- **Location**: `.opencode/memory-working/<sessionID>.json`
- **Schema**:
  ```typescript
  {
    sessionID: string;
    slots: {
      error: Array<WorkingMemoryItem>;      // Max 3
      decision: Array<WorkingMemoryItem>;   // Max 5
      todo: Array<WorkingMemoryItem>;       // Max 3
      dependency: Array<WorkingMemoryItem>; // Max 3
    };
    pool: Array<WorkingMemoryItem>;
    eventCounter: number;
    updatedAt: string;
  }
  ```

### Slot Types

| Slot | Max Items | Purpose |
|------|-----------|---------|
| **error** | 3 | Recent errors that need fixing |
| **decision** | 5 | Important decisions made |
| **todo** | 3 | Current task checklist |
| **dependency** | 3 | File/package dependencies |

### Memory Pool

General-purpose storage with **exponential decay**:

```typescript
score = exp(-γ * age) + mentionCount
```

Where:
- `γ = 0.85` (decay rate, 15% per event)
- `age = eventCounter - item.eventNumber`
- `mentionCount`: Number of times item mentioned in conversation

Items with `score < 0.01` are pruned.

### Auto-Extraction

Working memory items are **automatically extracted** from:
- Tool outputs (file paths, errors, dependencies)
- User messages (decisions, todos)
- Assistant responses (key information)

### Manual Management

Tools:
- `working_memory_add`: Manually add item
- `working_memory_clear`: Clear all items
- `working_memory_clear_slot`: Clear specific slot (e.g., after fixing all errors)
- `working_memory_remove`: Remove specific item by content match

### System Prompt Injection

```
<working_memory>
Recent session context (auto-managed, sorted by relevance):

⚠️ Errors:
  - TypeError at line 42 in utils.ts
  - Missing import in index.ts

📁 Key Files:
  - src/components/Button.tsx
  - src/utils/helpers.ts

(15 items shown, updated: 9:46:47 AM)
</working_memory>
```

## Phase 4: Pressure Monitoring

### Purpose
Track conversation context usage and trigger interventions when approaching limits.

### Pressure Calculation

```typescript
pressure = (visiblePromptChars / estimatedContextLimit) * 100
```

Where:
- `visiblePromptChars`: Total characters in system prompt + tool outputs
- `estimatedContextLimit`: ~180,000 chars (conservative estimate)

### Pressure Levels

| Level | Threshold | Behavior |
|-------|-----------|----------|
| **safe** | < 70% | Normal operation |
| **moderate** | 70-84% | Warning in system prompt |
| **high** | 85-94% | Aggressive pruning + warning |
| **critical** | ≥ 95% | Hyper-aggressive pruning + intervention |

### Pressure Storage

- **Location**: `.opencode/memory-working/<sessionID>_pressure.json`
- **Schema**:
  ```typescript
  {
    sessionID: string;
    level: "safe" | "moderate" | "high" | "critical";
    percentage: number;
    visiblePromptChars: number;
    estimatedLimit: 180000;
    lastChecked: string;
    interventionsSent: number;
  }
  ```

### Intervention Mechanism

When pressure reaches **critical** (≥95%):
1. Plugin sends `promptAsync()` message to agent
2. Message includes full visible prompt for review
3. Agent can compress core memory, clear working memory, or continue
4. Intervention tracked in `interventionsSent` counter

### System Prompt Injection

```
[Memory Pressure: 87% (high) - 156,600/180,000 chars]
⚠️ High memory pressure detected. Consider:
- Compressing core_memory blocks (use core_memory_update)
- Clearing resolved errors (use working_memory_clear_slot)
- Removing old pool items (auto-pruned at score < 0.01)
```

## Phase 4.5: Storage Governance

### Purpose
Prevent `.opencode/` directory bloat from accumulating tool output caches and orphaned memory files.

### Layer 1: Session Deletion Cleanup

**Trigger**: `experimental.session.deleted` hook

**Actions**:
1. Remove `.opencode/memory-core/<sessionID>.json`
2. Remove `.opencode/memory-working/<sessionID>.json`
3. Remove `.opencode/memory-working/<sessionID>_pressure.json`
4. Remove `.opencode/memory-working/<sessionID>_compaction.json`

### Layer 2: Tool Output Cache Sweep

**Trigger**: Every 500 events (`eventCounter % 500 === 0`)

**Target**: `.opencode/cache/tool-outputs/` directory

**Policy**:
- Keep most recent **300 files** (sorted by mtime)
- Delete files older than **7 days** (TTL policy)

**Logging**: Write sweep results to `.opencode/memory-working/<sessionID>_sweep.json`

```typescript
{
  sessionID: string;
  timestamp: string;
  eventCounter: number;
  results: {
    filesScanned: number;
    filesDeleted: number;
    bytesReclaimed: number;
    errors: Array<string>;
  };
}
```

## Performance Considerations

### Memory Budgets
- **Core Memory**: 4,500 chars (injected every message)
- **Working Memory**: ~1,600 chars (injected every message)
- **Total Overhead**: ~6,100 chars per message

### Compaction Behavior
When OpenCode compacts conversation (clears old messages):
- Core memory: **Preserved** (persistent across compactions)
- Working memory: **Preserved** (session-scoped, cleared on session end)
- Pressure state: **Preserved** (tracks across compaction)
- Compaction log: Saved to `<sessionID>_compaction.json`

### Storage Footprint
- Each session: 4 JSON files (~5-20 KB total)
- Tool output cache: Max 300 files (~10-50 MB depending on outputs)
- Sweep every 500 events keeps storage bounded

## Extension Points

### Custom Slot Types
To add new slot types:
1. Update `SlotType` union in types
2. Add to `SLOT_CONFIG` with max items
3. Update `formatWorkingMemoryForPrompt()` for display
4. Update extraction heuristics in `tool.execute.after`

### Custom Pruning Rules
To add pruning heuristics:
1. Update `shouldPrune()` with new detection logic
2. Add to `pruneToolOutput()` with filtering rules
3. Test with representative tool outputs

### Custom Pressure Thresholds
Adjust in constants:
```typescript
const PRESSURE_THRESHOLDS = {
  moderate: 70,
  high: 85,
  critical: 95,
};
```

## Migration & Compatibility

### Old Format → New Format
Plugin automatically migrates from old format:
```typescript
// Old format (pre-Phase 3)
{ items: Array<Item> }

// New format (Phase 3+)
{ slots: Record<SlotType, Array<Item>>, pool: Array<Item> }
```

Migration happens on first load of old format files.

## File System Layout

```
.opencode/
├── memory-core/
│   └── <sessionID>.json          # Core memory blocks
├── memory-working/
│   ├── <sessionID>.json          # Working memory (slots + pool)
│   ├── <sessionID>_pressure.json # Pressure monitoring state
│   ├── <sessionID>_compaction.json # Compaction event log
│   └── <sessionID>_sweep.json    # Storage sweep log
└── cache/
    └── tool-outputs/
        └── *.json                # Tool output cache (auto-swept)
```

## Security Considerations

- All files written with `0644` permissions (owner read/write, group/others read)
- Directories created with `0755` permissions (owner rwx, group/others rx)
- No sensitive data should be stored in memory blocks (user responsibility)
- Session IDs are opaque identifiers, not derived from sensitive data

---

**Last Updated**: February 2026  
**Implementation**: `index.ts` (1700+ lines)
