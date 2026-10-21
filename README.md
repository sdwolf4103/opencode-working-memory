# OpenCode Working Memory

[![npm version](https://img.shields.io/npm/v/opencode-working-memory.svg)](https://www.npmjs.com/package/opencode-working-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Automatic memory for OpenCode agents.

Working memory is context that **remembers what matters, fades what changes, and stays out of the way.**

OpenCode Working Memory preserves project decisions, preferences, and references across compactions and sessions, while keeping active files and unresolved errors fresh for the current session — with no manual tools or extra LLM/API calls.

It can also share that memory with other local coding agents. **CodeBuddy Code and oh-my-pi are supported today; support for more local harness agents is in progress.**

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
| Share memory across agents | A two-way bridge lets other local harness agents read and edit the same workspace memory. CodeBuddy Code and oh-my-pi are supported now; more harnesses are in progress. |

```text
remember this ──► workspace memory ──► /memory
     ▲                    │              searchable [M#] refs
     │                    ▼
compaction ─────► reinforce / replace ──► selective prompt context
```

## Installation

### OpenCode V2 (recommended)

Add the package to the `plugins` array in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-working-memory"]
}
```

V2 discovers the CLI/TUI entrypoint from the package's `./tui` export automatically, so there is no separate `tui.json` step. Restart OpenCode after changing the config.

To run a local checkout, point at the plugin directory (V2 requires a directory, not an `index.ts` file):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/mirro/coding/opencode-working-memory"]
}
```

Local directory plugins keep the server and TUI entrypoints side by side: V2 discovers `tui.ts` next to `index.ts`. The published package exposes the same module through `exports["./tui"]`.

### OpenCode V1

V1 keeps the original two-file setup:

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

Both adapters share the same on-disk memory format, so switching between V1 and V2 keeps existing workspace memory.

### Strict OpenAI-Compatible Providers (V1 only)

Some V1 providers, including GWDG/Qwen endpoints, reject requests with multiple system messages. If your provider returns `System message must be at the beginning`, enable merged system prompts in `.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["opencode-working-memory", { "mergeSystemMessages": true }]]
}
```

This keeps memory context available by appending workspace memory and hot session state into the first system message. Leave this option off for providers that already accept multiple system messages; the default separated prompts are more cache-friendly. V2 injects memory as separate system parts and ignores this option.

Fallback for older OpenCode/plugin hosts that do not pass plugin tuple options:

```bash
export OPENCODE_WM_MERGE_SYSTEM_MESSAGES=true
opencode
```

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

## Shared Memory with Other Local Harness Agents

OpenCode Working Memory can act as the shared memory layer for the coding agents you already run locally, so a decision captured in OpenCode is still available when you switch to another harness. **CodeBuddy Code and oh-my-pi are supported today; compatibility with other local harness agents is in progress.**

Each integration follows the same rules: it uses the target agent's native memory format and directory, only writes files that OpenCode owns, never rewrites another agent's files, and stays disabled until you configure it. No hooks or patches are required in the other agent.

### CodeBuddy Code

The optional CodeBuddy bridge shares memory both ways without changing CodeBuddy's code. It is disabled by default because it writes into CodeBuddy's memory directory.

Enable it in V2 `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-working-memory",
      "options": {
        "codeBuddyBridge": {
          "includeGlobal": true,
          "includeSensitive": false
        }
      }
    }
  ]
}
```

For a local checkout, use the plugin directory as `package`.

How it works:

- OpenCode exports each active workspace memory as `opencode-<id>.md` in CodeBuddy's project memory directory: `~/.codebuddy/projects/<compressed-workdir>/memory/`.
- It maintains one marked block in that directory's `MEMORY.md`; CodeBuddy's own index lines are preserved.
- CodeBuddy's project (and optionally global) topic files are indexed in OpenCode's system prompt. The agent reads the full file on demand with `read`/`grep`, so the 51-file / 17 KB index does not have to fit in OpenCode's memory budget.
- Editing an `opencode-*.md` file and saving it updates the matching OpenCode memory on the next OpenCode request. Deleting it supersedes the memory.
- To promote a CodeBuddy topic file into OpenCode's own JSON memory (and compaction flow), add `shared: true` to its frontmatter.
- Files whose names or descriptions look credential-related (`password`, `token`, `ssh`, `vps`, `access`, etc.) are skipped unless `includeSensitive: true`.

Defaults:

| Option | Default | Purpose |
|---|---|---|
| `includeGlobal` | `false` | Also index/import `~/.codebuddy/memories/global` |
| `includeSensitive` | `false` | Include credential-looking files |
| `maxIndexEntries` | `14` | CodeBuddy entries in the OpenCode prompt |
| `maxIndexChars` | `1600` | Character budget for that index |
| `maxImportedShared` | `12` | CodeBuddy `shared: true` files imported into JSON |
| `syncIntervalMs` | `3000` | Minimum gap between full scans |

CodeBuddy reads its memory at session start, so start a new CodeBuddy session to see newly exported OpenCode memories. OpenCode sees CodeBuddy edits on its next request.

### oh-my-pi (local memory backend)

The oh-my-pi bridge shares memory with omp's `local` memory backend, which stores plain Markdown. Keep `memory.backend: local` in `~/.omp/agent/config.yml`, then enable the bridge in V2 `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-working-memory",
      "options": {
        "ohMyPiBridge": {
          "includeSensitive": false
        }
      }
    }
  ]
}
```

How it works:

- oh-my-pi keeps per-project memory under `~/.omp/agent/memories/<encoded-workdir>/` and injects `memory_summary.md` plus `learned.md` into its system prompt. Only the `local` backend is supported; `mnemopi`, `hindsight`, and `sharpshooter` are not.
- OpenCode exports active workspace memories as lesson lines prefixed `[opencode:<id>]` in `learned.md`, at the head of the lesson list. Every other line in the file is preserved.
- oh-my-pi `learn` lessons are indexed in OpenCode's prompt, and up to 12 recent lessons are imported as read-mostly JSON memories tagged `omp`. Deleting an oh-my-pi lesson supersedes its imported copy, and re-adding it reactivates that memory.
- Editing an `[opencode:<id>]` line updates the matching OpenCode memory on the next request. Deleting the line supersedes it.
- The bridge never writes `memory_summary.md`, `MEMORY.md`, or `skills/`; those belong to oh-my-pi's consolidation pipeline.
- Credential-looking lessons are skipped unless `includeSensitive: true`.

Defaults:

| Option | Default | Purpose |
|---|---|---|
| `homeDir` | `~/.omp` | oh-my-pi config root |
| `agentDir` | `<homeDir>/agent` | Agent state directory |
| `includeSensitive` | `false` | Include credential-looking lessons |
| `maxExported` | `12` | OpenCode memories written to `learned.md` |
| `maxImportedLessons` | `12` | oh-my-pi lessons imported into JSON memory |
| `maxIndexEntries` | `14` | oh-my-pi lessons listed in the OpenCode prompt |
| `maxIndexChars` | `1600` | Character budget for that index |
| `syncIntervalMs` | `3000` | Minimum gap between full scans |

oh-my-pi builds its memory prompt when a session starts, so start a new omp session to see newly exported OpenCode memories. OpenCode sees oh-my-pi edits on its next request.

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
