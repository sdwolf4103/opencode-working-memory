import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { appendEvidenceEvents, type EvidenceEventInput, type EvidenceEventType, type EvidenceEventV1, type EvidenceOutcome, type EvidencePhase } from "../src/evidence-log.ts";
import { LONG_TERM_LIMITS, type LongTermMemoryEntry, type WorkspaceMemoryStore } from "../src/types.ts";
import { workspaceKey, workspaceMemoryPath } from "../src/paths.ts";
import { buildQualityJSON, formatQualityReviewBoard } from "../scripts/memory-diag/formatters/quality.ts";
import { groupEvidenceByMemoryId } from "../scripts/memory-diag/evidence-model.ts";
import { buildQualityReviewBoard, type ProvenanceClassification, type ReviewBoardReport } from "../scripts/memory-diag/quality-review-model.ts";
import { retentionCandidatesForDiag } from "../scripts/memory-diag/retention-model.ts";
import type { MemoryInspectionReadModel, NormalizedRejection, WorkspaceDiagSnapshot } from "../scripts/memory-diag/types.ts";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const generatedAt = "2026-05-11T12:00:00.000Z";

async function runMemoryDiag(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [
    "--experimental-strip-types",
    "scripts/memory-diag.ts",
    ...args,
  ], { cwd: repoRoot });

  return stdout.trim();
}

test("quality command returns review board skeleton for empty workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-memory-diag-quality-empty-"));
  try {
    const stdout = await runMemoryDiag(["quality", "--workspace", root]);

    assert.match(stdout, /Memory quality review board/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quality formatter returns required human sections in review-board order", () => {
  const model = inspectionModel([
    entry("mem-section", "Durable formatter section memory", "decision"),
  ], [
    event("evt-section", { type: "render_selected", phase: "render", outcome: "rendered", memory: { memoryId: "mem-section", type: "decision", source: "compaction" } }),
  ]);
  const report = buildQualityReviewBoard(model, {}, generatedAt);

  const output = formatQualityReviewBoard(report, {});

  assert.match(output, /Memory quality review board/);
  assert.match(output, /Purpose: evidence for human\/agent review only; no automatic judgment or cleanup\./);
  assert.match(output, /Primary review purpose: SYSTEM MECHANISM observations/);
  assert.match(output, /Secondary review purpose: MEMORY CONTENT quality/);
  const orderedSections = [
    "Evidence provenance",
    "Facts - system mechanisms",
    "Facts - memory content",
    "System mechanism review candidates",
    "Memory content review candidates",
    "Review questions",
    "Next commands",
  ];
  let previous = -1;
  for (const section of orderedSections) {
    const index = output.indexOf(section);
    assert.ok(index > previous, `${section} should appear after the previous section`);
    previous = index;
  }
});

test("quality formatter shows provenance counts alongside system mechanism facts", () => {
  const model = inspectionModel([entry("mem-provenance", "Reabsorbed formatter candidate", "decision")], [], [
    rejection("Reabsorbed formatter candidate", { type: "decision", reasons: ["bad_decision"], timestamp: "2026-05-10T00:00:00.000Z" }),
  ]);
  const report = buildQualityReviewBoard(model, {}, generatedAt);

  const output = formatQualityReviewBoard(report, {});
  const factsIndex = output.indexOf("Facts - system mechanisms");
  const memoryFactsIndex = output.indexOf("Facts - memory content");
  const countsIndex = output.indexOf("Provenance counts for mechanism evidence");

  assert.ok(countsIndex > factsIndex);
  assert.ok(countsIndex < memoryFactsIndex);
  assert.match(output, /reabsorbed_post_rejection=[1-9]\d*/);
});

test("quality human output uses neutral language and keeps raw reason codes in context", () => {
  const model = inspectionModel([entry("mem-neutral", "Architecture decision remains durable", "decision")], [], [
    rejection("Architecture candidate for parser policy", { type: "decision", reasons: ["bad_decision"], timestamp: "2026-05-10T00:00:00.000Z" }),
  ]);
  const report = buildQualityReviewBoard(model, {}, generatedAt);

  const output = formatQualityReviewBoard(report, {}).toLowerCase();

  for (const forbidden of [
    "bad memory",
    "delete",
    "obsolete",
    "should remove",
    "must remove",
    "false-positive risk",
    "clearly_garbage",
    "preserving the right memories",
    "lacks terminal removal",
    "needing review",
    "highest-value",
    "failing to",
    "too rigid",
    "noisy candidates",
    "when they should remain distinct",
  ]) {
    assert.equal(output.includes(forbidden), false, `human output should not contain ${forbidden}`);
  }
  for (const line of output.split("\n").filter(line => line.includes("bad_decision"))) {
    assert.match(line, /raw reason[- ]codes?/);
  }
});

test("quality flattens eviction details and defensively stringifies malformed nested facts", () => {
  const model = inspectionModel([], [
    event("evt-cap-details", {
      type: "memory_removed_capacity",
      phase: "storage",
      outcome: "removed",
      createdAt: "2026-05-11T11:00:00.000Z",
      memory: { memoryId: "mem-cap-details", type: "decision", source: "compaction" },
      reasonCodes: ["global_cap"],
      details: { globalCap: 28, typeCap: 10, malformed: { nested: true } } as unknown as EvidenceEventV1["details"],
    }),
  ]);

  const report = buildQualityReviewBoard(model, { verbose: true }, generatedAt);
  const candidate = report.reviewCandidates.find(item => item.id === "eviction:evt-cap-details");
  assert.ok(candidate);
  assert.equal(candidate.facts.globalCap, 28);
  assert.equal(candidate.facts.typeCap, 10);
  assert.equal(Object.hasOwn(candidate.facts, "details"), false);

  const output = formatQualityReviewBoard(report, { verbose: true });
  assert.doesNotMatch(output, /\[object Object\]/);
  assert.match(output, /globalCap=28/);
  assert.match(output, /typeCap=10/);
  assert.match(output, /malformed=\{"nested":true\}/);
});

test("quality deduplicates rejection candidates after filtering eligible records", () => {
  const model = inspectionModel([], [], [
    rejection("Architecture parser policy should remain durable", { type: "decision", reasons: ["temporary_status"], timestamp: "2026-05-09T00:00:00.000Z" }),
    rejection("Architecture parser policy should remain durable", { type: "decision", reasons: ["bad_decision"], timestamp: "2026-05-10T00:00:00.000Z" }),
  ]);

  const report = buildQualityReviewBoard(model, {}, generatedAt);
  const candidates = report.reviewCandidates.filter(candidate => candidate.source === "rejection_rule_evidence");

  assert.equal(report.facts.systemMechanisms.rejectionFilters.totalRecords, 2);
  assert.equal(report.facts.systemMechanisms.rejectionFilters.uniqueTexts, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].facts.timestamp, "2026-05-10T00:00:00.000Z");
});

test("quality deduplicates eligible rejection candidates newest first", () => {
  const model = inspectionModel([], [], [
    rejection("Ambiguous architecture memory candidate", { type: "decision", reasons: ["bad_decision"], timestamp: "2026-05-09T00:00:00.000Z" }),
    rejection("Ambiguous architecture memory candidate", { type: "decision", reasons: ["bad_decision"], timestamp: "2026-05-10T00:00:00.000Z" }),
  ]);

  const report = buildQualityReviewBoard(model, {}, generatedAt);
  const candidates = report.reviewCandidates.filter(candidate => candidate.source === "rejection_rule_evidence");

  assert.equal(report.facts.systemMechanisms.rejectionFilters.totalRecords, 2);
  assert.equal(report.facts.systemMechanisms.rejectionFilters.uniqueTexts, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].facts.timestamp, "2026-05-10T00:00:00.000Z");
});

test("quality formatter collapses uniform system candidate provenance by displayed group", () => {
  const model = inspectionModel([], capacityEvents(3));
  const report = buildQualityReviewBoard(model, { verbose: true }, generatedAt);

  const output = formatQualityReviewBoard(report, { verbose: true });
  const groupLineCount = output.match(/shared provenance for displayed candidates in this group/g)?.length ?? 0;

  assert.equal(groupLineCount, 1);
  assert.doesNotMatch(output, /^      provenance:/m);
  assert.doesNotMatch(output, /not annotated for likely current active-memory content/);
});

test("quality formatter prints standard active-memory questions once in section header", () => {
  const model = inspectionModel([
    entry("mem-question-1", "Question header active memory one", "decision"),
    entry("mem-question-2", "Question header active memory two", "feedback"),
  ], []);
  const report = buildQualityReviewBoard(model, {}, generatedAt);
  report.activeMemoryDisplay.items[1].reviewQuestions = [
    ...report.reviewQuestions.memoryContent,
    "Does this memory have additional workspace-specific review context?",
  ];

  const output = formatQualityReviewBoard(report, {});
  const activeSection = output.slice(output.indexOf("Memory content review candidates"), output.indexOf("Review questions"));

  assert.match(activeSection, /Standard review questions \(applicable to all active memories below\):/);
  for (const question of report.reviewQuestions.memoryContent) {
    assert.equal(activeSection.match(new RegExp(escapeRegExp(question), "g"))?.length ?? 0, 1);
  }
  assert.doesNotMatch(activeSection, /^      review questions:/m);
  assert.match(activeSection, /^      additional review questions:/m);
  assert.match(activeSection, /Does this memory have additional workspace-specific review context\?/);
});

test("quality formatter shows full active memory text under threshold and samples over threshold", () => {
  const shortEntries = [
    entry("mem-1", "Short active memory one with FULL_TEXT_SENTINEL_1", "feedback"),
    entry("mem-2", "Short active memory two with FULL_TEXT_SENTINEL_2", "decision"),
    entry("mem-3", "Short active memory three with FULL_TEXT_SENTINEL_3", "project"),
  ];
  const shortOutput = formatQualityReviewBoard(buildQualityReviewBoard(inspectionModel(shortEntries, []), {}, generatedAt), {});
  assert.match(shortOutput, /Active memories \(showing all 3 because <= 40\)/);
  assert.match(shortOutput, /FULL_TEXT_SENTINEL_3/);

  const largeEntries = Array.from({ length: 41 }, (_, index) => entry(
    `mem-${index.toString().padStart(2, "0")}`,
    `Large active memory ${index} FULL_TEXT_SENTINEL_${index}`,
    "feedback",
  ));
  const largeDefault = formatQualityReviewBoard(buildQualityReviewBoard(inspectionModel(largeEntries, []), {}, generatedAt), {});
  assert.match(largeDefault, /Showing 40 of 41 active memories\. Use --verbose or --json for all active memory text\./);
  const defaultActiveSection = largeDefault.slice(largeDefault.indexOf("Memory content review candidates"), largeDefault.indexOf("Review questions"));
  assert.doesNotMatch(defaultActiveSection, /FULL_TEXT_SENTINEL_40/);

  const largeVerbose = formatQualityReviewBoard(buildQualityReviewBoard(inspectionModel(largeEntries, []), { verbose: true }, generatedAt), { verbose: true });
  assert.match(largeVerbose, /Active memories \(showing all 41 because --verbose\)/);
  assert.match(largeVerbose, /FULL_TEXT_SENTINEL_40/);
});

test("quality formatter no-emoji output contains no emoji glyphs", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-memory-diag-quality-noemoji-"));
  try {
    await seedWorkspace(root, [entry("mem-noemoji", "No emoji command memory", "feedback")]);
    const stdout = await runMemoryDiag(["quality", "--workspace", root, "--no-emoji"]);

    assert.doesNotMatch(stdout, /[\u{1F300}-\u{1F9FF}]/u);
    assert.match(stdout, /Memory quality review board/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quality command json returns report shape and raw mode preserves unredacted text", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-memory-diag-quality-json-"));
  try {
    await seedWorkspace(root, [entry("mem-json-cli", "JSON text with token=secret-value and path /Users/alice/project/private.txt", "project")]);

    const redacted = JSON.parse(await runMemoryDiag(["quality", "--workspace", root, "--json"]));
    assertReviewBoardShape(redacted);
    assert.doesNotMatch(JSON.stringify(redacted), /secret-value|\/Users\/alice/);

    const raw = JSON.parse(await runMemoryDiag(["quality", "--workspace", root, "--json", "--raw"]));
    assertReviewBoardShape(raw);
    assert.match(JSON.stringify(raw), /secret-value|\/Users\/alice/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildQualityJSON redacts by default and preserves report shape when raw", () => {
  const rawReport = buildQualityReviewBoard(inspectionModel([
    entry("mem-json-builder", "Builder text token=secret-value in /Users/alice/private.txt", "project"),
  ], []), { raw: true }, generatedAt);

  const redacted = buildQualityJSON(rawReport, false) as ReviewBoardReport;
  assertReviewBoardShape(redacted);
  assert.doesNotMatch(JSON.stringify(redacted), /secret-value|\/Users\/alice/);

  const raw = buildQualityJSON(rawReport, true) as ReviewBoardReport;
  assert.match(JSON.stringify(raw), /secret-value|\/Users\/alice/);
});

test("quality review model applies active memory threshold, full text, and redaction", () => {
  const entries = Array.from({ length: 41 }, (_, index) => entry(
    `mem-${index.toString().padStart(2, "0")}`,
    index === 0
      ? "Keep full text with token=secret-value and path /Users/alice/project/private.txt for review"
      : `Keep full text for active memory ${index}`,
    "feedback",
  ));
  const model = inspectionModel(entries, []);

  const defaultReport = buildQualityReviewBoard(model, {}, generatedAt);
  assert.equal(defaultReport.activeMemoryDisplay.threshold, 40);
  assert.equal(defaultReport.activeMemoryDisplay.mode, "sample");
  assert.equal(defaultReport.activeMemoryDisplay.shown, 40);
  assert.equal(defaultReport.activeMemoryDisplay.total, 41);
  assert.equal(defaultReport.activeMemoryDisplay.items.at(-1)?.id, "mem-39");
  assert.equal(defaultReport.activeMemoryDisplay.items[0].text.includes("Keep full text with"), true);
  assert.doesNotMatch(defaultReport.activeMemoryDisplay.items[0].text, /secret-value|\/Users\/alice/);
  assert.match(defaultReport.activeMemoryDisplay.items[0].text, /\[REDACTED\]|<path>/);

  const verboseReport = buildQualityReviewBoard(model, { verbose: true }, generatedAt);
  assert.equal(verboseReport.activeMemoryDisplay.mode, "all");
  assert.equal(verboseReport.activeMemoryDisplay.shown, 41);

  const rawReport = buildQualityReviewBoard(model, { raw: true }, generatedAt);
  assert.match(rawReport.activeMemoryDisplay.items[0].text, /secret-value|\/Users\/alice/);
});

test("quality provenance counts use all mechanism candidates when human output is representative", () => {
  const active = Array.from({ length: 28 }, (_, index) => entry(
    `mem-active-${index}`,
    `Active display stability memory ${index}`,
    "feedback",
  ));
  const events = capacityEvents(12);
  const model = inspectionModel(active, events);

  const defaultReport = buildQualityReviewBoard(model, {}, generatedAt);
  const verboseReport = buildQualityReviewBoard(model, { verbose: true }, generatedAt);

  assert.equal(defaultReport.provenanceContext.countsByClassification.unversioned_ambiguous, 12);
  assert.equal(verboseReport.provenanceContext.countsByClassification.unversioned_ambiguous, 12);
  assert.equal(defaultReport.reviewCandidates.filter(candidate => candidate.mechanism === "eviction_cap").length, 10);
  assert.equal(verboseReport.reviewCandidates.filter(candidate => candidate.mechanism === "eviction_cap").length, 12);
  assert.equal(defaultReport.provenanceContext.candidateLimit, 10);
  assert.deepEqual(defaultReport.provenanceContext.candidateDisplay?.byMechanism.eviction_cap, { shown: 10, total: 12 });
  assert.match(formatQualityReviewBoard(defaultReport, {}), /System mechanism review candidates \(representative; 10 shown of 12 total; limit 10 per mechanism category\)/);
  assert.equal(defaultReport.activeMemoryDisplay.shown, 28);
  assert.equal(defaultReport.activeMemoryDisplay.total, 28);
  assert.equal(verboseReport.activeMemoryDisplay.shown, 28);
  assert.equal(verboseReport.activeMemoryDisplay.total, 28);
});

test("quality json includes all system mechanism candidates without verbose", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-memory-diag-quality-json-candidates-"));
  try {
    await seedWorkspace(root, []);
    await appendEvidenceEvents(root, capacityEventInputs(12));

    const report = JSON.parse(await runMemoryDiag(["quality", "--workspace", root, "--json"])) as ReviewBoardReport;
    const evictionCandidates = report.reviewCandidates.filter(candidate => candidate.mechanism === "eviction_cap");

    assert.equal(evictionCandidates.length, 12);
    assert.equal(report.provenanceContext.candidateLimit, undefined);
    assert.equal(report.activeMemoryDisplay.shown, 0);
    assert.equal(report.activeMemoryDisplay.total, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quality review model builds system mechanism facts and neutral candidates", () => {
  const active = [
    entry("mem-a", "Retention architecture uses evidence windows for durable review", "decision"),
    entry("mem-b", "Duplicate durable instruction", "feedback"),
    entry("mem-c", "Duplicate durable instruction", "feedback"),
    entry("old-a", "Superseded same type replacement", "decision", { status: "superseded" }),
    entry("old-b", "Superseded cross type replacement", "project", { status: "superseded" }),
  ];
  const events = [
    event("evt-reinforced", { type: "memory_reinforced", phase: "reinforcement", outcome: "reinforced", memory: { memoryId: "mem-a", type: "decision", source: "compaction" } }),
    event("evt-block-1", { type: "memory_reinforced", phase: "reinforcement", outcome: "rejected", memory: { memoryId: "mem-a", type: "decision", source: "compaction" }, reasonCodes: ["reinforcement_window_blocked"], details: { ref: "1" } }),
    event("evt-block-2", { type: "memory_reinforced", phase: "reinforcement", outcome: "rejected", memory: { memoryId: "mem-a", type: "decision", source: "compaction" }, reasonCodes: ["reinforcement_window_blocked"], details: { ref: "2" } }),
    event("evt-malformed", { type: "extraction_candidate_rejected", phase: "extraction", outcome: "rejected", reasonCodes: ["invalid_memory_command"] }),
    event("evt-cap-type", { type: "memory_removed_capacity", phase: "storage", outcome: "removed", memory: { memoryId: "old-type", type: "decision", source: "compaction" }, reasonCodes: ["type_cap"], createdAt: "2026-05-10T12:00:00.000Z" }),
    event("evt-cap-global", { type: "memory_removed_capacity", phase: "storage", outcome: "removed", memory: { memoryId: "old-global", type: "feedback", source: "compaction" }, reasonCodes: ["global_cap"], createdAt: "2026-05-10T11:00:00.000Z", textPreview: "evicted token=secret-value from /tmp/private.txt" }),
    event("evt-missing", { type: "promotion_promoted", phase: "promotion", outcome: "promoted", memory: { memoryId: "historical-unknown", type: "reference", source: "compaction" } }),
    event("evt-replace-same", { type: "memory_replaced_numbered_ref", phase: "storage", outcome: "superseded", memory: { memoryId: "old-a", type: "decision", source: "compaction" }, reasonCodes: ["same_type_replace"], relations: [{ role: "superseded", memory: { memoryId: "old-a", type: "decision" } }, { role: "superseded_by", memory: { memoryId: "mem-a", type: "decision" } }] }),
    event("evt-replace-cross", { type: "memory_replaced_numbered_ref", phase: "storage", outcome: "superseded", memory: { memoryId: "old-b", type: "project", source: "compaction" }, reasonCodes: ["cross_type_replace"], relations: [{ role: "superseded", memory: { memoryId: "old-b", type: "project" } }, { role: "superseded_by", memory: { memoryId: "mem-a", type: "decision" } }] }),
  ];
  const rejections = [
    rejection("Retention architecture uses evidence windows for durable review", { type: "decision", reasons: ["bad_decision"], timestamp: "2026-05-10T10:00:00.000Z" }),
    rejection("Ambiguous useful candidate", { type: "decision", reasons: ["bad_decision"], timestamp: "2026-05-10T09:00:00.000Z" }),
    rejection("Temporary progress note", { type: "feedback", reasons: ["bad_feedback", "temporary_status"], timestamp: "2026-05-10T08:00:00.000Z" }),
  ];
  const model = inspectionModel(active, events, rejections, { limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: 2 } });

  const report = buildQualityReviewBoard(model, {}, generatedAt);

  assert.deepEqual(report.facts.systemMechanisms.rejectionFilters.byRawReasonCode, { bad_decision: 2, bad_feedback: 1, temporary_status: 1 });
  assert.equal(report.facts.systemMechanisms.rejectionFilters.byType.decision, 2);
  assert.equal(report.facts.systemMechanisms.rejectionFilters.ambiguousOrArchitectureLike, 2);
  assert.equal(report.facts.systemMechanisms.rejectionFilters.hardReasonOrNoiseHeuristic, 0);
  assert.equal(report.facts.systemMechanisms.rejectionFilters.reabsorbedRejectedTexts, 1);

  assert.equal(report.facts.systemMechanisms.reinforcementRules.reinforceEvents, 3);
  assert.equal(report.facts.systemMechanisms.reinforcementRules.reinforcedEvents, 1);
  assert.equal(report.facts.systemMechanisms.reinforcementRules.rejectedOrBlockedEvents, 2);
  assert.equal(report.facts.systemMechanisms.reinforcementRules.windowBlockedEvents, 2);
  assert.equal(report.facts.systemMechanisms.reinforcementRules.windowBlockRate, 2 / 3);
  assert.deepEqual(report.facts.systemMechanisms.reinforcementRules.repeatedBlocksByMemory, [{ memoryId: "mem-a", count: 2, refs: ["1", "2"], rawReasonCodes: ["reinforcement_window_blocked"] }]);
  assert.equal(report.facts.systemMechanisms.reinforcementRules.malformedCommandEvents, 1);

  assert.equal(report.facts.systemMechanisms.evictionAndCaps.activeMemories, 3);
  assert.deepEqual(report.facts.systemMechanisms.evictionAndCaps.fullCaps, ["global"]);
  assert.equal(report.facts.systemMechanisms.evictionAndCaps.removedByCapacity, 2);
  assert.equal(report.facts.systemMechanisms.evictionAndCaps.removedByGlobalCap, 1);
  assert.equal(report.facts.systemMechanisms.evictionAndCaps.removedByTypeCap, 1);
  assert.equal(report.facts.systemMechanisms.evictionAndCaps.unknownDisappearances, 1);
  assert.equal(report.facts.systemMechanisms.evictionAndCaps.recentEvictionsByType.decision, 1);
  assert.equal(report.facts.systemMechanisms.evictionAndCaps.recentEvictedContentShown, 2);

  assert.equal(report.facts.systemMechanisms.identityAndDedup.replacementEvents, 2);
  assert.equal(report.facts.systemMechanisms.identityAndDedup.sameTypeReplacementEvents, 1);
  assert.equal(report.facts.systemMechanisms.identityAndDedup.crossTypeReplacementEvents, 1);
  assert.equal(report.facts.systemMechanisms.identityAndDedup.duplicateTextOrIdentityGroups, 1);

  assert.ok(report.reviewCandidates.some(candidate => candidate.source === "reabsorption_evidence" && candidate.provenance?.classification === "reabsorbed_post_rejection"));
  assert.ok(report.reviewCandidates.some(candidate => candidate.mechanism === "reinforcement_rule"));
  assert.ok(report.reviewCandidates.some(candidate => candidate.source === "eviction_cap_evidence" && candidate.evidence.textAvailable === false));
  assert.ok(report.reviewCandidates.some(candidate => candidate.source === "identity_dedup_evidence"));
  assert.ok(report.reviewCandidates.every(candidate => Array.isArray(candidate.heuristicFlags) && Array.isArray(candidate.reviewQuestions)));
  assert.ok(report.reviewCandidates.filter(candidate => candidate.source !== "active_memory").every(candidate => candidate.provenance));
  assert.doesNotMatch(JSON.stringify(report), /secret-value|\/tmp\/private/);
});

test("quality review model includes provenance timeline and classification counts", () => {
  const active = [entry("mem-active", "Reabsorbed post rejection candidate", "decision")];
  const events = [
    event("evt-migration-1", { type: "memory_migration_superseded", phase: "storage", outcome: "superseded", createdAt: "2026-05-01T00:00:00.000Z", details: { migrationId: "2026-05-01-retention-clock-backfill" } }),
    event("evt-before", { type: "memory_removed_capacity", phase: "storage", outcome: "removed", createdAt: "2026-04-30T00:00:00.000Z", memory: { memoryId: "before", type: "decision", source: "compaction" }, reasonCodes: ["global_cap"] }),
    event("evt-before-unknown", { type: "promotion_promoted", phase: "promotion", outcome: "promoted", createdAt: "2026-04-30T01:00:00.000Z", memory: { memoryId: "before-unknown", type: "reference", source: "compaction" } }),
    event("evt-after", { type: "memory_removed_capacity", phase: "storage", outcome: "removed", createdAt: "2026-05-11T11:00:00.000Z", memory: { memoryId: "after", type: "feedback", source: "compaction" }, reasonCodes: ["type_cap"] }),
  ];
  const rejections = [
    rejection("Legacy unscoped architecture rule", { type: "decision", reasons: ["bad_decision"], timestamp: "2026-04-29T00:00:00.000Z", legacy: true }),
    rejection("Reabsorbed post rejection candidate", { type: "decision", reasons: ["bad_decision"], timestamp: "2026-05-10T00:00:00.000Z" }),
  ];
  const model = inspectionModel(active, events, rejections, {
    migrations: ["2026-04-26-p0-cleanup", "2026-04-28-quality-cleanup", "2026-05-01-retention-clock-backfill"],
    lastActivityAt: "2026-05-10T00:00:00.000Z",
  });

  const report = buildQualityReviewBoard(model, {}, generatedAt);
  const byMigration = new Map(report.provenanceContext.migrationTimeline.map(row => [row.migrationId, row]));

  assert.equal(report.provenanceContext.method, "migration_timestamp_and_format_inference");
  assert.equal(report.provenanceContext.producerVersionAvailable, false);
  assert.equal(report.provenanceContext.falseCurrentRiskBias, "prefer_unversioned_ambiguous_when_uncertain");
  assert.equal(byMigration.get("2026-04-26-p0-cleanup")?.presentInStore, true);
  assert.equal(byMigration.get("2026-05-01-retention-clock-backfill")?.firstEvidenceAt, "2026-05-01T00:00:00.000Z");
  assert.equal(report.provenanceContext.lastActivityAt, "2026-05-10T00:00:00.000Z");
  for (const classification of provenanceClassifications()) {
    assert.equal(typeof report.provenanceContext.countsByClassification[classification], "number");
  }
  assert.ok(report.provenanceContext.countsByClassification.legacy_unversioned_format >= 1);
  assert.ok(report.provenanceContext.countsByClassification.reabsorbed_post_rejection >= 1);
  assert.ok(report.provenanceContext.countsByClassification.suspected_pre_migration_legacy >= 1);
  assert.ok(report.provenanceContext.countsByClassification.likely_current_behavior >= 1);
});

test("quality review model exposes required JSON shape with neutral language", () => {
  const model = inspectionModel([entry("mem-json", "Durable JSON shape memory", "project")], [
    event("evt-json", { type: "render_selected", phase: "render", outcome: "rendered", memory: { memoryId: "mem-json", type: "project", source: "compaction" } }),
  ]);

  const report = buildQualityReviewBoard(model, {}, generatedAt);
  assertReviewBoardShape(report);

  const serialized = JSON.stringify(report).toLowerCase();
  for (const forbidden of ["bad memory", "delete", "obsolete", "should remove"]) {
    assert.equal(serialized.includes(forbidden), false, `report should not contain ${forbidden}`);
  }
});

function entry(id: string, text: string, type: LongTermMemoryEntry["type"], overrides: Partial<LongTermMemoryEntry> = {}): LongTermMemoryEntry {
  return {
    id,
    type,
    text,
    source: "compaction",
    confidence: 0.75,
    status: "active",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-10T00:00:00.000Z",
    retentionClock: new Date("2026-05-10T00:00:00.000Z").getTime(),
    ...overrides,
  };
}

function event(
  eventId: string,
  overrides: Partial<EvidenceEventV1> & { type: EvidenceEventType; phase: EvidencePhase; outcome: EvidenceOutcome },
): EvidenceEventV1 {
  return {
    version: 1,
    eventId,
    createdAt: "2026-05-11T00:00:00.000Z",
    workspaceKey: "workspace-key",
    workspaceRootHash: "workspace-root-hash",
    reasonCodes: [],
    ...overrides,
  };
}

function capacityEvents(count: number): EvidenceEventV1[] {
  return Array.from({ length: count }, (_, index) => event(`evt-cap-${index.toString().padStart(2, "0")}`, {
    type: "memory_removed_capacity",
    phase: "storage",
    outcome: "removed",
    createdAt: `2026-05-11T${String(index).padStart(2, "0")}:00:00.000Z`,
    memory: { memoryId: `evicted-${index}`, type: "feedback", source: "compaction" },
    reasonCodes: ["global_cap"],
  }));
}

function capacityEventInputs(count: number): EvidenceEventInput[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "memory_removed_capacity",
    phase: "storage",
    outcome: "removed",
    memory: { memoryId: `evicted-${index}`, type: "feedback", source: "compaction" },
    reasonCodes: ["global_cap"],
  }));
}

function rejection(text: string, options: { type: NormalizedRejection["type"]; reasons: string[]; timestamp: string; legacy?: boolean }): NormalizedRejection {
  return {
    timestamp: options.timestamp,
    workspaceKey: options.legacy ? undefined : "workspace-key",
    workspaceRoot: undefined,
    workspaceRootHash: options.legacy ? undefined : "workspace-root-hash",
    type: options.type,
    source: "compaction",
    origin: "compaction_candidate",
    fromTrigger: false,
    text,
    reasons: options.reasons,
  };
}

function inspectionModel(
  entries: LongTermMemoryEntry[],
  events: EvidenceEventV1[],
  rejectionRecords: NormalizedRejection[] = [],
  storeOverrides: Partial<WorkspaceMemoryStore> = {},
): MemoryInspectionReadModel {
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root: "/tmp/workspace", key: "workspace-key" },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    entries,
    migrations: [],
    updatedAt: generatedAt,
    lastActivityAt: "2026-05-10T00:00:00.000Z",
    ...storeOverrides,
  };
  const retention = retentionCandidatesForDiag(store, new Date(generatedAt).getTime());
  const snapshot: WorkspaceDiagSnapshot = {
    store,
    journal: { version: 1, workspace: { root: "", key: "" }, entries: [], updatedAt: new Date(0).toISOString() },
    retention,
    memories: [],
    recentEvents: [],
    allEvents: events,
    summary: { storedActive: entries.length, rendered: retention.rendered.length, pending: 0, rejectedLast7Days: 0, corruptStoresQuarantinedLast30Days: 0 },
  };
  return {
    snapshot,
    store,
    pending: snapshot.journal,
    evidenceEvents: events,
    rejectionRecords,
    currentById: new Map(entries.map(memory => [memory.id, memory])),
    evidenceByMemoryId: groupEvidenceByMemoryId(events),
  };
}

function provenanceClassifications(): ProvenanceClassification[] {
  return [
    "explicit_migration_evidence",
    "legacy_unversioned_format",
    "reabsorbed_post_rejection",
    "suspected_pre_migration_legacy",
    "likely_current_behavior",
    "unversioned_ambiguous",
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function seedWorkspace(root: string, entries: LongTermMemoryEntry[]): Promise<void> {
  const key = await workspaceKey(root);
  const memoryPath = await workspaceMemoryPath(root);
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root, key },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    entries,
    migrations: [],
    updatedAt: generatedAt,
    lastActivityAt: "2026-05-10T00:00:00.000Z",
  };

  await mkdir(dirname(memoryPath), { recursive: true });
  await writeFile(memoryPath, JSON.stringify(store, null, 2));
}

function assertReviewBoardShape(report: ReviewBoardReport): void {
  assert.equal(report.version, 1);
  assert.equal(typeof report.generatedAt, "string");
  assert.equal(typeof report.workspace.rootHash, "string");
  assert.equal(typeof report.workspace.key, "string");
  assert.equal(report.purpose, "review_evidence_only");
  assert.equal(report.languageGuidance.nonAuthoritative, true);
  assert.equal(report.languageGuidance.mutation, "none");
  assert.equal(report.languageGuidance.rawReasonCodesAreEvidence, true);
  assert.equal(report.languageGuidance.producerVersionRecorded, false);
  assert.equal(report.languageGuidance.provenanceInferenceOnly, true);
  assert.equal(report.languageGuidance.primaryReviewPurpose, "system_mechanism_observations");
  assert.equal(report.languageGuidance.secondaryReviewPurpose, "memory_content_quality");
  assert.ok(Array.isArray(report.provenanceContext.migrationTimeline));
  assert.equal(typeof report.provenanceContext.countsByClassification.unversioned_ambiguous, "number");
  assert.equal(typeof report.facts.systemMechanisms.rejectionFilters.totalRecords, "number");
  assert.equal(typeof report.facts.systemMechanisms.reinforcementRules.windowBlockRate, "number");
  assert.ok(Array.isArray(report.facts.systemMechanisms.evictionAndCaps.fullCaps));
  assert.equal(typeof report.facts.systemMechanisms.identityAndDedup.duplicateTextOrIdentityGroups, "number");
  assert.equal(typeof report.facts.memoryContent.evidenceCoverage.covered, "number");
  assert.ok(Array.isArray(report.activeMemoryDisplay.items));
  assert.ok(Array.isArray(report.reviewCandidates));
  assert.ok(Array.isArray(report.reviewQuestions.systemMechanism));
  assert.ok(Array.isArray(report.reviewQuestions.memoryContent));
  assert.ok(Array.isArray(report.nextCommands));
}
