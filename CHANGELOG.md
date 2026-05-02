# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
