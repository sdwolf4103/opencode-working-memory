# Native TUI Memory Command UX Implementation Plan

> **For agentic workers:** Use `agenthub-writing-plans-skill` to create this plan and `agenthub-executing-plans-skill` to execute it task-by-task. Steps use checkbox (`- [ ]`) syntax. Wave checkpoints are gates.

**Goal:** Replace the current ambiguous native OpenCode TUI memory slash-command surface with three visibly distinct hyphenated commands before commit/push.

**User outcome:** OpenCode users see only `/memory-status`, `/memory-list`, and `/memory-help` in slash autocomplete; status shows memory statistics, list shows current active workspace memories as display-local `[M1]` refs, and duplicate recent-activity commands are no longer user-facing.

**Architecture:** Keep the existing TUI plugin and no-reply session-message injection path. Change only the command registration/routing layer (`src/tui-plugin.ts`) and the local read/format core (`src/memory-visibility.ts`), then update focused tests and docs. Do not add storage, background jobs, LLM calls, command mutation, or a parallel UI surface.

**Tech stack:** TypeScript ESM on Node >=22.6, OpenCode TUI plugin API, local JSON stores, Node built-in test runner with `--experimental-strip-types`.

**Scope mode:** COMPLETE for the approved UX correction; no implementation code is changed by this plan.

---

## Scope Challenge

- Existing leverage: Reuse `src/tui-plugin.ts` command registration and `api.client.session.prompt({ noReply: true })`; reuse `src/memory-visibility.ts` local read snapshots, redaction helper, and `accountWorkspaceMemoryRender()`/`accountWorkspaceMemoryCompactionRefs()` accounting instead of creating a separate diagnostic subsystem.
- Minimum complete change: Register three unique top-level slash names, add/route a list formatter, remove visible activity/last commands, make status stats-only, and update README/CHANGELOG/tests to match the new public surface.
- Scope smell check: Expected code/docs/test touch set is 6 files: `src/tui-plugin.ts`, `src/memory-visibility.ts`, `tests/tui-plugin.test.ts`, `tests/memory-visibility.test.ts`, `README.md`, and `CHANGELOG.md`. `RELEASE_NOTES.md`, `docs/installation.md`, and `docs/configuration.md` do not currently mention the TUI memory commands and should stay unchanged unless implementation reveals new command mentions.
- Lake vs ocean: The lake is display-only status/list/help for existing local data. Ocean-sized extras remain out of scope: `/memory delete`, `/memory edit`, stable memory IDs in the TUI, interactive list selection, evidence activity dashboards, assistant-style output APIs, and upstream OpenCode TUI changes.
- Out of scope: No activity/last user-facing commands, no `/memory` space-subcommand autocomplete entries, no new aliases unless OpenCode proves they do not create duplicate menu rows, no persistence schema changes, no LLM/API calls, and no server plugin behavior changes.

## Search and Prior Art

- Layer 1 choices:
  - `src/tui-plugin.ts:113-148` currently registers four commands with the same `slash.name: "memory"`, causing OpenCode to show multiple identical `/memory` rows.
  - `src/tui-plugin.ts:58-63` maps internal values `memory.activity` and `memory.last` to the same `"activity"` command, confirming duplication.
  - `src/memory-visibility.ts:12` currently exposes `MemoryVisibilityCommand = "status" | "activity" | "help"`; `formatMemoryHelp()` at lines 273-288 documents `/memory activity` and `/memory last`.
  - `src/memory-visibility.ts:213-238` already formats status counts but also includes preview lines; the approved UX wants status focused on statistics and delegates memory content to `/memory-list`.
  - `src/workspace-memory.ts:937-997` already has numbered ref accounting (`accountWorkspaceMemoryCompactionRefs`) that returns rendered entries, omitted entries, and `refs` with `M1`, `M2`, ... display labels. This is the best existing source for list refs because it respects the same selection/cap logic as compaction refs.
  - `tests/tui-plugin.test.ts:98-153` covers TUI registration, no-reply injection, routing, no-session warning, dialog clearing, and injection failure.
  - `tests/memory-visibility.test.ts:53-195` covers status/activity/help formatting and read-only redaction behavior.
  - `README.md:64-76` and `CHANGELOG.md:8-25` document the current `/memory` status/activity/help UX and must be updated before commit/push.
- Layer 2 choices: None required. Do not add dependencies.
- Layer 3 choices: A small `MemoryListModel`/`formatMemoryList()` in `src/memory-visibility.ts` is justified because the TUI needs a user-facing grouped list shape that differs from compaction prompt text.
- Eureka findings: OpenCode's current slash menu does not visibly distinguish trailing subcommand text, so the technically elegant `/memory status` model is worse UX than three hyphenated top-level commands for this release.

## Architecture

### Components and responsibilities

- `src/tui-plugin.ts`: Owns visible TUI command names and active-session/no-reply injection. It should register exactly three commands with `slash.name` values `memory-status`, `memory-list`, and `memory-help`; internal `value` strings may remain dot-form (`memory.status`, `memory.list`, `memory.help`) because they are not displayed to users.
- `src/memory-visibility.ts`: Owns read-only local models and markdown/plain-text formatting. It should expose command variants `status`, `list`, and `help`; status should report stats only; list should show active rendered workspace memories with display-local `[M#]` refs; help should list only the three public commands. `MemoryVisibilityCommand` is currently consumed by `src/tui-plugin.ts`; verify no other consumers exist before changing/removing exported command variants.
- `src/workspace-memory.ts`: No planned edit. Reuse `accountWorkspaceMemoryRender()` for stats and `accountWorkspaceMemoryCompactionRefs()` for capped/ref-capable list selection. If imports need updating, import only existing exported functions.
- `tests/tui-plugin.test.ts`: Assert unique slash names and removal of user-facing activity/last registrations.
- `tests/memory-visibility.test.ts`: Assert status/list/help output contracts, redaction/truncation, caps, and fallback routing.
- `README.md` and `CHANGELOG.md`: Align public docs with the new three-command UX. `RELEASE_NOTES.md` has no 1.6.1 TUI command section today; leave it unchanged unless a later release-notes pass adds one.

### Data flow

```text
User selects /memory-status, /memory-list, or /memory-help in OpenCode TUI
  -> src/tui-plugin.ts registered command onSelect
  -> determine active sessionID from api.route/current session route
  -> commandFromValue(value) returns "status" | "list" | "help"
  -> src/memory-visibility.ts renderMemoryCommand(root, sessionID, command)
       status: read workspace/session/pending snapshots + render accounting counts
       list: read workspace snapshot + accountWorkspaceMemoryCompactionRefs() + safePreview()
       help: static command help
  -> api.client.session.prompt({ sessionID, noReply: true, parts: [{ type: "text", text }] })
  -> OpenCode renders the report as local no-reply session text; no LLM call is made
```

### Output contracts

#### `/memory-status`

Required shape:

```md
## Memory status

Workspace:
- Active memories: <n>
- Rendered in prompt: <n>
- Omitted active memories: <n>
- Superseded memories: <n>

Pending:
- Pending in this session: <n>
- Pending journal memories: <n>

Session:
- Open errors: <n>
- Recent decisions: <n>

Use /memory-list to view current [M1]-[M28] memory refs.

Local only: no LLM request was made.
```

Notes:
- Remove preview lines from status.
- Keep zero/empty counts visible.
- Keep the local-only footer.

#### `/memory-list`

Required shape:

```md
## Current workspace memories

Display refs are local to this output and may change after memory updates.

feedback:
- [M1] <redacted/truncated text>

project:
- [M2] <redacted/truncated text>

decision:
- [M3] <redacted/truncated text>

reference:
- [M4] <redacted/truncated text>

Shown: <rendered> of <active> active memories.
Omitted active memories: <omitted-active>.

Local only: no LLM request was made.
```

Notes:
- Use refs that are explicitly display-local, not stable IDs.
- Group by memory type/kind in the existing order: `feedback`, `project`, `decision`, `reference`.
- Show only active, non-superseded memories selected by the same caps/budget used for rendered memory refs. The default global cap is 28 (`src/types.ts` via `LONG_TERM_LIMITS.maxEntries`).
- Apply `safePreview()` or equivalent credential redaction/truncation to every displayed memory text. Do not dump raw JSON or full unbounded memory text.
- Empty state: `No active workspace memories are stored yet.` plus the local-only footer.

#### `/memory-help`

Required shape:

```md
## Memory help

Commands:
- /memory-status — show local memory statistics.
- /memory-list — show current workspace memories as display-local [M1]-[M28] refs.
- /memory-help — show this help.

These commands are read-only, local-only, and do not call the LLM.
```

Notes:
- Do not mention `/memory`, `/memory status`, `/memory activity`, or `/memory last` as available commands.
- It is acceptable to keep a short note that mutation commands such as delete/edit are not available, but do not expand scope.

### Error flow

- No active session route: preserve existing warning toast behavior and do not write a message.
- Local read/format error with a session: preserve existing `## Memory error` stream-visible report.
- `api.client.session.prompt()` failure: preserve existing error toast and no retry.
- Unknown internal command value: route to help. Do not register unknown/legacy values in the visible command list.

### Security and permissions

- Commands are read-only over local memory/session/pending files and write only the user-invoked no-reply session output.
- Display memory text only after redaction and truncation.
- Do not introduce shell execution, network calls, LLM calls, or file writes to memory stores.
- Do not treat display-local `[M#]` refs as authorization or stable identity; they are only labels in the printed list.

### Performance

- Status remains O(number of workspace/session/pending entries), using existing bounded stores.
- List should format at most the rendered/ref-selected memories and must respect existing caps/budgets; avoid full evidence lifecycle joins.
- Removing activity from the visible UX avoids querying/formatting evidence logs during normal command use.

### Production failure scenarios

- OpenCode still displays aliases or duplicate slash names unexpectedly: keep only three primary `slash.name` values and avoid aliases until verified.
- User expects `/memory` from an unreleased local build: because this is before commit/push, prefer clean UX over compatibility debt; docs should clearly advertise the three hyphenated commands.
- Very long memories or credentials appear in stored data: list formatter must redacted/truncate via `safePreview()` and tests should assert credential-like fixture text is absent.
- More than 28 active memories exist: list reports shown vs active and omitted count; it must not imply refs cover hidden memories.

## Backwards Compatibility Stance

- Treat the current `/memory` space-subcommand surface as pre-public/unshipped for this commit because it produces duplicate-looking menu entries in OpenCode.
- Remove visible registrations for `/memory`, `/memory status`, `/memory activity`, `/memory last`, and `/memory help`.
- Do not document old spellings.
- Internal fallback may continue routing unknown values to help, but do not preserve hidden legacy command entries if OpenCode would show them in autocomplete.
- If a reviewer requests aliases, add only after confirming aliases do not create extra duplicate menu rows; otherwise defer aliases to a later OpenCode API capability discussion.

## File Plan

- Modify: `src/tui-plugin.ts:58-63` — route `memory.status`, `memory.list`, and `memory.help`; remove activity/last mapping from the public path.
- Modify: `src/tui-plugin.ts:113-148` — register exactly three commands with `slash.name` values `memory-status`, `memory-list`, `memory-help`; remove `Memory activity` and `Memory last` command objects.
- Modify: `src/memory-visibility.ts:12-40` — change command/model types from status/activity/help to status/list/help; add `MemoryListModel`; remove or unexport activity-only types/functions if no longer used.
- Modify: `src/memory-visibility.ts:190-238` — keep stats model but format status as grouped statistics with no previews.
- Modify: `src/memory-visibility.ts:240-271` — replace activity reader/formatter with list reader/formatter or remove activity code and add list code nearby.
- Modify: `src/memory-visibility.ts:273-288` — update help to list only `/memory-status`, `/memory-list`, `/memory-help`.
- Modify: `src/memory-visibility.ts:291-302` — route `"list"` to the new list formatter and remove `"activity"` routing.
- Modify: `tests/tui-plugin.test.ts` — assert three unique visible commands and route status/list/help.
- Modify: `tests/memory-visibility.test.ts` — replace activity tests with list tests; update status/help assertions.
- Modify: `README.md:33,51-76` — update feature copy and Native TUI command docs.
- Modify: `CHANGELOG.md:8-25` — amend unreleased/current 1.6.1 entry from status/activity/help to status/list/help and note hyphenated names.
- No planned change: `RELEASE_NOTES.md` — no 1.6.1 TUI command mention exists in current evidence.
- No planned change: `docs/installation.md`, `docs/configuration.md` — current grep found no TUI command mentions.

## Test Strategy

- Framework: Node built-in test runner via `npm test`; TypeScript via `npm run typecheck`.
- Unit coverage:
  - `memory-visibility.ts` status counts with active/superseded/rendered/omitted entries, pending memories, pending journal entries, open errors, and recent decisions; assert no preview section remains.
  - `memory-visibility.ts` list output with active memories grouped by type, display-local `[M#]` labels, shown/active/omitted summary, redacted credential-like text, empty state, and local-only footer.
  - `memory-visibility.ts` help text lists only three hyphenated commands and omits `/memory activity` and `/memory last`.
  - `renderMemoryCommand()` routes `status`, `list`, and `help`; unknown values fall back to help.
- TUI integration-style unit coverage:
  - Registers exactly three command values.
  - Slash names are exactly `memory-status`, `memory-list`, `memory-help` and unique.
  - No registered command value is `memory.activity` or `memory.last`.
  - Selecting `memory.status`, `memory.list`, and `memory.help` injects no-reply text with the expected heading.
  - Existing no-session warning, dialog clearing, and prompt-injection failure behavior still passes.
- Docs verification:
  - Grep for old public spellings in markdown and source tests after implementation; old spellings should remain only in this plan or intentionally in negative assertions.

## Implementation Tasks

## Wave 1: Failing Tests for the New Public Contract

### Task 1.1: Update TUI command registration/routing tests first

**Purpose:** Prove the slash command menu no longer contains duplicate-looking `/memory` entries.

**Files:**
- Modify: `tests/tui-plugin.test.ts`

**Behavior:**
- Given the TUI plugin registers commands, there are exactly three memory commands.
- Given autocomplete displays slash names, the names are unique hyphenated top-level commands.
- Given a command is selected, status/list/help route to distinct headings.

- [ ] **Step 1: Write failing tests**

Add or update assertions equivalent to:

```ts
test("registers three unique hyphenated memory slash commands", async () => {
  const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } } });
  await MemoryTuiPlugin(api as any, undefined, mockMeta);

  const slashNames = api.commands.map(command => command.slash?.name).filter(Boolean);
  assert.deepEqual(slashNames, ["memory-status", "memory-list", "memory-help"]);
  assert.equal(new Set(slashNames).size, slashNames.length);
  assert.deepEqual(api.commands.map(command => command.value), ["memory.status", "memory.list", "memory.help"]);
  assert.equal(api.commands.some(command => command.value === "memory.activity"), false);
  assert.equal(api.commands.some(command => command.value === "memory.last"), false);
});
```

Update the routing test to select `memory.list` and expect `## Current workspace memories`.

- [ ] **Step 2: Run expected failure**

Run: `node --import ./tests/setup-xdg-data-home.ts --test --experimental-strip-types tests/tui-plugin.test.ts`

Expected: FAIL because current `src/tui-plugin.ts` registers repeated `slash.name: "memory"` and does not register `memory.list`.

### Task 1.2: Update memory visibility formatter tests first

**Purpose:** Lock the approved status/list/help output shape before implementation.

**Files:**
- Modify: `tests/memory-visibility.test.ts`

**Behavior:**
- Status is stats-only and points to `/memory-list`.
- List prints current active memories grouped by type with display-local refs and redaction.
- Help lists only three hyphenated commands.

- [ ] **Step 1: Write failing tests**

Required assertions:

```ts
assert.match(output, /^## Memory status/);
assert.match(output, /Workspace:/);
assert.match(output, /Pending:/);
assert.match(output, /Session:/);
assert.match(output, /Use \/memory-list to view current \[M1\]-\[M28\] memory refs\./);
assert.equal(output.includes("Recent active memory previews"), false);
```

Replace activity tests with list tests that create at least one memory for each type and one superseded memory. The redaction fixture must include at least one short credential-like active memory that is guaranteed to render, such as `Remember password: sushi for the fake test.`, so `output.includes("sushi") === false` proves redaction rather than omission by caps/budget. Assert:

```ts
assert.match(output, /^## Current workspace memories/);
assert.match(output, /Display refs are local to this output/);
assert.match(output, /feedback:\n- \[M\d+\]/);
assert.match(output, /project:\n- \[M\d+\]/);
assert.match(output, /decision:\n- \[M\d+\]/);
assert.match(output, /reference:\n- \[M\d+\]/);
assert.match(output, /Shown: \d+ of \d+ active memories\./);
assert.equal(output.includes("sushi"), false);
assert.equal(output.includes("Superseded memory should not be active"), false);
```

Update help assertions:

```ts
assert.match(output, /\/memory-status/);
assert.match(output, /\/memory-list/);
assert.match(output, /\/memory-help/);
assert.equal(output.includes("/memory activity"), false);
assert.equal(output.includes("/memory last"), false);
```

- [ ] **Step 2: Run expected failure**

Run: `node --import ./tests/setup-xdg-data-home.ts --test --experimental-strip-types tests/memory-visibility.test.ts`

Expected: FAIL because current implementation still exposes activity/last and lacks list output.

### Wave 1 Checkpoint

- [ ] Confirm both focused test files fail for the expected missing behavior, not unrelated setup errors.
- [ ] Do not proceed if failures indicate fixture/storage regressions unrelated to command UX.

## Wave 2: Implement the Visibility Core

### Task 2.1: Add list model/formatter and simplify status/help

**Purpose:** Make the local rendering core match the approved command set independently of TUI registration.

**Files:**
- Modify: `src/memory-visibility.ts`

**Implementation instructions:**
- Change `MemoryVisibilityCommand` to `"status" | "list" | "help"`.
- Add a `MemoryListModel` that contains:
  - `activeMemories: number`
  - `renderedMemories: number`
  - `omittedActiveMemories: number`
  - `groups: Record<LongTermMemoryEntry["type"], Array<{ ref: string; text: string }>>` or equivalent typed structure preserving `feedback`, `project`, `decision`, `reference` order.
- Implement `getMemoryList(root: string)` using `readWorkspaceMemorySnapshot(root)` and `accountWorkspaceMemoryCompactionRefs(store)`.
  - Count active memories from the raw/snapshot store by `status !== "superseded"`.
  - Use accounting `refs` plus `rendered` entries to build display-local refs.
  - Only use the `refs`, `rendered`, and `omitted` fields from `accountWorkspaceMemoryCompactionRefs()` for the list formatter; discard its `evidence` and `prompt` fields and do not call `appendEvidenceEvents()` from `/memory-list`.
  - Display text must pass through `safePreview(ref.textPreview)`.
  - `omittedActiveMemories` should count only `accounting.omitted` entries whose memory is not superseded; `accounting.omitted` can include superseded entries from selection accounting and those must not inflate active omissions.
- Implement `formatMemoryList(model)` with the required output contract.
- Update `formatMemoryStatus()` to remove preview output and use grouped stat sections.
- Update `formatMemoryHelp()` to list only `/memory-status`, `/memory-list`, `/memory-help`.
- Update `renderMemoryCommand()` switch to route `"list"`.
- Remove `MemoryActivityModel`, `DEFAULT_ACTIVITY_LIMIT`, `MAX_ACTIVITY_LIMIT`, `clampLimit`, `getMemoryActivity()`, `formatMemoryActivity()`, `formatActivityEvent()`, and `summarizeReasons()` if they become unused. Also remove unused `EvidenceEventV1`/`queryEvidenceEvents` imports.
- Before deleting activity-only exports/helpers, grep `src/` for `MemoryActivityModel`, `getMemoryActivity`, `formatMemoryActivity`, `formatActivityEvent`, and `summarizeReasons()`; remove them only after confirming there are no cross-module consumers outside `memory-visibility.ts`.

- [ ] **Step 1: Implement minimal code**

Do not modify `src/workspace-memory.ts` unless TypeScript proves an export is missing. Current evidence shows `accountWorkspaceMemoryCompactionRefs` is exported.

- [ ] **Step 2: Run focused verification**

Run: `node --import ./tests/setup-xdg-data-home.ts --test --experimental-strip-types tests/memory-visibility.test.ts`

Expected: PASS.

- [ ] **Step 3: Run typecheck for dead imports/types**

Run: `npm run typecheck`

Expected: PASS and output includes `TYPECHECK_PASS`.

### Wave 2 Checkpoint

- [ ] Status output contains no memory preview content.
- [ ] List output includes display-local `[M#]` refs, grouped by type, with redacted/truncated text.
- [ ] Activity/last formatter exports are either removed or no longer referenced by user-facing code.

## Wave 3: Implement the TUI Command Surface

### Task 3.1: Register only three hyphenated slash commands

**Purpose:** Fix OpenCode autocomplete by ensuring visible slash names are unique top-level commands.

**Files:**
- Modify: `src/tui-plugin.ts`

**Implementation instructions:**
- Update `commandFromValue(value)`:
  - `memory.status` -> `"status"`
  - `memory.list` -> `"list"`
  - `memory.help` -> `"help"`
  - default -> `"help"`
- Update `memoryCommands(api)` to return exactly three objects:
  - title `Memory status`, value `memory.status`, description `Show working memory statistics in the current session.`, category `Memory`, suggested `true`, `slash: { name: "memory-status" }`
  - title `Memory list`, value `memory.list`, description `Show current workspace memories with display-local refs.`, category `Memory`, `slash: { name: "memory-list" }`
  - title `Memory help`, value `memory.help`, description `Show working memory help.`, category `Memory`, `slash: { name: "memory-help" }`
- Remove `Memory activity` and `Memory last` command objects.
- Do not include `aliases: ["mem"]` in this wave; aliases can be reconsidered only after verifying they do not create duplicate menu entries.

- [ ] **Step 1: Implement minimal code**

Keep existing active-session guard, no-reply injection, dialog clearing, and prompt failure toast logic unchanged.

- [ ] **Step 2: Run focused verification**

Run: `node --import ./tests/setup-xdg-data-home.ts --test --experimental-strip-types tests/tui-plugin.test.ts`

Expected: PASS.

- [ ] **Step 3: Run adjacent focused verification**

Run: `node --import ./tests/setup-xdg-data-home.ts --test --experimental-strip-types tests/tui-plugin.test.ts tests/memory-visibility.test.ts`

Expected: PASS.

### Wave 3 Checkpoint

- [ ] TUI registration tests prove slash names are unique.
- [ ] No test expects or selects `memory.activity` or `memory.last`.
- [ ] No implementation path requires OpenCode to render trailing subcommand text.

## Wave 4: Documentation and Release Metadata Alignment

### Task 4.1: Update user-facing docs

**Purpose:** Ensure install/usage docs no longer advertise broken or removed command spellings.

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Verify/no change unless needed: `RELEASE_NOTES.md`, `docs/installation.md`, `docs/configuration.md`

**Implementation instructions:**
- In `README.md` feature bullets, replace “status, recent activity, and help” with “status, current memory list, and help”.
- In the Native TUI Memory Command section, document:
  - `/memory-status` — status counts/statistics
  - `/memory-list` — current active workspace memories with display-local `[M1]` refs
  - `/memory-help` — help
- Keep the existing local-only/no LLM/no-reply transcript caveat.
- Remove docs for `/memory`, `/memory status`, `/memory activity`, `/memory last`, and `/memory help` as available user commands.
- In `CHANGELOG.md` 1.6.1 entry, amend the current TUI command bullet to say hyphenated `/memory-status`, `/memory-list`, `/memory-help`, and note recent activity/last were removed before release because duplicate entries were not useful.
- `RELEASE_NOTES.md` currently has no 1.6.1 TUI command mention in the evidence read; do not add a release note unless the release process requires a 1.6.1 section.

- [ ] **Step 1: Update markdown docs**

Use exact command names consistently.

- [ ] **Step 2: Run docs/source grep**

Run equivalent local search:

```bash
rg "/memory activity|/memory last|/memory status|/memory help|slash: \{ name: \"memory\"|memory\.activity|memory\.last" README.md CHANGELOG.md src tests
```

Expected: no matches except this plan file if searching the whole repo, or negative test assertions that intentionally verify old commands are absent. The space-separated forms in this grep are obsolete spellings; the correct hyphenated commands `/memory-status`, `/memory-list`, and `/memory-help` should remain present.

### Wave 4 Checkpoint

- [ ] Docs advertise only `/memory-status`, `/memory-list`, `/memory-help`.
- [ ] Changelog matches the pre-release UX correction.
- [ ] No release docs mention stale activity/last commands.

## Final Verification

- [ ] Run: `npm run typecheck`
  Expected: PASS and output includes `TYPECHECK_PASS`.
- [ ] Run: `npm test`
  Expected: PASS and output includes `TEST_PASS`.
- [ ] Run: `npm pack --dry-run`
  Expected: package contains `index.ts`, `src/tui-plugin.ts`, `src/memory-visibility.ts`, README, LICENSE, and no unexpected generated artifacts.
- [ ] Manual OpenCode TUI smoke before commit/push:
  - Configure `.opencode/tui.json` to load the local plugin target.
  - Open slash command menu and confirm exactly three visible memory commands: `/memory-status`, `/memory-list`, `/memory-help`.
  - Select `/memory-status`; expected no-reply session text headed `## Memory status`, no assistant response, no LLM/provider activity.
  - Select `/memory-list`; expected no-reply session text headed `## Current workspace memories`, display-local `[M#]` refs, grouped memory types, redacted/truncated text.
  - Select `/memory-help`; expected help lists only the three hyphenated commands.
- [ ] Review changed files for placeholders, dead code, unused activity imports, debug logging, stale docs, raw secret output, and accidental storage writes.

## Review Readiness

- [ ] Scope challenge resolved: this is a focused UX correction, not a memory subsystem rewrite.
- [ ] Architecture and data flow are explicit.
- [ ] Every changed behavior has a focused test or manual TUI smoke check.
- [ ] Failure paths and user-visible states are covered.
- [ ] Commands are exact and runnable.
- [ ] Backwards compatibility stance is explicit and pre-release-safe.
- [ ] Plan has no placeholders.

## Risks and Mitigations

- Risk: Hyphenated names are less elegant than `/memory status` subcommands. Mitigation: current OpenCode menu behavior makes hyphenated top-level names the only visible unambiguous option.
- Risk: Users may interpret `[M#]` as stable memory IDs. Mitigation: list output must explicitly say refs are display-local and may change after memory updates.
- Risk: Activity formatter code may be left as unused dead code. Mitigation: typecheck plus source grep should catch unused imports/references; remove activity-only exports unless a maintainer-only consumer is introduced later.
- Risk: List output may leak long or sensitive memory text. Mitigation: use redaction/truncation for each line and add regression assertions that credential-like fixture text is absent.
- Risk: Docs drift with the just-added 1.6.1 changelog. Mitigation: amend the same 1.6.1 entry before commit/push rather than adding contradictory release notes.
