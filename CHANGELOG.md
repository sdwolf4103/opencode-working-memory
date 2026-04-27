# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-04-27

### Added

- P0 consolidation accounting for workspace memory promotion.
- Accounting-aware deduplication (`dedupeLongTermEntriesWithAccounting`).
- Accounting-aware normalization (`normalizeWorkspaceMemoryWithAccounting`).
- Promotion classification: promoted, absorbed, superseded, rejected.
- Remove absorbed/superseded keys from rejected set to avoid duplicate rejection tracking.
- Memory quality evaluation fixtures covering accepted durable facts and rejected noisy facts.
- Sharper compaction memory extraction prompt with concrete good/bad memory examples.
- Pending journal retention: max 50 entries, 30-day TTL, automatic pruning on save.
- Plugin capability test to catch missing OpenCode hooks before release.
- CI workflow for weekly OpenCode plugin API compatibility testing.
- Indirect prompt-injection filtering for workspace memory candidates.
- Expanded credential redaction for common API key, token, secret, credential, auth, and private-key labels.

### Fixed

- Promotion accounting now clears only pending memories that survive workspace normalization/cap limits.
- `session.deleted` now uses shared session ID extraction, matching `session.compacted` behavior.
- Absorbed duplicate pending memories are accounted for instead of retrying forever.
- Active vs superseded boundary when promoting pending memories (superseded entries no longer block promotion of same-key active memories).
- Removed unused `rejected_duplicate_lower_quality` type.

### Changed

- Clarified superseded accounting semantics: P0 emits events only, does not archive newly superseded records.
- README structure was streamlined around the automatic memory flow and ongoing memory-quality work.
- Architecture docs now describe `Memory candidates:` as the primary extraction format and XML candidate blocks as legacy.
- Superpowers implementation plans are no longer tracked in git.

### Known Limitations

- Compatibility is tested against OpenCode plugin API `>=1.2.0 <2.0.0`.
- Credential redaction is best-effort; do not store secrets.
- This is working memory, not semantic search.
- Multi-process writes to the same workspace are not fully serialized.

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
