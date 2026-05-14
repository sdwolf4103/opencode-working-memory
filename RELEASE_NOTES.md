# Release Notes

## 1.6.3 (2026-05-14)

### Diagnostic Quality Review Board

This patch release focuses on safer memory diagnostics. It adds a read-only quality review board and finer reinforcement drill-downs so reviewers can inspect memory-system evidence without treating historical artifacts as current failures or turning heuristic flags into automatic cleanup decisions.

The goal is better observability before policy changes: diagnostics show facts, provenance, answerability, and review questions, while leaving judgment to the operator.

### What Changed

- **Quality review board**: `memory-diag quality` now reports system-mechanism facts for rejection filters, reinforcement rules, eviction/caps, identity/dedup, and active memory content review.
- **Version/provenance context**: diagnostics distinguish current producer-instrumented events from historical or unversioned evidence where possible, and label ambiguous evidence conservatively.
- **Focused reinforcement drill-down**: `memory-diag commands --memory <memory-id>` shows one memory's reinforcement command evidence, current status, recorded block reasons, missing details, and UTC-day evidence.
- **Canonical active-memory JSON surface**: `memory-diag quality --json` now uses `activeMemoryDisplay` as the single active-memory review surface instead of duplicating active memories under `reviewCandidates`.
- **Attribution-safe wording**: quality and reinforcement diagnostics avoid claiming that a block is a bug, policy failure, or cause of memory loss; they present recorded evidence and review prompts instead.

### Upgrade Notes

- No configuration changes are required.
- Existing workspace memory files and evidence logs remain compatible.
- If you consume `memory-diag quality --json` from unreleased builds after v1.6.2, read active-memory review data from `activeMemoryDisplay`; `reviewCandidates` is now reserved for system-mechanism candidates.

### Useful Commands

```bash
npx --package opencode-working-memory@1.6.3 memory-diag quality
npx --package opencode-working-memory@1.6.3 memory-diag quality --json
npx --package opencode-working-memory@1.6.3 memory-diag commands --memory <memory-id>
```

### Validation

- `node --test --experimental-strip-types tests/memory-diag-quality.test.ts` — 53 tests passing
- `node --test --experimental-strip-types tests/memory-diag.test.ts` — 39 tests passing
- `npm run typecheck` — `TYPECHECK_PASS`
- `npm test` — 486 tests passing, `TEST_PASS`
- `npm run build` — `BUILD_PASS`
- `npm run test:pack:memory-diag` — packed tarball smoke test passed

---

## 1.6.2 (2026-05-11)

### Published `memory-diag` Bin Fix

This patch release fixes the published npm package path for `memory-diag`. In v1.6.1 the source-tree CLI tests passed, but the installed package could fail under `npx --package opencode-working-memory memory-diag` because Node refuses TypeScript type stripping for files inside `node_modules`.

v1.6.2 compiles the diagnostics CLI during packing and makes the npm bin launch the compiled JavaScript runtime.

### What Changed

- **Compiled diagnostics runtime**: `prepack` now builds `dist/scripts/memory-diag.js` before the package is packed or published.
- **Safer npm bin wrapper**: `memory-diag` no longer runs published `.ts` files through `--experimental-strip-types`; it launches the compiled JS artifact and reports a clear reinstall/build message if the artifact is missing.
- **Packaged-bin smoke test**: release verification now includes a pack/npx smoke test from a temp consumer project outside the repository.

### Upgrade Notes

- No config changes are required.
- Existing OpenCode server and TUI plugin entry points are unchanged.
- If you hit the v1.6.1 bin failure, upgrade and rerun:

```bash
npx --package opencode-working-memory@1.6.2 memory-diag --help
```

### Validation

- `npm run build` — `BUILD_PASS`
- `node ./scripts/memory-diag-bin.cjs --help`
- `npm run test:pack:memory-diag` — packed tarball smoke test passed
- `npm run typecheck` — `TYPECHECK_PASS`
- `npm test` — 421 tests passing, `TEST_PASS`
- `npm pack --dry-run` — includes compiled `dist/` diagnostics artifacts

---

## 1.6.1 (2026-05-08)

### Native TUI Memory Menu

This release adds a native OpenCode TUI memory menu so users can inspect local working memory without asking the model and without adding command output to the conversation transcript.

Open `/memory` in the TUI to browse memory status, current workspace memories, and help from native dialogs.

> Memory should stay visible when you need it — and stay out of the transcript when you are only inspecting it.

```text
  /memory
     │
     ├─ Status
     │    local counts and memory health
     │
     ├─ Current memories
     │    searchable grouped [M#] refs
     │
     └─ Help
          local usage notes
```

### What Changed

- **Single TUI entry point**: `/memory` opens a native submenu instead of exposing multiple memory slash commands.
- **Searchable current memory list**: `Current memories` uses OpenCode's native select dialog for bounded scrolling, filtering, and grouping.
- **Transcript-free inspection**: memory status, list, help, empty states, and errors render in native dialogs instead of user-style session messages.
- **Server and TUI plugin exports**: the package exposes `./server` and `./tui` entry points for OpenCode plugin loading.
- **User docs refreshed**: README highlights the `/memory` workflow and moves the full diagnostics CLI reference to `docs/diagnostics.md`.

### Upgrade Notes

- Add `.opencode/tui.json` if you want the native `/memory` TUI menu. Existing server-only configuration continues to work.
- Restart OpenCode after adding the TUI plugin config.
- The TUI menu is read-only and local-only. It does not call the LLM.
- Individual memory row selection is intentionally a no-op in this release; use the list for inspection and search.

### Validation

- `npm run typecheck` — `TYPECHECK_PASS`
- `npm test` — 421 tests passing, `TEST_PASS`
- `npm pack --dry-run`
- Real OpenCode TUI smoke test for `/memory` menu, searchable current memories, and transcript-free output.

---

## 1.6.0 (2026-05-08)

### Numbered Memory Refs

This release turns compaction from a one-way memory extractor into a memory maintenance loop. The model now sees numbered references for existing workspace memories and can explicitly reinforce a still-useful memory or propose a protected replacement when compaction reveals that old memory is obsolete.

The goal is not to make memory more aggressive. It is to make memory more accountable: old facts should be strengthened when they keep proving useful, replaced only when the target is safe, and diagnosable when the model tries something risky.

> **Good memory is selective memory.**
> v1.6 lets memory say “this still matters” without copying it again — and lets obsolete compaction memories fade behind a safer replacement trail.

```text
  compaction summary
        │
        ▼
  Memory candidates:
    Memory ref snapshot id: <uuid>
    [M1] decision · reinforced=2 · source=explicit
    [M2] project  · reinforced=0 · source=compaction
        │
        ├─ REINFORCE [M1]
        │     ↑ slows decay, no text mutation
        │
        └─ REPLACE [M2] project Updated durable fact
              ↑ only allowed for safe compaction targets
```

### What Changed

- **Numbered memory refs**: compaction prompts now render existing workspace memories as `[M1]`, `[M2]`, ... references so the model can target a known memory instead of restating it as a duplicate candidate.
- **REINFORCE commands**: `REINFORCE [M#]` increments the target memory's reinforcement count and updates its retention clock without changing its text.
- **Protected REPLACE commands**: `REPLACE [M#] [type] text` supersedes the old memory and appends a replacement only when the target is safe: active, compaction-sourced, and not already reinforced.
- **Reinforce + append workflow**: when a memory is mostly right but needs more context, compaction can reinforce the old memory and emit a new candidate for the new durable fact instead of mutating history.
- **Compaction prompt restructure**: verbose type definitions and the old “reuse existing wording exactly” instruction were replaced with shorter command rules, categorization guidance, and concrete memory-operation examples.
- **Hot state removed from compaction context**: active files, current errors, and pending session state remain in normal prompt context but are no longer duplicated inside the compaction prompt, saving budget and reducing accidental promotion of transient state.
- **New hard quality gates**: unresolved questions, transient bug/debug state, and deployment snapshots are rejected as durable memory candidates.
- **Soft terse-label diagnostic**: very short label-like candidates are reported for tuning without being hard-rejected in v1.6.
- **Decision cap raised**: rendered decision memories now have a per-type cap of 12 instead of 10, while the global rendered cap remains 28.
- **Overlap guard for compaction refs**: memory ref snapshots are tagged with a compaction ID when available, so overlapping same-session compactions cannot silently apply commands against the wrong numbered snapshot.
- **Safer evidence semantics**: rejected memory command events use a neutral `target` relation role instead of lifecycle roles such as `reinforced` or `superseded`.

### Why This Helps

- Useful memories can become stronger through real reuse instead of duplicate extraction.
- Obsolete compaction-sourced memories can be replaced with an explicit evidence trail rather than left to drift.
- Manual, explicit, and already-reinforced memories are protected from automatic replacement.
- Compaction prompt budget is spent on durable memory maintenance, not on duplicated hot session state.
- Command outcomes are visible enough to tune the feature after release instead of guessing from reinforcement counts alone.

### Diagnostics

Inspect command behavior with:

```bash
npx --package opencode-working-memory memory-diag commands
npx --package opencode-working-memory memory-diag commands --verbose
npx --package opencode-working-memory memory-diag commands --json
```

The command report includes:

- compactions with command evidence
- REINFORCE and REPLACE counts
- reinforced, superseded, rejected, and blocked outcomes
- invalid or malformed command counts
- same-type vs cross-type replacements
- protected REPLACE blocks, split by reinforced target and protected source
- latest command events in verbose mode

If a numbered replacement needs manual recovery, use the dry-run-first revert command:

```bash
npx --package opencode-working-memory memory-diag revert --memory <replacement-memory-id>
npx --package opencode-working-memory memory-diag revert --memory <replacement-memory-id> --apply
```

You can also target a replacement evidence event directly:

```bash
npx --package opencode-working-memory memory-diag revert --event <event-id>
```

### Safety Model

- REINFORCE never edits memory text.
- REPLACE is rejected for manual or explicit memories.
- REPLACE is rejected for already reinforced targets.
- REPLACE is rejected if the numbered ref no longer matches the current memory ID, status, and exact key.
- If a compaction snapshot ID is present and mismatched, all numbered commands from that summary are rejected with `missing_memory_ref_snapshot`.
- If the model omits the snapshot ID, v1.6 falls back to exact memory ref validation for compatibility and command effectiveness.

### Upgrade Notes

- No configuration changes required.
- Existing workspace memory files remain compatible.
- Existing session state remains compatible; old sessions without compaction ref snapshots fall back safely.
- Existing evidence logs remain compatible; new command events are appended only after v1.6 runs.
- `memory-diag` now exposes two additional public commands: `commands` and `revert`.

### Validation

- `npm run typecheck` — `TYPECHECK_PASS`
- `npm test` — 405 tests passing, `TEST_PASS`

---

## 1.5.5 (2026-05-05)

### Hot State Rendering Health

This release replaces blunt prompt truncation with a section-aware greedy renderer that fits whole lines and suppresses empty sections, plus render accounting types for future diagnostics.

> **Good rendering is selective too.** If a section doesn't fit, omit it — don't cut it in half.

### What Changed

- **Whole-line rendering**: the hot session state prompt no longer truncates mid-line with `.slice(0, maxRenderedChars)`. A greedy line accumulator fits complete lines and stops when the next line would exceed the 700-char budget.
- **Header-only sections suppressed**: a section heading is only rendered if at least one entry fits alongside it. No more orphaned `active_files:` headers with no content underneath.
- **Render accounting**: `accountHotSessionStateRender()` now returns `prompt`, `omitted[]`, and `maxRenderedChars` so future v2 diagnostics can surface which items fell out and why.
- **Two-layer omission model**: section caps (`section_cap`) trim per-type overflow first, then the char budget (`char_budget`) trims anything that doesn't fit. Each omitted item carries its reason and section.
- **Backward-compatible wrapper**: `renderHotSessionState()` delegates to the accounting function and returns just the prompt string, preserving existing plugin behavior.

### Docs Fixes

- **Active-file ranking formula corrected**: `docs/configuration.md` now matches the actual implementation — `ACTION_WEIGHT[action] + count * 3` with weights edit 50, write 45, grep 30, read 20, tie-break by `lastSeen` descending. The old docs claimed `count * action_weight * recency_decay` with weights 4/3/2/1.
- **Injection order clarified**: README now explains that workspace memory and hot state system-prompt positions depend on whether workspace memory state is available.

### Not Included Yet

- Evidence events for omitted items are deferred to v2, pending a `memory-diag` consumer to avoid unused storage litter.

### Upgrade Notes

- No configuration changes required.
- Existing workspace memory files remain compatible.
- Hot session state rendering behavior is intentionally different (cleaner output, no mid-line cuts), but the same information is presented when it fits within the budget.

### Validation

- `npm run typecheck` — `TYPECHECK_PASS`
- `npm test` — 356 tests passing, `TEST_PASS`

---

## 1.5.4 (2026-05-02)

### Memory Diagnostics Surface Cleanup

This cleanup release keeps the newly published `memory-diag` CLI small before legacy spellings become compatibility debt.

### What Changed

- **Official commands only**: the public CLI surface is `status`, `rejected`, `missing`, and `explain`.
- **Pre-public aliases removed**: old spellings such as `health`, `quality`, `rejections`, `disappearances`, and `trace` are no longer recognized.
- **Maintainer diagnostics clarified**: hidden `coverage` and `audit` commands remain available as maintainer-only diagnostics and stay out of public usage output.
- **Cleaner internals**: current command metadata now has one source of truth, and legacy command/formatter wrappers were removed.
- **Internal cleanup script hidden**: the workspace cleanup helper is no longer exposed as an npm script; the underlying development tool remains in `scripts/dev/`.

### Validation

- `npm run typecheck` — `TYPECHECK_PASS`
- `npm test` — 347 tests passing, `TEST_PASS`

---

## 1.5.3 (2026-05-02)

### Published Memory Diagnostics CLI

This release makes the read-only workspace memory diagnostics CLI available as the package binary `memory-diag`, with user-facing commands for checking memory health and understanding why memories are rejected, missing, shown, or hidden.

> Good memory is selective memory — and diagnostics should explain the selection.

### What Changed

- **Published CLI bin**: run diagnostics with `npx --package opencode-working-memory memory-diag` or `memory-diag status`.
- **User-facing commands**: `status`, `rejected`, `missing`, and `explain <memory-id>` are documented as the supported public workflow.
- **Legacy compatibility**: existing maintainer and legacy commands remain accepted with deprecation notices where applicable.
- **Cleaner CLI architecture**: the former monolithic diagnostics script is now split into focused command, model, formatter, and utility modules.
- **Faster diagnostics**: evidence grouping avoids repeated per-memory evidence queries in snapshot diagnostics.
- **Cleaner failures**: top-level CLI error handling now reports usage and unexpected command errors without noisy stack traces.
- **Docs alignment**: README and configuration docs now use package-qualified `npx` commands to avoid resolving an unrelated package named `memory-diag`.

### Requirements

- Node.js `>=22.6.0` is now required because the published diagnostics binary runs TypeScript through Node's `--experimental-strip-types` support.

### Validation

- `npm run typecheck` — `TYPECHECK_PASS`
- `npm test` — 358 tests passing, `TEST_PASS`

---

## 1.5.1 (2026-04-30)

### Evidence Loop and Explainability

This release adds an evidence-based audit trail for memory lifecycle events and user-facing diagnostics for understanding why memories are rendered, promoted, or rejected.

> **Evidence before sublimation.** Every memory decision can be traced.

### What Changed

- **Evidence log**: extraction, promotion, reinforcement, render, and storage events are now recorded in a per-workspace `events.jsonl` with 90-day retention and 5000-event cap.
- **User explainability**: `memory-diag explain` shows per-memory render status with strength, reasons, and evidence. `memory-diag trace --memory <id>` shows the full lifecycle history.
- **Machine-readable diagnostics**: `memory-diag health --json` outputs structured `MemoryDiagJSON` for scripting.
- **Calendar-day reinforcement gate**: reinforcement now requires distinct UTC calendar days, preventing repetitive-task gaming that could inflate a memory's strength within a single day.
- **SafetyCritical deprecation complete**: the `safetyCritical` field no longer affects retention strength or type-cap bypass. All memories fade by the same rules.
- **Retention module extraction**: retention constants and calculations moved to `src/retention.ts` for cleaner separation.

### Privacy

- Evidence text previews are credential-redacted. Memory content is stored as truncated hashes, never in full.
- Diagnostics default to redacted output. `--raw` is available for maintainers.

### Upgrade Notes

- No configuration changes required.
- Existing workspace memory files remain compatible.
- Evidence logs are created automatically; no migration needed.

### Validation

- `npm run typecheck`
- `npm test` — 271 tests passing

---

## 1.5.0 (2026-04-29)

### Retention Decay Model

This release changes workspace memory retention from hard stale pruning and additive priority scoring to a strength-based decay model.

Think of it like a forgetting curve: memories fade over time, but important and reinforced memories decay slower. Weak entries fall out of rendered prompt context by cap competition, not hard deletion.

> **Memory should fade, so the agent can keep learning.**
> Important memories decay slower, but every memory must leave room for newer project reality and avoid long-term memory pollution.

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

### What Changed

- **Strength-based retention**: workspace memory now uses exponential decay: initial strength × age decay.
- **Better initial strength**: type, source, and user importance now determine how strong a memory starts.
- **No confidence scoring**: confidence remains in stored data for compatibility, but it no longer affects retention ranking.
- **Type caps**: rendered workspace memory now caps feedback, decisions, project facts, and references separately so one type cannot monopolize all 28 slots.
- **Deprecation:** `safetyCritical` field no longer affects retention strength or type-cap bypass. All system memories now fade according to the same rules. Safety rules belong in user-controlled `agent.md` files, not in system memory.
- **Dormant-aware age**: after 14 inactive days, additional dormant workspace time counts at 0.25x so paused projects do not forget too aggressively.
- **Reinforcement**: repeated matching memories reinforce the survivor and slow future decay, with same-session and one-hour guards to avoid accidental spam.
- **No hard stale pruning**: old or stale-marked memories are no longer automatically dropped by age; they lose rendered space only through cap competition.
- **Calibrated prompt budgets**: observed rendered output was typically under ~2000 characters for workspace memory and ~500 characters for hot session state, so defaults were reduced to 3600 and 700 characters to keep overhead lower while retaining buffer.
- **Clearer health output**: `memory-diag health` now reports stored vs rendered counts, type caps, global cap overflow, dormancy, retention monitoring, and strength-ranked top/weakest entries.

### Why This Helps

- User preferences and explicit memories are less likely to disappear just because inferred project facts are newer.
- Feedback, decisions, project facts, and references share prompt space more fairly.
- Returning to an old workspace is less punishing because dormant time decays more slowly.
- Maintainers can see why memories are rendered or capped instead of guessing from a single active-memory count.
- Stale entries can fade out of prompt context without destructive cleanup.

### Diagnostics

Maintainers can inspect retention behavior with:

```bash
bun scripts/memory-diag.ts health
```

The health output now includes sections like:

```txt
Stored active memories: 28
Rendered candidates: 20

By type:
  feedback  stored=17  rendered=10  typeCap=10
  decision  stored=11  rendered=10  typeCap=10

Retention caps:
  type-capped entries: 8
  global-cap overflow: 0

Dormancy:
  dormant discount active: no

Retention monitoring:
  high_importance_ratio: 0.0% (alert > 30%)
```

### Not Included Yet

- Delete tombstones are not implemented in this release.
- Explicit `supersedes` chain enforcement is still deferred.
- Hot/warm/cold tiered storage remains future work.

### Upgrade Notes

- No configuration changes required.
- Existing workspace memory files remain compatible.
- Existing entries without a `retentionClock` fall back safely to existing timestamps.
- The OpenCode config entry stays the same:

```json
{
  "plugin": ["opencode-working-memory"]
}
```

### Validation

- `npm run typecheck`
- `npm test` — 242 tests passing
- `bun scripts/memory-diag.ts health`

---

## 1.4.0 (2026-04-28)

### Memory Quality Cleanup

This release improves automatic workspace memory quality without risking broad cleanup of useful existing memories.

The quality gate is now shared across compaction extraction and migration checks, the compaction prompt is stricter about what should become durable memory, and the one-time migration is intentionally conservative.

### What Changed

- **Unified quality rules**: memory quality checks now live in one shared module and apply consistently across feedback, decisions, project facts, and references.
- **Stricter compaction output**: the compaction prompt now tells the model to save fewer memories and prefer durable facts, user preferences, architecture decisions, and hard-to-rediscover references.
- **Conservative migration cleanup**: the `2026-04-28-quality-cleanup` migration only supersedes high-confidence garbage patterns, not every rejected memory.
- **Audit logs**: automatic migration cleanup writes local JSONL audit records so superseded entries can be inspected and restored.
- **Extraction rejection logs**: newly rejected compaction candidates are logged locally to help calibrate future quality rules.
- **Regression coverage**: migration behavior is tested against sanitized real-workspace patterns to prevent mass false positives from coming back.
- **Workspace cleanup tooling**: a dev/admin cleanup command can dry-run or quarantine definite temp/test workspace residues without deleting unknown missing-root workspaces.
- **Test storage isolation**: test runs now use a temporary `XDG_DATA_HOME`, preventing fixture workspaces from polluting real local memory data.

### What Gets Cleaned Up

The migration may supersede existing `source: "compaction"` memories only when they match hard garbage patterns:

- Empty entries
- Progress snapshots, such as "Wave 1 completed successfully"
- Test or suite count snapshots, such as "180 tests passed"
- Raw errors and stack traces
- Commit or CI snapshots
- Temporary status notes, such as "Currently running npm test"
- Active file snapshots
- Code or API signatures
- Path-heavy entries that are just rediscoverable file lists

### What Is Protected

The migration does not supersede entries whose only issue is a soft heuristic failure, such as:

- `bad_feedback`
- `bad_decision`

This protects useful declarative memories like:

- Product branding rules
- API facts
- Release rules
- Architecture decisions
- User workflow preferences

Explicit and manual memories are also protected.

### Migration Behavior

- Runs once per workspace.
- Only affects active `source: "compaction"` entries.
- Marks matching entries as `status: "superseded"` instead of deleting them.
- Adds `quality_cleanup` and `quality:<reason>` tags to superseded entries.
- Writes audit logs to:
  `~/.local/share/opencode-working-memory/migration-logs/2026-04-28-quality-cleanup.jsonl`
- Writes extraction rejection logs to:
  `~/.local/share/opencode-working-memory/extraction-rejections.jsonl`

### Recovery

If a useful memory is superseded, inspect the migration audit log and restore the entry by changing its status back to `"active"` in the workspace's `workspace-memory.json`.

### Workspace Residue Cleanup

If old test/temp workspace stores already exist locally, inspect them first:

```bash
npm run cleanup:workspaces -- --dry-run
```

To move definite temp/test residues into a local quarantine folder instead of deleting them:

```bash
npm run cleanup:workspaces -- --quarantine
```

The cleanup command skips existing workspace roots and unknown missing-root workspaces by default.

### Upgrade Notes

- No configuration changes required.
- Existing workspace memory files remain compatible.
- The OpenCode config entry stays the same:

```json
{
  "plugin": ["opencode-working-memory"]
}
```

### Validation

- `npm test`
- `npm run typecheck`

---

## 1.3.2 (2026-04-27)

### CI Compatibility Patch

- Fixed the compatibility workflow so dependency installation works without a committed lockfile.
- Moved compatibility CI to Node 24 so TypeScript-stripping tests run correctly.
- No runtime or storage changes.

---

## 1.3.1 (2026-04-27)

### Security and Reliability Patch

This patch release keeps the v1.3 memory-consolidation model intact while tightening storage safety, compatibility checks, and repository-agnostic dedupe behavior.

### What Changed

- **Bounded pending journal**: pending memories are capped at 50 entries and pruned after 30 days.
- **Security hardening**: workspace memory candidates now reject indirect prompt-injection attempts, and redaction covers broader token, secret, credential, auth, and private-key labels.
- **Compatibility coverage**: plugin capability tests and weekly OpenCode plugin API compatibility CI help catch hook drift before release.
- **Repo-agnostic dedupe**: long-term memory dedupe no longer depends on hardcoded project-specific topic rules; project/reference memories use generic URL/path identity plus exact canonical matching.
- **Clearer limitations**: README and changelog now document compatibility, best-effort secret redaction, working-memory scope, plugin ordering, and multi-process write boundaries.

### Thanks

- Thanks @StevenChoo for the security hardening contribution in #3.

### Upgrade Notes

- No user migration is required.
- Existing workspace memory and pending journal files remain compatible.
- The OpenCode config entry stays the same:

```json
{
  "plugin": ["opencode-working-memory"]
}
```

### Validation

- `npm test`
- `npm run typecheck`

---

## 1.3.0 (2026-04-27)

### Better Memory Consolidation

This release makes OpenCode Working Memory smarter about what happens to saved memories after compaction. Instead of treating every pending memory as simply "kept" or "not kept", it now understands four outcomes:

- **Promoted** — a new memory was saved to workspace memory.
- **Absorbed** — the memory was a duplicate of something already remembered.
- **Superseded** — a newer same-topic decision or preference replaced an older one.
- **Rejected** — the memory was stale, noisy, or over the workspace memory limit.

### What This Improves

- **Fewer repeated pending memories**: duplicate or superseded memories no longer keep coming back for promotion.
- **Cleaner long-term memory**: old same-topic decisions are replaced more predictably.
- **Safer promotion accounting**: pending memories are only cleared when the final normalized workspace memory confirms what happened to them.
- **More useful compaction output**: the compaction prompt now includes clearer examples of what should and should not become durable memory.

### Also Included

- Memory quality regression fixtures: 5 examples that should be kept and 7 noisy examples that should be rejected.
- Fix for `session.deleted` session ID extraction so cleanup and promotion use the same event parsing path.
- Fix for active-vs-superseded promotion behavior: archived superseded entries no longer block a fresh active memory.
- README and architecture documentation updates.

### Upgrade Notes

- No user migration is required.
- Existing workspace memory files remain compatible.
- The OpenCode config entry stays the same:

```json
{
  "plugin": ["opencode-working-memory"]
}
```

### Tests

- **135 tests pass**.

---

## 1.2.3 (2026-04-27)

### Prompt Cache Optimization — Frozen Snapshot + Ephemeral Delta

This release optimizes OpenCode Working Memory's impact on OpenCode's prompt cache, following Hermes-style architecture patterns.

### Key Features

- **Frozen workspace snapshot**: Workspace memory is now rendered once at session start and cached as immutable `system[1]`. No mid-session re-render that could invalidate the cache.
- **Ephemeral hot state**: Hot session state (active files, errors) is rendered in `system[2+]`, which is excluded from the first-two-system cache control.
- **Durable pending journal**: Explicit memories are written to both session state and a durable workspace-level pending journal, ensuring no data loss between compactions.
- **Safe promotion**: Explicit memories are promoted from pending to workspace memory at:
  - Next session start (before frozen snapshot)
  - `session.compacted`
  - `session.deleted` (before cleanup)

### Architecture

```
system[0]  → OpenCode / agent header (stable cached)
system[1] → Frozen workspace memory snapshot (stable cached)
system[2+] → Hot session state + pending memories (dynamic, not cached)
```

### Fixed

- **Hot state invalidating cache**: Active files / errors updating every tool call previously caused the entire workspace memory block to be re-hashed, killing cache efficiency.
- **Explicit memory loss**: Without compaction, explicit memories could be lost when sessions ended without promotion.
- **Mid-session mutation**: Explicit memories no longer mutate the running frozen snapshot; they appear as pending and are promoted safely.

### Migration

- One-time migration: `2026-04-27-p0-cleanup` removes stale pending journal entries older than 60 days.

### Tests

- **91 tests pass** (24 workspace-memory, 34 extractors, 14 plugin, 19 pending-journal)

---

## 1.2.2 (2026-04-27)

### Safer Multilingual Memory Capture

This release strengthens explicit memory handling across languages while keeping sensitive credentials out of stored workspace memory.

### Key Features

- **Always-on credential redaction**: Credentials are redacted both when memory is loaded and when it is saved
- **Multilingual memory triggers**: Added Japanese and Korean explicit-memory phrases, plus expanded Chinese coverage
- **Expanded snapshot filtering**: Rejects Wave/Sprint/Milestone/Task progress snapshots that should not become durable memory
- **Higher memory quality bar**: Extraction now focuses on durable facts that will change future behavior

### Fixed

- **Credential leakage risk**: Password/PIN-style values are now redacted with delimiter-preserving patterns, including multilingual labels such as `パスワード`, `비밀번호`, `contraseña`, `mot de passe`, and `Passwort`.
- **Missing non-English explicit memory requests**: Japanese (`覚えて`, `メモして`), Korean (`기억해`, `메모해줘`), and additional Chinese triggers are now recognized.
- **Progress snapshots polluting memory**: Wave/Sprint/Milestone/Task status updates are filtered from long-term memory unless they contain durable facts.

### Migration

- Runs one-time cleanup for legacy snapshot entries: `2026-04-26-p0-cleanup`

---

## 1.2.1 (2026-04-26)

### Compaction Memory Quality — Four-Layer Defense

This release addresses systemic quality issues in workspace memory: duplicates, stale entries, and silently lost memory candidates. A four-layer defense is now in place:

```
Prompt    → Durable-content guidance keeps LLM on factual memories
Parser    → Accepts bracketless format, filters session snapshots
Storage   → Entity-key dedup + topic supersession + source priority
Staleness → Age-based pruning of obsolete compaction/manual entries
```

### Key Features

- **Self-cleaning memory**: Entity-key deduplication, topic supersession, and age-based staleness pruning automatically maintain memory quality
- **Robust parser**: Accepts both bracketless (`- type text`) and bracketed (`- [type] text`) formats — no more silently lost memories
- **Durable-content prompt**: Compaction template now guides LLM toward factual, long-lived memories while explicitly discouraging session ephemera
- **Smart snapshot filtering**: Automatically rejects project-type snapshots (file counts, test counts, Phase progress) that don't belong in long-term memory

### Fixed

- **Bracketless format bug**: Parser regex only matched `- [type]` pattern; real LLM output often uses `- type` (no brackets). Both formats now accepted. (P0a)
- **Purple/italic text in OpenCode UI**: Replaced XML/HTML comment templates with clean Markdown headings. Further hardened with negative instructions to forbid YAML frontmatter. (P0b β)
- **Session snapshots polluting memory**: Project entries like "37 個文件", "26 tests pass", "Phase 2 completed" now rejected by parser filter. (P0c)
- **Duplicate entries**: Entities deduped by key (e.g., `opencode-agenthub plugin system`). Topic conflicts resolved via supersession: newer shorter facts beat older verbose ones for decisions/feedback. (P0d)
- **Stale entries never cleaned**: Compaction/manual entries with `staleAfterDays` now auto-pruned after 30-day grace period.
- **Short reference entries rejected**: Admin PIN (`456123`) and config values (`Scrypt n=32768`) now allowed through config value allowlist despite being under 20 chars.

### Changed

- **`chooseBetterMemory`**: Now accepts `"entity"` mode (length preferred, for project/reference) and `"supersession"` mode (freshness preferred, for decision/feedback).
- **Source priority in sort**: Manual/source priority now included as secondary sort tie-breaker after entry priority.

### Technical Details

- **Parser formats**: 4 accepted (plain text label primary, plus Markdown section, legacy section, legacy XML)
- **Chinese counter words**: Regex matches `個`/`个` between numbers and nouns (e.g., `37 個文件`)
- **Entity keys cautious**: Only known product keys extracted (`opencode-agenthub`); generic config references fall back to canonical text dedup

### Tests

- **70/70 tests pass** (24 workspace-memory, 34 extractors, 12 plugin)

---

## 1.2.0 (2026-04-26)

### Memory V2 Architecture

This release introduces a complete architectural redesign from the previous four-tier memory system to a streamlined three-layer architecture:

```
┌──────────────────────────────────────────────────────────────────┐
│  LAYER 1: WORKSPACE MEMORY                                       │
│  Persists across sessions in same workspace (survives restart)  │
│  Extracted during compaction - NO EXTRA API CALL                │
└──────────────────────────────────────────────────────────────────┘
          ↑
┌──────────────────────────────────────────────────────────────────┐
│  LAYER 2: HOT SESSION STATE                                      │
│  Per-session, auto-tracked, resets on new session                │
│  Tracks: Active files, Open errors, Recent decisions            │
└──────────────────────────────────────────────────────────────────┘
          ↑
┌──────────────────────────────────────────────────────────────────┐
│  LAYER 3: NATIVE OPENCODE STATE                                  │
│  Uses OpenCode's built-in todos - No plugin storage needed       │
└──────────────────────────────────────────────────────────────────┘
```

### Key Features

- **Cross-session memory**: Workspace memory persists between sessions in the same workspace
- **No extra API calls**: Memory extraction piggybacks on OpenCode's existing compaction summary
- **Zero configuration**: Works out of the box with sensible defaults
- **Zero tools**: No manual memory management needed - fully automatic

### Added

- **Workspace Memory**: Long-term memory that survives restarts and compactions
  - Types: `feedback`, `project`, `decision`, `reference`
  - Sources: `explicit` (user), `compaction`, `manual`
  - Limits: 5200 chars / 28 entries

- **Hot Session State**: Automatic tracking for current session
  - Active files with action-based ranking
  - Open errors with fingerprinting
  - Recent decisions for compaction promotion

- **Quality Gates**:
  - Canonical deduplication of workspace memories
  - Negative memory request filtering ("don't remember")
  - Compaction quality gate (rejects git hashes, stack traces, path-heavy facts)

### Fixed

- **False positive error tracking**: `exitCode === undefined` no longer creates spurious errors from commands like `git log` or `cat`
- **XML truncation**: Workspace memory rendering never truncates closing `</workspace_memory>` tag
- **Negative memory filtering**: Correctly interprets "don't remember this" and "不要記住"
- **"always" trigger removed**: No longer treats "always" as a memory trigger keyword

### Changed

- **Storage location**: `~/.local/share/opencode-working-memory/workspaces/{workspaceKey}/`
- **No manual tools**: Removed `core_memory_update`, `core_memory_read` - memory is fully automatic
- **Hook-based extraction**: Memory is extracted during `experimental.session.compacting` hook

### Breaking Changes

- Previous four-tier architecture is replaced with three-layer architecture
- Core Memory blocks (goal/progress/context) removed in favor of typed entries
- Working Memory slots and pool replaced with Hot Session State
- Pressure monitoring and smart pruning removed (not needed with new architecture)

### Migration

- Old memory files (`.opencode/memory-core/`, `.opencode/memory-working/`) are not migrated
- New storage location is used (`~/.local/share/opencode-working-memory/`)
- No action required - plugin starts fresh with new architecture

### Technical Details

- **Plugin entry**: `index.ts` exports `{ id: "working-memory", server: MemoryV2Plugin }`
- **Hooks implemented**:
  - `experimental.chat.system.transform` - Inject workspace memory and hot session state
  - `tool.execute.after` - Track active files and open errors
  - `experimental.session.compacting` - Extract workspace memory candidates
  - `event` - Handle session lifecycle events

### Files in Package

```
index.ts
src/extractors.ts
src/opencode.ts
src/paths.ts
src/plugin.ts
src/session-state.ts
src/storage.ts
src/types.ts
src/workspace-memory.ts
README.md
LICENSE
```

---

## 1.1.2 (Previous Version)

- Four-tier memory architecture
- Core Memory blocks (goal/progress/context)
- Working Memory with slots and pool
- Pressure monitoring with interventions
- Smart pruning of tool outputs
