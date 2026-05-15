# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.4] - 2026-05-15

### Changed

- Replaced same-session reinforcement blocking with a rolling 7-day elapsed reinforcement window so long-lived OpenCode sessions can reinforce durable memories after meaningful weekly recurrence.
- Kept the 45-day base half-life while changing the max reinforcement count to a growth saturation point: memories at count 6 can refresh retention timestamps weekly without increasing count or effective half-life.
- Bumped memory evidence instrumentation to version 3 for the new elapsed-window and refresh-only reinforcement semantics.
- Updated `memory-diag commands --memory` to show elapsed-window details, `sameSession` evidence, `reinforcementMode`, and legacy missing timestamp markers without exposing raw session IDs.
- Updated `memory-diag quality` to keep historical `same_session` block accounting while preventing new `sameSession` evidence from triggering old same-session diagnostic questions.

### Fixed

- Prevented long-lived sessions from indefinitely blocking reinforcement solely because the session ID stayed the same across days.
- Prevented saturated memories from growing stronger beyond the max reinforcement count while still allowing continued weekly use to keep them fresh.
- Preserved historical block reason compatibility for `same_session`, `same_utc_day`, `min_interval`, and `max_count` without producing those reasons from the new policy path.

## [1.6.3] - 2026-05-14

### Added

- Added `memory-diag quality`, a read-only review board for memory-system mechanism evidence, answerability levels, provenance classification, active-memory review surfaces, and JSON review output.
- Added producer/version-aware diagnostic facts so current instrumentation can be separated from historical or unversioned evidence when reviewing reinforcement, rejection, and eviction patterns.
- Added `memory-diag commands --memory <memory-id>` for focused reinforcement command detail, including current memory status, recorded block reasons, missing block detail counts, UTC-day evidence, and privacy-safe JSON.

### Changed

- Made `activeMemoryDisplay` the canonical active-memory review surface in `memory-diag quality` JSON and removed duplicate active-memory `reviewCandidates` entries.
- Clarified diagnostic provenance and answerability wording so `memory-diag quality` separates facts, heuristic flags, review questions, and human judgment requirements.

### Fixed

- Removed duplicate active-memory candidate construction from `memory-diag quality` to prevent drift between human output and JSON surfaces.
- Kept reinforcement detail diagnostics evidence-only so blocked reinforcement attempts are shown as recorded evidence without claiming policy failure or memory loss.

## [1.6.2] - 2026-05-11

### Fixed

- Fixed the published `memory-diag` npm bin by compiling the diagnostics CLI before packing and launching the compiled JavaScript runtime instead of type-stripping TypeScript under `node_modules`.

### Added

- Added a pack/npx smoke test that runs `memory-diag --help` from a packed tarball outside the repository.

## [1.6.1] - 2026-05-08

### Added

- Native OpenCode TUI `/memory` submenu for local memory statistics, searchable current workspace memory refs, and help.
- Package `./tui` export for OpenCode TUI plugin loading.

### Changed

- README documents separate server and TUI plugin configuration.
- Recent activity/last TUI commands were removed before release because duplicate-looking slash menu entries were not useful.
- Pre-release hyphenated TUI commands were consolidated into `/memory` because native submenu/list dialogs provide better bounded navigation with less slash-menu clutter.

### Fixed

- Replaced a literal NUL byte in `workspace-memory.ts` regex source with a `\0` escape so source search tools treat the file as text.

### Notes / Known UX

- TUI memory command output opens in transcript-free native TUI dialogs and does not call the LLM.

## [1.6.0] - 2026-05-08

### Added

- Numbered compaction memory references (`[M1]`, `[M2]`, ...) for existing rendered workspace memories.
- Compaction memory commands: `REINFORCE [M#]` for retention reinforcement and `REPLACE [M#] [type] text` for protected replacement.
- `CompactionMemoryRef` session-state snapshots with optional compaction IDs for overlap detection.
- Evidence events for numbered memory command outcomes: `memory_reinforced`, `memory_replaced_numbered_ref`, and `memory_reverted_numbered_ref`.
- Public `memory-diag commands` report for command counts, outcomes, rejection reasons, protected replacement blocks, malformed commands, and latest command events.
- Public dry-run-first `memory-diag revert` command for manually reverting successful numbered replacements by replacement memory ID or evidence event ID.
- Hard quality rejection reasons for unresolved questions, transient bug/debug state, and deployment snapshots.
- Soft `terse_label` diagnostic for very short label-like candidates.
- Regression tests for command parsing, REINFORCE, protected REPLACE, revert behavior, compaction ref validation, overlap protection, and fallback behavior when the model omits the compaction snapshot ID.

### Changed

- Compaction prompts now include numbered memory refs and concise memory-operation rules instead of asking the model to reuse existing wording exactly.
- Compaction no longer duplicates hot session state inside the compaction prompt; hot state remains available in normal prompt context.
- Duplicate maintenance now prefers explicit REINFORCE or protected REPLACE evidence over silent duplicate restatement.
- Rendered decision memory cap increased from 10 to 12 while keeping the global rendered cap at 28.
- Rejected memory command evidence now uses neutral `target` relations instead of lifecycle-mutating `reinforced` or `superseded` relation roles.
- `memory-diag` public command metadata now includes `commands` and `revert` alongside `status`, `rejected`, `missing`, and `explain`.

### Fixed

- Overlapping same-session compactions can no longer silently apply numbered commands against the wrong snapshot when the snapshot ID is present.
- Numbered command resolution now rejects stale refs whose memory ID, status, or exact key no longer match the current workspace memory entry.
- Protected replacements are surfaced as first-class diagnostics instead of being buried in generic rejection counts.

### Recovery note

Successful numbered replacements supersede the original memory and add a replacement. To inspect or recover one, run `memory-diag commands --verbose`, then dry-run `memory-diag revert --memory <replacement-memory-id>` or `memory-diag revert --event <event-id>` before adding `--apply`.

## [1.5.5] - 2026-05-05

### Added

- Section-aware greedy line accumulator for hot session state rendering that fits whole lines instead of truncating mid-line.
- `accountHotSessionStateRender()` accounting function returning prompt text, omitted items, and char budget for v2 evidence extension.
- Exported types for render accounting diagnostics: `HotStateSection`, `HotStateOmissionReason`, `HotStateOmittedItem`, `HotSessionStateRenderAccounting`.
- 9 direct unit tests for hot session state rendering covering empty state, ranking, section caps, char budget, boundary conditions, header suppression, wrapper parity, and newline counting.
- Two-layer omission model: section caps first (`section_cap`), then char budget (`char_budget`), with clear per-item omission reasons.

### Changed

- Hot session state rendering no longer uses blunt `.slice(0, maxRenderedChars)` prompt truncation.
- Header-only sections are suppressed: a section is only rendered if at least one entry line fits the char budget.
- `renderHotSessionState()` is now a delegation wrapper to `accountHotSessionStateRender().prompt`, preserving backward compatibility.
- Fixed `docs/configuration.md` active-file ranking formula: was `count * action_weight * recency_decay` with weights 4/3/2/1, now correctly `ACTION_WEIGHT[action] + count * 3` with weights edit 50, write 45, grep 30, read 20, tie-break by `lastSeen` descending.
- Clarified `README.md` system prompt injection order: workspace memory and hot state index positions depend on whether workspace memory state is available.

### Fixed

- Hot session state prompt could be truncated mid-line under the old `.slice()` budget enforcement.

## [1.5.4] - 2026-05-02

### Changed

- Centralized the supported `memory-diag` command metadata for the official public commands: `status`, `rejected`, `missing`, and `explain`.
- Removed pre-public legacy aliases so unsupported spellings now use the standard unknown-subcommand path instead of carrying v2.0 compatibility debt.
- Kept `coverage` and `audit` as hidden maintainer diagnostics with neutral maintainer-only notices.
- Removed public npm script exposure for the internal workspace cleanup tool while keeping the development tool in the repository.

### Fixed

- Moved missing-memory disappearance detail formatting into the official `missing` formatter before deleting legacy disappearance formatter code.

## [1.5.3] - 2026-05-02

### Added

- Published the read-only `memory-diag` package binary for package-qualified `npx --package opencode-working-memory memory-diag` usage.
- Added user-facing diagnostics commands for concise status, rejected memory review, missing memory review, and per-memory explanation.

### Changed

- Reworked the diagnostics CLI into focused command, model, formatter, and utility modules while preserving legacy aliases and maintainer diagnostics.
- Updated README and configuration docs to document the supported `memory-diag` CLI workflow and package-qualified `npx` usage.
- Raised the Node.js requirement to `>=22.6.0` for the TypeScript diagnostics CLI runtime.

### Fixed

- Avoided repeated workspace snapshot construction in status diagnostics.
- Replaced per-memory evidence summary lookups with grouped evidence processing to avoid N+1 diagnostics work.
- Added top-level CLI error handling for cleaner user-facing failures.
- Removed a diagnostics model circular dependency by extracting evidence grouping helpers to a neutral module.

## [1.5.1] - 2026-04-30

### Added

- Per-workspace evidence log for extraction, promotion, reinforcement, render, storage, and hook lifecycle events.
- `memory-diag health --json` for machine-readable diagnostics.
- `memory-diag explain` for per-memory render status, strength, reasons, and evidence event IDs.
- `memory-diag trace --memory <id>` for memory lifecycle history.
- UTC calendar-day reinforcement gate so repeated matches cannot inflate a memory multiple times in the same day.

### Changed

- Retention constants and calculations moved to `src/retention.ts`.
- `safetyCritical` is now fully inert: no retention multiplier and no type-cap bypass, while remaining JSON-compatible.

## [1.5.0] - 2026-04-29

### Added

- Strength-based workspace memory retention using exponential decay instead of additive priority scoring.
- Per-type rendered caps for workspace memory candidates: feedback 10, decision 10, project 8, and reference 6.
- Dormant-workspace effective age: after 14 days without activity, additional dormant time counts at 0.25x for retention decay.
- Reinforcement tracking for repeated memories, with same-session and one-hour guards to prevent accidental reinforcement spam.
- Memory health diagnostics for stored vs rendered counts, type caps, global cap overflow, dormancy, retention monitoring, and strength-ranked top/weakest entries.
- CLI smoke tests and regression fixtures covering retention decay, stale-prune removal, type caps, reinforcement, invalid timestamps, and diagnostics.

### Changed

- Workspace memory rendering now ranks entries by retention strength, not the previous priority/penalty model.
- Confidence is retained for compatibility but no longer affects retention scoring.
- Deprecated `safetyCritical` is retained for JSON compatibility but no longer affects retention strength or type-cap behavior.
- Old or stale-marked memories are no longer hard-pruned; they remain stored and only fall out of rendered context through strength and cap competition.
- Existing duplicate promotion and dedupe paths now reinforce the surviving memory instead of only absorbing the duplicate.
- Health output now separates stored active memories from rendered candidates to make cap behavior easier to understand.
- Default prompt budgets are lower after calibration against observed rendered output: workspace memory is 3600 characters and hot session state is 700 characters.

### Fixed

- Invalid `updatedAt` or `retentionClock` values no longer produce `NaN` retention strength or unstable sorting.
- Dormant age calculation only discounts the dormant overlap since an entry was created, so new memories do not inherit old workspace dormancy.
- Type max totals above the global cap are handled correctly: the global rendered limit still wins.

### Not Included Yet

- Delete tombstones and explicit `supersedes` chain enforcement remain deferred follow-up work.
- Hot/warm/cold tiered storage remains a future v1.6 direction.

## [1.4.0] - 2026-04-28

### Added

- Local migration audit log for the `2026-04-28-quality-cleanup` migration:
  `~/.local/share/opencode-working-memory/migration-logs/2026-04-28-quality-cleanup.jsonl`.
- Local extraction rejection log for rejected compaction memory candidates:
  `~/.local/share/opencode-working-memory/extraction-rejections.jsonl`.
- Sanitized real-workspace regression fixtures for memory cleanup migration behavior.
- Safe workspace residue cleanup tooling that dry-runs by default and quarantines definite temp/test workspace stores instead of deleting them.

### Changed

- Unified memory quality rules in a shared quality gate for compaction memory candidates and cleanup checks.
- Rewritten compaction memory prompt to reduce over-production of low-quality memories.
- Changed quality cleanup migration to be conservative: it supersedes only high-confidence garbage patterns, including progress snapshots, raw errors, commit/CI snapshots, temporary status notes, active file snapshots, code/API signatures, path-heavy entries, and empty entries.
- Soft heuristic failures (`bad_feedback`, `bad_decision`) are intentionally excluded from automatic migration cleanup to protect durable declarative memories such as branding rules, API facts, release rules, user workflow preferences, and architecture decisions.
- Isolated test runs under a temporary `XDG_DATA_HOME` so test workspaces no longer pollute real local workspace memory data.

### Recovery note

The cleanup migration changes matching entries to `status: "superseded"`; it does not delete the entry. If a useful memory is superseded, inspect the migration audit log and restore by changing that entry back to `status: "active"` in the workspace's `workspace-memory.json`. The migration runs once per workspace.

## [1.3.3] - 2026-04-28

### Fixed

- Added atomic cross-process storage writes with stale-lock recovery and heartbeat refresh to prevent concurrent memory-file corruption.
- Scoped pending-memory promotion by owner/session so global unowned cleanup no longer removes active owned entries.
- Retained source-aware pending memories until they are actually promoted, absorbed, superseded, or rejected.
- Persisted load-time security redaction and expanded Bearer-token redaction to reduce secret retention risk.
- Hardened workspace normalization, cache bounds, rejected-entry retention, and session cleanup behavior.

## [1.3.2] - 2026-04-27

### Fixed

- Compatibility CI now installs dependencies with `npm install` so it works in this no-lockfile repository.
- Compatibility CI now runs on Node 24, matching the test command's `--experimental-strip-types` requirement.

## [1.3.1] - 2026-04-27

### Added

- Pending journal retention: max 50 entries, 30-day TTL, automatic pruning on save.
- Plugin capability test to catch missing OpenCode hooks before release.
- CI workflow for weekly OpenCode plugin API compatibility testing.
- Indirect prompt-injection filtering for workspace memory candidates.
- Expanded credential redaction for common API key, token, secret, credential, auth, and private-key labels.

### Fixed

- Pending memory journal entries are now bounded and pruned instead of growing indefinitely.
- Adversarial memory candidates that try to override system instructions are rejected before storage.
- Broader credential-like labels are redacted from workspace memory text.

### Changed

- Memory dedupe is now repo-agnostic: project/reference entries use exact canonical text plus generic URL/path identity, while decision/feedback entries no longer use repository-specific topic heuristics.
- OpenCode plugin compatibility is documented and declared as `>=1.2.0 <2.0.0`.
- README limitations now concisely document compatibility, secret handling, semantic-memory scope, plugin ordering, and multi-process write boundaries.

### Known Limitations

- Compatibility is tested against OpenCode plugin API `>=1.2.0 <2.0.0`.
- Credential redaction is best-effort; do not store secrets.
- This is working memory, not semantic search.
- Other prompt or compaction plugins may conflict depending on plugin order.
- Multi-process writes to the same workspace are not fully serialized.

## [1.3.0] - 2026-04-27

### Added

- P0 consolidation accounting for workspace memory promotion.
- Accounting-aware deduplication (`dedupeLongTermEntriesWithAccounting`).
- Accounting-aware normalization (`normalizeWorkspaceMemoryWithAccounting`).
- Promotion classification: promoted, absorbed, superseded, rejected.
- Remove absorbed/superseded keys from rejected set to avoid duplicate rejection tracking.
- Memory quality evaluation fixtures covering accepted durable facts and rejected noisy facts.
- Sharper compaction memory extraction prompt with concrete good/bad memory examples.

### Fixed

- Promotion accounting now clears only pending memories that survive workspace normalization/cap limits.
- `session.deleted` now uses shared session ID extraction, matching `session.compacted` behavior.
- Absorbed duplicate pending memories are accounted for instead of retrying forever.
- Active vs superseded boundary when promoting pending memories (superseded entries no longer block promotion of same-key active memories).
- Removed unused `rejected_duplicate_lower_quality` type.

### Changed

- Deferred pending journal safety cap implementation (see TODO in `src/pending-journal.ts`).
- Clarified superseded accounting semantics: P0 emits events only, does not archive newly superseded records.
- README structure was streamlined around the automatic memory flow and ongoing memory-quality work.
- Architecture docs now describe `Memory candidates:` as the primary extraction format and XML candidate blocks as legacy.
- Superpowers implementation plans are no longer tracked in git.

## [1.2.3] - 2026-04-26

### Added

- Frozen workspace memory snapshot in `system[1]` for better OpenCode prompt-cache stability.
- Ephemeral hot session state and pending memories in later system messages.
- Durable pending journal so explicit memories survive until promotion.

### Fixed

- Explicit memories no longer mutate the frozen workspace snapshot mid-session.
- Pending memories are promoted at safe cache-epoch boundaries.

## [1.2.0] - 2026-04-25

### Added

- Memory V2 three-layer architecture.
- Workspace memory for durable cross-session decisions, preferences, project facts, and references.
- Hot session state for active files, open errors, and recent context.
- Hook-based memory extraction during OpenCode compaction.

### Changed

- Removed manual memory tools in favor of automatic prompt injection.
- Moved storage to `~/.local/share/opencode-working-memory/`.

## [1.1.0] - 2026-04-24

### Changed

- Improved pre-V2 memory documentation and installation flow.

## [1.0.0] - 2026-04-23

### Added

- Initial release with three-layer memory architecture.
- Initial OpenCode memory integration.
- Basic memory extraction and prompt injection.
