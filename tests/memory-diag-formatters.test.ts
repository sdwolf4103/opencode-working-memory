import test from "node:test";
import assert from "node:assert/strict";
import type { EvidenceEventType, EvidenceEventV1, EvidenceOutcome, EvidencePhase } from "../src/evidence-log.ts";
import type { MemoryInspectionReadModel, WorkspaceDiagSnapshot } from "../scripts/memory-diag/types.ts";
import { formatCoverage } from "../scripts/memory-diag/formatters/coverage.ts";
import { formatMigrationAudit } from "../scripts/memory-diag/formatters/audit.ts";
import { formatExplain } from "../scripts/memory-diag/formatters/explain.ts";
import { buildMissingJSON, formatMissing } from "../scripts/memory-diag/formatters/missing.ts";
import { formatTrace } from "../scripts/memory-diag/formatters/trace.ts";

function emptyInspectionModel(): MemoryInspectionReadModel {
  return {
    store: {
      version: 1,
      workspace: { root: "/tmp/workspace", key: "workspace-key" },
      limits: { maxRenderedChars: 24_000, maxEntries: 28 },
      entries: [],
      migrations: [],
      updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    },
    pending: { version: 1, workspace: { root: "", key: "" }, entries: [], updatedAt: new Date(0).toISOString() },
    evidenceEvents: [],
    rejectionRecords: [],
    currentById: new Map(),
    evidenceByMemoryId: new Map(),
  };
}

function emptySnapshot(): WorkspaceDiagSnapshot {
  return {
    store: emptyInspectionModel().store,
    journal: emptyInspectionModel().pending,
    retention: { sorted: [], rendered: [], typeCapped: [], globalCapped: [] },
    memories: [],
    recentEvents: [],
    allEvents: [],
    summary: {
      storedActive: 0,
      rendered: 0,
      pending: 0,
      rejectedLast7Days: 0,
      corruptStoresQuarantinedLast30Days: 0,
    },
  };
}

function event(overrides: Partial<EvidenceEventV1> & { type: EvidenceEventType; phase: EvidencePhase; outcome: EvidenceOutcome }): EvidenceEventV1 {
  return {
    version: 1,
    eventId: `evt-${overrides.type}`,
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    workspaceKey: "workspace-key",
    workspaceRootHash: "workspace-root-hash",
    reasonCodes: [],
    ...overrides,
  };
}

test("coverage formatter includes class counts section", () => {
  const output = formatCoverage([]);

  assert.match(output, /Class counts:/);
  assert.match(output, /Per-memory rows:\n  \(none\)/);
});

test("missing formatter verbose output preserves disappearance details", () => {
  const output = formatMissing([], { verbose: true });

  assert.match(output, /No missing memories found\./);
});

test("missing JSON includes disappearance rows and summary", () => {
  const rows = [{
    id: "historical-1",
    classification: "historical_absent_unknown_reason" as const,
    terminalType: "unknown" as const,
    reasonCodes: [],
    events: [event({ type: "extraction_candidate_accepted", phase: "extraction", outcome: "accepted" })],
    event: undefined,
  }];

  const output = buildMissingJSON(rows, { generatedAt: "2026-01-01T00:00:00.000Z" });

  assert.equal(output.version, 1);
  assert.deepEqual(output.summary, { total: 1, explained: 0, needsReview: 1 });
  assert.deepEqual((output.disappearances as Array<{ id: string }>)[0]?.id, "historical-1");
});

test("trace formatter includes lifecycle section", () => {
  const output = formatTrace("mem-1", emptySnapshot(), {
    events: [event({ type: "render_selected", phase: "render", outcome: "rendered", memory: { memoryId: "mem-1", type: "feedback", source: "explicit" } })],
  });

  assert.match(output, /Lifecycle:/);
  assert.match(output, /evt-render_selected render_selected/);
});

test("audit formatter preserves no-log output", () => {
  const output = formatMigrationAudit([], { raw: false });

  assert.match(output, /Migration audit report/);
  assert.match(output, /No migration logs found\./);
});

test("explain formatter preserves no-memory output", () => {
  const output = formatExplain(emptySnapshot());

  assert.match(output, /Workspace memory explainability/);
  assert.match(output, /No memories found\./);
});
