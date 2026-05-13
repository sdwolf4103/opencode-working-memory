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
| How do I review memory quality without automatic cleanup? | `npx --package opencode-working-memory memory-diag quality` |
| Revert a numbered replacement? | `npx --package opencode-working-memory memory-diag revert --memory <replacement-memory-id>` |

## Global Options

- `--workspace <path>` — inspect another workspace; defaults to the current directory.
- `--verbose` — show detailed diagnostics.
- `--json` — print machine-readable output where supported.

## Diagnostic Answerability Contract

Every diagnostic section must document:

1. **Question:** What does the reviewer want to know?
2. **Decision:** What action could the answer inform?
3. **Competing explanations:** At least two interpretations of the same metric.
4. **Required signals:** What fields/events distinguish those explanations?
5. **Current signals:** What currently exists?
6. **Answerability level:** `supported` | `partial` | `inventory_only` | `not_instrumented`
7. **Output permission:** What the tool may say without overclaiming.

For `memory-diag quality`:
- `reinforcementRules`: `inventory_only` (cannot distinguish spam from legitimate blocks)
- `evictionAndCaps`: `inventory_only` (cannot distinguish healthy turnover from premature eviction)
- Old evidence remains ambiguous. Answerability improves only for events produced after instrumentation version 2. Mixed old/new logs will show a mix of `inventory_only` and `partial` sections.
- Producer-instrumented reinforcement blocks can upgrade `reinforcementRules` to `partial` by showing exact block reasons and UTC-day grouping; they still require human content judgment.
- Producer-instrumented capacity removals with rank/strength snapshots can upgrade `evictionAndCaps` to `partial`; fullness alone remains occupancy inventory, not proof of a capacity problem.

## Examples

```bash
npx --package opencode-working-memory memory-diag status
npx --package opencode-working-memory memory-diag rejected --verbose
npx --package opencode-working-memory memory-diag missing --workspace /path/to/project
npx --package opencode-working-memory memory-diag status --json
npx --package opencode-working-memory memory-diag commands --verbose
npx --package opencode-working-memory memory-diag quality
npx --package opencode-working-memory memory-diag revert --memory <replacement-memory-id>
```

## Quality Review Board

Use `memory-diag quality` for a read-only, answerability-scoped evidence inventory without automatic cleanup.

- Primarily provides memory-system mechanism observations for human/agent interpretation.
- Secondarily helps review active memory content quality.
- Prints answerability labels and output permissions so inventory facts are not presented as conclusions.
- Separates system-mechanism facts, memory-content facts, heuristic flags, and review questions.
- Includes inferred evidence provenance because historical records do not record producer package version.
- Labels uncertain provenance as `unversioned_ambiguous` so old artifacts are not treated as current mechanism failures.
- Does not decide what to delete or mutate.
- Use `--json` for agent/objective review.

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
