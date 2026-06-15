# Plan: User-Led Memory Review for Memory 2.0

## Goal

Add a user-led memory review workflow that lets the user ask the agent to inspect
workspace memory, propose maintenance changes, and apply only user-approved
updates through deterministic plugin code.

This is the product direction for Memory 2.0: keep the current automatic memory
pipeline stable, then add an explicit review layer where the user owns mutation
approval.

OpenCode proposal capture has been checked against
`/Users/sd_wo/work/opencode-clone` on `dev` at `d9d43d851`. The current plugin
surface exposes `experimental.text.complete`, which receives the completed
assistant text for a text part. Memory Review should use this as the primary
proposal capture path, while keeping CLI import as a fallback and diagnostic
path.

## Non-Goals

- Do not give the agent direct write access to `workspace-memory.json`.
- Do not make automatic consolidation mutate memory without user approval.
- Do not replace the current explicit-memory, compaction, retention, or
  diagnostics paths.
- Do not introduce a Codex-style two-phase model-generated memory pipeline.
- Do not require extra model calls for normal memory operation.

## Product Shape

The workflow has three roles:

- Agent: reads a frozen memory review snapshot and proposes changes.
- User: approves, rejects, or ignores proposals.
- Plugin: validates and applies approved proposals deterministically.

The agent never writes memory. The plugin never invents memory content. The user
decides which proposed mutations are allowed.

## User Workflow

Initial MVP:

```text
/memory
  -> user selects Review from the existing memory menu
  -> if no current proposal set exists, creates a memory review snapshot/prompt
  -> includes current active memories as [M#] refs and diagnostic context
  -> automatically sends the review prompt to the current session
  -> asks the agent to return one structured proposal batch
  -> server plugin captures completed assistant text through
     experimental.text.complete and seals one proposal set
  -> once proposals are captured, opens the local batch review UI
  -> lets the user select, reject, or edit proposed replacements
  -> applies the selected proposal batch through plugin validation
```

Possible final TUI shape:

```text
/memory
  ├─ Status
  ├─ Current memories
  ├─ Review
  ├─ Proposals
  └─ Help
```

`/memory -> Review` is the primary product surface. Do not ship a `/brain` alias
in the first wave; it adds command surface before the core workflow is proven.

Selecting Review is explicit user authorization to run the review prompt. The
plugin may submit that prompt automatically; this does not give the agent write
access to memory, because all mutations still require later user approval in the
proposal review UI.

## Proposal Transport

Current OpenCode has a usable primary transport. In
`/Users/sd_wo/work/opencode-clone`, `packages/plugin/src/index.ts` defines:

```typescript
"experimental.text.complete"?: (
  input: { sessionID: string; messageID: string; partID: string },
  output: { text: string },
) => Promise<void>
```

`packages/opencode/src/session/processor.ts` triggers this hook at `text-end`
with the completed assistant text. Memory Review should use the hook to parse
one assistant response into one sealed proposal set.

Transport rules:

- The hook must parse only and must return `output.text` unchanged. Implement the
  hook handler by snapshotting `const originalText = output.text` before parsing
  and returning `{ text: originalText }` after capture, even when parsing fails.
- Accept proposal JSON only when it references an active review snapshot ID
  created by this plugin.
- Accept proposal JSON only inside a dedicated fenced block whose info string is
  `memory-review-proposals`. A message that mentions a snapshot ID outside that
  fenced block is not a proposal response.
- The fenced JSON must include both the proposal set `kind` sentinel and the
  active `snapshotId`.
- A snapshot may capture at most one proposal set.
- Once a proposal set is sealed, later assistant messages must not append to or
  overwrite it.
- If capture fails or no matching snapshot exists, ignore the text and emit
  diagnostic evidence only.
- Keep `memory-diag memory-review import <proposal-json>` as a fallback and test
  fixture path. The CLI import path must call the same `captureProposalSet`
  function as the hook path, with a synthetic capture context.

The fallback import path is still useful because it keeps parser/apply tests
independent of OpenCode streaming behavior, but it is not the primary MVP user
path.

## Review Snapshot

The review flow should create a frozen snapshot with stable refs. The snapshot
is the only authority the agent may use for proposal targets.

Snapshot contents:

- Active workspace memories with `[M#]` display refs.
- Memory IDs, type, source, status, exact key, identity key, and text.
- Render status: rendered, type-capped, global-capped, char-budget omitted.
- Retention signals: strength, reinforcement count, last reinforced timestamp,
  and age when available.
- Pending memories and promotion retry state.
- Recent rejected candidates summarized by reason code.
- Recent numbered command evidence: reinforced, replaced, rejected, reverted.
- Capacity pressure and type cap observations.
- A snapshot ID used later for stale-target detection.

The snapshot should be stored locally before the prompt is emitted:

```text
workspace-memory-review/
  snapshots/{snapshotId}.json
  proposals/{proposalSetId}.json
```

Actual path naming can follow existing storage conventions, but proposal data
must live under the workspace memory root and use atomic writes.

## Proposal Lifecycle

The proposal set must be frozen before user review:

- A proposal set is created from one assistant response and one snapshot.
- Once stored, a proposal set is sealed and immutable.
- Later assistant messages never append to or overwrite an existing proposal
  set.
- A new review run creates a new snapshot and proposal set.
- The review UI always shows the sealed proposal set selected by ID.
- User approval/rejection state is stored separately from the immutable proposal
  set.

This keeps the user approval target stable even if the conversation continues
after proposal generation.

Decision state should live in a separate append-only log or UI state file:

```text
workspace-memory-review/
  snapshots/{snapshotId}.json
  proposals/{proposalSetId}.json
  decisions/{proposalSetId}.jsonl
```

Decision records should track selection and user edits without mutating the
sealed proposal set:

- selected or unselected;
- rejected;
- user-edited replacement text, when present;
- validation result for the selected proposal;
- batch apply attempt ID and outcome.

## Memory Review Prompt

The prompt should be explicit that the agent is performing review only.

Core instructions:

```text
You are reviewing workspace memory quality.

Your job is to propose memory maintenance actions only.
Do not mutate memory.
Do not invent facts.
Use only the memory snapshot and evidence below.

Allowed proposal types:
- consolidate: merge duplicate or overlapping memories
- update: replace stale or unclear wording with a better durable fact
- forget: supersede low-value, stale, unsafe, or misleading memory

For every proposal include:
- action
- target refs
- proposed type and text when applicable
- evidence refs
- risk level
- rationale
- for consolidate, verbatim text of every target memory being merged
- why this helps future sessions
- why this is not temporary session state

Return structured JSON in the requested schema.
Wrap the JSON in a single fenced block with info string
`memory-review-proposals`.
Include the exact snapshot ID from the review prompt inside the JSON.
Do not mention the snapshot ID anywhere outside the fenced JSON block.
No changes are applied unless the user approves them later.
```

The prompt should prefer a small number of high-value proposals. Empty output is
valid when memory is already healthy. MVP should hard-cap each proposal set at 6
proposals so the review UI stays manageable.

## Proposal Schema

```typescript
export type MemoryReviewProposalAction =
  | "consolidate"
  | "update"
  | "forget";

export type MemoryReviewProposalRisk = "low" | "medium" | "high";

export type MemoryReviewProposal = {
  id: string;
  action: MemoryReviewProposalAction;
  targets: string[];
  proposedType?: LongTermType;
  proposedText?: string;
  proposedEntries?: Array<{
    type: LongTermType;
    text: string;
  }>;
  evidenceRefs: string[];
  risk: MemoryReviewProposalRisk;
  rationale: string;
  targetQuotes?: string[];
  futureValue: string;
  temporaryStateCheck: string;
};

export type MemoryReviewProposalSet = {
  version: 1;
  kind: "opencode_working_memory_review_proposal_set";
  id: string;
  snapshotId: string;
  createdAt: string;
  source: "assistant_memory_review";
  status: "sealed";
  sealed: true;
  proposals: MemoryReviewProposal[];
};
```

`MemoryReviewProposalSet.source` is local review metadata, not a new
`LongTermMemoryEntry.source`. MVP approved replacement memories should use the
existing `manual` source because the user explicitly approved them. If a later
implementation adds a dedicated long-term memory source, it must audit retention,
diagnostics, migrations, and all source-based cleanup rules first.

The TypeScript shape keeps some fields optional because validity depends on the
proposal action. The parser must enforce action-specific requirements:

- `forget` requires targets and no replacement text.
- `update` requires exactly one target and one `proposedText`.
- `consolidate` requires multiple targets, one `proposedText`, and
  `targetQuotes` containing the verbatim text of every target.

The first implementation should accept JSON fenced in the completed assistant
text captured by `experimental.text.complete`, and should also accept identical
JSON through the CLI import path. Parser behavior should fail closed:

- reject missing `memory-review-proposals` fence;
- reject missing or wrong `kind`;
- reject malformed JSON;
- reject unknown action names;
- reject more than 6 proposals;
- reject targets not present in the snapshot;
- reject proposals missing rationale or risk;
- reject mutation actions without proposed text or entries where required.
- reject `consolidate` proposals missing verbatim target quotes.

## Apply Semantics

Approved proposals are applied by plugin code, not by the agent. The review UI
may apply a selected batch, but validation still runs per proposal and the final
mutation must be computed by deterministic plugin code.

Each proposal in an apply batch must validate:

- Proposal set exists and references a known snapshot.
- Target refs resolve to memory IDs in that snapshot.
- Current memory IDs still exist.
- Current exact keys match the snapshot exact keys.
- Current target statuses still allow the action.
- Proposed text is redacted and passes the existing quality gate.
- Proposed text stays within existing memory limits.
- Protected memory classes are respected: MVP may target only active
  `compaction` memories. It must reject entries whose source is `explicit` or
  `manual`, whose `safetyCritical` flag is true, or whose reinforcement count is
  above the review threshold.
- Operation is allowed for the action kind.
- Replacement text does not collide with unrelated active entries by exact key or
  identity key.
- Redaction is applied before exact-key and identity-key checks.

Action behavior:

- `forget`: mark target active memories as `superseded`.
- `update`: supersede one target and add one replacement memory.
- `consolidate`: supersede multiple targets and add one replacement memory.

Batch behavior:

- `Apply selected` builds one ordered apply batch from currently checked
  proposals.
- The batch dry-run validates every selected proposal against the same initial
  current store.
- Apply revalidates the whole batch inside the locked workspace-memory update
  callback.
- If proposals in the same batch conflict over targets, exact keys, identity
  keys, or replacement text, reject the conflicting proposals before mutation.
- MVP should prefer all-or-nothing batch apply. If any selected proposal fails
  locked validation, show the failed reason and apply none of the batch.

Apply should use the same locked read-modify-write path as existing workspace
memory updates. MVP should also support dry-run validation for every proposal:
the plugin computes the exact store changes that would happen for the selected
batch and shows them in the review UI before the user confirms apply.

Dry-run and apply must share the same normalization path. Add either a preview
mode to the locked workspace-memory update path or a
`previewWorkspaceMemoryUpdate` helper that reads under the same lock, applies the
same updater to a cloned store, runs the same redaction, migration, retention
backfill, dedupe, and limit-enforcement pipeline, and returns the normalized
canonical diff without persisting. If redaction, migration, retention backfill,
or limit enforcement would change the previewed result, dry-run must show that
normalized result or reject the proposal before approval.

All target/exact-key/status checks must be repeated inside the locked apply
callback so concurrent compaction cannot invalidate the snapshot between preview
and mutation.

Later action types can add:

- `split`: supersede one target and add multiple replacement memories.
- `promote`: move a pending memory into workspace memory if it still passes
  promotion checks.
- `keep`: record approval evidence only; no store mutation.

## Evidence Events

Add evidence so review decisions are diagnosable:

- `memory_review_proposal_detected`
- `memory_review_proposal_rejected`
- `memory_review_proposal_approved`
- `memory_review_proposal_edited`
- `memory_review_batch_apply_started`
- `memory_review_batch_apply_failed`
- `memory_review_batch_applied`
- `memory_review_proposal_applied`
- `memory_review_proposal_apply_failed`

Important reason codes:

- `malformed_proposal_json`
- `missing_proposal_fence`
- `missing_proposal_kind`
- `unknown_action`
- `too_many_proposals`
- `missing_target`
- `snapshot_mismatch`
- `target_changed`
- `target_unavailable`
- `duplicate_target`
- `identity_collision`
- `redaction_changed_text`
- `quality_gate_rejected`
- `protected_source`
- `capture_snapshot_missing`
- `capture_already_sealed`
- `capture_snapshot_id_outside_fence`
- `user_edited`
- `user_rejected`
- `user_approved`
- `batch_conflict`

Evidence should include memory refs and short redacted text previews only.
These event types must be added to `src/evidence-log.ts`, and lifecycle queries
must either surface or intentionally ignore them with tests.

## TUI Review Experience

The proposal list should show:

- selected state;
- action and risk;
- target refs and current text preview;
- proposed text preview;
- rationale;
- dry-run diff;
- validation status;
- edit, reject, apply selected, apply all safe, discard, and back actions.

The primary review shape is batch selection:

```text
/memory -> Proposals

[x] consolidate M2, M7     low
[x] update M4              medium
[ ] forget M9              high

Edit selected
Reject selected
Apply selected
Apply all safe
Discard and restart
```

The user can edit proposed replacement text before applying. Edited replacement
text is a user override, not pure agent output; it must still pass the same
redaction, quality, collision, and limit checks before mutation.

`Apply selected` applies only checked proposals. `Apply all safe` includes only
currently valid low-risk and medium-risk proposals; high-risk proposals require
explicit selection plus an extra confirmation.

TUI integration should use the existing `/memory` command menu first. Add a
Review item to the current `DialogSelect` flow rather than introducing a new
slash command parser in the first wave.

MVP should auto-submit the review prompt after the user selects Review. Phase 0
must verify whether the current TUI plugin context can call
`client.session.prompt` or an equivalent current-session prompt API. If automatic
submission is unavailable, a copyable prompt dialog is an explicit degraded
fallback, not the target MVP experience.

The existing TUI plugin currently uses legacy `api.command.register`, and
OpenCode still supports that through a command shim. MVP may keep this path to
minimize product surface changes. A later compatibility cleanup should migrate
to `api.keymap.registerLayer({ commands, bindings })`, because the legacy
command API is marked deprecated in OpenCode's TUI plugin types. This migration
requires reshaping command definitions into keymap command objects; it is not a
mechanical rename.

The proposal UI should also include "New review" or "Discard and restart" so a
user can intentionally abandon a sealed proposal set and create a fresh snapshot.

## Recovery

Approved mutations should be reversible through existing supersession evidence.
Dry-run is part of MVP so users can inspect the exact mutation before approving.

MVP recovery can be:

- inspect `memory-diag explain <memory-id>`;
- manually add a corrective explicit memory;
- later add `memory-diag memory-review revert --event <event-id>`.

Do not build revert in the first wave unless review apply proves risky in real
use.

## Affected Files

Likely implementation files:

- `src/types.ts`
- `src/plugin.ts`
- `src/tui-plugin.ts`
- `src/memory-visibility.ts`
- `src/workspace-memory.ts`
- `src/evidence-log.ts`
- `src/retention.ts` only if a new long-term memory source is added later
- new `src/memory-review.ts`
- scripts under `scripts/memory-diag/` for CLI import fallback, dry-run, and
  apply
- tests under `tests/memory-review.test.ts` and focused plugin/TUI/CLI tests
- docs updates in `README.md` and `docs/diagnostics.md`

Keep `src/plugin.ts` thin. Prompt construction, snapshot creation, proposal
parsing, validation, dry-run, apply, and evidence emission should live in
`src/memory-review.ts` behind a narrow API.

## Prompt Budget

The review snapshot can grow quickly because it includes active memories,
retention signals, pending memories, rejected candidates, and evidence. MVP must
use an explicit prompt budget:

- Include all active rendered memory refs first.
- Cap rejected candidate summaries and evidence rows by recency.
- Prefer reason-code summaries over long text.
- Redact previews before counting budget.
- Emit accounting in the snapshot for omitted sections so the agent knows the
  review is partial.

## Verification

Minimum test coverage:

- Snapshot generation includes stable refs and exact keys.
- Proposal parser accepts valid JSON and fails closed on malformed data.
- Apply rejects stale snapshot targets.
- Apply rejects changed exact keys.
- Apply rejects quality-gate failures and redacts secrets.
- Apply handles `forget`, `update`, and `consolidate`.
- Parser rejects proposal sets above the 6-proposal cap.
- Parser rejects mutable or unsealed proposal sets.
- Parser rejects text that contains a snapshot ID but lacks the
  `memory-review-proposals` fence.
- Parser rejects missing or wrong proposal set `kind`.
- Hook capture stores one sealed proposal set for one active snapshot and never
  returns changed assistant text.
- Hook capture ignores assistant text without an active matching snapshot ID.
- Consolidation proposals include target quotes for review.
- Dry-run output matches the eventual applied mutation.
- Dry-run and apply both run validation under lock.
- Protected sources are rejected.
- Replacement exact-key and identity-key collisions are rejected.
- Redaction that changes proposed text is reported.
- Malformed JSON fence extraction fails closed.
- Concurrent compaction between dry-run and apply returns `target_changed` or
  `target_unavailable`.
- TUI Review auto-submits the review prompt only after explicit user selection
  of Review.
- TUI review never mutates memory before batch approval.
- TUI supports selecting/unselecting proposals, editing proposed replacement
  text, `Apply selected`, and `Apply all safe`.
- `Apply all safe` excludes high-risk proposals unless explicitly selected and
  confirmed.
- User-edited replacement text is validated through the same redaction, quality,
  collision, and limit gates as agent-proposed text.
- Batch dry-run and apply are all-or-nothing when selected proposals conflict or
  fail locked validation.
- TUI Review shows a degraded copyable prompt fallback when automatic prompt
  submission is unavailable.
- Users can discard a sealed proposal set and start a new review snapshot.
- Evidence events are emitted for approval, rejection, success, and failure.
- Existing tests still pass.

Commands:

```bash
npm run typecheck
npm test
```

## Risks

- The agent may over-propose cleanup. Mitigation: prompt says empty is valid,
  parser enforces a 6-proposal cap, and TUI keeps user approval mandatory.
- Proposal JSON may be brittle. Mitigation: fail closed and allow the user to ask
  the agent to regenerate.
- User approval UI can become too complex. Mitigation: start with one proposal
  list, checkbox selection, edit selected, and two apply actions: `Apply
  selected` and `Apply all safe`.
- Consolidation can accidentally erase useful nuance. Mitigation: exact-key
  stale checks, verbatim target quotes, dry-run diff, quality gate, protected
  source rules, and evidence trail.
- This can blur the line between diagnostics and mutation. Mitigation: keep
  diagnostics read-only and put mutation only behind explicit proposal approval.
- Plugin proposal capture may not be available. Mitigation: resolve transport
  first with an `experimental.text.complete` contract test and keep CLI import as
  a fallback.
- Assistant text capture hooks can technically rewrite text. Mitigation: Memory
  Review must treat `experimental.text.complete` as read-only and return
  `output.text` unchanged.
- `experimental.text.complete` fires for every assistant text part. Mitigation:
  require the `memory-review-proposals` fenced block, the proposal set `kind`,
  and an active snapshot ID; ignore snapshot IDs mentioned outside the fence.
- Restricting MVP mutation targets to `compaction` memories limits user control
  over explicit/manual memories. Mitigation: treat this as a deliberate first
  safety boundary, then consider explicit/manual review later with stronger
  confirmations.
- Automatic review prompt submission could feel surprising if triggered
  indirectly. Mitigation: only auto-submit after the user explicitly selects
  `/memory -> Review`, and show a confirmation label before starting.

## Rollout Plan

0. Add transport and TUI capability probes: `experimental.text.complete`
   captures completed assistant text, matching fenced proposal blocks are parsed,
   unmatched text is ignored, `output.text` is returned unchanged, and the TUI
   can auto-submit a review prompt to the current session after explicit Review
   selection. If automatic submission is unavailable, document the degraded
   copyable prompt fallback. The transport probe can be a Node test that invokes
   the exported hook handler/capture helper directly with synthetic
   `{ sessionID, messageID, partID }` input and asserts the returned text is
   unchanged.
1. Add snapshot/proposal/apply data model, sealed proposal sets, separate
   decision logs, dry-run output, and pure validation functions.
2. Add parser, hook capture, CLI import fallback, dry-run, user-edit
   validation, and batch apply tests before any TUI mutation path.
3. Add diagnostics/evidence surfaces for review proposals and decisions.
4. Integrate the existing `/memory` TUI menu with Review auto-submit, proposal
   batch listing, selection, edit, dry-run display, `Apply selected`, and `Apply
   all safe`.
5. Migrate TUI command registration from legacy `api.command.register` to
   `api.keymap.registerLayer` when the core workflow is proven.
6. Consider later actions only after real usage: `split`, `promote`, and
   `keep`.

Each phase should keep existing memory behavior unchanged unless the user starts
the memory review workflow.
