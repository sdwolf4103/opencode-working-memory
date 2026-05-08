# Memory Diagnostics

Use the read-only diagnostics CLI when you want to understand what OpenCode Working Memory is doing for the current workspace.

The npm package is `opencode-working-memory`; the installed bin is `memory-diag`, so package-qualified `npx` avoids resolving a different package named `memory-diag`.

## Commands

| Question | Command |
|---|---|
| Is memory healthy? | `npx --package opencode-working-memory memory-diag` or `npx --package opencode-working-memory memory-diag status` |
| Why was something rejected? | `npx --package opencode-working-memory memory-diag rejected` |
| Where did my memory go? | `npx --package opencode-working-memory memory-diag missing` |
| Why is this memory shown or hidden? | `npx --package opencode-working-memory memory-diag explain <memory-id>` |
| How are numbered memory commands behaving? | `npx --package opencode-working-memory memory-diag commands` |
| Revert a numbered replacement? | `npx --package opencode-working-memory memory-diag revert --memory <replacement-memory-id>` |

## Global Options

- `--workspace <path>` — inspect another workspace; defaults to the current directory.
- `--verbose` — show detailed diagnostics.
- `--json` — print machine-readable output where supported.

## Examples

```bash
npx --package opencode-working-memory memory-diag status
npx --package opencode-working-memory memory-diag rejected --verbose
npx --package opencode-working-memory memory-diag missing --workspace /path/to/project
npx --package opencode-working-memory memory-diag status --json
npx --package opencode-working-memory memory-diag commands --verbose
npx --package opencode-working-memory memory-diag revert --memory <replacement-memory-id>
```

## Numbered Memory Command Reports

Use `memory-diag commands` to inspect `REINFORCE [M#]` and `REPLACE [M#]` outcomes from compaction.

```bash
npx --package opencode-working-memory memory-diag commands
npx --package opencode-working-memory memory-diag commands --verbose
```

The report includes successful reinforcements, successful replacements, malformed commands, stale refs, protected replacement blocks, and latest command events in verbose mode.

## Dry-run Recovery

`memory-diag revert` is dry-run by default. Add `--apply` only after reviewing the planned original/replacement status changes.

```bash
npx --package opencode-working-memory memory-diag revert --memory <replacement-memory-id>
npx --package opencode-working-memory memory-diag revert --memory <replacement-memory-id> --apply
```

You can also target a replacement evidence event directly:

```bash
npx --package opencode-working-memory memory-diag revert --event <event-id>
```
