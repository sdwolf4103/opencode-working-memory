import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryV2Plugin } from "../src/plugin.ts";
import { queryEvidenceEvents } from "../src/evidence-log.ts";
import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "../src/types.ts";
import {
  appendMemoryReviewDecisionEvidence,
  applyMemoryReviewProposalBatch,
  captureMemoryReviewProposalText,
  createMemoryReviewDecisionRecord,
  createMemoryReviewSnapshot,
  dryRunMemoryReviewProposalSet,
  loadMemoryReviewProposalSet,
  memoryReviewBatchFailureEvidence,
  MEMORY_REVIEW_PROPOSAL_SET_KIND,
  parseMemoryReviewProposalText,
  planMemoryReviewBatchApply,
  sealMemoryReviewProposalSet,
  saveMemoryReviewSnapshot,
  validateMemoryReviewUserEdit,
  validateMemoryReviewProposalSet,
} from "../src/memory-review.ts";
import { loadWorkspaceMemory, saveWorkspaceMemory } from "../src/workspace-memory.ts";
import { runMemoryReview } from "../scripts/memory-diag/commands/memory-review.ts";

async function textCompleteHook(): Promise<(
  input: { sessionID: string; messageID: string; partID: string },
  output: { text: string },
) => Promise<{ text: string; detected: boolean; proposalBlockCount: number }>> {
  const plugin = await MemoryV2Plugin({
    directory: "/tmp/memory-review-probe-test",
    client: {
      session: {
        get: async () => ({ data: { parentID: null } }),
      },
    },
  } as any);

  const hook = plugin["experimental.text.complete"];
  assert.equal(typeof hook, "function");
  return hook as any;
}

function proposalFence(snapshotId = "snapshot_probe"): string {
  return [
    "Review complete.",
    "",
    "```memory-review-proposals",
    JSON.stringify({
      version: 1,
      kind: MEMORY_REVIEW_PROPOSAL_SET_KIND,
      id: "proposal_set_probe",
      snapshotId,
      proposals: [],
    }),
    "```",
    "",
    "No changes are applied.",
  ].join("\n");
}

function memory(id: string, text: string, overrides: Partial<LongTermMemoryEntry> = {}): LongTermMemoryEntry {
  const now = "2026-06-16T00:00:00.000Z";
  return {
    id,
    type: "decision",
    text,
    source: "compaction",
    confidence: 0.8,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function store(entries: LongTermMemoryEntry[]): WorkspaceMemoryStore {
  return {
    version: 1,
    workspace: { root: "/tmp/memory-review", key: "workspace-key" },
    limits: { maxRenderedChars: 3600, maxEntries: 28 },
    entries,
    migrations: [],
    updatedAt: "2026-06-16T00:00:00.000Z",
  };
}

function proposalSet(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: MEMORY_REVIEW_PROPOSAL_SET_KIND,
    id: "proposal_set_1",
    snapshotId: "snapshot_1",
    createdAt: "2026-06-16T00:00:00.000Z",
    source: "assistant_memory_review",
    status: "sealed",
    sealed: true,
    proposals: [
      {
        id: "proposal_1",
        action: "update",
        targets: ["M1"],
        proposedType: "decision",
        proposedText: "Use the typed memory review model for future review operations.",
        evidenceRefs: ["E1"],
        risk: "low",
        rationale: "The current memory is vague.",
        futureValue: "Future sessions know which model to use.",
        temporaryStateCheck: "This is a durable architecture preference, not current progress.",
      },
    ],
    ...overrides,
  };
}

function fencedProposalSet(input: unknown): string {
  return [
    "Assistant prose before the proposal.",
    "```memory-review-proposals",
    JSON.stringify(input),
    "```",
    "Assistant prose after the proposal.",
  ].join("\n");
}

test("memory review text.complete probe returns assistant text unchanged and detects proposal fence", async () => {
  const hook = await textCompleteHook();
  const text = proposalFence();
  const output = { text };

  const result = await hook({ sessionID: "ses_1", messageID: "msg_1", partID: "part_fenced" }, output);

  assert.equal(result.text, text);
  assert.equal(output.text, text);
  assert.equal(result.detected, true);
  assert.equal(result.proposalBlockCount, 1);
});

test("memory review text.complete probe ignores text without dedicated proposal fence", async () => {
  const hook = await textCompleteHook();
  const text = "The snapshot ID is snapshot_probe, but this is ordinary assistant text.";
  const output = { text };

  const result = await hook({ sessionID: "ses_1", messageID: "msg_1", partID: "part_plain" }, output);

  assert.equal(result.text, text);
  assert.equal(output.text, text);
  assert.equal(result.detected, false);
  assert.equal(result.proposalBlockCount, 0);
});

test("memory review text.complete probe ignores non-dedicated fenced JSON", async () => {
  const hook = await textCompleteHook();
  const text = [
    "```json",
    JSON.stringify({ kind: MEMORY_REVIEW_PROPOSAL_SET_KIND, snapshotId: "snapshot_probe", proposals: [] }),
    "```",
  ].join("\n");
  const output = { text };

  const result = await hook({ sessionID: "ses_1", messageID: "msg_1", partID: "part_json" }, output);

  assert.equal(result.text, text);
  assert.equal(output.text, text);
  assert.equal(result.detected, false);
  assert.equal(result.proposalBlockCount, 0);
});

test("memory review text.complete probe handles multi-part assistant text by detecting only the fenced part", async () => {
  const hook = await textCompleteHook();
  const plainOutput = { text: "Part 1: analysis and normal prose without a proposal fence." };
  const fencedOutput = { text: proposalFence("snapshot_part_2") };

  const plainResult = await hook({ sessionID: "ses_1", messageID: "msg_1", partID: "part_plain" }, plainOutput);
  const fencedResult = await hook({ sessionID: "ses_1", messageID: "msg_1", partID: "part_fenced" }, fencedOutput);

  assert.equal(plainResult.text, plainOutput.text);
  assert.equal(plainResult.detected, false);
  assert.equal(plainResult.proposalBlockCount, 0);
  assert.equal(fencedResult.text, fencedOutput.text);
  assert.equal(fencedResult.detected, true);
  assert.equal(fencedResult.proposalBlockCount, 1);
});

test("memory review snapshot assigns stable refs and key metadata for active memories", () => {
  const snapshot = createMemoryReviewSnapshot(store([
    memory("mem_decision", "Use typed review proposals.", { type: "decision" }),
    memory("mem_reference", "Docs live in `docs/plan-memory-review.md`.", { type: "reference" }),
    memory("mem_old", "Superseded memory is excluded.", { status: "superseded" }),
  ]), {
    id: "snapshot_1",
    createdAt: "2026-06-16T00:00:00.000Z",
  });

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.kind, "opencode_working_memory_review_snapshot");
  assert.equal(snapshot.id, "snapshot_1");
  assert.deepEqual(snapshot.memories.map(item => item.ref), ["M1", "M2"]);
  assert.deepEqual(snapshot.memories.map(item => item.memoryId), ["mem_decision", "mem_reference"]);
  assert.ok(snapshot.memories.every(item => item.status === "active"));
  assert.ok(snapshot.memories.every(item => item.exactKey.includes(":")));
  assert.ok(snapshot.memories.every(item => item.identityKey.includes(":")));
  assert.equal(snapshot.renderAccounting.rendered, 2);
  assert.equal(snapshot.renderAccounting.omitted.some(item => item.reason === "superseded" && item.memoryId === "mem_old"), true);
});

test("memory review proposal validation accepts sealed valid proposal sets", () => {
  const snapshot = createMemoryReviewSnapshot(store([memory("mem_1", "Old typed model note.")]), { id: "snapshot_1" });
  const result = validateMemoryReviewProposalSet(proposalSet(), snapshot);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("memory review proposal validation rejects wrong kind and mutable proposal sets", () => {
  const snapshot = createMemoryReviewSnapshot(store([memory("mem_1", "Old typed model note.")]), { id: "snapshot_1" });

  assert.deepEqual(
    validateMemoryReviewProposalSet(proposalSet({ kind: "wrong_kind" }), snapshot).errors.map(error => error.code),
    ["missing_proposal_kind"],
  );
  assert.deepEqual(
    validateMemoryReviewProposalSet(proposalSet({ sealed: false, status: "draft" }), snapshot).errors.map(error => error.code),
    ["proposal_set_unsealed"],
  );
});

test("memory review proposal validation rejects action-specific invalid proposals", () => {
  const snapshot = createMemoryReviewSnapshot(store([
    memory("mem_1", "First target."),
    memory("mem_2", "Second target."),
  ]), { id: "snapshot_1" });

  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ["forget replacement", { action: "forget", targets: ["M1"], proposedText: "replacement" }, ["forget_has_replacement"]],
    ["forget missing target", { action: "forget", targets: [] }, ["missing_target"]],
    ["update multiple targets", { action: "update", targets: ["M1", "M2"], proposedText: "replacement" }, ["update_target_count"]],
    ["update missing text", { action: "update", targets: ["M1"], proposedText: "" }, ["missing_proposed_text"]],
    ["consolidate one target", { action: "consolidate", targets: ["M1"], proposedText: "replacement", targetQuotes: ["First target."] }, ["consolidate_target_count"]],
    ["consolidate missing quotes", { action: "consolidate", targets: ["M1", "M2"], proposedText: "replacement", targetQuotes: ["First target."] }, ["missing_target_quotes"]],
    ["unknown action", { action: "split", targets: ["M1"] }, ["unknown_action"]],
    ["invalid proposed type", { proposedType: "invalid" }, ["invalid_proposed_type"]],
    ["null proposed type", { proposedType: null }, ["invalid_proposed_type"]],
    ["non-string proposed type", { proposedType: 42 }, ["invalid_proposed_type"]],
    ["explicitly undefined proposed type", { proposedType: undefined }, ["invalid_proposed_type"]],
  ];

  for (const [name, proposalOverrides, expectedCodes] of cases) {
    const set = proposalSet({ proposals: [{ ...(proposalSet().proposals[0] as any), ...proposalOverrides }] });
    const codes = validateMemoryReviewProposalSet(set, snapshot).errors.map(error => error.code);
    for (const expectedCode of expectedCodes) {
      assert.ok(codes.includes(expectedCode), `${name} should include ${expectedCode}; got ${codes.join(", ")}`);
    }
  }
});

test("memory review explicitly rejects deferred split promote and keep actions", () => {
  const workspaceStore = store([memory("mem_1", "Old typed model note.")]);
  const snapshot = createMemoryReviewSnapshot(workspaceStore, { id: "snapshot_1" });
  const deferredActions = ["split", "promote", "keep"] as const;

  for (const action of deferredActions) {
    const set = proposalSet({
      proposals: [{
        ...(proposalSet().proposals[0] as any),
        id: `proposal_${action}`,
        action,
        targets: ["M1"],
      }],
    });

    const validation = validateMemoryReviewProposalSet(set, snapshot);
    assert.equal(validation.valid, false, `${action} should be unsupported until real usage proves it is needed`);
    assert.deepEqual(validation.errors.map(error => error.code), ["unknown_action"]);

    const dryRun = dryRunMemoryReviewProposalSet(set, snapshot);
    assert.equal(dryRun.valid, false);
    assert.deepEqual(dryRun.operations, []);

    const plan = planMemoryReviewBatchApply(set, snapshot, workspaceStore, { proposalIds: [`proposal_${action}`] });
    assert.equal(plan.valid, false);
    assert.deepEqual(plan.operations, []);
    assert.deepEqual(workspaceStore.entries.map(entry => ({ id: entry.id, status: entry.status })), [{ id: "mem_1", status: "active" }]);
  }
});

test("memory review proposal validation rejects missing rationale risk and more than six proposals", () => {
  const snapshot = createMemoryReviewSnapshot(store([memory("mem_1", "Old typed model note.")]), { id: "snapshot_1" });
  const baseProposal = proposalSet().proposals[0] as Record<string, unknown>;

  const missingFields = proposalSet({ proposals: [{ ...baseProposal, risk: "urgent", rationale: "" }] });
  assert.deepEqual(validateMemoryReviewProposalSet(missingFields, snapshot).errors.map(error => error.code), ["missing_risk", "missing_rationale"]);

  const tooMany = proposalSet({
    proposals: Array.from({ length: 7 }, (_, index) => ({ ...baseProposal, id: `proposal_${index + 1}` })),
  });
  assert.deepEqual(validateMemoryReviewProposalSet(tooMany, snapshot).errors.map(error => error.code), ["too_many_proposals"]);
});

test("sealed memory review proposal sets are immutable at the object boundary", () => {
  const sealed = sealMemoryReviewProposalSet(proposalSet());

  assert.equal(Object.isFrozen(sealed), true);
  assert.equal(Object.isFrozen(sealed.proposals), true);
  assert.equal(Object.isFrozen(sealed.proposals[0]), true);
  assert.throws(() => { (sealed as any).status = "draft"; }, TypeError);
  assert.equal(sealed.status, "sealed");
});

test("memory review dry-run describes intended operations without mutating workspace memory", () => {
  const entry1 = memory("mem_1", "Old typed model note.");
  const entry2 = memory("mem_2", "Duplicate model note.");
  const workspaceStore = store([entry1, entry2]);
  const snapshot = createMemoryReviewSnapshot(workspaceStore, { id: "snapshot_1" });
  const set = proposalSet({
    proposals: [
      { ...(proposalSet().proposals[0] as any), id: "proposal_update", action: "update", targets: ["M1"], proposedText: "Use typed review model helpers." },
      { ...(proposalSet().proposals[0] as any), id: "proposal_forget", action: "forget", targets: ["M2"], proposedText: undefined },
    ],
  });

  const dryRun = dryRunMemoryReviewProposalSet(set, snapshot);

  assert.equal(dryRun.valid, true);
  assert.deepEqual(dryRun.operations.map(operation => operation.kind), ["supersede_and_add", "supersede"]);
  assert.deepEqual(dryRun.operations[0].targetMemoryIds, ["mem_1"]);
  assert.equal(dryRun.operations[0].replacement?.text, "Use typed review model helpers.");
  assert.deepEqual(dryRun.operations[1].targetRefs, ["M2"]);
  assert.equal(workspaceStore.entries[0].text, "Old typed model note.");
  assert.equal(workspaceStore.entries[0].status, "active");
});

test("memory review decision records are separate append-only log entries", () => {
  const record = createMemoryReviewDecisionRecord({
    proposalSetId: "proposal_set_1",
    proposalId: "proposal_1",
    decision: "selected",
    createdAt: "2026-06-16T00:00:00.000Z",
    note: "User selected for later dry-run.",
  });

  assert.deepEqual(record, {
    version: 1,
    kind: "opencode_working_memory_review_decision",
    proposalSetId: "proposal_set_1",
    proposalId: "proposal_1",
    decision: "selected",
    createdAt: "2026-06-16T00:00:00.000Z",
    note: "User selected for later dry-run.",
  });
});

test("memory review parser accepts only valid dedicated fenced proposal JSON", () => {
  const parsed = parseMemoryReviewProposalText(fencedProposalSet(proposalSet()));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.proposalSet?.id, "proposal_set_1");

  assert.deepEqual(parseMemoryReviewProposalText(JSON.stringify(proposalSet())).reasonCodes, ["missing_proposal_fence"]);
  assert.deepEqual(parseMemoryReviewProposalText("```json\n{}\n```").reasonCodes, ["missing_proposal_fence"]);
  assert.deepEqual(parseMemoryReviewProposalText("```memory-review-proposals\n{bad json\n```").reasonCodes, ["malformed_proposal_json"]);
  assert.deepEqual(parseMemoryReviewProposalText(fencedProposalSet({ ...proposalSet(), kind: "wrong" })).reasonCodes, ["missing_proposal_kind"]);
  assert.deepEqual(parseMemoryReviewProposalText(`${fencedProposalSet(proposalSet())}\n${fencedProposalSet(proposalSet({ id: "proposal_set_2" }))}`).reasonCodes, ["multiple_proposal_fences"]);
  assert.deepEqual(parseMemoryReviewProposalText(`${fencedProposalSet(proposalSet())}\n\n\`\`\`memory-review-proposals\n{bad json\n\`\`\``).reasonCodes, ["multiple_proposal_fences"]);
});

test("memory review capture stores one sealed proposal set and never changes assistant text", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-review-capture-"));
  try {
    const snapshot = createMemoryReviewSnapshot(store([memory("mem_1", "Old typed model note.")]), { id: "snapshot_1" });
    await saveMemoryReviewSnapshot(root, snapshot);
    const text = fencedProposalSet(proposalSet());

    const result = await captureMemoryReviewProposalText(root, text, {
      source: "hook",
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "part_1",
    });

    assert.equal(result.text, text);
    assert.equal(result.status, "captured");
    assert.equal(result.proposalSetId, "proposal_set_1");
    const stored = await loadMemoryReviewProposalSet(root, "proposal_set_1");
    assert.equal(stored?.status, "sealed");
    assert.equal(stored?.sealed, true);

    const overwrite = await captureMemoryReviewProposalText(root, fencedProposalSet(proposalSet({ id: "proposal_set_2" })), {
      source: "hook",
      sessionID: "ses_1",
      messageID: "msg_2",
      partID: "part_1",
    });
    assert.equal(overwrite.text, fencedProposalSet(proposalSet({ id: "proposal_set_2" })));
    assert.equal(overwrite.status, "ignored");
    assert.deepEqual(overwrite.reasonCodes, ["capture_already_sealed"]);
    assert.equal((await loadMemoryReviewProposalSet(root, "proposal_set_1"))?.id, "proposal_set_1");
    assert.equal(await loadMemoryReviewProposalSet(root, "proposal_set_2"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory review hook capture ignores text without active matching snapshot while preserving text", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-review-hook-missing-snapshot-"));
  try {
    const plugin = await MemoryV2Plugin({
      directory: root,
      client: { session: { get: async () => ({ data: { parentID: null } }) } },
    } as any);
    const hook = plugin["experimental.text.complete"] as any;
    const text = fencedProposalSet(proposalSet({ snapshotId: "missing_snapshot" }));
    const output = { text };

    const result = await hook({ sessionID: "ses_1", messageID: "msg_1", partID: "part_1" }, output);

    assert.equal(output.text, text);
    assert.equal(result.text, text);
    assert.equal(result.detected, true);
    assert.equal(result.status, "ignored");
    assert.deepEqual(result.reasonCodes, ["capture_snapshot_missing"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory review capture rejects snapshot mismatch unknown targets and duplicate targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-review-capture-invalid-"));
  try {
    const snapshot = createMemoryReviewSnapshot(store([memory("mem_1", "Old typed model note.")]), { id: "snapshot_1" });
    await saveMemoryReviewSnapshot(root, snapshot);

    const mismatch = await captureMemoryReviewProposalText(root, fencedProposalSet(proposalSet({ snapshotId: "snapshot_2" })), { source: "cli_import" });
    assert.equal(mismatch.status, "ignored");
    assert.deepEqual(mismatch.reasonCodes, ["capture_snapshot_missing"]);

    const unknownTarget = proposalSet({ proposals: [{ ...(proposalSet().proposals[0] as any), targets: ["M9"] }] });
    const unknown = await captureMemoryReviewProposalText(root, fencedProposalSet(unknownTarget), { source: "cli_import" });
    assert.equal(unknown.status, "rejected");
    assert.ok(unknown.reasonCodes.includes("missing_target"));

    const duplicateTarget = proposalSet({ proposals: [{ ...(proposalSet().proposals[0] as any), targets: ["M1", "M1"] }] });
    const duplicate = await captureMemoryReviewProposalText(root, fencedProposalSet(duplicateTarget), { source: "cli_import" });
    assert.equal(duplicate.status, "rejected");
    assert.ok(duplicate.reasonCodes.includes("duplicate_target"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory review capture rejects deferred split promote and keep actions", async () => {
  for (const action of ["split", "promote", "keep"] as const) {
    const root = await mkdtemp(join(tmpdir(), `memory-review-deferred-${action}-`));
    try {
      const snapshot = createMemoryReviewSnapshot(store([memory("mem_1", "Old typed model note.")]), { id: "snapshot_1" });
      await saveMemoryReviewSnapshot(root, snapshot);
      const set = proposalSet({
        id: `proposal_set_${action}`,
        proposals: [{
          ...(proposalSet().proposals[0] as any),
          id: `proposal_${action}`,
          action,
          targets: ["M1"],
        }],
      });

      const result = await captureMemoryReviewProposalText(root, fencedProposalSet(set), { source: "cli_import" });

      assert.equal(result.status, "rejected", `${action} capture should be rejected`);
      assert.deepEqual(result.reasonCodes, ["unknown_action"]);
      assert.equal(await loadMemoryReviewProposalSet(root, `proposal_set_${action}`), null);

      const events = await queryEvidenceEvents(root, { types: ["memory_review_proposal_rejected"] });
      assert.equal(events.length, 1);
      assert.deepEqual(events[0].reasonCodes, ["unknown_action"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("memory review CLI import fallback uses the shared capture path", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-review-cli-import-"));
  try {
    const snapshot = createMemoryReviewSnapshot(store([memory("mem_1", "Old typed model note.")]), { id: "snapshot_1" });
    await saveMemoryReviewSnapshot(root, snapshot);
    const importFile = join(root, "proposal.md");
    await writeFile(importFile, fencedProposalSet(proposalSet()), "utf8");

    const result = await runMemoryReview({ raw: false, workspace: root, positional: ["import", importFile] });

    assert.equal(result.exitCode ?? 0, 0);
    assert.match(result.stdout, /captured proposal_set_1/);
    assert.equal((await loadMemoryReviewProposalSet(root, "proposal_set_1"))?.snapshotId, "snapshot_1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory review CLI import rejects deferred later actions", async () => {
  for (const action of ["split", "promote", "keep"] as const) {
    const root = await mkdtemp(join(tmpdir(), `memory-review-cli-deferred-${action}-`));
    try {
      const snapshot = createMemoryReviewSnapshot(store([memory("mem_1", "Old typed model note.")]), { id: "snapshot_1" });
      await saveMemoryReviewSnapshot(root, snapshot);
      const importFile = join(root, "proposal.md");
      await writeFile(importFile, fencedProposalSet(proposalSet({
        id: `proposal_set_${action}`,
        proposals: [{
          ...(proposalSet().proposals[0] as any),
          id: `proposal_${action}`,
          action,
          targets: ["M1"],
        }],
      })), "utf8");

      const result = await runMemoryReview({ raw: false, workspace: root, positional: ["import", importFile] });

      assert.equal(result.exitCode, 1, `${action} import should fail closed`);
      assert.match(result.stdout, /memory-review rejected: unknown_action/);
      assert.equal(await loadMemoryReviewProposalSet(root, `proposal_set_${action}`), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("memory review user edit validation applies redaction quality length and collision gates", () => {
  const workspaceStore = store([
    memory("mem_1", "Old typed model note."),
    memory("mem_2", "Keep exact collision text.", { type: "decision" }),
  ]);
  const snapshot = createMemoryReviewSnapshot(workspaceStore, { id: "snapshot_1" });
  const proposal = proposalSet().proposals[0] as any;

  assert.equal(validateMemoryReviewUserEdit(proposal, snapshot, "Use stable typed memory review architecture.", workspaceStore).valid, true);
  assert.deepEqual(validateMemoryReviewUserEdit(proposal, snapshot, "Use password: sushi for review.", workspaceStore).errors.map(error => error.code), ["redaction_changed_text"]);
  assert.ok(validateMemoryReviewUserEdit(proposal, snapshot, "Phase 2 implementation completed.", workspaceStore).errors.some(error => error.code === "quality_gate_rejected"));
  assert.ok(validateMemoryReviewUserEdit(proposal, snapshot, "x".repeat(261), workspaceStore).errors.some(error => error.code === "edited_text_too_long"));
  assert.ok(validateMemoryReviewUserEdit(proposal, snapshot, "Keep exact collision text.", workspaceStore).errors.some(error => error.code === "identity_collision"));
});

test("memory review batch apply planning is all-or-nothing and detects conflicts without mutating", () => {
  const workspaceStore = store([
    memory("mem_1", "Old typed model note."),
    memory("mem_2", "Second stale note."),
  ]);
  const snapshot = createMemoryReviewSnapshot(workspaceStore, { id: "snapshot_1" });
  const validSet = proposalSet({
    proposals: [
      { ...(proposalSet().proposals[0] as any), id: "proposal_1", targets: ["M1"], proposedText: "Use typed review model helpers." },
      { ...(proposalSet().proposals[0] as any), id: "proposal_2", targets: ["M2"], proposedText: "Use sealed proposal model helpers." },
    ],
  });
  const plan = planMemoryReviewBatchApply(validSet, snapshot, workspaceStore);
  assert.equal(plan.valid, true);
  assert.equal(plan.operations.length, 2);
  assert.equal(workspaceStore.entries.every(entry => entry.status === "active"), true);

  const conflictSet = proposalSet({
    proposals: [
      { ...(proposalSet().proposals[0] as any), id: "proposal_1", targets: ["M1"], proposedText: "Use typed review model helpers." },
      { ...(proposalSet().proposals[0] as any), id: "proposal_2", targets: ["M1"], proposedText: "Use conflicting typed model helpers." },
    ],
  });
  const conflict = planMemoryReviewBatchApply(conflictSet, snapshot, workspaceStore);
  assert.equal(conflict.valid, false);
  assert.deepEqual(conflict.operations, []);
  assert.ok(conflict.errors.some(error => error.code === "batch_conflict"));
});

test("review edits validate supplied types and preserve independent facts sharing a path", () => {
  const target = memory("target", "Config .opencode/opencode.json defines server plugins.", { type: "reference" });
  const other = memory("other", "Config .opencode/opencode.json defines provider settings.", { type: "reference" });
  const workspaceStore = store([target, other]);
  const snapshot = createMemoryReviewSnapshot(workspaceStore, { id: "snapshot_1" });
  const ref = snapshot.memories.find(item => item.memoryId === target.id)!.ref;
  const proposal = { ...proposalSet().proposals[0], targets: [ref], proposedType: "reference" } as any;
  const replacement = "Config .opencode/opencode.json defines server plugin loading order.";
  assert.equal(validateMemoryReviewUserEdit(proposal, snapshot, replacement, workspaceStore).valid, true);
  assert.ok(validateMemoryReviewUserEdit(proposal, snapshot, other.text, workspaceStore).errors.some(error => error.code === "identity_collision"));
  for (const proposedType of [null, undefined, "unexpected", 42]) {
    const result = validateMemoryReviewUserEdit({ ...proposal, proposedType }, snapshot, replacement, workspaceStore);
    assert.ok(result.errors.some(error => error.code === "invalid_proposed_type"));
  }
});

test("invalid proposedType is rejected before apply and leaves workspace memory unchanged", async () => {
  for (const proposedType of ["bogus", null, 42]) {
    const root = await mkdtemp(join(tmpdir(), "memory-review-invalid-type-"));
    try {
      const workspaceStore = store([memory("mem_1", "Old typed model note.")]);
      await saveWorkspaceMemory(root, workspaceStore);
      const snapshot = createMemoryReviewSnapshot(workspaceStore, { id: "snapshot_1" });
      const set = proposalSet({ proposals: [{ ...(proposalSet().proposals[0] as any), proposedType }] }) as any;
      const before = await loadWorkspaceMemory(root);
      const result = await applyMemoryReviewProposalBatch(root, set, snapshot, ["proposal_1"]);
      assert.equal(result.applied, false);
      assert.ok(result.errors.some(error => error.code === "invalid_proposed_type"));
      const after = await loadWorkspaceMemory(root);
      assert.deepEqual(after.entries, before.entries);
      assert.equal(after.entries[0].status, "active");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("omitted proposedType consistently falls back to the target type in preview and apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-review-type-fallback-"));
  try {
    const workspaceStore = store([memory("mem_1", "Old typed model note.", { type: "project" })]);
    await saveWorkspaceMemory(root, workspaceStore);
    const snapshot = createMemoryReviewSnapshot(workspaceStore, { id: "snapshot_1" });
    const set = proposalSet({ proposals: [{ ...(({ proposedType: _proposedType, ...proposal }) => proposal)(proposalSet().proposals[0] as any) }] }) as any;
    const plan = planMemoryReviewBatchApply(set, snapshot);
    assert.equal(plan.valid, true);
    assert.equal(plan.operations[0].replacement?.type, "project");
    const result = await applyMemoryReviewProposalBatch(root, set, snapshot, ["proposal_1"]);
    assert.equal(result.applied, true);
    const current = await loadWorkspaceMemory(root);
    assert.equal(current.entries.find(entry => entry.text === set.proposals[0].proposedText)?.type, "project");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory review apply emits started evidence and replacement retention metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-review-apply-started-"));
  try {
    const workspaceStore = store([memory("mem_1", "Old typed model note.", { type: "decision" })]);
    await saveWorkspaceMemory(root, workspaceStore);
    const snapshot = createMemoryReviewSnapshot(await loadWorkspaceMemory(root), { id: "snapshot_1" });
    const set = proposalSet({
      proposals: [{
        ...(proposalSet().proposals[0] as any),
        id: "proposal_apply",
        targets: ["M1"],
        proposedType: "decision",
        proposedText: "Use typed review model helpers for future memory review.",
      }],
    }) as any;

    const result = await applyMemoryReviewProposalBatch(root, set, snapshot, ["proposal_apply"]);

    assert.equal(result.applied, true);
    const events = await queryEvidenceEvents(root, { types: ["memory_review_batch_apply_started", "memory_review_batch_applied"] });
    assert.deepEqual(events.map(event => event.type), ["memory_review_batch_apply_started", "memory_review_batch_applied"]);
    assert.equal(events[0].phase, "memory_review");
    assert.equal(events[0].outcome, "approved");
    assert.deepEqual(events[0].reasonCodes, ["apply_started"]);
    assert.equal(events[0].details?.proposalSetId, "proposal_set_1");
    assert.equal(events[0].details?.snapshotId, "snapshot_1");
    assert.equal(events[0].details?.applyAttemptId, result.applyAttemptId);
    assert.deepEqual(events[0].details?.proposalIds, ["proposal_apply"]);

    const current = await loadWorkspaceMemory(root);
    const replacement = current.entries.find(entry => entry.text === "Use typed review model helpers for future memory review.");
    assert.ok(replacement, "expected replacement memory to be stored");
    assert.equal(replacement.source, "manual");
    assert.equal(replacement.staleAfterDays, 45);
    assert.equal(typeof replacement.retentionClock, "number");
    assert.ok(Number.isFinite(replacement.retentionClock));
    assert.ok(Math.abs(replacement.retentionClock - Date.parse(replacement.createdAt)) < 1000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory review capture emits detected evidence with redacted proposal preview and target refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-review-evidence-capture-"));
  try {
    const snapshot = createMemoryReviewSnapshot(store([memory("mem_1", "Old typed model note.")]), { id: "snapshot_1" });
    await saveMemoryReviewSnapshot(root, snapshot);
    const set = proposalSet({
      proposals: [{
        ...(proposalSet().proposals[0] as any),
        proposedText: "Use password: sushi only in the test preview.",
      }],
    });

    await captureMemoryReviewProposalText(root, fencedProposalSet(set), { source: "hook", sessionID: "ses_1", messageID: "msg_1", partID: "part_1" });

    const events = await queryEvidenceEvents(root, { types: ["memory_review_proposal_detected"] });
    assert.equal(events.length, 1);
    assert.equal(events[0].phase, "memory_review");
    assert.equal(events[0].outcome, "detected");
    assert.equal(events[0].details?.snapshotId, "snapshot_1");
    assert.equal(events[0].details?.proposalSetId, "proposal_set_1");
    assert.deepEqual(events[0].details?.targetRefs, ["M1"]);
    assert.equal(events[0].relations?.[0]?.role, "target");
    assert.equal(events[0].relations?.[0]?.memory?.memoryId, "mem_1");
    assert.ok(events[0].textPreview?.includes("[REDACTED]"));
    assert.ok(!JSON.stringify(events[0]).includes("sushi"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory review capture emits rejected evidence for validation failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-review-evidence-rejected-"));
  try {
    const snapshot = createMemoryReviewSnapshot(store([memory("mem_1", "Old typed model note.")]), { id: "snapshot_1" });
    await saveMemoryReviewSnapshot(root, snapshot);
    const unknownTarget = proposalSet({ proposals: [{ ...(proposalSet().proposals[0] as any), targets: ["M9"] }] });

    await captureMemoryReviewProposalText(root, fencedProposalSet(unknownTarget), { source: "cli_import" });

    const events = await queryEvidenceEvents(root, { types: ["memory_review_proposal_rejected"] });
    assert.equal(events.length, 1);
    assert.equal(events[0].phase, "memory_review");
    assert.equal(events[0].outcome, "rejected");
    assert.ok(events[0].reasonCodes.includes("missing_target"));
    assert.equal(events[0].details?.snapshotId, "snapshot_1");
    assert.equal(events[0].details?.proposalSetId, "proposal_set_1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory review decision evidence models approved rejected and edited decisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-review-evidence-decisions-"));
  try {
    const base = { proposalSetId: "proposal_set_1", proposalId: "proposal_1", createdAt: "2026-06-16T00:00:00.000Z" };

    await appendMemoryReviewDecisionEvidence(root, createMemoryReviewDecisionRecord({ ...base, decision: "approved" }));
    await appendMemoryReviewDecisionEvidence(root, createMemoryReviewDecisionRecord({ ...base, decision: "rejected" }));
    await appendMemoryReviewDecisionEvidence(root, createMemoryReviewDecisionRecord({ ...base, decision: "edited", userEditedText: "Use password: sushi in edited text." }));

    const approved = await queryEvidenceEvents(root, { types: ["memory_review_proposal_approved"] });
    const rejected = await queryEvidenceEvents(root, { types: ["memory_review_proposal_rejected"], outcomes: ["rejected"] });
    const edited = await queryEvidenceEvents(root, { types: ["memory_review_proposal_edited"] });

    assert.equal(approved.length, 1);
    assert.equal(approved[0].outcome, "approved");
    assert.deepEqual(approved[0].reasonCodes, ["user_approved"]);
    assert.equal(rejected.length, 1);
    assert.deepEqual(rejected[0].reasonCodes, ["user_rejected"]);
    assert.equal(edited.length, 1);
    assert.equal(edited[0].outcome, "edited");
    assert.ok(edited[0].textPreview?.includes("[REDACTED]"));
    assert.ok(!JSON.stringify(edited[0]).includes("sushi"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory review batch conflict prepares failed evidence without mutating", () => {
  const workspaceStore = store([
    memory("mem_1", "Old typed model note."),
    memory("mem_2", "Second stale note."),
  ]);
  const snapshot = createMemoryReviewSnapshot(workspaceStore, { id: "snapshot_1" });
  const conflictSet = proposalSet({
    proposals: [
      { ...(proposalSet().proposals[0] as any), id: "proposal_1", targets: ["M1"], proposedText: "Use typed review model helpers." },
      { ...(proposalSet().proposals[0] as any), id: "proposal_2", targets: ["M1"], proposedText: "Use conflicting typed model helpers." },
    ],
  });
  const plan = planMemoryReviewBatchApply(conflictSet, snapshot, workspaceStore);
  const event = memoryReviewBatchFailureEvidence(plan, conflictSet as any, snapshot);

  assert.equal(event.type, "memory_review_batch_apply_failed");
  assert.equal(event.phase, "memory_review");
  assert.equal(event.outcome, "failed");
  assert.deepEqual(event.reasonCodes, ["batch_conflict"]);
  assert.deepEqual(event.details?.targetRefs, ["M1"]);
  assert.equal(workspaceStore.entries.every(entry => entry.status === "active"), true);
});
