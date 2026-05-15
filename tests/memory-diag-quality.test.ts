import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
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
import { normalizeRejection } from "../scripts/memory-diag/rejections-model.ts";
import { retentionCandidatesForDiag } from "../scripts/memory-diag/retention-model.ts";
import type { MemoryInspectionReadModel, NormalizedRejection, WorkspaceDiagSnapshot } from "../scripts/memory-diag/types.ts";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const generatedAt = "2026-05-11T12:00:00.000Z";
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };

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
  assert.equal(defaultReport.reviewCandidates.every(candidate => candidate.source !== "active_memory"), true);
  assert.equal(defaultReport.reviewCandidates.every(candidate => candidate.concernKind === "system_mechanism"), true);

  const verboseReport = buildQualityReviewBoard(model, { verbose: true }, generatedAt);
  assert.equal(verboseReport.activeMemoryDisplay.mode, "all");
  assert.equal(verboseReport.activeMemoryDisplay.shown, 41);

  const jsonReport = buildQualityReviewBoard(model, { json: true }, generatedAt);
  assert.equal(jsonReport.activeMemoryDisplay.mode, "all");
  assert.equal(jsonReport.activeMemoryDisplay.shown, 41);
  assert.equal(jsonReport.activeMemoryDisplay.total, 41);
  assert.equal(jsonReport.reviewCandidates.every(candidate => candidate.source !== "active_memory"), true);

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

test("new evidence events include producer metadata and historical events remain accepted", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-memory-diag-quality-producer-"));
  try {
    const [stored] = await appendEvidenceEvents(root, [event("evt-input-producer", {
      type: "render_selected",
      phase: "render",
      outcome: "rendered",
      memory: { memoryId: "mem-produced", type: "decision", source: "compaction" },
    })]);

    assert.equal(stored.producerName, "opencode-working-memory");
    assert.equal(stored.producerVersion, packageJson.version);
    assert.equal(stored.instrumentationVersion, 3);

    const historical = event("evt-historical-no-producer", {
      type: "render_selected",
      phase: "render",
      outcome: "rendered",
      memory: { memoryId: "mem-historical", type: "decision", source: "compaction" },
    });
    const report = buildQualityReviewBoard(inspectionModel([
      entry("mem-historical", "Historical uninstrumented memory", "decision"),
    ], [historical]), {}, generatedAt);
    assert.equal(report.facts.memoryContent.evidenceCoverage.covered, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejection normalization preserves producer and decision metadata", () => {
  const normalized = normalizeRejection({
    timestamp: "2026-05-12T00:00:00.000Z",
    type: "decision",
    source: "compaction",
    text: "Rejected diagnostic metadata candidate",
    reasons: ["bad_decision"],
    producerName: "opencode-working-memory",
    producerVersion: packageJson.version,
    instrumentationVersion: 2,
    decisionLogicName: "assessMemoryQuality",
    decisionLogicVersion: 1,
  });

  assert.ok(normalized);
  assert.equal(normalized.producerName, "opencode-working-memory");
  assert.equal(normalized.producerVersion, packageJson.version);
  assert.equal(normalized.instrumentationVersion, 2);
  assert.equal(normalized.decisionLogicName, "assessMemoryQuality");
  assert.equal(normalized.decisionLogicVersion, 1);
});

test("quality upgrades answerability when producer-instrumented block reasons exist", () => {
  const model = inspectionModelWithProducerEvents();

  const report = buildQualityReviewBoard(model, {}, generatedAt);

  assert.ok(report.facts.systemMechanisms.instrumentation);
  assert.ok(report.facts.systemMechanisms.instrumentation.evidenceEventsWithProducer > 0);
  assert.equal(report.facts.systemMechanisms.instrumentation.evidenceEventsTotal, 3);
  assert.equal(report.facts.systemMechanisms.reinforcementRules.blocksByExactReason.same_utc_day, 1);
  assert.equal(report.facts.systemMechanisms.reinforcementRules.blocksByExactReason.same_session, 1);
  assert.deepEqual(report.facts.systemMechanisms.reinforcementRules.windowBlocksByUtcDay, { "2026-05-11": 2 });
  assert.equal(report.facts.systemMechanisms.reinforcementRules.blockDetailsMissing, 1);

  assert.equal(report.answerability?.reinforcementRules?.level, "partial");

  const output = formatQualityReviewBoard(report, {});
  assert.match(output, /Producer coverage: 3 of 3 evidence events instrumented/);
  assert.match(output, /Exact block reasons: same_session=1, same_utc_day=1/);
  assert.match(output, /Answerability: partial.*causal fields exist, but human content judgment is still required/);
});

test("quality keeps reinforcement inventory-only for uninstrumented block reasons", () => {
  const model = inspectionModel([], [
    event("evt-old-block", {
      type: "memory_reinforced",
      phase: "reinforcement",
      outcome: "rejected",
      memory: { memoryId: "mem-old-block", type: "decision", source: "compaction" },
      reasonCodes: ["reinforcement_window_blocked"],
      details: { blockReason: "same_utc_day" },
    }),
  ]);

  const report = buildQualityReviewBoard(model, {}, generatedAt);

  assert.equal(report.facts.systemMechanisms.instrumentation.evidenceEventsWithProducer, 0);
  assert.equal(report.answerability?.reinforcementRules?.level, "inventory_only");
});

test("quality shows capacity snapshot facts when present", () => {
  const model = inspectionModelWithCapacitySnapshots();

  const report = buildQualityReviewBoard(model, {}, generatedAt);

  assert.equal(report.facts.systemMechanisms.evictionAndCaps.recentCapacityRemovalsWithSnapshot, 1);
  assert.equal(report.facts.systemMechanisms.evictionAndCaps.capacitySnapshotsMissing, 1);
  assert.deepEqual(report.facts.systemMechanisms.evictionAndCaps.highestRankRemoved, {
    memoryId: "mem-cap-snapshot",
    rankAtRemoval: 2,
    strengthAtRemoval: 0.82,
    type: "decision",
    eventId: "evt-cap-snapshot",
  });
  assert.equal(report.answerability?.evictionAndCaps?.level, "partial");

  const output = formatQualityReviewBoard(report, {});
  assert.match(output, /Removals with snapshot: 1/);
  assert.match(output, /Removals without snapshot: 1 \(historical\)/);
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
  assert.ok(report.reviewCandidates.length > 0);
  assert.equal(report.reviewCandidates.every(candidate => candidate.source !== "active_memory"), true);
  assert.equal(report.reviewCandidates.every(candidate => candidate.concernKind === "system_mechanism"), true);
  assert.ok(report.reviewCandidates.every(candidate => Array.isArray(candidate.heuristicFlags) && Array.isArray(candidate.reviewQuestions)));
  assert.ok(report.reviewCandidates.every(candidate => candidate.provenance));
  assert.doesNotMatch(JSON.stringify(report), /secret-value|\/tmp\/private/);
});

test("quality report includes answerability for all mechanism sections", () => {
  const report = buildQualityReviewBoard(inspectionModel([
    entry("mem-answerability", "Answerability contract memory", "decision"),
  ], []), {}, generatedAt);

  // Every diagnostic section must have an answerability contract.
  assert.ok(report.answerability, "report must have answerability field");
  assert.equal(report.answerability.reinforcementRules?.level, "inventory_only");
  assert.equal(report.answerability.evictionAndCaps?.level, "inventory_only");
  assert.equal(report.answerability.unknownDisappearances?.level, "inventory_only");
});

test("quality human output avoids misleading phrases", () => {
  const report = buildQualityReviewBoard(inspectionModel([
    entry("mem-wording", "Neutral wording memory", "decision"),
  ], []), {}, generatedAt);
  const output = formatQualityReviewBoard(report, { verbose: true });
  const lower = output.toLowerCase();
  assert.match(output, /Answerability: inventory_only/);
  assert.match(output, /Output permission:/);
  assert.doesNotMatch(lower, /reference shortage/);
  assert.doesNotMatch(lower, /reference insufficient/);
  assert.doesNotMatch(lower, /cap pressure/);
  assert.doesNotMatch(lower, /window too strict/);
  assert.doesNotMatch(lower, /current bug/);
  assert.doesNotMatch(lower, /highest-value/);
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

test("versioned quality facts are additive in JSON shape", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-version-shape", packageJson.version, false),
  ]), {}, generatedAt);

  assertReviewBoardShape(report);
  const versioned = report.facts.systemMechanisms.versionedFacts;
  assert.ok(versioned);
  assert.equal(versioned.currentPackageVersion, packageJson.version);
  assert.deepEqual(versioned.buckets, ["current", "previous", "unknown_unversioned"]);
  assert.ok(report.facts.systemMechanisms.reinforcementRules);
});

test("versioned quality distinguishes all-evidence coverage from mechanism opportunities", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    ...Array.from({ length: 20 }, (_, index) => versionedEvent(`evt-render-current-${index}`, packageJson.version, {
      type: "render_selected",
      phase: "render",
      outcome: "rendered",
      memory: { memoryId: `mem-${index}`, type: "decision", source: "compaction" },
    })),
    reinforcementAttempt("evt-current-block", packageJson.version, true),
  ]), {}, generatedAt);
  const output = formatQualityReviewBoard(report, {});

  assert.match(output, /version-stamp coverage/i);
  assert.match(output, /not mechanism problem counts/i);
  assert.match(output, /Mechanism opportunities below are reinforcement attempts only; render\/accounting events are excluded\./);
  assert.match(output, /current version .*opportunities=1, observed=1/);
});

test("versioned quality detects previous-only reinforcement pattern with sufficient current sample", () => {
  const events = [
    reinforcementAttempt("evt-prev-block-1", "1.6.0", true),
    reinforcementAttempt("evt-prev-block-2", "1.6.0", true),
    ...Array.from({ length: 5 }, (_, index) => reinforcementAttempt(`evt-current-ok-${index}`, packageJson.version, false)),
    reinforcementAttempt("evt-unknown-block", undefined, true),
  ];
  const report = buildQualityReviewBoard(inspectionModel([], events), {}, generatedAt);
  const facts = report.facts.systemMechanisms.versionedFacts?.reinforcementRules;

  assert.equal(facts?.buckets.current.opportunityCount, 5);
  assert.equal(facts?.buckets.current.observedPatternCount, 0);
  assert.equal(facts?.buckets.current.sampleAssessment, "not_observed_with_sufficient_sample");
  assert.match(facts?.inference.message ?? "", /No recurrence observed/);
  assert.doesNotMatch(facts?.inference.message ?? "", /fixed|resolved|absent in current version/i);
});

test("versioned quality reports current reinforcement recurrence", () => {
  const events = [
    reinforcementAttempt("evt-prev-block", "1.6.0", true),
    reinforcementAttempt("evt-current-block", packageJson.version, true),
    ...Array.from({ length: 5 }, (_, index) => reinforcementAttempt(`evt-current-any-${index}`, packageJson.version, false)),
  ];
  const report = buildQualityReviewBoard(inspectionModel([], events), {}, generatedAt);
  const facts = report.facts.systemMechanisms.versionedFacts?.reinforcementRules;
  const output = formatQualityReviewBoard(report, {});

  assert.equal(facts?.inference.status, "pattern_persists_across_versions");
  assert.match(output, /Current recurrence detected/);
});

test("versioned reinforcement inference surfaces current exact block reasons", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-current-same-session", packageJson.version, true, {
      details: { blockReason: "same_session" },
      reasonCodes: ["numbered_ref_reinforce", "reinforcement_window_blocked", "reinforcement_block_same_session"],
    }),
    ...Array.from({ length: 4 }, (_, index) => reinforcementAttempt(`evt-current-ok-${index}`, packageJson.version, false)),
  ]), {}, generatedAt);
  const output = formatQualityReviewBoard(report, {});
  const reinforcementBlock = output.slice(output.indexOf("  Reinforcement rules"), output.indexOf("  Eviction and caps"));

  assert.match(reinforcementBlock, /(diagnostic: current block reasons=same_session=1|inference: .*same_session=1)/s);
});

test("versioned reinforcement inference does not invent missing block reasons", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-current-missing-reason", packageJson.version, true, {
      details: {},
      reasonCodes: ["numbered_ref_reinforce", "reinforcement_window_blocked"],
    }),
    ...Array.from({ length: 4 }, (_, index) => reinforcementAttempt(`evt-current-ok-missing-${index}`, packageJson.version, false)),
  ]), {}, generatedAt);
  const output = formatQualityReviewBoard(report, {});

  assert.match(output, /block details missing=1/);
  assert.doesNotMatch(output, /same_session=1/);
  assert.doesNotMatch(output, /same_utc_day=1/);
});

test("quality surfaces same-session cross-day reinforcement as design diagnostic question", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-cross-day-same-session", packageJson.version, true, {
      createdAt: "2026-05-13T07:48:21.364Z",
      reasonCodes: ["numbered_ref_reinforce", "reinforcement_window_blocked", "reinforcement_block_same_session"],
      details: {
        blockReason: "same_session",
        attemptedAtIso: "2026-05-13T07:48:21.361Z",
        lastReinforcedAtIso: "2026-05-12T09:19:08.708Z",
      },
    }),
    reinforcementAttempt("evt-cross-day-same-session-older", packageJson.version, true, {
      createdAt: "2026-05-12T07:48:21.364Z",
      reasonCodes: ["numbered_ref_reinforce", "reinforcement_window_blocked", "reinforcement_block_same_session"],
      details: {
        blockReason: "same_session",
        attemptedAtIso: "2026-05-12T07:48:21.361Z",
        lastReinforcedAtIso: "2026-05-11T09:19:08.708Z",
      },
    }),
    ...Array.from({ length: 4 }, (_, index) => reinforcementAttempt(`evt-cross-day-ok-${index}`, packageJson.version, false)),
  ]), {}, generatedAt);
  const output = formatQualityReviewBoard(report, {});
  const diagnosticQuestions = report.facts.systemMechanisms.versionedFacts?.reinforcementRules.diagnosticQuestions;

  assert.equal(diagnosticQuestions?.length, 1);
  assert.equal(diagnosticQuestions?.[0]?.question, "Should same_session reinforcement blocking apply across UTC days?");
  assert.deepEqual(diagnosticQuestions?.[0]?.evidence, [
    "count=2",
    "eventId=evt-cross-day-same-session",
    "attemptedAtIso=2026-05-13T07:48:21.361Z",
    "lastReinforcedAtIso=2026-05-12T09:19:08.708Z",
  ]);
  assert.match(output, /Should same_session reinforcement blocking apply across UTC days/i);
  assert.match(output, /2026-05-13/);
  assert.match(output, /2026-05-12/);
  assert.doesNotMatch(output, /definitely a bug/i);
});

test("quality treats elapsed-window and refresh-only reinforcement as new evidence without old same-session question", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-elapsed-window-block", packageJson.version, true, {
      instrumentationVersion: 3,
      reasonCodes: ["numbered_ref_reinforce", "reinforcement_window_blocked", "reinforcement_block_min_elapsed_window"],
      details: {
        blockReason: "min_elapsed_window",
        elapsedMs: 601_200_000,
        requiredElapsedMs: 604_800_000,
        sameSession: true,
        attemptedAtIso: "2026-05-13T07:48:21.361Z",
        lastReinforcedAtIso: "2026-05-06T08:48:21.361Z",
      },
    }),
    reinforcementAttempt("evt-refresh-only", packageJson.version, false, {
      instrumentationVersion: 3,
      reasonCodes: ["numbered_ref_reinforce", "reinforcement_window_allowed", "reinforcement_saturation_refresh"],
      details: {
        reinforcementMode: "refresh_only",
        elapsedMs: 604_800_000,
        requiredElapsedMs: 604_800_000,
        sameSession: true,
      },
    }),
    ...Array.from({ length: 4 }, (_, index) => reinforcementAttempt(`evt-elapsed-ok-${index}`, packageJson.version, false, { instrumentationVersion: 3 })),
  ]), {}, generatedAt);
  const facts = report.facts.systemMechanisms.reinforcementRules;
  const versionedFacts = report.facts.systemMechanisms.versionedFacts?.reinforcementRules.buckets.current.facts;
  const output = formatQualityReviewBoard(report, {});

  assert.equal(facts.blocksByExactReason.min_elapsed_window, 1);
  assert.equal(facts.blocksByExactReason.same_session, undefined);
  assert.equal(facts.reinforcedEvents, 5);
  assert.equal(facts.rejectedOrBlockedEvents, 1);
  assert.equal(versionedFacts?.blocksByExactReason.min_elapsed_window, 1);
  assert.equal(versionedFacts?.reinforcedEvents, 5);
  assert.equal(versionedFacts?.rejectedOrBlockedEvents, 1);
  assert.equal(report.facts.systemMechanisms.versionedFacts?.reinforcementRules.diagnosticQuestions, undefined);
  assert.doesNotMatch(output, /Should same_session reinforcement blocking apply across UTC days/i);
  assert.doesNotMatch(output, /same_session=1/);
});

test("versioned quality warns when current reinforcement sample is small", () => {
  const events = [
    reinforcementAttempt("evt-prev-small-block", "1.6.0", true),
    reinforcementAttempt("evt-current-small-1", packageJson.version, false),
    reinforcementAttempt("evt-current-small-2", packageJson.version, false),
  ];
  const report = buildQualityReviewBoard(inspectionModel([], events), {}, generatedAt);
  const facts = report.facts.systemMechanisms.versionedFacts?.reinforcementRules;

  assert.equal(facts?.buckets.current.sampleAssessment, "not_observed_but_sample_small");
  assert.match(formatQualityReviewBoard(report, {}), /do not infer absence/);
});

test("versioned reinforcement diagnostic strength is weak when below threshold", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    ...Array.from({ length: 3 }, (_, index) => reinforcementAttempt(`evt-strength-weak-${index}`, packageJson.version, false)),
  ]), {}, generatedAt);

  assert.match(formatQualityReviewBoard(report, {}), /diagnostic strength: weak/i);
});

test("versioned reinforcement diagnostic strength is unavailable when no current opportunities", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-strength-prev", "1.6.0", false),
  ]), {}, generatedAt);

  assert.match(formatQualityReviewBoard(report, {}), /diagnostic strength: unavailable/i);
});

test("versioned reinforcement diagnostic strength is moderate with causal detail", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-strength-blocked", packageJson.version, true, {
      details: { blockReason: "same_session" },
      reasonCodes: ["numbered_ref_reinforce", "reinforcement_window_blocked", "reinforcement_block_same_session"],
    }),
    ...Array.from({ length: 4 }, (_, index) => reinforcementAttempt(`evt-strength-ok-${index}`, packageJson.version, false)),
  ]), {}, generatedAt);

  assert.match(formatQualityReviewBoard(report, {}), /diagnostic strength: moderate; causal detail available/i);
});

test("versioned quality groups eviction snapshot recurrence by producer version", () => {
  const events = [
    capacityRemoval("evt-prev-missing", "1.6.0", false),
    ...Array.from({ length: 5 }, (_, index) => capacityRemoval(`evt-current-snapshot-${index}`, packageJson.version, true)),
  ];
  const report = buildQualityReviewBoard(inspectionModel([], events), {}, generatedAt);
  const facts = report.facts.systemMechanisms.versionedFacts?.evictionAndCaps;

  assert.equal(facts?.buckets.current.facts.capacitySnapshotsMissing, 0);
  assert.equal(facts?.buckets.previous.facts.capacitySnapshotsMissing, 1);
  assert.equal(facts?.buckets.current.sampleAssessment, "not_observed_with_sufficient_sample");
  assert.equal(report.answerability?.evictionAndCaps.level, "partial");
});

test("versioned quality treats unknown producerVersion as unknown/unversioned", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-unknown-version", "unknown", true),
  ]), {}, generatedAt);
  const facts = report.facts.systemMechanisms.versionedFacts?.reinforcementRules;

  assert.equal(facts?.buckets.current.opportunityCount, 0);
  assert.equal(facts?.buckets.unknown_unversioned.opportunityCount, 1);
  assert.equal(report.answerability?.reinforcementRules.level, "inventory_only");
});

test("versioned quality buckets rejection filter candidates and candidate version context", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [], [
    rejection("Architecture current rejection candidate", { type: "decision", reasons: ["bad_decision"], timestamp: "2026-05-10T00:00:00.000Z", producerVersion: packageJson.version }),
    rejection("Architecture previous rejection candidate", { type: "decision", reasons: ["bad_decision"], timestamp: "2026-05-09T00:00:00.000Z", producerVersion: "1.6.0" }),
    rejection("Architecture unknown rejection candidate", { type: "decision", reasons: ["bad_decision"], timestamp: "2026-05-08T00:00:00.000Z" }),
  ]), { verbose: true }, generatedAt);
  const facts = report.facts.systemMechanisms.versionedFacts?.rejectionFilters;

  assert.equal(facts?.buckets.current.opportunityCount, 1);
  assert.equal(facts?.buckets.previous.opportunityCount, 1);
  assert.equal(facts?.buckets.unknown_unversioned.opportunityCount, 1);
  assert.equal(report.reviewCandidates.find(candidate => candidate.facts.timestamp === "2026-05-10T00:00:00.000Z")?.versionContext?.group, "current");
  assert.equal(report.reviewCandidates.find(candidate => candidate.facts.timestamp === "2026-05-09T00:00:00.000Z")?.versionContext?.group, "previous");
});

test("versioned quality formatter avoids forbidden version-inference wording", () => {
  const output = formatQualityReviewBoard(buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-wording-prev", "1.6.0", true),
    ...Array.from({ length: 5 }, (_, index) => reinforcementAttempt(`evt-wording-current-${index}`, packageJson.version, false)),
  ]), {}, generatedAt), {}).toLowerCase();

  for (const forbidden of ["fixed", "resolved", "bug fixed", "regression fixed", "absent in current version"]) {
    assert.equal(output.includes(forbidden), false, `output should not contain ${forbidden}`);
  }
});

test("quality CLI JSON includes versionedFacts end to end", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-memory-diag-quality-versioned-json-"));
  try {
    await seedWorkspace(root, []);
    await appendEvidenceEvents(root, [{ type: "memory_reinforced", phase: "reinforcement", outcome: "reinforced", reasonCodes: [] }]);
    const report = JSON.parse(await runMemoryDiag(["quality", "--workspace", root, "--json"])) as ReviewBoardReport;
    assert.ok(report.facts.systemMechanisms.versionedFacts);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("versioned quality cannot assess when no current-version events exist", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-no-current-prev", "1.6.0", true),
    reinforcementAttempt("evt-no-current-unknown", undefined, true),
  ]), {}, generatedAt);
  const facts = report.facts.systemMechanisms.versionedFacts?.reinforcementRules;

  assert.equal(facts?.buckets.current.sampleAssessment, "no_current_version_opportunities");
  assert.equal(facts?.inference.status, "no_current_version_opportunities");
  assert.match(formatQualityReviewBoard(report, {}), /cannot assess recurrence/);
});

test("versioned quality reports pattern persisting across all version buckets", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-all-current-block", packageJson.version, true),
    ...Array.from({ length: 5 }, (_, index) => reinforcementAttempt(`evt-all-current-${index}`, packageJson.version, false)),
    reinforcementAttempt("evt-all-prev-block", "1.6.0", true),
    reinforcementAttempt("evt-all-unknown-block", undefined, true),
  ]), {}, generatedAt);

  assert.equal(report.facts.systemMechanisms.versionedFacts?.reinforcementRules.inference.status, "pattern_persists_across_versions");
  assert.match(formatQualityReviewBoard(report, {}).toLowerCase(), /current recurrence detected.*persists across versions/s);
});

test("versioned quality labels current-only pattern as new, not recurrence", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-new-current-block", packageJson.version, true),
    ...Array.from({ length: 5 }, (_, index) => reinforcementAttempt(`evt-new-current-${index}`, packageJson.version, false)),
  ]), {}, generatedAt);
  const facts = report.facts.systemMechanisms.versionedFacts?.reinforcementRules;

  assert.equal(facts?.inference.status, "no_previous_pattern_observed");
  assert.match(facts?.inference.message ?? "", /new pattern, not a recurrence/);
});

test("versioned quality emits current_recurrence_detected when current has signal and unknown/unversioned has signal but previous has none", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-current-unknown-current-block", packageJson.version, true),
    ...Array.from({ length: 4 }, (_, index) => reinforcementAttempt(`evt-current-unknown-current-ok-${index}`, packageJson.version, false)),
    reinforcementAttempt("evt-current-unknown-unknown-block", "unknown", true),
  ]), {}, generatedAt);
  const facts = report.facts.systemMechanisms.versionedFacts?.reinforcementRules;

  assert.equal(facts?.buckets.current.opportunityCount, 5);
  assert.equal(facts?.buckets.current.observedPatternCount, 1);
  assert.equal(facts?.buckets.previous.observedPatternCount, 0);
  assert.equal(facts?.buckets.unknown_unversioned.observedPatternCount, 1);
  assert.equal(facts?.inference.status, "current_recurrence_detected");
  assert.match(facts?.inference.message ?? "", /unknown\/unversioned evidence/);
  assert.match(facts?.inference.message ?? "", /cannot confirm or deny/);
});

test("versioned quality still emits no_previous_pattern_observed when both previous and unknown/unversioned have no signal", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-current-only-current-block", packageJson.version, true),
    ...Array.from({ length: 4 }, (_, index) => reinforcementAttempt(`evt-current-only-current-ok-${index}`, packageJson.version, false)),
    reinforcementAttempt("evt-current-only-unknown-ok", "unknown", false),
  ]), {}, generatedAt);
  const facts = report.facts.systemMechanisms.versionedFacts?.reinforcementRules;

  assert.equal(facts?.buckets.current.opportunityCount, 5);
  assert.equal(facts?.buckets.current.observedPatternCount, 1);
  assert.equal(facts?.buckets.previous.observedPatternCount, 0);
  assert.equal(facts?.buckets.unknown_unversioned.observedPatternCount, 0);
  assert.equal(facts?.inference.status, "no_previous_pattern_observed");
  assert.doesNotMatch(facts?.inference.message ?? "", /Current recurrence detected/);
});

test("versioned quality treats empty and whitespace producerVersion as unknown/unversioned", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-empty-version", "", true),
    reinforcementAttempt("evt-space-version", "  ", true),
  ]), {}, generatedAt);

  assert.equal(report.facts.systemMechanisms.versionedFacts?.reinforcementRules.buckets.current.opportunityCount, 0);
  assert.equal(report.facts.systemMechanisms.versionedFacts?.reinforcementRules.buckets.previous.opportunityCount, 0);
  assert.equal(report.facts.systemMechanisms.versionedFacts?.reinforcementRules.buckets.unknown_unversioned.opportunityCount, 2);
});

test("versioned quality leaves current bucket empty when current package version is unknown", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-current-unknown-override", packageJson.version, true),
  ]), { currentProducerVersion: "unknown" }, generatedAt);

  assert.equal(report.facts.systemMechanisms.versionedFacts?.reinforcementRules.buckets.current.opportunityCount, 0);
  assert.equal(report.facts.systemMechanisms.versionedFacts?.reinforcementRules.inference.status, "no_current_version_opportunities");
  assert.match(report.facts.systemMechanisms.versionedFacts?.reinforcementRules.inference.message ?? "", /unknown/);
});

test("quality answerability stays conservative when only previous version has reinforcement signal", () => {
  const report = buildQualityReviewBoard(inspectionModel([], [
    reinforcementAttempt("evt-prev-only-block", "1.6.0", true),
  ]), {}, generatedAt);

  assert.equal(report.answerability?.reinforcementRules.level, "inventory_only");
});

test("versioned quality exposes unknown/unversioned composition breakdown", () => {
  const unknownEvents = [
    ...Array.from({ length: 4 }, (_, index) => reinforcementAttempt(`evt-no-fields-${index}`, undefined, true)),
    ...Array.from({ length: 3 }, (_, index) => reinforcementAttempt(`evt-unknown-fields-${index}`, "unknown", true)),
    reinforcementAttempt("evt-empty-fields-1", "", true),
    reinforcementAttempt("evt-empty-fields-2", "", true),
    reinforcementAttempt("evt-space-fields", "  ", true),
    reinforcementAttempt("evt-known-current", packageJson.version, false),
    reinforcementAttempt("evt-known-prev", "1.6.0", false),
  ];
  const report = buildQualityReviewBoard(inspectionModel([], unknownEvents), {}, generatedAt);
  const buckets = report.facts.systemMechanisms.versionedFacts?.reinforcementRules.buckets;

  assert.deepEqual(buckets?.unknown_unversioned.versionAvailability, { noProducerFields: 4, unknownProducerVersion: 3, emptyProducerVersion: 3, knownProducerVersion: 0 });
  assert.equal(buckets?.current.versionAvailability.knownProducerVersion, 1);
  assert.equal(buckets?.previous.versionAvailability.knownProducerVersion, 1);
  assert.equal(buckets?.current.versionAvailability.emptyProducerVersion, 0);
  assert.equal(buckets?.previous.versionAvailability.noProducerFields, 0);
});

test("versioned quality marks low version coverage as transitional", () => {
  const events = Array.from({ length: 2_292 }, (_, index) => versionedEvent(`evt-transitional-${index}`, "unknown", {
    type: "render_selected",
    phase: "render",
    outcome: "rendered",
    memory: { memoryId: `mem-${index}`, type: "decision", source: "compaction" },
  }));
  const report = buildQualityReviewBoard(inspectionModel([], events), {}, generatedAt);

  assert.equal(report.facts.systemMechanisms.versionedFacts?.versionCoverage.isTransitional, true);
  assert.equal(report.facts.systemMechanisms.versionedFacts?.versionCoverage.coveragePercent, 0);
  const output = formatQualityReviewBoard(report, {});
  assert.match(output, /Coverage: 0% of 2,292/);
  assert.match(output, /Version coverage is below 50%/);
});

test("versioned quality marks fully stamped evidence as non-transitional", () => {
  const events = [
    ...Array.from({ length: 15 }, (_, index) => reinforcementAttempt(`evt-nontrans-current-${index}`, packageJson.version, false)),
    ...Array.from({ length: 5 }, (_, index) => reinforcementAttempt(`evt-nontrans-prev-${index}`, "1.6.0", false)),
  ];
  const report = buildQualityReviewBoard(inspectionModel([], events), {}, generatedAt);

  assert.equal(report.facts.systemMechanisms.versionedFacts?.versionCoverage.isTransitional, false);
  assert.equal(report.facts.systemMechanisms.versionedFacts?.versionCoverage.coveragePercent, 100);
  assert.doesNotMatch(formatQualityReviewBoard(report, {}), /Version coverage is below 50%/);
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

function versionedEvent(
  eventId: string,
  producerVersion: string | undefined,
  overrides: Partial<EvidenceEventV1> & { type: EvidenceEventType; phase: EvidencePhase; outcome: EvidenceOutcome },
): EvidenceEventV1 {
  const base = event(eventId, overrides);
  if (producerVersion === undefined) return base;
  return {
    ...base,
    producerName: "opencode-working-memory",
    producerVersion,
    instrumentationVersion: 2,
  };
}

function reinforcementAttempt(
  id: string,
  producerVersion: string | undefined,
  blocked = false,
  overrides: Partial<EvidenceEventV1> = {},
): EvidenceEventV1 {
  const base = versionedEvent(id, producerVersion, {
    type: "memory_reinforced",
    phase: "reinforcement",
    outcome: blocked ? "rejected" : "reinforced",
    memory: { memoryId: `mem-${id}`, type: "decision", source: "compaction" },
    reasonCodes: blocked ? ["reinforcement_window_blocked"] : [],
    details: blocked ? { blockReason: "same_utc_day", ref: id } : undefined,
  });
  return {
    ...base,
    ...overrides,
    details: overrides.details ?? base.details,
    reasonCodes: overrides.reasonCodes ?? base.reasonCodes,
  };
}

function capacityRemoval(id: string, producerVersion: string | undefined, withSnapshot: boolean): EvidenceEventV1 {
  return versionedEvent(id, producerVersion, {
    type: "memory_removed_capacity",
    phase: "storage",
    outcome: "removed",
    createdAt: "2026-05-11T10:00:00.000Z",
    memory: { memoryId: `mem-${id}`, type: "decision", source: "compaction" },
    reasonCodes: ["global_cap"],
    details: withSnapshot ? { strengthAtRemoval: 0.8, rankAtRemoval: 2 } : undefined,
  });
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

function inspectionModelWithProducerEvents(): MemoryInspectionReadModel {
  return inspectionModel([], [
    event("evt-new-block-same-day", {
      type: "memory_reinforced",
      phase: "reinforcement",
      outcome: "rejected",
      createdAt: "2026-05-11T09:00:00.000Z",
      memory: { memoryId: "mem-producer-block", type: "decision", source: "compaction" },
      reasonCodes: ["reinforcement_window_blocked", "reinforcement_block_same_utc_day"],
      details: { blockReason: "same_utc_day", ref: "1" },
      producerName: "opencode-working-memory",
      producerVersion: packageJson.version,
      instrumentationVersion: 2,
    }),
    event("evt-new-block-same-session", {
      type: "memory_reinforced",
      phase: "reinforcement",
      outcome: "rejected",
      createdAt: "2026-05-11T10:00:00.000Z",
      memory: { memoryId: "mem-producer-block", type: "decision", source: "compaction" },
      reasonCodes: ["reinforcement_window_blocked", "reinforcement_block_same_session"],
      details: { blockReason: "same_session", ref: "2" },
      producerName: "opencode-working-memory",
      producerVersion: packageJson.version,
      instrumentationVersion: 2,
    }),
    event("evt-new-block-missing-detail", {
      type: "memory_reinforced",
      phase: "reinforcement",
      outcome: "rejected",
      createdAt: "2026-05-11T11:00:00.000Z",
      memory: { memoryId: "mem-producer-block", type: "decision", source: "compaction" },
      reasonCodes: ["reinforcement_window_blocked"],
      producerName: "opencode-working-memory",
      producerVersion: packageJson.version,
      instrumentationVersion: 2,
    }),
  ]);
}

function inspectionModelWithCapacitySnapshots(): MemoryInspectionReadModel {
  return inspectionModel([], [
    event("evt-cap-snapshot", {
      type: "memory_removed_capacity",
      phase: "storage",
      outcome: "removed",
      createdAt: "2026-05-11T10:00:00.000Z",
      memory: { memoryId: "mem-cap-snapshot", type: "decision", source: "compaction" },
      reasonCodes: ["global_cap"],
      details: { strengthAtRemoval: 0.82, rankAtRemoval: 2, typeRankAtRemoval: 1, ageDaysAtRemoval: 3 },
      producerName: "opencode-working-memory",
      producerVersion: packageJson.version,
      instrumentationVersion: 2,
    }),
    event("evt-cap-historical", {
      type: "memory_removed_capacity",
      phase: "storage",
      outcome: "removed",
      createdAt: "2026-05-11T09:00:00.000Z",
      memory: { memoryId: "mem-cap-historical", type: "feedback", source: "compaction" },
      reasonCodes: ["type_cap"],
    }),
  ]);
}

function rejection(text: string, options: { type: NormalizedRejection["type"]; reasons: string[]; timestamp: string; legacy?: boolean; producerVersion?: string; producerName?: string; instrumentationVersion?: number }): NormalizedRejection {
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
    ...(options.producerName !== undefined || options.producerVersion !== undefined || options.instrumentationVersion !== undefined
      ? {
          producerName: options.producerName ?? "opencode-working-memory",
          producerVersion: options.producerVersion,
          instrumentationVersion: options.instrumentationVersion ?? 2,
        }
      : {}),
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
  assert.equal(typeof report.languageGuidance.producerVersionRecorded, "boolean");
  assert.equal(report.languageGuidance.provenanceInferenceOnly, true);
  assert.equal(report.languageGuidance.primaryReviewPurpose, "system_mechanism_observations");
  assert.equal(report.languageGuidance.secondaryReviewPurpose, "memory_content_quality");
  assert.ok(Array.isArray(report.provenanceContext.migrationTimeline));
  assert.equal(typeof report.provenanceContext.countsByClassification.unversioned_ambiguous, "number");
  assert.equal(typeof report.facts.systemMechanisms.rejectionFilters.totalRecords, "number");
  assert.equal(typeof report.facts.systemMechanisms.reinforcementRules.windowBlockRate, "number");
  assert.ok(Array.isArray(report.facts.systemMechanisms.evictionAndCaps.fullCaps));
  assert.equal(typeof report.facts.systemMechanisms.identityAndDedup.duplicateTextOrIdentityGroups, "number");
  assert.ok(report.facts.systemMechanisms.versionedFacts);
  assert.equal(typeof report.facts.systemMechanisms.versionedFacts.currentPackageVersion, "string");
  assert.equal(typeof report.facts.memoryContent.evidenceCoverage.covered, "number");
  assert.equal(report.answerability?.reinforcementRules.level, "inventory_only");
  assert.equal(report.answerability?.evictionAndCaps.level, "inventory_only");
  assert.ok(Array.isArray(report.activeMemoryDisplay.items));
  assert.ok(Array.isArray(report.reviewCandidates));
  assert.ok(Array.isArray(report.reviewQuestions.systemMechanism));
  assert.ok(Array.isArray(report.reviewQuestions.memoryContent));
  assert.ok(Array.isArray(report.nextCommands));
}
