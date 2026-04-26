# OpenCode Working Memory Plugin

[![npm version](https://img.shields.io/npm/v/opencode-working-memory.svg)](https://www.npmjs.com/package/opencode-working-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Automatic memory system that keeps your AI agent context-aware across compactions.**

Stop losing context when OpenCode compacts your conversation. This plugin automatically tracks what matters — decisions, active files, open errors — and preserves it across sessions.

## What You Get

**Three-layer memory, zero extra API calls:**

| Layer | Scope | What It Tracks | Persists? |
|-------|-------|----------------|-----------|
| **Workspace Memory** | Cross-session | Decisions, project info, references | ✅ Yes |
| **Hot Session State** | Per-session | Active files, open errors | ❌ Resets |
| **Native OpenCode** | Per-session | Todos | ✅ Built-in |

**Key benefits:**
- 🧠 **Remembers across sessions** — Workspace memory survives restarts
- 🔌 **No extra API calls** — Piggybacks on existing compaction
- 📡 **Zero configuration** — Works out of the box
- 🔧 **Zero tools** — No manual memory management needed

## Installation

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-working-memory"]
}
```

Restart OpenCode. The plugin activates automatically — no manual setup needed.

## How It Works

**Three layers, zero API calls, automatic persistence:**

```
┌──────────────────────────────────────────────────────────────────┐
│  LAYER 1: WORKSPACE MEMORY                                       │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  📦 Persists across sessions (in same workspace)           │  │
│  │  📦 Survives compaction & restart                          │  │
│  │                                                            │  │
│  │  Stored in: ~/.local/share/.../workspace-memory.json       │  │
│  │  Contains: decisions • project info • references           │  │
│  │  Written: during compaction (no extra LLM call!)           │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
          ↑ extracted during compaction (piggyback, no API call)
          │
┌──────────────────────────────────────────────────────────────────┐
│  LAYER 2: HOT SESSION STATE                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  🔥 Per-session, auto-tracked, resets on new session       │  │
│  │                                                            │  │
│  │  Active files (what you're editing)                        │  │
│  │  Open errors (typecheck, test, lint failures)              │  │
│  │  Recent decisions (candidates for Layer 1)                 │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
          ↑ harvested during compaction → promoted to Layer 1
          │
┌──────────────────────────────────────────────────────────────────┐
│  LAYER 3: NATIVE OPENCODE STATE                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  ✅ Uses OpenCode's built-in todos                         │  │
│  │  ✅ No plugin storage needed                               │  │
│  │  ✅ Delegates to native features                           │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘

KEY INSIGHT: Layer 1 memories are extracted during OpenCode's
             built-in compaction summary — NO additional LLM call!
```

### The Compaction Flow (No Extra API Call)

```
User Message ───────────────┐
                            │
Agent Response ─────────────┤
                            │  normal conversation
... more turns ... ─────────┤
                            │
                            ▼
              ╔═══════════════════════════════════════════╗
              ║     COMPACTION (OpenCode built-in)        ║
              ║                                           ║
              ║  OpenCode already calls LLM to summarize  ║
              ║  ──────────────────────────────────────── ║
              ║  Plugin piggybacks on THIS call           ║
              ║  to extract workspace memory candidates   ║
              ║                                           ║
              ║  Output includes:                         ║
              ║  <workspace_memory_candidates>            ║
              ║  - [decision] Use npm cache for plugins   ║
              ║  - [project] React 18 with TypeScript     ║
              ║  </workspace_memory_candidates>           ║
              ╚═══════════════════════════════════════════╝
                            │
                            ▼
              ┌─────────────────────────────────┐
              │  Workspace Memory Updated       │
              │  (persists across sessions)     │
              └─────────────────────────────────┘
```

### Workspace Memory (Long-term)

Persists across sessions within the same workspace. Automatically extracted during compaction when the agent marks something with "remember" or "note":

```
<workspace_memory>
- [decision] Use npm cache for plugin loading, not npm link
- [project] This repo uses opencode-agenthub plugin system
- [reference] Storage: ~/.local/share/opencode-working-memory/...
</workspace_memory>
```

**Memory types:**
- `feedback` - User preferences for this workspace
- `project` - Project-level information
- `decision` - Important decisions made
- `reference` - Key references (paths, patterns)

**Sources:**
- `explicit` - User explicitly said "remember this" (confidence: 1.0)
- `compaction` - Extracted during compaction (confidence: 0.75)
- `manual` - Added programmatically (confidence: varies)

### Hot Session State (Short-term)

Automatically tracks current session context:

- **Active Files**: What files you're working on (ranked by recency and action type)
- **Open Errors**: Errors that haven't been fixed yet (typecheck, test failures, etc.)
- **Recent Decisions**: Decisions made this session (candidates for long-term promotion)

Injected into system prompt:
```
<workspace_memory>
- [decision] Use npm cache for plugin loading, not npm link
- [project] This repo uses opencode-agenthub plugin system
- [reference] Storage: ~/.local/share/opencode-working-memory/workspaces/{hash}/
</workspace_memory>

<hot_session_state>
active_files:
- src/plugin.ts (edit, 18x)
- tests/plugin.test.ts (edit, 5x)
- src/extractors.ts (grep, 3x)
open_errors:
- [typecheck] TS2345: Argument of type 'string' is not assignable...
</hot_session_state>
```

## Quality Guarantees

The plugin includes several quality guards:

- **No false positive errors**: Bash commands like `git log` or `cat` with "error" in output are not misidentified
- **Negative memory filtering**: "Don't remember this" is correctly interpreted
- **Compaction quality gate**: Rejects git hashes, stack traces, path-heavy facts from becoming long-term memories
- **Canonical deduplication**: Memories are deduplicated with case/punctuation normalization

## No Tools Required

Unlike other memory plugins, **this plugin has no manual tools**. Everything is automatic:

- No `core_memory_update` — memory is extracted automatically
- No `core_memory_read` — memory is injected into system prompt
- No `working_memory_add` — active files are tracked automatically

Just install and let it run. The plugin hooks into OpenCode's lifecycle events and does the right thing.

## Configuration

The plugin works out of the box with sensible defaults:

- **Workspace Memory**: 5200 chars, 28 entries max
- **Hot State**: 1200 chars rendered, 8 active files, 3 errors shown
- **Storage**: `~/.local/share/opencode-working-memory/workspaces/{hash}/`

See [Configuration Guide](docs/configuration.md) for customization options.

## For AI Agents

When using this plugin, the memory context appears in your system prompt. You can:

1. **Tell users about memories**: "I remember you decided to use npm cache for plugins"
2. **Ask about preferences**: "Should I add this to my memory for this workspace?"
3. **Note important decisions**: These will be extracted during compaction

To add something to long-term memory explicitly:
```
Remember this: [your note here]
```

The plugin captures this during compaction.

## Documentation

- [Architecture Overview](docs/architecture.md) - How the three layers work
- [Configuration](docs/configuration.md) - Customization options
- [Installation Guide](docs/installation.md) - Step-by-step setup

## Development

```bash
git clone https://github.com/sdwolf4103/opencode-working-memory.git
cd opencode-working-memory
npm install
npm test
npm run typecheck
```

## Requirements

- OpenCode >= 1.0.0
- Node.js >= 18.0.0

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- 📖 [Documentation](docs/)
- 🐛 [Report Issues](https://github.com/sdwolf4103/opencode-working-memory/issues)

---

**Made with ❤️ for the OpenCode community**