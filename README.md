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

## Features

- **Workspace memory** — durable project facts, preferences, decisions, and references across sessions.
- **Hot session state** — active files, open errors, and current working context for the current session.
- **Explicit memory triggers** — users can say “remember this”, “記住”, “覚えて”, or “기억해” to save durable facts.
- **Compaction-based extraction** — memory extraction piggybacks on OpenCode’s existing compaction flow.
- **Numbered memory refs** — compaction can `REINFORCE [M#]` useful memories or safely `REPLACE [M#]` obsolete compaction memories.
- **Native TUI `/memory` display** — show local memory status, recent activity, and help from the OpenCode TUI without an LLM/API call.
- **No manual tools** — memory is injected automatically into the system prompt.
- **Quality guards** — filters noisy memories, temporary progress snapshots, stack traces, raw errors, and credentials.
- **Retention decay** — keeps the strongest memories in prompt context while older or weaker memories fade out naturally; important and reinforced memories decay more slowly.

## Installation

Add OpenCode Working Memory to your server plugin config:

`.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-working-memory"]
}
```

To enable the native TUI `/memory` display command, also add the TUI plugin config:

`.opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-working-memory"]
}
```

Then restart OpenCode. Server memory activates automatically; TUI memory commands appear in slash command autocomplete when the TUI plugin is loaded.

## Native TUI Memory Command

The TUI plugin adds display-only local memory commands:

- `/memory` or `/memory status` — show status counts for workspace memory, rendered memories, pending memory, open errors, and recent decisions.
- `/memory activity` or `/memory last` — show recent local evidence activity. Due to the current OpenCode command model, some versions may show separate autocomplete entries instead of typed subargs.
- `/memory help` — show command help.

These commands are read-only and local-only. They read local memory files and inject output with OpenCode's no-reply session prompt path, so they do not make an LLM/API call.

Current OpenCode plugins do not expose an assistant-style command-output surface, so `/memory` output appears as a user-style conversation message. The output becomes part of the session transcript and may be included in future compaction summaries; this is expected command output.

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
│ system[2+]*: hot session state       │
└──────────────────────────────────────┘
```

\* Conceptually, workspace memory is pushed first when it is non-empty, and hot session state is pushed after workspace memory. If workspace memory is empty, hot state may be the first plugin-added system message. Actual `system[]` indices also depend on OpenCode and other plugins, so `system[1]` / `system[2+]` is a simplified model.

**Zero extra API calls:** OpenCode Working Memory does not call the model on its own. Memory extraction is folded into OpenCode's built-in compaction request.

**Cache-friendly layout:** durable workspace memory is rendered as a stable frozen snapshot for the session, while fast-changing hot session state is appended separately. Compaction starts a new cache epoch, refreshing the workspace snapshot after pending memories are promoted.

The runtime context has three layers:

| Layer | Purpose | Lifetime |
|---|---|---|
| Workspace Memory | Durable decisions, preferences, project facts, references | Cross-session |
| Hot Session State | Active files, open errors, recent context | Current session |
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

You can explicitly ask the agent to remember durable facts.

Examples:

```md
Remember this: we prefer Vitest for new frontend tests.
記住：這個 repo 發 release 前要先跑 npm test。
覚えておいて: API clients should use the shared retry helper.
기억해줘: this project uses pnpm, not npm.
```

Supported trigger languages include:

| Language | Examples |
|---|---|
| English | `remember this`, `save to memory`, `from now on`, `my preference` |
| Chinese | `記住`, `记住`, `記得`, `请帮我记住` |
| Japanese | `覚えて`, `覚えておいて`, `メモして` |
| Korean | `기억해`, `기억해줘`, `메모해줘` |

Negative requests are respected too:

```md
Don't remember this.
不要記住這個。
覚えないで。
기억하지 마.
```

Avoid saving:

- Secrets, passwords, tokens, or credentials
- Temporary progress updates
- Raw command output
- Short-lived session details

## Quality Guards

OpenCode Working Memory tries to keep memory useful and low-noise.

It includes guards for:

- Credential redaction
- Duplicate memory cleanup
- Accounting for promoted, absorbed, superseded, and rejected memories
- Strength-based retention so useful memories stay visible without hard age pruning
- Filtering stack traces, git hashes, raw errors, and noisy path-heavy facts
- Rejecting temporary project progress snapshots

The goal is to remember durable facts, not every detail.

**Good memory is selective memory.**

Historical cleanup is intentionally conservative: extraction-time filtering may reject more aggressively, but one-time migration cleanup only supersedes high-confidence garbage patterns. This protects existing durable memories written in declarative style, such as "API endpoint is X" or "Product branding is Y".

### Numbered Memory Refs

During compaction, existing workspace memories may be shown as numbered refs such as `[M1]` or `[M2]`. The model can use these refs to maintain memory without duplicating it:

```md
REINFORCE [M1]
REPLACE [M2] project Updated durable project fact.
```

- `REINFORCE [M#]` strengthens an existing memory's retention signal without changing its text.
- `REPLACE [M#] [type] text` supersedes a safe compaction-sourced memory and adds a replacement.
- Manual, explicit, and already-reinforced memories are protected from automatic replacement.
- Stale or mismatched numbered refs are rejected instead of mutating the wrong memory.

Use `memory-diag commands` to inspect command outcomes and `memory-diag revert` to dry-run and apply manual recovery for successful numbered replacements.

### Memory Diagnostics CLI

Use the read-only diagnostics CLI when you want to understand what memory is doing for the current workspace.

| Question | Command |
|---|---|
| Is memory healthy? | `npx --package opencode-working-memory memory-diag` or `npx --package opencode-working-memory memory-diag status` |
| Why was something rejected? | `npx --package opencode-working-memory memory-diag rejected` |
| Where did my memory go? | `npx --package opencode-working-memory memory-diag missing` |
| Why is this memory shown or hidden? | `npx --package opencode-working-memory memory-diag explain <memory-id>` |
| How are numbered memory commands behaving? | `npx --package opencode-working-memory memory-diag commands` |
| Revert a numbered replacement? | `npx --package opencode-working-memory memory-diag revert --memory <replacement-memory-id>` |

Global options:

- `--workspace <path>` — inspect another workspace; defaults to the current directory.
- `--verbose` — show detailed diagnostics.
- `--json` — print machine-readable output where supported.

Examples:

```bash
npx --package opencode-working-memory memory-diag status
npx --package opencode-working-memory memory-diag rejected --verbose
npx --package opencode-working-memory memory-diag missing --workspace /path/to/project
npx --package opencode-working-memory memory-diag status --json
npx --package opencode-working-memory memory-diag commands --verbose
npx --package opencode-working-memory memory-diag revert --memory <replacement-memory-id>
```

`memory-diag revert` is dry-run by default. Add `--apply` only after reviewing the planned original/replacement status changes.

The npm package is opencode-working-memory; the installed bin is memory-diag, so package-qualified npx avoids resolving a different package named memory-diag.

Maintainer-only diagnostics and cleanup commands are intentionally not documented here. Future work: move those internal commands to `docs/development.md`.

## Configuration

OpenCode Working Memory works out of the box.

Default behavior:

- Workspace memory budget: 3600 characters (~900 tokens)
- Workspace memory limit: 28 entries
- Hot session state budget: 700 characters (~175 tokens)
- Active files shown: 8
- Open errors shown: 3

See [Configuration](docs/configuration.md) for customization options.

## Roadmap

Current focus:

- Add explicit delete tombstones so removed memories do not get re-extracted.
- Monitor numbered refs and protected replacements with `memory-diag commands` before tightening automatic replacement policy further.
- Explore tiered hot/warm/cold storage after the retention model has more real-world data.

## Documentation

- [Architecture Overview](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Installation Guide](docs/installation.md)

## Development

```bash
git clone https://github.com/sdwolf4103/opencode-working-memory.git
cd opencode-working-memory
npm install
npm test
npm run typecheck
```

## Requirements

- OpenCode plugin API `>=1.2.0 <2.0.0`
- Node.js >= 22.6.0 (for `memory-diag` CLI, which runs TypeScript with `--experimental-strip-types`)

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
