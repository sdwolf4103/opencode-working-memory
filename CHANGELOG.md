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
- Clear terminal low-value compaction candidates after promotion review.

### Fixed

- Active vs superseded boundary when promoting pending memories (superseded entries no longer block promotion of same-key active memories).
- Removed unused `rejected_duplicate_lower_quality` type.

### Changed

- Deferred pending journal safety cap implementation (see TODO in `src/pending-journal.ts`).
- Clarified superseded accounting semantics: P0 emits events only, does not archive newly superseded records.

## [1.2.3] - 2026-04-26

### Fixed

- Account for absorbed pending memories in promotion accounting.
- Clarify cache epoch semantics and add regression tests.

## [1.2.0] - 2026-04-25

### Added

- Memory quality evaluation fixtures (5 accepted, 7 rejected cases).
- Compaction prompt examples for better memory extraction.
- Promotion accounting for pending memories.

## [1.1.0] - 2026-04-24

### Added

- Workspace memory cache optimization with frozen snapshots.
- Pending journal durability for same-session visibility.
- Credential redaction always-on.

## [1.0.0] - 2026-04-23

### Added

- Initial release with three-layer memory architecture.
- Hot session state, workspace memory, pending journal.
- Memory extraction from user messages and compaction summaries.