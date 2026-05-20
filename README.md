# OpenCode Working Memory

[![npm version](https://img.shields.io/npm/v/opencode-working-memory.svg)](https://www.npmjs.com/package/opencode-working-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Automatic memory for OpenCode agents.

Working memory is context that **remembers what matters, fades what changes, and stays out of the way.**

OpenCode Working Memory preserves project decisions, preferences, and references across compactions and sessions, while keeping active files and unresolved errors fresh for the current session — with no manual tools or extra LLM/API calls.

## Why This Exists

OpenCode compaction keeps conversations manageable, but important context can still get lost over time.

It adds a workspace-aware memory layer so your agent can remember durable facts while keeping short-term session state fresh and lightweight.

Use it when you want your agent to remember things like:

- Project conventions
- User preferences
- Architecture decisions
- Important file paths or references
- Current active files and unresolved errors

## What You Get

| Need | Feature |
|---|---|
| Remember durable context | Workspace memory keeps project facts, preferences, decisions, and references across sessions. |
| Capture what matters | Say `remember this` or `記住` to explicitly save important rules and preferences. |
| Inspect memory locally | Use `/memory` in the OpenCode TUI to browse status, help, and searchable current `[M#]` memories. |
| Stay out of the way | Memory is injected automatically and piggybacks on OpenCode compaction — no manual tools, no extra LLM/API calls. |
| Keep memory clean | Quality guards filter noise, redact credentials, dedupe repeats, and let weak memories fade. |

```text
remember this ──► workspace memory ──► /memory
     ▲                    │              searchable [M#] refs
     │                    ▼
compaction ─────► reinforce / replace ──► selective prompt context
```

## Installation

New users: add OpenCode Working Memory to both OpenCode plugin configs.

`.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-working-memory"]
}
```

`.opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-working-memory"]
}
```

Existing users: keep your current `.opencode/opencode.json` config and add only the `.opencode/tui.json` block above to enable the native `/memory` TUI menu.

Then restart OpenCode. Memory activates automatically, and `/memory` appears in the TUI slash command menu.

## Native TUI Memory Menu

The TUI plugin adds one display-only local memory command:

- `/memory` — open a native memory submenu.

Submenu entries:

- Status — show status counts for workspace memory, rendered memories, pending memory, open errors, and recent decisions.
- Current memories — browse a searchable grouped list of current active workspace memories with display-local `[M1]` refs.
- Help — show command help.

This menu is read-only and local-only. It reads local memory files and opens native TUI dialogs, so it does not create conversation history entries and does not make an LLM/API call.

```text
  /memory
     ├─ Status
     ├─ Current memories  ← searchable, grouped [M#] refs
     └─ Help
```

Use `/memory` when you want to inspect what the agent currently remembers without asking the model or polluting the transcript.

Compaction output already appears through OpenCode's built-in conversation flow. This plugin does not add duplicate compaction notices.

## How It Works

OpenCode Working Memory adds durable memory without making extra LLM/API calls.

```text
┌──────────────────────────────────────┐
│ 🧭 Conversation Events               │
│ edits, commands, errors, remembers   │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ 🔥 Hot Session State                 │
│ active files, open errors, pending   │
│                                      │
│ ~/.local/share/opencode-working-     │
│ memory/workspaces/{hash}/sessions/   │
│ {sessionID}.json                     │
└──────────────────┬───────────────────┘
                   │ when OpenCode compacts
                   ▼
┌──────────────────────────────────────┐
│ 🧠 OpenCode Compaction               │
│ existing LLM/API call                │
│ + memory extraction instructions     │
│                                      │
│ zero extra API calls                 │
└──────────────────┬───────────────────┘
                   │ filter, redact, dedupe
                   ▼
┌──────────────────────────────────────┐
│ 📦 Workspace Memory                  │
│ decisions, preferences, refs         │
│                                      │
│ ~/.local/share/opencode-working-     │
│ memory/workspaces/{hash}/            │
│ workspace-memory.json                │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ ⚡ Prompt Context                     │
│ system[1]*: frozen workspace memory  │
│ system[2+]*: frozen hot snapshot     │
└──────────────────────────────────────┘
```

\* Conceptually, frozen workspace memory is pushed first when it is non-empty, and the frozen hot snapshot is pushed after workspace memory. If workspace memory is empty, the hot snapshot may be the first plugin-added system message. Actual `system[]` indices also depend on OpenCode and other plugins, so `system[1]` / `system[2+]` is a simplified model.

**Zero extra API calls:** OpenCode Working Memory does not call the model on its own. Memory extraction is folded into OpenCode's built-in compaction request.

**Cache-friendly layout:** durable workspace memory and hot session state are rendered as separate frozen prompts that share the same epoch lifecycle. Hot state is an epoch-start snapshot: active files and open errors can change after it is created, and the conversation/tool transcript is the source of truth for newer events. The plugin intentionally does not invalidate the hot snapshot on active-file, open-error, recent-decision, or pending-memory changes because doing so would defeat prefix KV-cache reuse. Explicit pending memories remain durable and promote safely at compaction, but after the current epoch caches exist they do not force a prompt refresh.

The runtime context has three layers:

| Layer | Purpose | Lifetime |
|---|---|---|
| Workspace Memory | Durable decisions, preferences, project facts, references | Cross-session |
| Hot Session State | Active files, open errors, recent context, pending memories | Current session storage; frozen prompt refreshes at epoch boundaries |
| Native OpenCode State | Todos and built-in state | OpenCode-managed |

## Workspace Memory

Workspace memory is for durable information that should help future sessions.

Examples:

```md
- [decision] Use npm cache for plugin loading, not npm link.
- [project] This repo uses TypeScript and Node.js test runner.
- [feedback] User prefers concise implementation summaries.
- [reference] Storage lives under ~/.local/share/opencode-working-memory/.
```

Memory types:

- `feedback` — user preferences or recurring feedback
- `project` — stable project-level facts
- `decision` — important implementation or architecture decisions
- `reference` — useful paths, commands, or configuration references

### Retention Decay

> **Memory should fade, so the agent can keep learning.**
>
> Important memories decay more slowly, but every memory must leave room for newer project reality.

Memories decay over time. The strongest stay visible in the prompt; weaker ones fade from context without being deleted.

```text
  strength
    │
 ██ │╲____   reinforced: slower decline
    │     ╲______
 ▒▒ │            ╲__ ordinary memory
    │               ╲
    ├ ─ ─ ─ ─ ─ ─ ─ ─╲─ dynamic cap competition zone
 ░░ │                 ╲  easier for new memories to replace
    │                  ↑ still stored, not deleted
    └──────────────────────────────→ time / sessions
```

## Explicit Memory Triggers

Most memory is extracted automatically during compaction. When something is especially important, tell the agent directly:

```md
Remember this: we prefer Vitest for new frontend tests.
記住：這個 repo 發 release 前要先跑 npm test。
```

Use explicit triggers for stable preferences, project rules, architecture decisions, or important references. Then inspect active workspace memory with:

```text
/memory → Current memories
```

Trigger phrases include `remember this`, `save to memory`, `from now on`, `my preference`, `記住`, `記得`, `覚えて`, and `기억해`.

Negative requests are respected too: `Don't remember this`, `不要記住這個`, `覚えないで`, `기억하지 마`.

Avoid asking memory to save secrets, temporary progress, raw command output, or short-lived session details.

## Quality Guards

**Good memory is selective memory.**

OpenCode Working Memory is designed to be selective. Its strength is not storing more; it is keeping the prompt focused on durable facts that still help.

It protects memory quality in three ways:

- **Selective** — filters temporary progress, raw errors, stack traces, git hashes, noisy debug fragments, and duplicate restatements.
- **Safe** — redacts credentials and protects manual or explicit memories from unsafe automatic replacement.
- **Diagnosable** — tracks promoted, absorbed, superseded, rejected, reinforced, and replaced memory outcomes.

The goal is to remember durable facts, not every detail.

Historical cleanup is intentionally conservative: extraction-time filtering may reject more aggressively, but one-time migration cleanup only supersedes high-confidence garbage patterns. This protects existing durable memories written in declarative style, such as "API endpoint is X" or "Product branding is Y".

### Numbered Memory Refs

During compaction, existing workspace memories may be shown as numbered refs such as `[M1]` or `[M2]`. The model can reinforce a still-useful memory or propose a protected replacement instead of copying the same fact again.

```md
REINFORCE [M1]
REPLACE [M2] project Updated durable project fact.
```

Protected memories and stale refs are rejected rather than mutated. Use `memory-diag commands` for detailed command outcomes and recovery guidance.

### Memory Diagnostics CLI

For deeper troubleshooting, use the read-only `memory-diag` CLI:

```bash
npx --package opencode-working-memory memory-diag status
npx --package opencode-working-memory memory-diag rejected
npx --package opencode-working-memory memory-diag missing
npx --package opencode-working-memory memory-diag explain <memory-id>
npx --package opencode-working-memory memory-diag quality
```

See [Diagnostics](docs/diagnostics.md) for the full command reference, numbered memory command reports, and dry-run recovery workflow.

## Configuration

OpenCode Working Memory works out of the box.

Default behavior:

- Workspace memory budget: 3600 characters (~900 tokens)
- Workspace memory limit: 28 entries
- Hot session state budget: 700 characters (~175 tokens) per frozen hot snapshot
- Active files shown: 8
- Open errors shown: 3

See [Configuration](docs/configuration.md) for customization options.

## Documentation

- [Architecture Overview](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Diagnostics](docs/diagnostics.md)
- [Installation Guide](docs/installation.md)

## Requirements

- OpenCode plugin API `>=1.2.0 <2.0.0`
- Node.js >= 22.6.0 (the published `memory-diag` CLI runs compiled JavaScript)

## Limitations

- Requires OpenCode plugin API `>=1.2.0 <2.0.0`; OpenCode hook changes may break compatibility.
- Not a secret manager. Credential redaction is best-effort. Do not store secrets.
- Working memory only. No semantic search, embeddings, or vector knowledge base.
- Other prompt or compaction plugins may conflict depending on plugin order.
- Multiple OpenCode processes on the same workspace may race on local files.

## License

MIT License. See [LICENSE](LICENSE) for details.

## Support

- [Documentation](docs/)
- [Report Issues](https://github.com/sdwolf4103/opencode-working-memory/issues)

---

Made with ❤️ for the OpenCode community.
