# Memory Deduplication and Staleness Analysis

Date: 2026-04-26

## Executive recommendation

Fix this at storage time first, then tighten ingestion prompts.

Storage is the safety net. Every memory entry, whether from compaction, explicit user instruction, or future manual editing, already flows through `normalizeWorkspaceMemory()` in `src/workspace-memory.ts`. That is the right architectural choke point for deduplication, supersession, and lifecycle pruning.

Prompt changes are still useful, but only as a quality reducer. They cannot be the source of truth because model output will drift, multilingual phrasing will vary, and old stores already contain bad entries.

Do not add embeddings yet. This repo has 22 entries, a limit of 28, and all current failures are simple lexical/category problems. Embeddings would add latency, dependencies, nondeterminism, and storage shape questions for a problem that can be solved with boring code.

## Current data flow

```text
OpenCode session.compacted event
        │
        ▼
latestCompactionSummary(client, sessionID)
        │
        ▼
parseWorkspaceMemoryCandidates(summary)
        │       src/extractors.ts
        │       - validates shape and basic quality
        │       - assigns type/source/confidence/staleAfterDays
        ▼
updateWorkspaceMemory(directory, store => {
  store.entries.push(...candidates)
})
        │
        ▼
normalizeWorkspaceMemory(root, store)
        │       src/workspace-memory.ts
        │       - exact canonical dedupe only
        │       - maxEntries trim
        ▼
workspace-memory.json
```

The broken boundary is clear: ingestion appends all candidates, and normalization only dedupes exact normalized text per type.

## Problem 1: near-duplicate accumulation

### Diagnosis

`canonicalMemoryText()` catches only exact matches after NFKC, lowercase, and punctuation/whitespace collapse. It does not catch:

- same fact with extra location detail
- same path with slightly different label text
- same decision revised from version 3 to version 4
- bilingual restatements of the same project fact
- new fix superseding an older fix for the same issue

This is not one dedupe problem. It is three different classes wearing the same hat.

```text
Near duplicate classes
────────────────────────────────────────────
project/reference  → entity identity problem
feedback           → topic preference/result problem
decision           → supersession/history problem
```

Treating all of these with one fuzzy text threshold will either miss real duplicates or delete useful distinct decisions.

### Ingestion time vs storage time

Use both, with different jobs.

#### Storage time, required

Add deterministic memory normalization in `src/workspace-memory.ts`:

1. exact canonical dedupe, keep existing behavior
2. type-specific identity keys for obvious entities
3. simple lexical similarity for same-type candidates
4. explicit supersession rules for versioned/solution-style decisions
5. lifecycle pruning before `maxEntries` trim

Why storage first:

- one code path for compaction, explicit, manual, and tests
- fixes existing stores on next load/save
- deterministic and unit-testable
- does not depend on model behavior

#### Ingestion time, useful but secondary

Improve `buildCompactionPrompt()` in `src/plugin.ts` so compaction receives existing memory and is told to emit only new or replacing facts.

The current prompt already passes rendered workspace memory as background context and says "Do not output this context verbatim." That is not strong enough. Add a small rule near `Memory candidates:`:

```text
Before emitting a memory candidate, compare it to Background context.
Do not emit a candidate that repeats an existing memory.
If a new candidate replaces an older one, write only the newer statement.
Prefer one canonical statement per project fact, reference path, user feedback topic, or implementation decision.
```

This will reduce noise. It will not eliminate it. Models repeat themselves. Software should expect this.

### Recommended deduplication strategy

Use deterministic, type-aware dedupe. Avoid embeddings. Avoid global fuzzy dedupe as the main rule.

#### 1. Keep exact canonical dedupe

Current logic is good as the first pass.

```ts
dedup key = `${entry.type}:${canonicalMemoryText(text)}`
```

Keep source/confidence tie-breaking.

#### 2. Add type-specific identity extraction

For `project` and `reference`, dedupe by identifiable anchors, not prose.

Examples:

- repo/plugin system facts: normalized phrase key like `opencode-agenthub plugin system`
- file paths: normalized path key, with backticks stripped
- URLs/domains if they appear later

For the current data:

```text
reference:path:.opencode-agenthub/current/xdg/opencode/opencode.json
project:phrase:opencode-agenthub plugin system
```

When two entries share the same identity key, merge them by keeping the more useful text:

1. explicit source beats manual beats compaction
2. higher confidence beats lower confidence
3. more specific text beats vague text, usually longer but cap this to avoid keeping rambles
4. newer beats older if specificity/source/confidence tie

This directly fixes:

- `OpenCode plugin config location: ...` vs `OpenCode plugin config: ...`
- Chinese and English variants that both mention `opencode-agenthub plugin system`

#### 3. Add conservative lexical similarity only inside same type

Use token Jaccard or Dice similarity over normalized tokens after stopword removal. No new dependencies.

Suggested thresholds:

```text
project/reference: >= 0.72 duplicate
feedback:          >= 0.70 possible duplicate if same topic anchor exists
decision:          do not use fuzzy deletion by default
```

This should be a fallback after identity keys, not the primary system.

Risk: fuzzy matching can delete nearby but distinct decisions. Example: "Markdown headers cause purple text" and "Plain text labels avoid special markup" are related but both useful in the history of the bug.

Keep fuzzy matching conservative and type-scoped.

#### 4. Use explicit supersession for decisions

Decision duplication is fundamentally different. Decisions often form a timeline. Some are still valuable context, some are obsolete.

The pair below is supersession, not duplication:

```text
Parser supports 3 formats: HTML comment, Markdown section, legacy XML
Parser supports 4 formats: plain text label, Markdown section, legacy section name, legacy XML
```

The right model is: newer active decision supersedes older active decision on the same topic.

Keep this simple. Do not build a knowledge graph.

Add a small `decisionTopicKey(text)` heuristic:

```text
parser supports <n> formats       → decision:parser-supported-formats
solution: use ...                 → decision:purple-italic-output-format, if text contains purple/italic/markup/markdown/xml/html/comment/label
use output.prompt ... template     → decision:compaction-template-replacement
opencode plugin load/config facts  → decision:plugin-loading-config
```

That sounds bespoke, but that is acceptable here. The repo is small, the memory types are product-specific, and the current bad entries are product-specific. Boring beats clever.

When same decision topic appears:

- keep the newest active entry as active
- optionally mark the older entry `status: "superseded"` if the type supports it, or drop it during normalization if old status values are not preserved
- do not render superseded entries

If preserving history matters later, add `supersededBy?: string` and `supersededAt?: string` to the type. Not needed for the first fix.

### Type-specific policy

| Type | Nature | Recommended dedupe | Keep history? |
|---|---|---|---|
| `project` | stable facts about repo/system | identity key + conservative similarity | no, keep one canonical fact |
| `reference` | pointer to path/URL/config | path/URL/entity key | no, keep one canonical pointer |
| `feedback` | user preference or resolved issue | topic key + newer wins for same issue | usually no |
| `decision` | implementation choice over time | topic supersession, not fuzzy duplicate deletion | sometimes, but render only active latest |

## Problem 2: stale entries never cleaned

### Diagnosis

`staleAfterDays` exists, but only `renderEntry()` uses it to append `[Xd old, verify]`. Nothing removes or demotes stale entries. As a result, the store is monotonic until `maxEntries` forces a priority trim.

That trim is the wrong cleanup mechanism. It sorts by type/source/confidence, not usefulness. A stale high-priority decision can beat a fresh low-priority reference.

### When to prune

Prune during storage normalization, not render.

`normalizeWorkspaceMemory()` is already called by `load/save/updateWorkspaceMemory()`. That gives one central place to enforce lifecycle rules.

```text
load/update/save
      │
      ▼
normalizeWorkspaceMemory()
      │
      ├─ drop inactive/superseded from active set
      ├─ exact dedupe
      ├─ identity dedupe
      ├─ supersession
      ├─ stale lifecycle pruning
      └─ maxEntries trim
```

Do not prune only on render. Render is presentation. If render hides or labels stale entries while the JSON keeps growing, the system still rots.

Do not require explicit cleanup as the only path. It will not run often enough. An explicit cleanup command can be added later for manual inspection, but automatic normalization should handle the common case.

### Should `staleAfterDays` be enforced?

Yes, but not uniformly as immediate deletion for every type.

`staleAfterDays` means "this should be revalidated after this age." It does not always mean "delete at this age."

Use a two-tier lifecycle:

```text
fresh              age <= staleAfterDays
stale              staleAfterDays < age <= staleAfterDays + grace
prunable           age > staleAfterDays + grace
```

Suggested grace periods:

| Type | Current staleAfterDays | Grace | Auto-prune? | Rationale |
|---|---:|---:|---|---|
| `feedback` | none | none | no age-based prune | User preference can remain valid indefinitely. Prune only by supersession/topic replacement. |
| `decision` | 45 | 15 | yes if compaction/manual and not explicit | Implementation decisions age fast. Supersession should remove most earlier. |
| `project` | 60 | 30 | yes if compaction/manual and no strong identity/path | Project facts change slower. Keep explicit project facts unless replaced. |
| `reference` | 90 | 30 | yes if path no longer exists or prunable age exceeded | References are rediscoverable and can become stale. |

For the first implementation, a simpler rule is enough:

```text
Never age-prune feedback.
Never age-prune explicit entries automatically.
Drop compaction/manual entries when age > staleAfterDays + 30 days.
Drop superseded entries immediately from the active set.
```

This keeps user-owned memory safe while preventing compaction sludge.

### Explicit vs implicit contradiction detection

Use explicit supersession for known memory shapes. Do not try general contradiction detection.

General contradiction detection without LLM or embeddings is brittle. With an LLM it is nondeterministic and adds another model-quality surface. The current problem does not need that.

Recommended model:

- explicit supersession for same decision topic, same reference path, same project entity, same feedback topic
- newer entry wins inside the same topic unless older has higher source priority
- if `source === "explicit"`, require a newer explicit entry to replace it, or keep both

This gives predictable behavior and avoids deleting user instructions because a compaction guessed a replacement.

## Concrete implementation plan

### P0: centralize deterministic cleanup in `src/workspace-memory.ts`

Add helpers near `canonicalMemoryText()`:

```text
normalizedTokens(text)
extractPathKeys(text)
memoryIdentityKeys(entry)
decisionTopicKey(text)
feedbackTopicKey(text)
isPrunableByAge(entry, now)
chooseBetterMemory(existing, candidate)
```

Then change `enforceLongTermLimits(entries)` to run in phases:

```text
1. keep active entries only
2. truncate text
3. drop entries prunable by age, except feedback and explicit
4. exact canonical dedupe
5. identity-key dedupe for project/reference/feedback
6. decision-topic supersession
7. sort by priority with freshness as a tie-breaker
8. slice to maxEntries
```

Add freshness to `priority()` or to the final sort tie-breaker. Do not let 90-day-old compaction entries beat fresh entries just because type weight is higher.

Minimal version:

```text
priority desc, source priority desc, freshness desc, updatedAt desc
```

### P1: improve compaction prompt

Update `buildCompactionPrompt()` with dedupe instructions before the `Memory candidates:` examples.

Keep this short. Long prompts invite drift.

### P1: add tests before changing behavior

Use `tests/workspace-memory.test.ts` for normalization behavior.

Required regression tests:

```text
CODE PATH COVERAGE
==================
[+] enforceLongTermLimits(entries)
    ├── [GAP] exact canonical duplicate still dedupes
    ├── [GAP] project opencode-agenthub bilingual/long-short variants collapse to one
    ├── [GAP] reference same config path variants collapse to one
    ├── [GAP] decision parser 4 formats supersedes parser 3 formats
    ├── [GAP] feedback purple/italic newer fix supersedes older fix
    ├── [GAP] stale compaction decision older than staleAfterDays + grace is pruned
    ├── [GAP] stale explicit decision is retained
    └── [GAP] maxEntries trim runs after dedupe/prune

[+] renderWorkspaceMemory(store)
    └── [GAP] does not render superseded/pruned entries
```

No E2E needed. These are pure functions and deterministic store normalization paths.

### P2: optional explicit cleanup command

Later, add a manual cleanup/report command that prints:

- duplicates removed
- superseded decisions
- stale entries pruned
- entries retained because explicit

Not needed for the first fix. Useful for trust once memory stores grow.

## Why not embeddings

Embeddings are the wrong tool at this scale.

Costs:

- new dependency/API or local model decision
- cache/versioning problem for embedding vectors
- nondeterministic thresholds
- hard-to-debug deletions
- privacy and offline behavior questions

The current store has 22 entries. The failures are obvious strings, paths, topics, and versioned decisions. Use deterministic rules now. Reconsider embeddings only if stores grow into hundreds of entries and lexical/topic rules fail in real usage.

## Risks and tradeoffs

### Risk: deleting useful historical decisions

Mitigation: do not apply broad fuzzy dedupe to `decision`. Use topic-specific supersession only for known patterns. Keep explicit entries unless explicitly replaced.

### Risk: bespoke topic keys become a pile of regexes

Mitigation: keep the first version tiny and test-driven. Add keys only for observed failures. If this grows past roughly 10 topic rules, revisit the model.

### Risk: prompt-only fix gives false confidence

Mitigation: prompt change is P1, storage normalization is P0. The store must protect itself.

### Risk: stale pruning removes something still useful

Mitigation: no age pruning for feedback, no automatic age pruning for explicit entries, and grace periods for compaction/manual entries.

### Risk: normalization mutates existing stores unexpectedly

Mitigation: add tests with fixtures from the current store. Consider logging cleanup counts in development if a logging channel exists. The output should be deterministic.

## NOT in scope

- Embedding similarity, too much machinery for 22 entries.
- LLM-based contradiction detection, nondeterministic and hard to test.
- Full memory history graph with `supersededBy`, useful later but not required for current rendering quality.
- New cleanup UI or CLI, optional P2 after deterministic normalization lands.
- Changing `LongTermMemoryEntry` schema, avoid migration unless history preservation becomes required.

## Prioritized steps

1. **P0: Add tests in `tests/workspace-memory.test.ts` using the concrete duplicate examples from the current store.** This locks the desired behavior before touching cleanup logic.
2. **P0: Implement storage-time cleanup in `enforceLongTermLimits()`.** Exact dedupe, identity-key dedupe, decision supersession, stale pruning, then max-entry trim.
3. **P0: Make stale lifecycle enforceable but conservative.** No age pruning for feedback or explicit entries. Prune compaction/manual entries after `staleAfterDays + 30`.
4. **P1: Tighten `buildCompactionPrompt()` to avoid re-emitting existing memories and emit only replacing facts.** This reduces future noise but is not trusted as the only defense.
5. **P1: Add regression fixtures matching the real `workspace-memory.json` problem set.** Assert resulting entries are below the current 22 and contain the newer/canonical facts.
6. **P2: Add a cleanup report command only if users need visibility.** Defer until after the automatic path proves itself.

## Final architecture decision

The memory store should be self-cleaning at its storage boundary.

Use prompt engineering to reduce bad candidates, but make `src/workspace-memory.ts` the authority for what persists. Use deterministic, type-aware dedupe instead of embeddings. Treat `project` and `reference` as entity identity problems, `feedback` as topic replacement, and `decision` as explicit supersession.

That is the smallest design that solves the real failures without turning a 28-entry JSON file into a search platform.

## Addendum: bracketless memory candidate format from real compaction

Date: 2026-04-26

### Summary table

| Issue | Severity | Fix | Priority |
|-------|----------|-----|----------|
| Parser silently drops `- project text` bracketless candidates | High | Accept both `- [type] text` and `- type text` | P0 |
| Prompt examples imply brackets but do not explicitly require exact syntax | Medium | Add "Use exactly this format, including square brackets" plus a negative example | P0, same small patch |
| No regression test for bracketless candidate lines | High | Add parser test covering all four types in bracketless form | P0 |
| Future compactions may re-extract useful facts with changed counts or wording | Medium | Keep storage-time type-aware dedupe/staleness plan | P0, unchanged |

### 1. Parser fix

Accept `- type text` with no brackets.

Also strengthen the prompt. Do both.

The parser is the product boundary. Model output is not a contract, it is an input from an unreliable narrator with excellent vibes. If the model emits a plainly parseable, semantically valid candidate, dropping it silently is a data loss bug.

The prompt should still ask for the preferred bracketed format because bracketed type markers are less ambiguous. But prompt enforcement alone is not enough. The new evidence proves the model sometimes drops brackets even when examples include them.

Recommended parser behavior:

- preferred: `- [project] pathology-playground 後端健康改進計劃已完成 Phase 1-4`
- accepted fallback: `- project pathology-playground 後端健康改進計劃已完成 Phase 1-4`
- still reject unknown types
- still run `shouldAcceptWorkspaceMemoryCandidate()`
- still require body length and existing quality gates

### 2. Prompt format enforcement

Yes, add explicit syntax instructions.

Current prompt shows examples, but examples are not a hard enough constraint. Add one sentence before the examples:

```text
Use exactly this candidate format, including square brackets around the type:
```

Then keep the examples:

```text
Memory candidates:
- [feedback] content
- [project] content
- [decision] content
- [reference] content
```

Optionally add one short warning:

```text
Do not write `- project content`; write `- [project] content`.
```

Keep this short. Long formatting lectures increase prompt surface area and make the summary worse. One positive instruction plus one negative example is enough.

### 3. Impact on dedup plan

Parser robustness moves to P0, before storage dedup/staleness cleanup.

This changes sequencing, not the architecture.

Updated P0 order:

1. **P0a: Fix parser format tolerance and add regression tests.** Lost memory is worse than duplicate memory. A deduper cannot dedupe entries that never made it into the store.
2. **P0b: Implement storage-time dedupe and stale pruning.** Still the main long-term quality fix.
3. **P0c: Tighten prompt format instruction in the same small patch as parser tolerance.** Cheap and reduces fallback-parser usage.

The earlier recommendation still stands: storage normalization remains the authority for duplicates and staleness. This new evidence adds a more basic ingestion reliability bug in front of it.

### 4. Concrete implementation recommendation

#### Regex change

Replace the current parser line in `src/extractors.ts:parseWorkspaceMemoryCandidates()`:

```ts
const item = line.trim().match(/^-\s*\[(feedback|project|decision|reference)\]\s*(.+)$/i);
```

with a single regex that accepts bracketed and bracketless forms:

```ts
const item = line.trim().match(
  /^-\s*(?:\[(feedback|project|decision|reference)\]|(feedback|project|decision|reference)\b)\s+(.+)$/i,
);
if (!item) continue;

const type = (item[1] ?? item[2]).toLowerCase() as LongTermType;
const body = item[3].trim();
```

Why this shape:

- `(?:[type]|type\b)` accepts both formats
- `\b` prevents `projectile` from being parsed as `project`
- `\s+(.+)` requires real content after the type
- unknown types still fail

Even better for readability, avoid duplicate type alternation with a named group if the runtime target supports it cleanly:

```ts
const item = line.trim().match(
  /^-\s*(?:\[(?<bracketed>feedback|project|decision|reference)\]|(?<plain>feedback|project|decision|reference)\b)\s+(?<body>.+)$/i,
);
if (!item?.groups) continue;

const type = (item.groups.bracketed ?? item.groups.plain).toLowerCase() as LongTermType;
const body = item.groups.body.trim();
```

Recommendation: use the non-named-group version. It is uglier, but it is maximally boring and consistent with the existing code style.

Add tests in `tests/extractors.test.ts`:

```ts
test("parseWorkspaceMemoryCandidates accepts bracketless candidate format", () => {
  const summary = `
Memory candidates:
- project pathology-playground 後端健康改進計劃已完成 Phase 1-4
- reference Scrypt 參數必須是 N=16384, r=8, p=1
- feedback 端口 9473 可能被舊進程佔用，需殺掉後重啟
- decision Use output.prompt to replace the default compaction template
`;

  const items = parseWorkspaceMemoryCandidates(summary);

  assert.equal(items.length, 4);
  assert.deepEqual(items.map(item => item.type), [
    "project",
    "reference",
    "feedback",
    "decision",
  ]);
});
```

Also add a guard test:

```ts
test("parseWorkspaceMemoryCandidates rejects unknown bracketless candidate type", () => {
  const summary = `
Memory candidates:
- note this should not be parsed as memory
`;

  const items = parseWorkspaceMemoryCandidates(summary);

  assert.equal(items.length, 0);
});
```

#### Prompt change

In `src/plugin.ts:buildCompactionPrompt()`, change this block:

```ts
"At the end of the summary, extract durable memory entries for future",
"sessions using these labels:",
"",
"Memory candidates:",
"- [feedback] content",
"- [project] content",
"- [decision] content",
"- [reference] content",
```

to:

```ts
"At the end of the summary, extract durable memory entries for future",
"sessions using exactly this candidate format, including square brackets around the type:",
"",
"Memory candidates:",
"- [feedback] content",
"- [project] content",
"- [decision] content",
"- [reference] content",
"",
"Do not write '- project content'; write '- [project] content'.",
```

This gives the model a crisp positive format and a concrete anti-pattern. The parser still accepts the anti-pattern because users need data capture more than format purity.

### Final addendum decision

Parser tolerance is now P0.

The architecture stays the same: make the storage layer self-cleaning, and make ingestion defensive. But the implementation sequence changes because silent data loss beats duplicate accumulation in severity. First capture valid candidates reliably. Then dedupe and prune them.

## Addendum 2: content quality guidance

Date: 2026-04-26

### Summary table

| Issue | Severity | Fix | Priority |
|-------|----------|-----|----------|
| Model extracts low-durability progress snapshots as `project` memory | High | Add durable-content guidance to compaction prompt | P0 |
| Exact counts like `1237 tests pass` and `37 files` churn across sessions | High | Add parser quality filter for obvious snapshot patterns | P0 |
| Stable config values are useful and should still pass | Medium | Keep `reference` guidance permissive for config/crypto/PIN values | P0 |
| Environment issues like occupied ports may be useful briefly but not long-term | Medium | Prompt says unresolved issues only; storage staleness handles aging | P1 with staleness work |

### 1. Architecture fit

This belongs in both the prompt and the parser, with different responsibilities.

The prompt should teach the model what "durable" means. The model is choosing what to extract, so it needs product semantics:

- stable configuration values are good memory
- unresolved bugs can be useful memory
- exact test counts, file counts, and phase progress are usually bad long-term memory

The parser should still reject obvious low-durability snapshots as a backstop. The parser already has `shouldAcceptWorkspaceMemoryCandidate()` in `src/extractors.ts`; this is exactly where simple content-quality gates belong.

Do not put subtle semantic judgment in the parser. Do put obvious anti-patterns there.

Recommended split:

```text
Prompt
  └─ positive/negative guidance for durable memory selection

Parser quality gate
  └─ deterministic rejection of obvious snapshots
     - exact test counts
     - exact file counts
     - completed Phase N-M progress lines
     - temporary port/process cleanup notes when phrased as resolved/current env state

Storage normalization
  └─ dedupe, supersession, age-based pruning
```

This is the same design principle as the bracketless parser addendum: ask the model nicely, then make the code defensive.

### 2. Specificity vs risk

The proposed guidance is specific, but not too specific.

It names examples from the observed failure mode, but the rule underneath is general: facts should stay true across sessions. Exact counts and phase numbers are classic snapshot smell in almost every codebase.

Potential risk: sometimes an exact count is genuinely durable. Example: "USB sync protocol expects exactly 37 manifest entries" could be a stable contract, not a snapshot.

Mitigation: word the guidance around "session-specific progress" rather than banning all numbers. Keep config values explicitly allowed.

Good distinction:

```text
Bad: 1237 tests pass today
Good: Test suite is expected to pass before handoff

Bad: USB sync currently has 37 files
Good: USB sync covers bundles, server, frontend, tests, and docs

Bad: Phase 1-4 completed
Good: Backend health work is organized into phased improvements

Good: Scrypt parameters are N=16384, r=8, p=1
```

The first three are progress snapshots. The Scrypt value is a stable configuration contract. Numbers are not the problem. Temporary state is the problem.

### 3. Prompt length concern

Adding four lines is worth it.

This prompt is already making the model do extraction. Without guidance, the model optimizes for "important-looking facts," and progress snapshots look important. That creates churn, duplicates, and stale memory. Four lines preventing bad memory at the source are cheap.

If trimming is needed, trim redundant formatting language before removing quality guidance. Formatting mistakes lose entries or require parser tolerance. Content mistakes pollute the store. Both matter, but the durable-content guidance carries more product value than repeated Markdown formatting reminders.

Recommended trim posture:

- keep one concise formatting instruction
- keep one concise candidate syntax instruction
- add one concise durable-content block
- avoid long examples or taxonomy tables in the prompt

The prompt should not become a memory policy document. It just needs the model to stop writing "1237 tests pass" into long-term storage. Wild that we have to say this, but we do.

### 4. Concrete prompt recommendation

In `src/plugin.ts:buildCompactionPrompt()`, replace the candidate instruction block with this final version:

```ts
"At the end of the summary, extract durable memory entries for future sessions.",
"Only extract facts that are likely to stay true across sessions.",
"Do not extract session-specific progress like exact test counts, file counts, or phase numbers.",
"For progress, extract the stable goal or durable milestone, not the current number.",
"For references, extract configuration values that do not usually change between sessions.",
"For feedback, extract unresolved issues or user preferences that future sessions need to know.",
"Use exactly this candidate format, including square brackets around the type:",
"",
"Memory candidates:",
"- [feedback] content",
"- [project] content",
"- [decision] content",
"- [reference] content",
"",
"Do not write '- project content'; write '- [project] content'.",
```

This is slightly longer than the lead's proposal, but it avoids an overbroad ban on numbers by saying "session-specific progress." It also gives a positive replacement behavior: stable goal or durable milestone.

If a shorter version is required, use this:

```ts
"At the end of the summary, extract durable memory entries for future sessions.",
"Only extract facts likely to stay true across sessions; skip exact test counts, file counts, phase numbers, and temporary environment state.",
"References may include stable configuration values. Feedback should be unresolved issues or user preferences future sessions need.",
"Use exactly this candidate format, including square brackets around the type:",
```

Recommendation: use the longer block. The extra three lines buy clarity and reduce accidental over-filtering.

### Parser quality gate recommendation

Add deterministic snapshot rejection to `shouldAcceptWorkspaceMemoryCandidate()`.

Keep this conservative. Reject obvious snapshots, not every number.

Suggested first-pass rules:

```ts
// Session-specific progress snapshots, not durable memory.
if (entry.type === "project") {
  if (/\b\d+\s+tests?\s+pass(?:ed)?\b/i.test(text)) return false;
  if (/\b\d+\s+suites?\b/i.test(text)) return false;
  if (/\b\d+\s+(?:files?|文件)\b/i.test(text)) return false;
  if (/\bphase\s*\d+(?:\s*[-–]\s*\d+)?\s+(?:completed|done|finished)\b/i.test(text)) return false;
  if (/已完成\s*Phase\s*\d+(?:\s*[-–]\s*\d+)?/i.test(text)) return false;
}
```

Do not reject stable `reference` values containing numbers. These must pass:

```text
Admin PIN 是 456123
Scrypt 參數必須是 N=16384, r=8, p=1
```

For `feedback`, do not broadly reject ports yet. A port issue can be useful if it explains a recurring failure. Let staleness prune it, unless the text clearly says the issue was resolved. A future parser rule can reject resolved temporary env notes, but the current evidence is not enough to safely block all port-related feedback.

### 5. Integration with storage-time dedup/staleness

Prompt-level guidance and staleness solve different problems.

Staleness is cleanup after bad or aging facts are already stored. Prompt guidance prevents low-value facts from entering the store in the first place. Parser filtering catches obvious misses when the prompt fails.

Do not rely on staleness for exact counts.

Why:

- `maxEntries` is 28, so a few bad snapshots can evict useful facts before they age out
- exact counts will churn every compaction and create near-duplicates
- stale labels still consume render budget until pruning runs
- users see noisy memory and trust the feature less

Storage-time dedup/staleness remains required for facts that were good when written but later become outdated. Example: a config path that moves, a decision superseded by a better decision, or an unresolved bug that later gets fixed.

Use this mental model:

```text
Prompt guidance      → prevent bad candidates
Parser quality gate  → reject obvious bad candidates
Storage dedupe       → merge repeated good candidates
Storage staleness    → retire once-good candidates that aged out
```

### Updated priority

The new content-quality evidence adds another P0 ingestion fix.

Updated sequence:

1. **P0a: Parser accepts bracketless candidate format and tests it.** Prevent silent data loss.
2. **P0b: Prompt durable-content guidance.** Stop obvious snapshots at the source.
3. **P0c: Parser rejects obvious low-durability `project` snapshots.** Backstop the prompt with deterministic filters.
4. **P0d: Storage-time dedupe and staleness.** Still required for duplicate accumulation and lifecycle cleanup.

### Final addendum 2 decision

Add the durable-content guidance to the prompt and add conservative parser filters for obvious `project` snapshots.

This does not replace storage-time dedupe or staleness. It reduces garbage before it reaches that layer. The store still needs to clean itself, but it should not be used as a trash compactor for facts we already know are temporary.
