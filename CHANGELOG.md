# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-04-28

### Memory Quality Cleanup

- Unified quality gate for compaction memory candidates and cleanup checks.
- Rewritten compaction memory prompt to reduce over-production of low-quality memories.
- Conservative one-time quality cleanup migration (`2026-04-28-quality-cleanup`) that supersedes only high-confidence garbage patterns: progress snapshots, raw errors, commit/CI snapshots, temporary status notes, active file snapshots, code/API signatures, path-heavy entries, and empty entries.
- Soft heuristic failures (`bad_feedback`, `bad_decision`) are intentionally excluded from automatic migration cleanup to protect durable declarative memories such as branding rules, API facts, release rules, and architecture decisions.
- Migration audit log: `~/.local/share/opencode-working-memory/migration-logs/2026-04-28-quality-cleanup.jsonl`.
- Extraction rejection log: `~/.local/share/opencode-working-memory/extraction-rejections.jsonl`.

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
