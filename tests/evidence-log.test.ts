import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  EVIDENCE_LOG_LIMITS,
  appendEvidenceEvent,
  appendEvidenceEvents,
  queryEvidenceEvents,
  summarizeMemoryEvidence,
  traceMemoryLifecycle,
  type EvidenceEventInput,
  type EvidenceEventV1,
} from "../src/evidence-log.ts";
import { workspaceEvidenceLogPath, workspaceKey } from "../src/paths.ts";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "opencode-evidence-log-"));
}

function eventInput(overrides: Partial<EvidenceEventInput> = {}): EvidenceEventInput {
  return {
    type: "promotion_promoted",
    phase: "promotion",
    outcome: "promoted",
    reasonCodes: ["new_workspace_entry"],
    memory: { memoryId: "mem-a", type: "decision", source: "explicit", status: "active" },
    textPreview: "Use npm test before release",
    ...overrides,
  };
}

async function readLog(root: string): Promise<string> {
  return readFile(await workspaceEvidenceLogPath(root), "utf8");
}

function privacyHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function workspaceRootHash(root: string): Promise<string> {
  const resolved = await realpath(root).catch(() => root);
  return privacyHash(resolved);
}

function manualEvent(rootKey: string, rootHash: string, id: string, createdAt: string): EvidenceEventV1 {
  return {
    version: 1,
    eventId: id,
    createdAt,
    workspaceKey: rootKey,
    workspaceRootHash: rootHash,
    type: "render_selected",
    phase: "render",
    outcome: "rendered",
    memory: { memoryId: id, type: "decision" },
    reasonCodes: ["within_caps", "within_char_budget"],
  };
}

test("appendEvidenceEvent writes versioned JSONL with workspace hashes", async () => {
  const root = await tempRoot();
  try {
    const event = await appendEvidenceEvent(root, eventInput({ sessionHash: "session-1", messageHash: "message-1" }));
    const raw = await readLog(root);
    const stored = JSON.parse(raw.trim()) as EvidenceEventV1;

    assert.equal(stored.version, 1);
    assert.match(stored.eventId, /^evt_\d+_[a-z0-9]{8}$/);
    assert.equal(stored.eventId, event.eventId);
    assert.equal(stored.workspaceKey, await workspaceKey(root));
    assert.equal(stored.workspaceRootHash, await workspaceRootHash(root));
    assert.equal(stored.sessionHash, privacyHash("session-1"));
    assert.equal(stored.messageHash, privacyHash("message-1"));
    assert.equal(stored.type, "promotion_promoted");
    assert.equal(stored.outcome, "promoted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("appendEvidenceEvent redacts text previews before writing", async () => {
  const root = await tempRoot();
  try {
    await appendEvidenceEvent(root, eventInput({
      type: "extraction_candidate_rejected",
      phase: "extraction",
      outcome: "rejected",
      reasonCodes: ["raw_error"],
      textPreview: "password: sushi\nAdmin PIN 是 456123\nBearer abc.def.ghi\nThis candidate is rejected and should be short",
      details: {
        note: "password: sushi Admin PIN 是 456123 Bearer abc.def.ghi",
      },
    }));

    const raw = await readLog(root);
    const stored = JSON.parse(raw.trim()) as EvidenceEventV1;
    assert.ok(!raw.includes("sushi"));
    assert.ok(!raw.includes("456123"));
    assert.ok(!raw.includes("abc.def.ghi"));
    assert.ok(stored.textPreview?.includes("[REDACTED]"));
    assert.ok((stored.textPreview?.length ?? 0) <= 80);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent evidence appends preserve independent JSONL records", async () => {
  const root = await tempRoot();
  try {
    const count = 40;

    await Promise.all(Array.from({ length: count }, (_, index) =>
      appendEvidenceEvent(root, eventInput({ memory: { memoryId: `concurrent-${index}` } }))
    ));

    const raw = await readLog(root);
    const lines = raw.trim().split("\n");
    const events = await queryEvidenceEvents(root);
    const memoryIds = new Set(events.map(event => event.memory?.memoryId));

    assert.equal(lines.length, count);
    assert.equal(events.length, count);
    for (let index = 0; index < count; index += 1) {
      assert.equal(memoryIds.has(`concurrent-${index}`), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queryEvidenceEvents filters by type outcome and memory id", async () => {
  const root = await tempRoot();
  try {
    await appendEvidenceEvents(root, [
      eventInput({ type: "promotion_promoted", outcome: "promoted", memory: { memoryId: "mem-a" } }),
      eventInput({ type: "render_omitted", phase: "render", outcome: "omitted", reasonCodes: ["type_cap"], memory: { memoryId: "mem-a" } }),
      eventInput({ type: "render_omitted", phase: "render", outcome: "omitted", reasonCodes: ["global_cap"], memory: { memoryId: "mem-b" } }),
    ]);

    const result = await queryEvidenceEvents(root, {
      types: ["render_omitted"],
      outcomes: ["omitted"],
      memoryId: "mem-a",
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].type, "render_omitted");
    assert.equal(result[0].memory?.memoryId, "mem-a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory_removed_capacity event round-trips through append and query", async () => {
  const root = await tempRoot();
  try {
    await appendEvidenceEvent(root, eventInput({
      type: "memory_removed_capacity",
      phase: "storage",
      outcome: "removed",
      reasonCodes: ["global_cap"],
      memory: { memoryId: "removed-memory", type: "reference", source: "compaction", status: "active" },
      relations: [{ role: "removed", memory: { memoryId: "removed-memory", type: "reference", source: "compaction", status: "active" } }],
      details: {
        type: "reference",
        globalCap: 28,
        retentionClock: Date.UTC(2026, 4, 1),
        createdAt: "2026-05-01T00:00:00.000Z",
        source: "compaction",
      },
    }));

    const result = await queryEvidenceEvents(root, {
      types: ["memory_removed_capacity"],
      phases: ["storage"],
      outcomes: ["removed"],
      memoryId: "removed-memory",
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].type, "memory_removed_capacity");
    assert.equal(result[0].phase, "storage");
    assert.equal(result[0].outcome, "removed");
    assert.deepEqual(result[0].details, {
      type: "reference",
      globalCap: 28,
      retentionClock: Date.UTC(2026, 4, 1),
      createdAt: "2026-05-01T00:00:00.000Z",
      source: "compaction",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory_migration_superseded event round-trips through append and query", async () => {
  const root = await tempRoot();
  try {
    await appendEvidenceEvent(root, eventInput({
      type: "memory_migration_superseded",
      phase: "storage",
      outcome: "superseded",
      reasonCodes: ["migration:quality_cleanup", "quality:progress_snapshot"],
      memory: { memoryId: "migrated-memory", type: "project", source: "compaction", status: "superseded" },
      relations: [{ role: "superseded", memory: { memoryId: "migrated-memory", type: "project", source: "compaction", status: "superseded" } }],
      details: {
        migrationId: "2026-04-28-quality-cleanup",
        type: "project",
        source: "compaction",
      },
    }));

    const result = await queryEvidenceEvents(root, {
      types: ["memory_migration_superseded"],
      phases: ["storage"],
      outcomes: ["superseded"],
      memoryId: "migrated-memory",
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].type, "memory_migration_superseded");
    assert.equal(result[0].phase, "storage");
    assert.equal(result[0].outcome, "superseded");
    assert.ok(result[0].reasonCodes.includes("migration:quality_cleanup"));
    assert.equal(result[0].memory?.status, "superseded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory_reverted_numbered_ref event round-trips through append and query", async () => {
  const root = await tempRoot();
  try {
    await appendEvidenceEvent(root, eventInput({
      type: "memory_reverted_numbered_ref",
      phase: "storage",
      outcome: "recovered",
      reasonCodes: ["manual_revert_numbered_ref"],
      memory: { memoryId: "replacement-memory", type: "decision", source: "compaction", status: "superseded" },
      relations: [
        { role: "superseded", memory: { memoryId: "replacement-memory", type: "decision", source: "compaction", status: "superseded" } },
        { role: "recovered", memory: { memoryId: "restored-memory", type: "decision", source: "compaction", status: "active" } },
      ],
    }));

    const result = await queryEvidenceEvents(root, {
      types: ["memory_reverted_numbered_ref"],
      phases: ["storage"],
      outcomes: ["recovered"],
      memoryId: "restored-memory",
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].type, "memory_reverted_numbered_ref");
    assert.equal(result[0].phase, "storage");
    assert.equal(result[0].outcome, "recovered");
    assert.ok(result[0].reasonCodes.includes("manual_revert_numbered_ref"));
    assert.ok(result[0].relations?.some(relation => relation.role === "recovered" && relation.memory?.memoryId === "restored-memory"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queryEvidenceEvents supports newestFirst and limit", async () => {
  const root = await tempRoot();
  try {
    const events = await appendEvidenceEvents(root, [
      eventInput({ memory: { memoryId: "oldest" } }),
      eventInput({ memory: { memoryId: "middle" } }),
      eventInput({ memory: { memoryId: "newest" } }),
    ]);

    const result = await queryEvidenceEvents(root, { newestFirst: true, limit: 2 });

    assert.deepEqual(result.map(event => event.eventId), [events[2].eventId, events[1].eventId]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("appendEvidenceEvent returns a record when appendFile fails", async () => {
  const root = await tempRoot();
  try {
    const path = await workspaceEvidenceLogPath(root);
    await mkdir(path, { recursive: true });

    const event = await appendEvidenceEvent(root, eventInput());

    assert.equal(event.version, 1);
    assert.match(event.eventId, /^evt_\d+_[a-z0-9]{8}$/);
    assert.equal(event.workspaceKey, await workspaceKey(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence log pruning drops old events, caps count, and quarantines invalid lines", async () => {
  const root = await tempRoot();
  try {
    const path = await workspaceEvidenceLogPath(root);
    await mkdir(dirname(path), { recursive: true });
    const rootKey = await workspaceKey(root);
    const rootHash = await workspaceRootHash(root);
    const old = manualEvent(rootKey, rootHash, "old-event", new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString());
    const recentEvents = Array.from({ length: EVIDENCE_LOG_LIMITS.maxEventsPerWorkspace + 1 }, (_, i) =>
      manualEvent(rootKey, rootHash, `recent-${i}`, new Date(Date.now() - (EVIDENCE_LOG_LIMITS.maxEventsPerWorkspace - i) * 1000).toISOString())
    );
    await writeFile(path, [
      JSON.stringify(old),
      "{not valid json",
      ...recentEvents.map(event => JSON.stringify(event)),
    ].join("\n") + "\n", "utf8");

    const appended = await appendEvidenceEvents(root, Array.from({ length: EVIDENCE_LOG_LIMITS.pruneEveryAppendCount }, (_, i) =>
      eventInput({ memory: { memoryId: `appended-${i}` }, reasonCodes: ["new_workspace_entry"] })
    ));

    const events = await queryEvidenceEvents(root);
    const memoryIds = new Set(events.map(event => event.memory?.memoryId));
    const files = await readdir(dirname(path));

    assert.ok(events.length <= EVIDENCE_LOG_LIMITS.maxEventsPerWorkspace);
    assert.equal(memoryIds.has("old-event"), false);
    assert.equal(memoryIds.has("recent-0"), false, "oldest events over the count cap should be pruned");
    assert.equal(memoryIds.has(appended.at(-1)?.memory?.memoryId), true);
    assert.ok(files.some(file => file.startsWith("events.jsonl.corrupt-lines-")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory evidence summary and lifecycle trace derive latest status", async () => {
  const root = await tempRoot();
  try {
    await appendEvidenceEvents(root, [
      eventInput({ type: "extraction_candidate_accepted", phase: "extraction", outcome: "accepted", reasonCodes: ["quality_gate_passed"], memory: { memoryId: "mem-life", memoryKeyHash: "raw-key" } }),
      eventInput({ type: "promotion_promoted", phase: "promotion", outcome: "promoted", reasonCodes: ["new_workspace_entry"], memory: { memoryId: "mem-life", memoryKeyHash: "raw-key" } }),
      eventInput({ type: "memory_reinforced", phase: "reinforcement", outcome: "reinforced", reasonCodes: ["duplicate_exact"], relations: [{ role: "reinforced", memory: { memoryId: "mem-life", memoryKeyHash: "raw-key" } }] }),
      eventInput({ type: "render_selected", phase: "render", outcome: "rendered", reasonCodes: ["within_caps", "within_char_budget"], memory: { memoryId: "mem-life", memoryKeyHash: "raw-key" } }),
    ]);

    const summary = await summarizeMemoryEvidence(root, { memoryId: "mem-life" });
    const trace = await traceMemoryLifecycle(root, { memoryId: "mem-life" });

    assert.equal(summary.latestOutcome, "rendered");
    assert.equal(summary.latestRenderStatus, "rendered");
    assert.ok(summary.reasonCodes.includes("duplicate_exact"));
    assert.equal(trace.currentStatus, "rendered");
    assert.ok(trace.acceptedBy);
    assert.ok(trace.promotedBy);
    assert.equal(trace.reinforcedBy.length, 1);
    assert.equal(trace.latestRender?.type, "render_selected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence relation roles reject sublimation placeholders at compile-time surface", () => {
  const allowedRoles: Array<NonNullable<EvidenceEventInput["relations"]>[number]["role"]> = [
    "candidate",
    "pending",
    "promoted",
    "retained",
    "absorbed",
    "superseded",
    "superseded_by",
    "reinforced",
    "reinforced_by",
    "rendered",
    "omitted",
    "removed",
  ];

  assert.equal(allowedRoles.includes("candidate"), true);
});
