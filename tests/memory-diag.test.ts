import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { appendEvidenceEvents, type EvidenceEventInput } from "../src/evidence-log.ts";
import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "../src/types.ts";
import { LONG_TERM_LIMITS, PROMOTION_RETRY_LIMITS, type PendingMemoryJournalStore } from "../src/types.ts";
import { extractionRejectionLogPath, workspaceKey, workspaceMemoryPath, workspacePendingJournalPath } from "../src/paths.ts";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function entry(id: string, text: string, type: LongTermMemoryEntry["type"]): LongTermMemoryEntry {
  const now = new Date().toISOString();
  return {
    id,
    type,
    text,
    source: "compaction",
    confidence: 0.75,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

async function writeWorkspaceStore(root: string, entries: LongTermMemoryEntry[], options: { lastActivityAt?: string; omitLastActivityAt?: boolean } = {}): Promise<void> {
  const key = await workspaceKey(root);
  const path = await workspaceMemoryPath(root);
  const now = new Date().toISOString();
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root, key },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    entries,
    migrations: [],
    updatedAt: now,
  };
  if (!options.omitLastActivityAt) store.lastActivityAt = options.lastActivityAt ?? now;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2), "utf8");
}

async function runMemoryDiagHealth(root: string): Promise<string> {
  return runMemoryDiag(["health", "--workspace", root]);
}

async function runMemoryDiag(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [
    "--experimental-strip-types",
    "scripts/memory-diag.ts",
    ...args,
  ], { cwd: repoRoot });

  return stdout;
}

async function writePendingJournal(root: string, entries: LongTermMemoryEntry[]): Promise<void> {
  const key = await workspaceKey(root);
  const path = await workspacePendingJournalPath(root);
  const store: PendingMemoryJournalStore = {
    version: 1,
    workspace: { root, key },
    entries,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2), "utf8");
}

async function writeRejectionRecords(records: unknown[]): Promise<void> {
  const path = extractionRejectionLogPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map(record => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

function evidence(overrides: Partial<EvidenceEventInput>): EvidenceEventInput {
  return {
    type: "promotion_promoted",
    phase: "promotion",
    outcome: "promoted",
    memory: { memoryId: "mem-rendered", type: "feedback", source: "explicit", status: "active" },
    reasonCodes: ["new_workspace_entry"],
    ...overrides,
  };
}

test("memory health reports stored vs rendered retention counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-"));
  try {
    const entries: LongTermMemoryEntry[] = [
      ...Array.from({ length: 17 }, (_, i) => entry(`feedback-${i}`, `Unique feedback preference for memory health ${i}`, "feedback")),
      ...Array.from({ length: 11 }, (_, i) => entry(`decision-${i}`, `Unique durable decision for memory health ${i}`, "decision")),
    ];
    await writeWorkspaceStore(root, entries);

    const stdout = await runMemoryDiagHealth(root);

    assert.match(stdout, /Stored active memories:/);
    assert.match(stdout, /Rendered candidates:/);
    assert.match(stdout, /feedback\s+stored=17\s+rendered=10/);
    assert.match(stdout, /Top rendered candidates:\n\s+- strength=/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory health reports dormancy and retention monitoring deprecations", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-"));
  try {
    const lastActivityAt = new Date(Date.now() - 19 * 24 * 60 * 60 * 1000).toISOString();
    const entries = Array.from({ length: 10 }, (_, i) => ({
      ...entry(`monitoring-${i}`, `Unique monitoring memory ${i} for retention health`, i % 2 === 0 ? "feedback" : "decision"),
      userImportance: i < 4 ? "high" as const : "normal" as const,
      safetyCritical: i < 6,
      reinforcementCount: i < 2 ? 6 : 0,
    }));
    await writeWorkspaceStore(root, entries, { lastActivityAt });

    const stdout = await runMemoryDiagHealth(root);

    assert.match(stdout, /Dormancy:/);
    assert.match(stdout, /wall days since activity: 19\.0/);
    assert.match(stdout, /dormant discount active: yes/);
    assert.match(stdout, /dormant days past grace: 5\.0/);
    assert.match(stdout, /high_importance_ratio: 40\.0% .* ALERT/);
    assert.match(stdout, /safety_critical_count: 6 .*deprecated.* WARNING/);
    assert.match(stdout, /max_reinforced_count: 2 \(20\.0%, alert > 10%\) ALERT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory health reports global cap overflow separately from type caps", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-"));
  try {
    const entries: LongTermMemoryEntry[] = [
      ...Array.from({ length: 10 }, (_, i) => entry(`global-feedback-${i}`, `Unique global feedback preference ${i}`, "feedback")),
      ...Array.from({ length: 10 }, (_, i) => entry(`global-decision-${i}`, `Unique global durable decision ${i}`, "decision")),
      ...Array.from({ length: 8 }, (_, i) => entry(`global-project-${i}`, `Unique global project fact ${i}`, "project")),
      ...Array.from({ length: 6 }, (_, i) => entry(`global-reference-${i}`, `Unique global reference fact ${i}`, "reference")),
    ];
    await writeWorkspaceStore(root, entries);

    const stdout = await runMemoryDiagHealth(root);

    assert.match(stdout, /Rendered candidates: 28/);
    assert.match(stdout, /type-capped entries: 0/);
    assert.match(stdout, /global-cap overflow: 6/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory health reports missing dormancy and non-alert monitoring defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-"));
  try {
    await writeWorkspaceStore(root, [], { omitLastActivityAt: true });

    const stdout = await runMemoryDiagHealth(root);

    assert.match(stdout, /lastActivityAt: \(missing\)/);
    assert.match(stdout, /wall days since activity: unknown/);
    assert.match(stdout, /dormant discount active: no/);
    assert.match(stdout, /high_importance_ratio: 0\.0% \(alert > 30%\)\n/);
    assert.match(stdout, /safety_critical_count: 0 \(deprecated field\)\n/);
    assert.match(stdout, /max_reinforced_count: 0 \(alert > 10% active\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory health --json prints parseable privacy-safe diagnostics matching human counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-json-"));
  try {
    const rendered = { ...entry("mem-rendered", "Prefer small focused changes", "feedback"), source: "explicit" as const };
    const secret = { ...entry("mem-secret", "Use password: sushi only in test fixtures", "decision"), source: "manual" as const };
    const superseded = { ...entry("mem-old", "Old decision that was superseded", "decision"), status: "superseded" as const };
    const pending = { ...entry("mem-pending", "Retry this pending memory later", "project"), promotionAttempts: 1 };
    await writeWorkspaceStore(root, [rendered, secret, superseded]);
    await writePendingJournal(root, [pending]);
    await appendEvidenceEvents(root, [
      evidence({ type: "extraction_candidate_rejected", phase: "extraction", outcome: "rejected", memory: { memoryId: "mem-rejected", type: "feedback", source: "explicit" }, reasonCodes: ["raw_secret"], textPreview: "password: sushi should not leak" }),
      evidence({ type: "storage_corrupt_json_quarantined", phase: "storage", outcome: "quarantined", memory: undefined, reasonCodes: ["invalid_json"] }),
      evidence({ type: "promotion_promoted", phase: "promotion", outcome: "promoted", memory: { memoryId: "mem-rendered", type: "feedback", source: "explicit", status: "active" }, reasonCodes: ["new_workspace_entry"] }),
      evidence({ type: "render_selected", phase: "render", outcome: "rendered", memory: { memoryId: "mem-rendered", type: "feedback", source: "explicit", status: "active" }, reasonCodes: ["within_caps", "within_char_budget"] }),
    ]);

    const human = await runMemoryDiagHealth(root);
    const jsonText = await runMemoryDiag(["health", "--workspace", root, "--json"]);
    const parsed = JSON.parse(jsonText) as {
      version: 1;
      summary: { storedActive: number; rendered: number; pending: number; rejectedLast7Days: number; corruptStoresQuarantinedLast30Days: number };
      memories: Array<{ id: string; status: string; reasonCodes: string[]; evidenceEventIds: string[]; textPreview?: string }>;
      recentEvents: Array<{ eventId: string; type: string; outcome: string; createdAt: string; reasonCodes: string[] }>;
    };

    assert.equal(parsed.version, 1);
    assert.equal(parsed.summary.storedActive, Number(human.match(/Stored active memories: (\d+)/)?.[1]));
    assert.equal(parsed.summary.rendered, Number(human.match(/Rendered candidates: (\d+)/)?.[1]));
    assert.equal(parsed.summary.pending, Number(human.match(/Pending journal:\n\s+total: (\d+)/)?.[1]));
    assert.equal(parsed.summary.rejectedLast7Days, 1);
    assert.equal(parsed.summary.corruptStoresQuarantinedLast30Days, 1);
    assert.ok(parsed.recentEvents.some(event => event.eventId && event.type === "render_selected" && event.outcome === "rendered" && event.createdAt && event.reasonCodes.includes("within_caps")));
    assert.ok(parsed.memories.find(memory => memory.id === "mem-rendered")?.evidenceEventIds.length);
    assert.ok(!jsonText.includes("sushi"));
    assert.ok(jsonText.trim().startsWith("{"));
    assert.ok(jsonText.trim().endsWith("}"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory-diag explain shows rendered, omitted, pending, and evidence reason status", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-explain-"));
  try {
    const rendered = { ...entry("mem-rendered", "Rendered feedback wins the render set", "feedback"), source: "explicit" as const };
    const superseded = { ...entry("mem-superseded", "Superseded memory is not rendered", "decision"), status: "superseded" as const };
    const typeCapped = Array.from({ length: 11 }, (_, i) => entry(`mem-type-${i}`, `Type cap feedback memory ${i}`, "feedback"));
    const globalCapped = [
      ...Array.from({ length: 10 }, (_, i) => entry(`mem-g-feedback-${i}`, `Global cap feedback memory ${i}`, "feedback")),
      ...Array.from({ length: 10 }, (_, i) => entry(`mem-g-decision-${i}`, `Global cap decision memory ${i}`, "decision")),
      ...Array.from({ length: 8 }, (_, i) => entry(`mem-g-project-${i}`, `Global cap project memory ${i}`, "project")),
      ...Array.from({ length: 7 }, (_, i) => entry(`mem-g-reference-${i}`, `Global cap reference memory ${i}`, "reference")),
    ];
    const charBudget = { ...entry("mem-char-budget", "This active memory cannot fit the tiny character budget", "project") };
    await writeWorkspaceStore(root, [rendered, superseded, ...typeCapped, ...globalCapped, charBudget]);
    const key = await workspaceKey(root);
    const path = await workspaceMemoryPath(root);
    const raw = JSON.parse(await readFile(path, "utf8")) as WorkspaceMemoryStore;
    raw.limits.maxRenderedChars = 100;
    raw.workspace = { root, key };
    await writeFile(path, JSON.stringify(raw, null, 2), "utf8");

    const retry = { ...entry("mem-pending-retry", "Pending retry memory", "project"), promotionAttempts: 1, lastPromotionFailureReason: "capacity_rejected" };
    const exhausted = { ...entry("mem-pending-capacity", "Pending capacity rejected memory", "project"), promotionAttempts: PROMOTION_RETRY_LIMITS.maxExplicitAttempts, lastPromotionFailureReason: "capacity_rejected" };
    await writePendingJournal(root, [retry, exhausted]);
    await appendEvidenceEvents(root, [
      evidence({ type: "promotion_absorbed_exact", phase: "promotion", outcome: "absorbed", memory: { memoryId: "mem-absorbed", type: "feedback", source: "explicit" }, reasonCodes: ["same_exact_key"] }),
      evidence({ type: "storage_corrupt_json_quarantined", phase: "storage", outcome: "quarantined", memory: undefined, reasonCodes: ["invalid_json"] }),
    ]);

    const stdout = await runMemoryDiag(["explain", "--workspace", root]);

    assert.match(stdout, /Memory mem-rendered: rendered/);
    assert.match(stdout, /Memory mem-superseded: omitted_superseded/);
    assert.match(stdout, /omitted_type_cap/);
    assert.match(stdout, /omitted_global_cap/);
    assert.match(stdout, /omitted_char_budget/);
    assert.match(stdout, /Memory mem-pending-retry: pending_retry/);
    assert.match(stdout, /Memory mem-pending-capacity: pending_rejected_capacity/);
    assert.match(stdout, /Memory mem-absorbed: omitted_absorbed_duplicate/);
    assert.match(stdout, /quarantined_corrupt_store/);
    assert.match(stdout, /- strength=\d+\.\d{3}, type=feedback, source=explicit/);
    assert.match(stdout, /- evidence: .*promotion_absorbed_exact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory-diag trace prints lifecycle relations and redacts secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-trace-"));
  try {
    await writeWorkspaceStore(root, [
      { ...entry("mem-life", "Old token password: sushi should be redacted", "decision"), status: "superseded" as const },
      entry("mem-new", "Replacement memory", "decision"),
    ]);
    await appendEvidenceEvents(root, [
      evidence({ type: "extraction_candidate_accepted", phase: "extraction", outcome: "accepted", memory: { memoryId: "mem-life", type: "decision", source: "compaction" }, reasonCodes: ["quality_gate_passed"], textPreview: "password: sushi" }),
      evidence({ type: "pending_memory_appended", phase: "pending_journal", outcome: "accepted", memory: { memoryId: "mem-life", type: "decision", source: "compaction" }, relations: [{ role: "pending", memory: { memoryId: "mem-life" } }], reasonCodes: ["pending_journal_append"] }),
      evidence({ type: "promotion_promoted", phase: "promotion", outcome: "promoted", memory: { memoryId: "mem-life", type: "decision", source: "compaction" }, reasonCodes: ["new_workspace_entry"] }),
      evidence({ type: "memory_reinforced", phase: "reinforcement", outcome: "reinforced", memory: { memoryId: "mem-life", type: "decision", source: "compaction" }, relations: [{ role: "reinforced_by", memory: { memoryId: "mem-duplicate" } }], reasonCodes: ["duplicate_exact"] }),
      evidence({ type: "promotion_superseded", phase: "promotion", outcome: "superseded", memory: { memoryId: "mem-life", type: "decision", source: "compaction" }, relations: [{ role: "superseded_by", memory: { memoryId: "mem-new" } }], reasonCodes: ["superseded_existing"] }),
      evidence({ type: "render_omitted", phase: "render", outcome: "omitted", memory: { memoryId: "mem-life", type: "decision", source: "compaction" }, relations: [{ role: "omitted", memory: { memoryId: "mem-life" } }], reasonCodes: ["superseded"] }),
    ]);

    const stdout = await runMemoryDiag(["trace", "--workspace", root, "--memory", "mem-life"]);

    assert.match(stdout, /Memory mem-life: omitted_superseded/);
    assert.match(stdout, /Lifecycle:/);
    assert.match(stdout, /extraction_candidate_accepted: accepted; reasons=quality_gate_passed/);
    assert.match(stdout, /pending_memory_appended: accepted; reasons=pending_journal_append/);
    assert.match(stdout, /promotion_superseded: superseded; reasons=superseded_existing; .*superseded_by=mem-new/);
    assert.match(stdout, /memory_reinforced: reinforced; reasons=duplicate_exact; .*reinforced_by=mem-duplicate/);
    assert.match(stdout, /Superseded by:\n- mem-new/);
    assert.match(stdout, /Reinforced by:\n- mem-duplicate/);
    assert.ok(!stdout.includes("sushi"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory-diag trace requires --memory and reports unknown IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-trace-unknown-"));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, ["--experimental-strip-types", "scripts/memory-diag.ts", "trace", "--workspace", root], { cwd: repoRoot }),
      (error: unknown) => {
        const err = error as { code?: number; stderr?: string };
        assert.notEqual(err.code, 0);
        assert.match(err.stderr ?? "", /--memory requires an id/);
        assert.match(err.stderr ?? "", /Usage:/);
        return true;
      },
    );

    const stdout = await runMemoryDiag(["trace", "--workspace", root, "--memory", "missing-memory"]);
    assert.match(stdout, /Memory missing-memory: unknown/);
    assert.match(stdout, /Lifecycle:\n\(none\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function setupQualityFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-quality-"));
  const key = await workspaceKey(root);
  const now = new Date().toISOString();
  const entries = Array.from({ length: LONG_TERM_LIMITS.maxEntries }, (_, i) => ({
    ...entry(`quality-${i}`, `Quality fixture memory ${i}`, i % 2 === 0 ? "feedback" as const : "decision" as const),
    retentionClock: i === 0 ? -1 : Date.now(),
  }));
  await writeWorkspaceStore(root, entries);
  await appendEvidenceEvents(root, [
    evidence({ type: "promotion_promoted", phase: "promotion", outcome: "promoted", memory: { memoryId: "quality-1", type: "decision", source: "compaction" }, reasonCodes: ["new_workspace_entry"] }),
    evidence({ type: "promotion_promoted", phase: "promotion", outcome: "promoted", memory: { memoryId: "quality-historical", type: "reference", source: "compaction" }, reasonCodes: ["new_workspace_entry"] }),
  ]);
  await writeRejectionRecords([
    { timestamp: now, workspaceKey: key, workspaceRootHash: "hash", type: "decision", source: "compaction", text: "Implemented phase 2 and updated tests", reasons: ["bad_decision"] },
    { timestamp: now, type: "feedback", source: "compaction", text: "Wave 1 completed successfully", reasons: ["progress_snapshot", "bad_feedback"] },
  ]);
  return root;
}

test("quality human output includes summary and aggregate inspection counts", async () => {
  const root = await setupQualityFixture();
  try {
    const stdout = await runMemoryDiag(["quality", "--workspace", root]);

    assert.match(stdout, /Memory quality inspection/);
    assert.match(stdout, /Summary: Workspace memory quality is degraded:/);
    assert.match(stdout, /Caps:\n\s+active: 28 \/ 28/);
    assert.match(stdout, /decision: 14 \/ 10 FULL/);
    assert.match(stdout, /feedback: 14 \/ 10 FULL/);
    assert.match(stdout, /Retention clocks:\n\s+present: 27\n\s+missing: 0\n\s+invalid: 1/);
    assert.match(stdout, /Evidence:\n\s+current with evidence: 1\n\s+current without evidence: 27/);
    assert.match(stdout, /Rejection scoping:\n\s+total records: 2\n\s+workspace scoped: 1\n\s+legacy unscoped: 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quality --json includes summaryText, caps, retention, evidence, and rejections", async () => {
  const root = await setupQualityFixture();
  try {
    const stdout = await runMemoryDiag(["quality", "--workspace", root, "--json"]);
    const parsed = JSON.parse(stdout) as {
      summaryText: string;
      caps: { active: number; capsFull: boolean };
      retention: { invalid: number };
      evidence: { currentWithEvidence: number; unknownDisappearances: number };
      rejections: { workspaceScopedCount: number; legacyUnscopedCount: number };
    };

    assert.match(parsed.summaryText, /Workspace memory quality is degraded/);
    assert.equal(parsed.caps.active, LONG_TERM_LIMITS.maxEntries);
    assert.equal(parsed.caps.capsFull, true);
    assert.equal(parsed.retention.invalid, 1);
    assert.equal(parsed.evidence.currentWithEvidence, 1);
    assert.equal(parsed.evidence.unknownDisappearances, 1);
    assert.equal(parsed.rejections.workspaceScopedCount, 1);
    assert.equal(parsed.rejections.legacyUnscopedCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coverage human output includes class counts and per-memory rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-coverage-"));
  try {
    await writeWorkspaceStore(root, [
      entry("mem-full", "Full lifecycle memory", "feedback"),
      entry("mem-render-only", "Render only memory", "decision"),
      entry("mem-no-evidence", "No evidence memory", "project"),
    ]);
    await appendEvidenceEvents(root, [
      evidence({ type: "extraction_candidate_accepted", phase: "extraction", outcome: "accepted", memory: { memoryId: "mem-full", type: "feedback", source: "compaction" }, reasonCodes: ["quality_gate_passed"] }),
      evidence({ type: "promotion_promoted", phase: "promotion", outcome: "promoted", memory: { memoryId: "mem-full", type: "feedback", source: "compaction" }, reasonCodes: ["new_workspace_entry"] }),
      evidence({ type: "render_selected", phase: "render", outcome: "rendered", memory: { memoryId: "mem-render-only", type: "decision", source: "compaction" }, reasonCodes: ["within_caps"] }),
    ]);

    const stdout = await runMemoryDiag(["coverage", "--workspace", root]);

    assert.match(stdout, /Class counts:/);
    assert.match(stdout, /full_lifecycle: 1/);
    assert.match(stdout, /render_only: 1/);
    assert.match(stdout, /no_evidence: 1/);
    assert.match(stdout, /Per-memory rows:/);
    assert.match(stdout, /mem-full full_lifecycle .*extraction=1 promotion=1/);
    assert.match(stdout, /mem-render-only render_only .*render=1/);
    assert.match(stdout, /mem-no-evidence no_evidence .*total=0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coverage --json includes event counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-coverage-json-"));
  try {
    await writeWorkspaceStore(root, [entry("mem-full", "Full lifecycle memory", "feedback")]);
    await appendEvidenceEvents(root, [
      evidence({ type: "promotion_promoted", phase: "promotion", outcome: "promoted", memory: { memoryId: "mem-full", type: "feedback", source: "compaction" }, reasonCodes: ["new_workspace_entry"] }),
    ]);

    const stdout = await runMemoryDiag(["coverage", "--workspace", root, "--json"]);
    const parsed = JSON.parse(stdout) as { memories: Array<{ id: string; eventCounts: { total: number; byType: Record<string, number> } }> };
    const row = parsed.memories.find(memory => memory.id === "mem-full");

    assert.equal(row?.eventCounts.total, 1);
    assert.equal(row?.eventCounts.byType.promotion_promoted, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disappearances labels historical evidence-only memory unknown without terminal event", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-disappear-"));
  try {
    await writeWorkspaceStore(root, [entry("current", "Current memory", "feedback")]);
    await appendEvidenceEvents(root, [
      evidence({ type: "promotion_promoted", phase: "promotion", outcome: "promoted", memory: { memoryId: "historical-unknown", type: "decision", source: "compaction" }, reasonCodes: ["new_workspace_entry"] }),
    ]);

    const stdout = await runMemoryDiag(["disappearances", "--workspace", root]);

    assert.match(stdout, /Memory historical-unknown: historical_absent_unknown_reason terminal=unknown/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disappearances --explain shows capacity details and render omitted type-cap observations", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-disappear-explain-"));
  try {
    await writeWorkspaceStore(root, [entry("current", "Current memory", "feedback")]);
    await appendEvidenceEvents(root, [
      evidence({
        type: "memory_removed_capacity",
        phase: "storage",
        outcome: "removed",
        memory: { memoryId: "capacity-loser", type: "decision", source: "compaction", status: "active" },
        relations: [{ role: "removed", memory: { memoryId: "capacity-loser", type: "decision", source: "compaction", status: "active" } }],
        reasonCodes: ["type_cap"],
        details: { type: "decision", globalCap: 28, typeCap: 10, source: "compaction" },
      }),
      evidence({ type: "render_omitted", phase: "render", outcome: "omitted", memory: { memoryId: "render-loser", type: "feedback", source: "compaction" }, reasonCodes: ["type_cap"] }),
    ]);

    const stdout = await runMemoryDiag(["disappearances", "--workspace", root, "--explain"]);

    assert.match(stdout, /capacity-loser: historical_absent_with_reason terminal=memory_removed_capacity reasons=type_cap/);
    assert.match(stdout, /memory_removed_capacity details: .*globalCap=28 .*typeCap=10/);
    assert.match(stdout, /render-loser: historical_absent_with_reason terminal=render_omitted reasons=type_cap/);
    assert.match(stdout, /render_omitted type-cap observation: reasons=type_cap/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejections --quality --reason bad_decision --unique groups architecture-like samples heuristically", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-rejections-quality-"));
  try {
    const key = await workspaceKey(root);
    const now = new Date().toISOString();
    await writeRejectionRecords([
      { timestamp: now, workspaceKey: key, type: "decision", source: "compaction", text: "Retention scoring model uses evidence caps to avoid normalization drift", reasons: ["bad_decision"] },
      { timestamp: now, workspaceKey: key, type: "decision", source: "compaction", text: "Implemented phase 2 and updated tests", reasons: ["bad_decision"] },
      { timestamp: now, type: "decision", source: "compaction", text: "Maybe useful", reasons: ["bad_decision"] },
    ]);

    const stdout = await runMemoryDiag(["rejections", "--quality", "--workspace", root, "--reason", "bad_decision", "--unique"]);

    assert.match(stdout, /Possible false-positive grouping is heuristic, not deterministic truth/);
    assert.match(stdout, /architecture_like_possible_false_positive: 1/);
    assert.match(stdout, /clearly_garbage: 1/);
    assert.match(stdout, /ambiguous: 1/);
    assert.doesNotMatch(stdout, /deterministic truth\s*:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejections --quality --json includes scoping, unique reasons, and possible false-positive groups", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-rejections-json-"));
  try {
    const key = await workspaceKey(root);
    const now = new Date().toISOString();
    await writeRejectionRecords([
      { timestamp: now, workspaceKey: key, workspaceRootHash: "hash", type: "decision", source: "compaction", text: "Memory system schema boundary should remain stable", reasons: ["bad_decision"] },
      { timestamp: now, type: "feedback", source: "compaction", text: "Wave 1 completed successfully", reasons: ["progress_snapshot", "bad_feedback"] },
    ]);

    const stdout = await runMemoryDiag(["rejections", "--quality", "--workspace", root, "--json"]);
    const parsed = JSON.parse(stdout) as {
      workspaceScopedCount: number;
      legacyUnscopedCount: number;
      uniqueReasonDistribution: Record<string, number>;
      possibleFalsePositiveGroups: Record<string, { count: number }>;
    };

    assert.equal(parsed.workspaceScopedCount, 1);
    assert.equal(parsed.legacyUnscopedCount, 1);
    assert.equal(parsed.uniqueReasonDistribution.bad_decision, 1);
    assert.equal(parsed.possibleFalsePositiveGroups.architecture_like_possible_false_positive.count, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
