import test from "node:test";
import assert from "node:assert/strict";
import type { EvidenceEventType, EvidenceEventV1, EvidenceOutcome, EvidencePhase } from "../src/evidence-log.ts";
import type { MemoryInspectionReadModel, WorkspaceDiagSnapshot } from "../scripts/memory-diag/types.ts";
import { formatWorkspaceHealth } from "../scripts/memory-diag/formatters/health.ts";
import { formatQuality } from "../scripts/memory-diag/formatters/quality.ts";
import { formatCoverage } from "../scripts/memory-diag/formatters/coverage.ts";
import { formatDisappearances } from "../scripts/memory-diag/formatters/disappearances.ts";
import { formatRejectionQuality } from "../scripts/memory-diag/formatters/rejections.ts";
import { formatMigrationAudit } from "../scripts/memory-diag/formatters/audit.ts";
import { formatExplain } from "../scripts/memory-diag/formatters/explain.ts";
import { formatTrace } from "../scripts/memory-diag/formatters/trace.ts";
import { rejectionQualitySummary } from "../scripts/memory-diag/rejections-model.ts";

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

test("health formatter includes existing retention cap label", () => {
  const output = formatWorkspaceHealth({
    root: "/tmp/workspace",
    key: "workspace-key",
    memoryPath: "/tmp/workspace-memory.json",
    pendingPath: "/tmp/workspace-pending-journal.json",
    raw: false,
    now: new Date("2026-01-01T00:00:00.000Z").getTime(),
    includeTitle: true,
  }, { rawStore: null, rawJournal: null, pendingExists: false });

  assert.match(output, /Workspace memory health/);
  assert.match(output, /Retention caps:/);
});

test("quality formatter includes caps and retention clock sections", () => {
  const output = formatQuality(emptyInspectionModel(), new Date("2026-01-01T00:00:00.000Z").getTime());

  assert.match(output, /Caps:/);
  assert.match(output, /Retention clocks:/);
});

test("rejection quality formatter includes reason distribution sections", () => {
  const summary = rejectionQualitySummary([]);
  const output = formatRejectionQuality({ path: "/tmp/rejections.jsonl", invalidLines: 0, summary, raw: false });

  assert.match(output, /Reason distribution \(raw records\):/);
  assert.match(output, /Reason distribution \(unique text\):/);
});

test("coverage formatter includes class counts section", () => {
  const output = formatCoverage([]);

  assert.match(output, /Class counts:/);
  assert.match(output, /Per-memory rows:\n  \(none\)/);
});

test("disappearances formatter preserves empty-state label", () => {
  const output = formatDisappearances([]);

  assert.match(output, /No evidence-only memories found\./);
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
