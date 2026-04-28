# OpenCode Working Memory

[![npm version](https://img.shields.io/npm/v/opencode-working-memory.svg)](https://www.npmjs.com/package/opencode-working-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Automatic memory for OpenCode agents.

OpenCode Working Memory helps your agent keep useful context across compactions and sessions: project decisions, preferences, important references, active files, and unresolved errors.

It works automatically, without manual memory tools or extra LLM/API calls.

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
- **No manual tools** — memory is injected automatically into the system prompt.
- **Quality guards** — filters noisy memories, temporary progress snapshots, stack traces, raw errors, and credentials.

## Installation

Add OpenCode Working Memory to your OpenCode config:

```json
{
  "plugin": ["opencode-working-memory"]
}
```

Then restart OpenCode. It activates automatically.

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
│ system[1]: frozen workspace memory   │
│ system[2+]: hot session state        │
└──────────────────────────────────────┘
```

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
- Superseding older decisions with newer ones
- Consolidation accounting so promoted, absorbed, superseded, and rejected memories are handled differently
- Filtering stack traces, git hashes, raw errors, and noisy path-heavy facts
- Rejecting temporary project progress snapshots

The goal is to remember durable facts, not every detail.

Historical cleanup is intentionally conservative: extraction-time filtering may reject more aggressively, but one-time migration cleanup only supersedes high-confidence garbage patterns. This protects existing durable memories written in declarative style, such as "API endpoint is X" or "Product branding is Y".

## Configuration

OpenCode Working Memory works out of the box.

Default behavior:

- Workspace memory budget: 5200 characters
- Workspace memory limit: 28 entries
- Hot session state budget: 1200 characters
- Active files shown: 8
- Open errors shown: 3

See [Configuration](docs/configuration.md) for customization options.

## Ongoing Work

Current focus:

- Improve memory recording quality so only durable, useful facts are kept.
- Strengthen deduplication and supersession so stale memories do not pile up.
- Add better forgetting behavior for obsolete decisions, preferences, and project facts.

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
- Node.js >= 18.0.0

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
