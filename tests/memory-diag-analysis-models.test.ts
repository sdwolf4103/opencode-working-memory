import test from "node:test";
import assert from "node:assert/strict";
import type { EvidenceEventType, EvidenceEventV1, EvidenceOutcome, EvidencePhase } from "../src/evidence-log.ts";
import type { LongTermMemoryEntry } from "../src/types.ts";
import type { MemoryInspectionReadModel } from "../scripts/memory-diag/types.ts";
import { CliInputError, normalizeRejection, rejectionQualitySummary, sinceCutoff } from "../scripts/memory-diag/rejections-model.ts";
import { coverageRows, disappearanceRows } from "../scripts/memory-diag/inspection-model.ts";
import { groupEvidenceByMemoryId } from "../scripts/memory-diag/evidence-model.ts";
import { statusFromTraceEvent } from "../scripts/memory-diag/trace-model.ts";

function entry(id: string, type: LongTermMemoryEntry["type"]): LongTermMemoryEntry {
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  return {
    id,
    type,
    text: `${id} text`,
    source: "compaction",
    confidence: 0.75,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

function event(overrides: Partial<EvidenceEventV1> & { type: EvidenceEventType; phase: EvidencePhase; outcome: EvidenceOutcome }): EvidenceEventV1 {
  return {
    version: 1,
    eventId: `evt-${overrides.type}-${Math.random()}`,
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    workspaceKey: "workspace-key",
    workspaceRootHash: "workspace-root-hash",
    reasonCodes: [],
    ...overrides,
  };
}

function model(entries: LongTermMemoryEntry[], events: EvidenceEventV1[]): MemoryInspectionReadModel {
  return {
    store: {
      version: 1,
      workspace: { root: "/tmp/workspace", key: "workspace-key" },
      limits: { maxRenderedChars: 24_000, maxEntries: 28 },
      entries,
      migrations: [],
      updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    },
    pending: { version: 1, workspace: { root: "", key: "" }, entries: [], updatedAt: new Date(0).toISOString() },
    evidenceEvents: events,
    rejectionRecords: [],
    currentById: new Map(entries.map(memory => [memory.id, memory])),
    evidenceByMemoryId: groupEvidenceByMemoryId(events),
  };
}

test("normalizeRejection infers origins from source", () => {
  assert.equal(normalizeRejection({ source: "compaction", text: "a", reasons: ["bad_decision"] })?.origin, "compaction_candidate");
  assert.equal(normalizeRejection({ source: "explicit", text: "a", reasons: ["bad_feedback"] })?.origin, "explicit_trigger");
  assert.equal(normalizeRejection({ source: "manual", text: "a", reasons: ["bad_feedback"] })?.origin, "manual");
  assert.equal(normalizeRejection({ source: "unknown-source", text: "a", reasons: ["bad_feedback"] })?.origin, "unknown");
});

test("sinceCutoff accepts relative durations and ISO timestamps", () => {
  const now = new Date("2026-01-15T12:00:00.000Z").getTime();

  assert.equal(sinceCutoff("14d", now), now - 14 * 86_400_000);
  assert.equal(sinceCutoff("3h", now), now - 3 * 3_600_000);
  assert.equal(sinceCutoff("30m", now), now - 30 * 60_000);
  assert.equal(sinceCutoff("2026-01-01T00:00:00.000Z", now), new Date("2026-01-01T00:00:00.000Z").getTime());
  assert.throws(() => sinceCutoff("forever", now), (error: unknown) => {
    assert.ok(error instanceof CliInputError);
    assert.equal((error as Error).message, "Invalid --since value: forever");
    return true;
  });
});

test("rejectionQualitySummary keeps architecture-like false-positive grouping", () => {
  const records = [
    normalizeRejection({ type: "decision", source: "compaction", text: "Retention scoring model uses evidence caps to avoid normalization drift", reasons: ["bad_decision"] }),
    normalizeRejection({ type: "decision", source: "compaction", text: "Implemented phase 2 and updated tests", reasons: ["bad_decision"] }),
    normalizeRejection({ type: "decision", source: "compaction", text: "Maybe useful", reasons: ["bad_decision"] }),
  ].filter(record => record !== null);

  const summary = rejectionQualitySummary(records);

  assert.equal(summary.totalRecords, 3);
  assert.equal(summary.possibleFalsePositiveGroups.architecture_like_possible_false_positive.count, 1);
  assert.equal(summary.possibleFalsePositiveGroups.clearly_garbage.count, 1);
  assert.equal(summary.possibleFalsePositiveGroups.ambiguous.count, 1);
});

test("coverageRows classifies current and historical memory evidence", () => {
  const entries = [entry("mem-full", "feedback"), entry("mem-render-only", "decision"), entry("mem-no-evidence", "project")];
  const events = [
    event({ type: "extraction_candidate_accepted", phase: "extraction", outcome: "accepted", memory: { memoryId: "mem-full", type: "feedback", source: "compaction" } }),
    event({ type: "promotion_promoted", phase: "promotion", outcome: "promoted", memory: { memoryId: "mem-full", type: "feedback", source: "compaction" } }),
    event({ type: "render_selected", phase: "render", outcome: "rendered", memory: { memoryId: "mem-render-only", type: "decision", source: "compaction" } }),
    event({ type: "memory_removed_capacity", phase: "storage", outcome: "removed", memory: { memoryId: "historical-cap", type: "project", source: "compaction" }, reasonCodes: ["global_cap"] }),
    event({ type: "promotion_promoted", phase: "promotion", outcome: "promoted", memory: { memoryId: "historical-unknown", type: "reference", source: "compaction" } }),
  ];

  const rows = coverageRows(model(entries, events), true);
  const byId = new Map(rows.map(row => [row.id, row.class]));

  assert.equal(byId.get("mem-full"), "full_lifecycle");
  assert.equal(byId.get("mem-render-only"), "render_only");
  assert.equal(byId.get("mem-no-evidence"), "no_evidence");
  assert.equal(byId.get("historical-cap"), "historical_absent_with_reason");
  assert.equal(byId.get("historical-unknown"), "historical_absent_unknown_reason");
});

test("disappearanceRows surfaces terminal capacity evidence", () => {
  const events = [
    event({ type: "promotion_promoted", phase: "promotion", outcome: "promoted", memory: { memoryId: "capacity-loser", type: "decision", source: "compaction" } }),
    event({ type: "memory_removed_capacity", phase: "storage", outcome: "removed", memory: { memoryId: "capacity-loser", type: "decision", source: "compaction" }, reasonCodes: ["type_cap"] }),
  ];

  const rows = disappearanceRows(model([], events));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "capacity-loser");
  assert.equal(rows[0].classification, "historical_absent_with_reason");
  assert.equal(rows[0].terminalType, "memory_removed_capacity");
  assert.deepEqual(rows[0].reasonCodes, ["type_cap"]);
});

test("statusFromTraceEvent maps lifecycle events", () => {
  assert.equal(statusFromTraceEvent(undefined), "unknown");
  assert.equal(statusFromTraceEvent(event({ type: "render_selected", phase: "render", outcome: "rendered" })), "rendered");
  assert.equal(statusFromTraceEvent(event({ type: "render_omitted", phase: "render", outcome: "omitted", reasonCodes: ["type_cap"] })), "omitted_type_cap");
  assert.equal(statusFromTraceEvent(event({ type: "promotion_absorbed_exact", phase: "promotion", outcome: "absorbed" })), "omitted_absorbed_duplicate");
  assert.equal(statusFromTraceEvent(event({ type: "promotion_retry_scheduled", phase: "promotion", outcome: "retried" })), "pending_retry");
  assert.equal(statusFromTraceEvent(event({ type: "promotion_retry_exhausted", phase: "promotion", outcome: "exhausted" })), "pending_rejected_capacity");
  assert.equal(statusFromTraceEvent(event({ type: "storage_corrupt_json_quarantined", phase: "storage", outcome: "quarantined" })), "quarantined_corrupt_store");
  assert.equal(statusFromTraceEvent(event({ type: "promotion_superseded", phase: "promotion", outcome: "superseded" })), "omitted_superseded");
});
