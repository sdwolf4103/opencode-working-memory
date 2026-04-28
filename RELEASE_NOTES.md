# Release Notes

## 1.4.0 (2026-04-28)

### Memory Quality Cleanup

This minor release automatically improves memory quality for all existing users on upgrade. Low-quality compaction memories are identified and superseded without requiring manual cleanup.

### What Changed

- **Unified quality gate**: All memory types (feedback, decision, project, reference) now share the same quality rules instead of only project entries having a quality check.
- **Hardened compaction prompt**: The model is explicitly instructed that most compactions should produce zero memories, with clear good/bad examples.
- **Auto-supersede migration**: On first load after upgrade, existing low-quality `compaction` memories are automatically marked as `superseded` with quality tags. Explicit and manual memories are never affected.

### What Gets Cleaned Up

Low-quality memory patterns that are now rejected/superseded:

- Progress snapshots: "Wave 1 completed successfully", "180 tests passed"
- Session-internal notes: "The assistant reviewed feedback and updated the plan"
- Implementation notes: "Implemented X in plugin.ts"
- Commit/CI references: "Commit a762e86 contains the fix"
- Raw errors and stack traces
- Temporary status: "Currently running npm test"

### Migration Behavior

- Runs exactly once per workspace (idempotent, non-destructive)
- Only affects `source: "compaction"` entries
- Explicit/manual memories are protected
- Superseded entries retain `status: "superseded"` and quality tags for audit
- No user action required

### Upgrade Notes

- No configuration changes required.
- Existing workspace memory files are automatically cleaned on first load.
- The OpenCode config entry stays the same:

```json
{
  "plugin": ["opencode-working-memory"]
}
```

### Validation

- `npm test` (196 tests)
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
