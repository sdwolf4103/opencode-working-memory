import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvidenceEvents, queryEvidenceEvents, summarizeMemoryEvidence, type EvidenceEventInput, type EvidenceEventV1 } from "../src/evidence-log.ts";
import { groupEvidenceByMemoryId } from "../scripts/memory-diag/evidence-model.ts";
import { retentionCandidatesForDiag } from "../scripts/memory-diag/retention-model.ts";
import { buildMemoryDiagJSON, memoryDiagJSONFromSnapshot, normalizedJournal, normalizedStore, snapshotForOptions } from "../scripts/memory-diag/workspace-snapshot.ts";
import { workspaceKey, workspaceMemoryPath, workspacePendingJournalPath } from "../src/paths.ts";
import { LONG_TERM_LIMITS, type LongTermMemoryEntry, type PendingMemoryJournalStore, type WorkspaceMemoryStore } from "../src/types.ts";

function entry(id: string, text: string, type: LongTermMemoryEntry["type"]): LongTermMemoryEntry {
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  return {
    id,
    type,
    text,
    source: "compaction",
    confidence: 0.75,
    status: "active",
    createdAt: now,
    updatedAt: now,
    retentionClock: new Date(now).getTime(),
  };
}

function evidence(overrides: Partial<EvidenceEventInput>): EvidenceEventInput {
  return {
    type: "promotion_promoted",
    phase: "promotion",
    outcome: "promoted",
    memory: { memoryId: "mem-active", type: "decision", source: "compaction", status: "active" },
    reasonCodes: ["new_workspace_entry"],
    ...overrides,
  };
}

function groupedEvidenceSummary(grouped: Map<string, EvidenceEventV1[]>, memoryId: string): { eventIds: string[]; reasonCodes: string[] } {
  const events = grouped.get(memoryId) ?? [];
  const reasonCodes = new Set<string>();
  for (const event of events) {
    for (const reason of event.reasonCodes) reasonCodes.add(reason);
  }
  return {
    eventIds: events.map(event => event.eventId),
    reasonCodes: [...reasonCodes],
  };
}

async function writeWorkspaceStore(root: string, entries: LongTermMemoryEntry[]): Promise<void> {
  const key = await workspaceKey(root);
  const path = await workspaceMemoryPath(root);
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root, key },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    entries,
    migrations: [],
    updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2), "utf8");
}

async function writePendingJournal(root: string, entries: LongTermMemoryEntry[]): Promise<void> {
  const key = await workspaceKey(root);
  const path = await workspacePendingJournalPath(root);
  const store: PendingMemoryJournalStore = {
    version: 1,
    workspace: { root, key },
    entries,
    updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2), "utf8");
}

test("normalizedStore returns an empty store with limits and empty arrays", () => {
  const store = normalizedStore(null, "/tmp/example-workspace", "workspace-key");

  assert.equal(store.version, 1);
  assert.deepEqual(store.workspace, { root: "/tmp/example-workspace", key: "workspace-key" });
  assert.deepEqual(store.limits, { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries });
  assert.deepEqual(store.entries, []);
  assert.deepEqual(store.migrations, []);
});

test("normalizedJournal returns an empty journal", () => {
  const journal = normalizedJournal(null);

  assert.equal(journal.version, 1);
  assert.deepEqual(journal.workspace, { root: "", key: "" });
  assert.deepEqual(journal.entries, []);
  assert.equal(journal.updatedAt, new Date(0).toISOString());
});

test("retentionCandidatesForDiag separates rendered, type-capped, and global-capped entries", () => {
  const entries: LongTermMemoryEntry[] = [
    ...Array.from({ length: 11 }, (_, i) => entry(`feedback-${String(i).padStart(2, "0")}`, `Feedback memory ${i}`, "feedback")),
    ...Array.from({ length: 10 }, (_, i) => entry(`decision-${String(i).padStart(2, "0")}`, `Decision memory ${i}`, "decision")),
    ...Array.from({ length: 8 }, (_, i) => entry(`project-${String(i).padStart(2, "0")}`, `Project memory ${i}`, "project")),
    ...Array.from({ length: 6 }, (_, i) => entry(`reference-${String(i).padStart(2, "0")}`, `Reference memory ${i}`, "reference")),
  ];
  const store = normalizedStore({ entries, workspace: { root: "/tmp/root", key: "key" } } as WorkspaceMemoryStore, "/tmp/root", "key");

  const candidates = retentionCandidatesForDiag(store, new Date("2026-01-02T00:00:00.000Z").getTime());

  assert.equal(candidates.rendered.length, LONG_TERM_LIMITS.maxEntries);
  assert.equal(candidates.typeCapped.length, 1);
  assert.equal(candidates.globalCapped.length, 6);
  assert.equal(candidates.typeCapped[0].entry.type, "feedback");
});

test("buildMemoryDiagJSON redacts previews, includes pending entries, and preserves summary fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-workspace-model-"));
  try {
    const active = entry("mem-active", "Remember password: sushi and file /Users/alice/private.txt", "decision");
    const pending = { ...entry("mem-pending", "Pending api_key=secret-value", "project"), promotionAttempts: 1 };
    await writeWorkspaceStore(root, [active]);
    await writePendingJournal(root, [pending]);

    const diag = await buildMemoryDiagJSON(root);

    assert.equal(diag.version, 1);
    assert.equal(diag.summary.storedActive, 1);
    assert.equal(diag.summary.rendered, 1);
    assert.equal(diag.summary.pending, 1);
    assert.equal(diag.summary.rejectedLast7Days, 0);
    assert.equal(diag.summary.corruptStoresQuarantinedLast30Days, 0);
    assert.equal(diag.memories.length, 2);
    assert.equal(diag.memories.find(memory => memory.id === "mem-pending")?.status, "pending_retry");
    assert.ok(diag.memories.some(memory => memory.textPreview?.includes("[REDACTED]")));
    assert.ok(diag.memories.some(memory => memory.textPreview?.includes("<path>")));
    assert.ok(!JSON.stringify(diag).includes("sushi"));
    assert.ok(!JSON.stringify(diag).includes("secret-value"));
    assert.equal(diag.workspace.key, await workspaceKey(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memoryDiagJSONFromSnapshot serializes an existing snapshot with fixed generatedAt", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-snapshot-json-"));
  try {
    const active = entry("mem-active", "Stable decision memory", "decision");
    const pending = { ...entry("mem-pending", "Pending project memory", "project"), promotionAttempts: 1 };
    await writeWorkspaceStore(root, [active]);
    await writePendingJournal(root, [pending]);

    const snapshot = await snapshotForOptions({ raw: false, workspace: root });
    const generatedAt = "2026-05-02T00:00:00.000Z";
    const diag = memoryDiagJSONFromSnapshot(root, snapshot, generatedAt);

    assert.equal(diag.version, 1);
    assert.equal(diag.generatedAt, generatedAt);
    assert.equal(diag.memories, snapshot.memories);
    assert.equal(diag.recentEvents, snapshot.recentEvents);
    assert.equal(diag.summary, snapshot.summary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grouped evidence summaries match per-memory summaries for stored pending and absorbed memories", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-evidence-equivalence-"));
  try {
    const active = entry("mem-active", "Stable decision memory", "decision");
    const pending = { ...entry("mem-pending", "Pending project memory", "project"), promotionAttempts: 1 };
    await writeWorkspaceStore(root, [active]);
    await writePendingJournal(root, [pending]);
    await appendEvidenceEvents(root, [
      evidence({ memory: { memoryId: "mem-active", type: "decision", source: "compaction", status: "active" }, reasonCodes: ["stored_reason"] }),
      evidence({ type: "pending_memory_appended", phase: "pending_journal", outcome: "accepted", memory: { memoryId: "mem-pending", type: "project", source: "compaction" }, reasonCodes: ["pending_reason"] }),
      evidence({ type: "promotion_absorbed_exact", phase: "promotion", outcome: "absorbed", memory: { memoryId: "mem-absorbed", type: "feedback", source: "compaction" }, reasonCodes: ["same_exact_key"] }),
    ]);

    const grouped = groupEvidenceByMemoryId(await queryEvidenceEvents(root));
    for (const id of ["mem-active", "mem-pending", "mem-absorbed"]) {
      const oldSummary = await summarizeMemoryEvidence(root, { memoryId: id });
      const groupedSummary = groupedEvidenceSummary(grouped, id);

      assert.deepEqual(groupedSummary.eventIds, oldSummary.eventIds);
      assert.deepEqual(groupedSummary.reasonCodes, oldSummary.reasonCodes);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildMemoryDiagJSON preserves evidence ids and reason codes for stored pending and absorbed memories", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-evidence-rows-"));
  try {
    const active = entry("mem-active", "Stable decision memory", "decision");
    const pending = { ...entry("mem-pending", "Pending project memory", "project"), promotionAttempts: 1 };
    await writeWorkspaceStore(root, [active]);
    await writePendingJournal(root, [pending]);
    const events = await appendEvidenceEvents(root, [
      evidence({ memory: { memoryId: "mem-active", type: "decision", source: "compaction", status: "active" }, reasonCodes: ["stored_reason"] }),
      evidence({ type: "pending_memory_appended", phase: "pending_journal", outcome: "accepted", memory: { memoryId: "mem-pending", type: "project", source: "compaction" }, reasonCodes: ["pending_reason"] }),
      evidence({ type: "promotion_absorbed_exact", phase: "promotion", outcome: "absorbed", memory: { memoryId: "mem-absorbed", type: "feedback", source: "compaction" }, reasonCodes: ["same_exact_key"] }),
    ]);

    const diag = await buildMemoryDiagJSON(root);
    const activeRow = diag.memories.find(memory => memory.id === "mem-active");
    const pendingRow = diag.memories.find(memory => memory.id === "mem-pending");
    const absorbedRow = diag.memories.find(memory => memory.id === "mem-absorbed");

    assert.ok(activeRow);
    assert.ok(pendingRow);
    assert.ok(absorbedRow);
    assert.deepEqual(activeRow.evidenceEventIds, [events[0].eventId]);
    assert.ok(activeRow.reasonCodes.includes("stored_reason"));
    assert.deepEqual(pendingRow.evidenceEventIds, [events[1].eventId]);
    assert.ok(pendingRow.reasonCodes.includes("pending_reason"));
    assert.deepEqual(absorbedRow.evidenceEventIds, [events[2].eventId]);
    assert.ok(absorbedRow.reasonCodes.includes("same_exact_key"));
    assert.ok(absorbedRow.reasonCodes.includes("absorbed_duplicate"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
