import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { appendEvidenceEvents, queryEvidenceEvents, type EvidenceEventInput } from "../src/evidence-log.ts";
import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "../src/types.ts";
import { LONG_TERM_LIMITS, PROMOTION_RETRY_LIMITS, type PendingMemoryJournalStore } from "../src/types.ts";
import { extractionRejectionLogPath, workspaceEvidenceLogPath, workspaceKey, workspaceMemoryPath, workspacePendingJournalPath } from "../src/paths.ts";

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

async function runMemoryDiagStatusVerbose(root: string): Promise<string> {
  return runMemoryDiag(["status", "--workspace", root, "--verbose"]);
}

async function runMemoryDiag(args: string[]): Promise<string> {
  const { stdout } = await runMemoryDiagResult(args);
  return stdout;
}

async function runMemoryDiagResult(args: string[], options: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--experimental-strip-types",
    "scripts/memory-diag.ts",
    ...args,
  ], { cwd: options.cwd ?? repoRoot });

  return { stdout: stdout.trim(), stderr: stderr.trim() };
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

function replacementFixture(): { original: LongTermMemoryEntry; replacement: LongTermMemoryEntry } {
  const original = {
    ...entry("mem-original", "Original compaction memory to restore", "decision"),
    status: "superseded" as const,
  };
  const replacement = {
    ...entry("mem-replacement", "Replacement compaction memory to revert", "decision"),
    supersedes: [original.id],
  };
  return { original, replacement };
}

function replacementEvidence(original: LongTermMemoryEntry, replacement: LongTermMemoryEntry): EvidenceEventInput {
  return evidence({
    type: "memory_replaced_numbered_ref",
    phase: "storage",
    outcome: "superseded",
    memory: { memoryId: original.id, type: original.type, source: original.source, status: "superseded" },
    relations: [
      { role: "superseded", memory: { memoryId: original.id, type: original.type, source: original.source, status: "superseded" } },
      { role: "superseded_by", memory: { memoryId: replacement.id, type: replacement.type, source: replacement.source, status: "active" } },
    ],
    reasonCodes: ["numbered_ref_replace", "same_type_replace"],
    details: { ref: "M1", oldMemoryId: original.id, newMemoryId: replacement.id },
  });
}

const attributionSafetyTerms = [
  "b" + "ug",
  "fix" + "ed",
  "incor" + "rect",
  "wrong" + "ly blocked",
  "caused memory" + " loss",
  "prevent" + "ed retention",
  "should" + " allow",
  "policy" + " failure",
  "regres" + "sion",
];

function assertNoAttributionSafetyTerms(text: string): void {
  for (const term of attributionSafetyTerms) {
    assert.doesNotMatch(text, new RegExp(term, "i"));
  }
}

async function setupMemoryCommandDetailFixture(root: string): Promise<void> {
  await writeWorkspaceStore(root, [
    { ...entry("mem-detail", "Detail drill-down memory remains current", "decision"), source: "explicit" as const },
  ]);
  await appendEvidenceEvents(root, [
    evidence({
      type: "memory_reinforced",
      phase: "reinforcement",
      outcome: "reinforced",
      memory: { memoryId: "mem-detail", type: "decision", source: "explicit", status: "active" },
      reasonCodes: ["numbered_ref_reinforce", "reinforcement_window_allowed"],
      details: { ref: "M3", attemptedAtIso: "2026-05-12T23:55:00.000Z", reinforcedAtIso: "2026-05-12T23:55:01.000Z" },
      sessionHash: "command-session-one",
      messageHash: "command-message-one",
    }),
    evidence({
      type: "memory_reinforced",
      phase: "reinforcement",
      outcome: "rejected",
      memory: { memoryId: "mem-detail", type: "decision", source: "explicit", status: "active" },
      reasonCodes: ["numbered_ref_reinforce", "reinforcement_window_blocked", "reinforcement_block_same_session"],
      details: {
        ref: "M3",
        blockReason: "same_session",
        attemptedAtIso: "2026-05-13T00:05:00.000Z",
        lastReinforcedAtIso: "2026-05-12T23:55:01.000Z",
      },
      sessionHash: "command-session-one",
      messageHash: "command-message-two",
    }),
    evidence({
      type: "memory_reinforced",
      phase: "reinforcement",
      outcome: "rejected",
      memory: { memoryId: "mem-detail", type: "decision", source: "explicit", status: "active" },
      reasonCodes: ["numbered_ref_reinforce", "reinforcement_window_blocked"],
      details: { ref: "M3", attemptedAtIso: "2026-05-13T00:06:00.000Z" },
      sessionHash: "command-session-two",
      messageHash: "command-message-three",
    }),
    evidence({
      type: "memory_reinforced",
      phase: "reinforcement",
      outcome: "rejected",
      memory: { memoryId: "mem-detail", type: "decision", source: "explicit", status: "active" },
      reasonCodes: ["numbered_ref_reinforce", "reinforcement_window_blocked", "reinforcement_block_min_elapsed_window"],
      details: {
        ref: "M3",
        blockReason: "min_elapsed_window",
        attemptedAtIso: "2026-05-20T00:05:00.000Z",
        lastReinforcedAtIso: "2026-05-13T00:05:00.001Z",
        elapsedMs: 604_799_999,
        requiredElapsedMs: 604_800_000,
        sameSession: true,
        sessionID: "raw-session-secret",
        lastReinforcedSessionID: "raw-last-session-secret",
      },
      sessionHash: "command-session-three",
      messageHash: "command-message-four",
    }),
    evidence({
      type: "memory_reinforced",
      phase: "reinforcement",
      outcome: "reinforced",
      memory: { memoryId: "mem-detail", type: "decision", source: "explicit", status: "active" },
      reasonCodes: ["numbered_ref_reinforce", "reinforcement_window_allowed"],
      details: {
        ref: "M3",
        reinforcementOutcome: "reinforced",
        reinforcementMode: "increment",
        attemptedAtIso: "2026-05-20T00:05:00.001Z",
        lastReinforcedAtIso: "2026-05-13T00:05:00.001Z",
        elapsedMs: 604_800_000,
        requiredElapsedMs: 604_800_000,
        sameSession: false,
        sessionID: "raw-increment-session-secret",
      },
      sessionHash: "command-session-four",
      messageHash: "command-message-five",
    }),
    evidence({
      type: "memory_reinforced",
      phase: "reinforcement",
      outcome: "reinforced",
      memory: { memoryId: "mem-detail", type: "decision", source: "explicit", status: "active" },
      reasonCodes: ["numbered_ref_reinforce", "reinforcement_window_allowed", "reinforcement_saturation_refresh"],
      details: {
        ref: "M3",
        reinforcementOutcome: "refreshed",
        reinforcementMode: "refresh_only",
        attemptedAtIso: "2026-05-27T00:05:00.001Z",
        lastReinforcedAtIso: "2026-05-20T00:05:00.001Z",
        elapsedMs: 604_800_000,
        requiredElapsedMs: 604_800_000,
        sameSession: true,
        lastReinforcedSessionID: "raw-refresh-last-session-secret",
      },
      sessionHash: "command-session-five",
      messageHash: "command-message-six",
    }),
    evidence({
      type: "memory_reinforced",
      phase: "reinforcement",
      outcome: "reinforced",
      memory: { memoryId: "mem-detail", type: "decision", source: "explicit", status: "active" },
      reasonCodes: ["numbered_ref_reinforce", "reinforcement_window_allowed"],
      details: {
        ref: "M3",
        reinforcementOutcome: "reinforced",
        reinforcementMode: "increment",
        attemptedAtIso: "2026-05-28T00:05:00.001Z",
        requiredElapsedMs: 604_800_000,
        sameSession: false,
        legacyMissingTimestamp: true,
        sessionID: "raw-legacy-session-secret",
      },
      sessionHash: "command-session-six",
      messageHash: "command-message-seven",
    }),
    evidence({
      type: "render_selected",
      phase: "render",
      outcome: "rendered",
      memory: { memoryId: "mem-detail", type: "decision", source: "explicit", status: "active" },
      reasonCodes: ["within_caps", "within_char_budget"],
    }),
  ]);
}

test("status handles missing workspace store as empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-memory-diag-missing-health-"));
  try {
    const stdout = await runMemoryDiag(["status", "--workspace", root]);

    assert.match(stdout, /Memory status/);
    assert.match(stdout, /active memories: 0/);
    assert.match(stdout, /pending: 0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status verbose handles missing workspace store as empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-memory-diag-missing-quality-"));
  try {
    const stdout = await runMemoryDiag(["status", "--workspace", root, "--verbose"]);

    assert.match(stdout, /Memory status inspection/);
    assert.match(stdout, /Caps:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coverage and disappearances handle missing workspace store as empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-memory-diag-missing-inspection-"));
  try {
    const coverageStdout = await runMemoryDiag(["coverage", "--workspace", root]);
    assert.match(coverageStdout, /no_evidence: 0/);
    assert.match(coverageStdout, /Per-memory rows:\n\s+\(none\)/);

    const missingStdout = await runMemoryDiag(["missing", "--workspace", root]);
    assert.match(missingStdout, /No missing memories found\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status with unsupported all flag shows usage error", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-memory-diag-conflicting-flags-"));
  try {
    await assert.rejects(
      runMemoryDiagResult(["status", "--all", "--workspace", root]),
      (error: unknown) => {
        const err = error as { code?: number; stderr?: string };
        assert.notEqual(err.code, 0);
        assert.match(err.stderr ?? "", /status does not accept --all/);
        assert.match(err.stderr ?? "", /Usage:/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory-diag reports unexpected command errors without stack traces", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-memory-diag-error-boundary-"));
  try {
    await writeWorkspaceStore(root, []);
    // Invalid rejection filter values are parse-caught before dispatch, so this
    // fixture exercises the same top-level boundary with a command-thrown Error.
    await mkdir(await workspaceEvidenceLogPath(root), { recursive: true });

    await assert.rejects(
      runMemoryDiagResult(["status", "--workspace", root]),
      (error: unknown) => {
        const err = error as { code?: number; stderr?: string };
        assert.notEqual(err.code, 0);
        assert.match(err.stderr ?? "", /memory-diag failed:/);
        assert.doesNotMatch(err.stderr ?? "", /\n\s+at\s|Error:/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory-diag defaults to status when no subcommand is supplied", async () => {
  const result = await runMemoryDiagResult([]);

  assert.match(result.stdout, /Memory status/);
  assert.match(result.stdout, /Key metrics:/);
  assert.equal(result.stderr, "");
});

test("removed legacy aliases return unknown subcommand", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-memory-diag-legacy-health-"));
  try {
    for (const command of ["health", "rejections", "disappearances", "trace"]) {
      await assert.rejects(
        runMemoryDiagResult([command, "--workspace", root]),
        (error: unknown) => {
          const err = error as { code?: number; stderr?: string };
          assert.notEqual(err.code, 0);
          assert.match(err.stderr ?? "", new RegExp(`Unknown subcommand: ${command}`));
          assert.match(err.stderr ?? "", /Usage:/);
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory health reports stored vs rendered retention counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-"));
  try {
    const entries: LongTermMemoryEntry[] = [
      ...Array.from({ length: 17 }, (_, i) => entry(`feedback-${i}`, `Unique feedback preference for memory health ${i}`, "feedback")),
      ...Array.from({ length: 11 }, (_, i) => entry(`decision-${i}`, `Unique durable decision for memory health ${i}`, "decision")),
    ];
    await writeWorkspaceStore(root, entries);

    const stdout = await runMemoryDiagStatusVerbose(root);

    assert.match(stdout, /Memory status inspection/);
    assert.match(stdout, /active: 28 \/ 28/);
    assert.match(stdout, /rendered: 21/);
    assert.match(stdout, /feedback: 17 \/ 10 FULL/);
    assert.match(stdout, /Top rendered candidates:\n\s+- strength=/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory-diag commands reports zero counts for empty evidence log", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-commands-empty-"));
  try {
    const stdout = await runMemoryDiag(["commands", "--workspace", root]);

    assert.match(stdout, /Memory command diagnostics/);
    assert.match(stdout, /compactions with command evidence: 0/);
    assert.match(stdout, /reinforce: 0/);
    assert.match(stdout, /replace: 0/);
    assert.match(stdout, /invalid\/malformed commands: 0/);
    assert.match(stdout, /Protected REPLACE blocked: 0 \(reinforced: 0, source: 0\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory-diag commands summarizes seeded command evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-commands-"));
  try {
    await appendEvidenceEvents(root, [
      evidence({
        type: "memory_reinforced",
        phase: "reinforcement",
        outcome: "reinforced",
        memory: { memoryId: "reinforced-1", type: "decision", source: "compaction", status: "active" },
        reasonCodes: ["numbered_ref_reinforce", "reinforcement_window_allowed"],
        sessionHash: "command-session-a",
      }),
      evidence({
        type: "memory_reinforced",
        phase: "reinforcement",
        outcome: "rejected",
        memory: { memoryId: "reinforced-blocked", type: "feedback", source: "compaction", status: "active" },
        reasonCodes: ["numbered_ref_reinforce", "reinforcement_window_blocked"],
        sessionHash: "command-session-a",
      }),
      evidence({
        type: "memory_replaced_numbered_ref",
        phase: "storage",
        outcome: "superseded",
        memory: { memoryId: "replace-old-same", type: "decision", source: "compaction", status: "superseded" },
        relations: [
          { role: "superseded", memory: { memoryId: "replace-old-same", type: "decision", source: "compaction", status: "superseded" } },
          { role: "superseded_by", memory: { memoryId: "replace-new-same", type: "decision", source: "compaction", status: "active" } },
        ],
        reasonCodes: ["numbered_ref_replace", "same_type_replace"],
        sessionHash: "command-session-b",
      }),
      evidence({
        type: "memory_replaced_numbered_ref",
        phase: "storage",
        outcome: "superseded",
        memory: { memoryId: "replace-old-cross", type: "project", source: "compaction", status: "superseded" },
        relations: [
          { role: "superseded", memory: { memoryId: "replace-old-cross", type: "project", source: "compaction", status: "superseded" } },
          { role: "superseded_by", memory: { memoryId: "replace-new-cross", type: "decision", source: "compaction", status: "active" } },
        ],
        reasonCodes: ["numbered_ref_replace", "cross_type_replace"],
        sessionHash: "command-session-b",
      }),
      evidence({
        type: "memory_replaced_numbered_ref",
        phase: "storage",
        outcome: "rejected",
        memory: { memoryId: "replace-protected-reinforced", type: "decision", source: "compaction", status: "active" },
        reasonCodes: ["protected_reinforced_target"],
        sessionHash: "command-session-c",
      }),
      evidence({
        type: "memory_replaced_numbered_ref",
        phase: "storage",
        outcome: "rejected",
        memory: { memoryId: "replace-protected-source", type: "feedback", source: "explicit", status: "active" },
        reasonCodes: ["protected_memory_source"],
        sessionHash: "command-session-c",
      }),
      evidence({
        type: "extraction_candidate_rejected",
        phase: "extraction",
        outcome: "rejected",
        memory: { type: "decision", source: "compaction" },
        reasonCodes: ["invalid_memory_ref"],
        textPreview: "REINFORCE [X3]",
        sessionHash: "command-session-c",
      }),
    ]);

    const stdout = await runMemoryDiag(["commands", "--workspace", root, "--verbose"]);

    assert.match(stdout, /compactions with command evidence: 3/);
    assert.match(stdout, /reinforce: 2/);
    assert.match(stdout, /replace: 4/);
    assert.match(stdout, /reinforced: 1/);
    assert.match(stdout, /superseded: 2/);
    assert.match(stdout, /rejected: 3/);
    assert.match(stdout, /blocked: 3/);
    assert.match(stdout, /invalid\/malformed commands: 1/);
    assert.match(stdout, /same-type replacements: 1/);
    assert.match(stdout, /cross-type replacements: 1/);
    assert.match(stdout, /Protected REPLACE blocked: 2 \(reinforced: 1, source: 1\)/);
    assert.match(stdout, /protected_reinforced_target: 1/);
    assert.match(stdout, /protected_memory_source: 1/);
    assert.match(stdout, /Latest command events/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory-diag commands json exposes protected replacement counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-commands-json-"));
  try {
    await appendEvidenceEvents(root, [
      evidence({
        type: "memory_replaced_numbered_ref",
        phase: "storage",
        outcome: "rejected",
        memory: { memoryId: "replace-protected-reinforced-json", type: "decision", source: "compaction", status: "active" },
        reasonCodes: ["protected_reinforced_target"],
        sessionHash: "json-command-session",
      }),
      evidence({
        type: "memory_replaced_numbered_ref",
        phase: "storage",
        outcome: "rejected",
        memory: { memoryId: "replace-protected-source-json", type: "feedback", source: "manual", status: "active" },
        reasonCodes: ["protected_memory_source"],
        sessionHash: "json-command-session",
      }),
    ]);

    const stdout = await runMemoryDiag(["commands", "--workspace", root, "--json"]);
    const parsed = JSON.parse(stdout) as {
      protectedReplacements: { total: number; protectedReinforcedTarget: number; protectedMemorySource: number };
      commands: { reinforce: number; replace: number };
      outcomes: { rejected: number };
    };

    assert.deepEqual(parsed.protectedReplacements, {
      total: 2,
      protectedReinforcedTarget: 1,
      protectedMemorySource: 1,
    });
    assert.equal(parsed.commands.replace, 2);
    assert.equal(parsed.commands.reinforce, 0);
    assert.equal(parsed.outcomes.rejected, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory-diag commands memory selector prints reinforcement detail", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-commands-memory-"));
  try {
    await setupMemoryCommandDetailFixture(root);

    const stdout = await runMemoryDiag(["commands", "--memory", "mem-detail", "--workspace", root]);

    assert.match(stdout, /Memory command diagnostics for mem-detail/);
    assert.match(stdout, /Current memory:/);
    assert.match(stdout, /status: active/);
    assert.match(stdout, /render: rendered/);
    assert.match(stdout, /Reinforcement summary:/);
    assert.match(stdout, /attempts: 7/);
    assert.match(stdout, /reinforced: 4/);
    assert.match(stdout, /rejected\/blocked: 3/);
    assert.match(stdout, /window blocked: 3/);
    assert.match(stdout, /block reasons: min_elapsed_window=1, same_session=1, unknown=1/);
    assert.match(stdout, /block details missing: 1/);
    assert.match(stdout, /same-session cross UTC day blocks: 1/);
    assert.match(stdout, /refs: M3/);
    assert.match(stdout, /blockReason=min_elapsed_window/);
    assert.match(stdout, /elapsedMs=604799999/);
    assert.match(stdout, /requiredElapsedMs=604800000/);
    assert.match(stdout, /sameSession=yes/);
    assert.match(stdout, /sameSession=no/);
    assert.match(stdout, /reinforcementMode=refresh_only/);
    assert.match(stdout, /legacyMissingTimestamp=yes/);
    assert.match(stdout, /crossUtcDay=yes/);
    assert.doesNotMatch(stdout, /render_selected/);
    assert.doesNotMatch(stdout, /raw-session-secret/);
    assert.doesNotMatch(stdout, /raw-last-session-secret/);
    assert.doesNotMatch(stdout, /raw-refresh-last-session-secret/);
    assertNoAttributionSafetyTerms(stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory-diag commands memory selector emits stable JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-commands-memory-json-"));
  try {
    await setupMemoryCommandDetailFixture(root);

    const stdout = await runMemoryDiag(["commands", "--memory", "mem-detail", "--workspace", root, "--json"]);
    const parsed = JSON.parse(stdout) as {
      version: 1;
      memoryId: string;
      current: { present: boolean; status?: string; renderStatus?: string };
      summary: {
        attempts: number;
        reinforced: number;
        rejectedOrBlocked: number;
        blocksByReason: Record<string, number>;
        blockDetailsMissing: number;
        sameSessionCrossUtcDayBlocks: number;
      };
      events: Array<{
        eventId: string;
        outcome: string;
        blockReason?: string;
        crossUtcDay?: boolean | "unknown";
        elapsedMs?: number;
        requiredElapsedMs?: number;
        sameSession?: boolean;
        legacyMissingTimestamp?: boolean;
        reinforcementMode?: string;
        instrumentationVersion?: number;
      }>;
    };

    assert.equal(parsed.version, 1);
    assert.equal(parsed.memoryId, "mem-detail");
    assert.equal(parsed.current.present, true);
    assert.equal(parsed.current.status, "active");
    assert.equal(parsed.current.renderStatus, "rendered");
    assert.equal(parsed.summary.attempts, 7);
    assert.equal(parsed.summary.reinforced, 4);
    assert.equal(parsed.summary.rejectedOrBlocked, 3);
    assert.equal(parsed.summary.blocksByReason.min_elapsed_window, 1);
    assert.equal(parsed.summary.blocksByReason.same_session, 1);
    assert.equal(parsed.summary.blocksByReason.unknown, 1);
    assert.equal(parsed.summary.blockDetailsMissing, 1);
    assert.equal(parsed.summary.sameSessionCrossUtcDayBlocks, 1);
    assert.equal(parsed.events.some(event => event.blockReason === "min_elapsed_window" && event.elapsedMs === 604_799_999 && event.requiredElapsedMs === 604_800_000 && event.sameSession === true), true);
    assert.equal(parsed.events.some(event => event.reinforcementMode === "increment" && event.elapsedMs === 604_800_000 && event.sameSession === false), true);
    assert.equal(parsed.events.some(event => event.reinforcementMode === "refresh_only" && event.elapsedMs === 604_800_000 && event.sameSession === true), true);
    assert.equal(parsed.events.some(event => event.legacyMissingTimestamp === true), true);
    assert.equal(parsed.events.every(event => event.instrumentationVersion === 3), true);
    assert.equal(parsed.events.some(event => event.blockReason === "same_session" && event.crossUtcDay === true), true);
    assert.equal(parsed.events.some(event => event.blockReason === "unknown" && event.crossUtcDay === "unknown"), true);
    assert.equal(JSON.stringify(parsed).includes("command-session"), false);
    assert.equal(JSON.stringify(parsed).includes("command-message"), false);
    assert.equal(JSON.stringify(parsed).includes("Detail drill-down memory remains current"), false);
    assert.equal(JSON.stringify(parsed).includes("raw-session-secret"), false);
    assert.equal(JSON.stringify(parsed).includes("raw-last-session-secret"), false);
    assert.equal(JSON.stringify(parsed).includes("raw-refresh-last-session-secret"), false);
    assertNoAttributionSafetyTerms(stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory-diag commands memory selector reports empty evidence neutrally", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-commands-memory-empty-"));
  try {
    await writeWorkspaceStore(root, [entry("mem-empty", "Memory without reinforcement command evidence", "feedback")]);

    const stdout = await runMemoryDiag(["commands", "--memory", "mem-empty", "--workspace", root]);

    assert.match(stdout, /Memory command diagnostics for mem-empty/);
    assert.match(stdout, /No reinforcement command evidence found for mem-empty\./);
    assertNoAttributionSafetyTerms(stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory-diag revert dry-run plans changes without mutating", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-revert-dry-run-"));
  try {
    const { original, replacement } = replacementFixture();
    await writeWorkspaceStore(root, [original, replacement]);
    await appendEvidenceEvents(root, [replacementEvidence(original, replacement)]);
    const path = await workspaceMemoryPath(root);
    const before = await readFile(path, "utf8");

    const stdout = await runMemoryDiag(["revert", "--workspace", root, "--memory", replacement.id]);
    const after = await readFile(path, "utf8");
    const reverts = await queryEvidenceEvents(root, { types: ["memory_reverted_numbered_ref"] });

    assert.match(stdout, /Memory revert dry run/);
    assert.match(stdout, /replacement: mem-replacement/);
    assert.match(stdout, /original: mem-original/);
    assert.match(stdout, /No changes applied/);
    assert.equal(after, before);
    assert.equal(reverts.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory-diag revert apply restores original and emits evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-revert-apply-"));
  try {
    const { original, replacement } = replacementFixture();
    await writeWorkspaceStore(root, [original, replacement]);
    const [replaceEvent] = await appendEvidenceEvents(root, [replacementEvidence(original, replacement)]);

    const stdout = await runMemoryDiag(["revert", "--workspace", root, "--event", replaceEvent.eventId, "--apply"]);
    const stored = JSON.parse(await readFile(await workspaceMemoryPath(root), "utf8")) as WorkspaceMemoryStore;
    const restored = stored.entries.find(item => item.id === original.id);
    const supersededReplacement = stored.entries.find(item => item.id === replacement.id);
    const reverts = await queryEvidenceEvents(root, { types: ["memory_reverted_numbered_ref"], outcomes: ["recovered"] });
    const commandsStdout = await runMemoryDiag(["commands", "--workspace", root, "--verbose"]);

    assert.match(stdout, /Memory revert applied/);
    assert.equal(restored?.status, "active");
    assert.equal(supersededReplacement?.status, "superseded");
    assert.ok(restored?.updatedAt && restored.updatedAt !== original.updatedAt);
    assert.ok(supersededReplacement?.updatedAt && supersededReplacement.updatedAt !== replacement.updatedAt);
    assert.equal(reverts.length, 1);
    assert.equal(reverts[0].type, "memory_reverted_numbered_ref");
    assert.equal(reverts[0].outcome, "recovered");
    assert.ok(reverts[0].reasonCodes.includes("manual_revert_numbered_ref"));
    assert.ok(reverts[0].relations?.some(relation => relation.role === "recovered" && relation.memory?.memoryId === original.id));
    assert.match(commandsStdout, /memory_reverted_numbered_ref/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory-diag revert rejects unsafe requests", async () => {
  const missingOriginalRoot = await mkdtemp(join(tmpdir(), "opencode-memory-diag-revert-missing-original-"));
  const replacementSupersededRoot = await mkdtemp(join(tmpdir(), "opencode-memory-diag-revert-replacement-superseded-"));
  const laterSupersessionRoot = await mkdtemp(join(tmpdir(), "opencode-memory-diag-revert-later-supersession-"));
  const wrongEventRoot = await mkdtemp(join(tmpdir(), "opencode-memory-diag-revert-wrong-event-"));
  try {
    const { original, replacement } = replacementFixture();

    await writeWorkspaceStore(missingOriginalRoot, [replacement]);
    await appendEvidenceEvents(missingOriginalRoot, [replacementEvidence(original, replacement)]);
    await assert.rejects(
      runMemoryDiagResult(["revert", "--workspace", missingOriginalRoot, "--memory", replacement.id]),
      (error: unknown) => {
        const err = error as { stderr?: string };
        assert.match(err.stderr ?? "", /revert rejected: original memory mem-original is missing/);
        return true;
      },
    );

    await writeWorkspaceStore(replacementSupersededRoot, [original, { ...replacement, status: "superseded" }]);
    await appendEvidenceEvents(replacementSupersededRoot, [replacementEvidence(original, replacement)]);
    await assert.rejects(
      runMemoryDiagResult(["revert", "--workspace", replacementSupersededRoot, "--memory", replacement.id]),
      (error: unknown) => {
        const err = error as { stderr?: string };
        assert.match(err.stderr ?? "", /revert rejected: replacement memory mem-replacement is not active/);
        return true;
      },
    );

    const later = { ...entry("mem-later", "Later active supersession", "decision"), supersedes: [replacement.id] };
    await writeWorkspaceStore(laterSupersessionRoot, [original, replacement, later]);
    await appendEvidenceEvents(laterSupersessionRoot, [replacementEvidence(original, replacement)]);
    await assert.rejects(
      runMemoryDiagResult(["revert", "--workspace", laterSupersessionRoot, "--memory", replacement.id]),
      (error: unknown) => {
        const err = error as { stderr?: string };
        assert.match(err.stderr ?? "", /revert rejected: replacement memory mem-replacement is superseded by active memory mem-later/);
        return true;
      },
    );

    const [wrongEvent] = await appendEvidenceEvents(wrongEventRoot, [evidence({ type: "promotion_promoted", phase: "promotion", outcome: "promoted" })]);
    await assert.rejects(
      runMemoryDiagResult(["revert", "--workspace", wrongEventRoot, "--event", wrongEvent.eventId]),
      (error: unknown) => {
        const err = error as { stderr?: string };
        assert.match(err.stderr ?? "", /revert rejected: event .* is not a memory_replaced_numbered_ref event/);
        return true;
      },
    );
  } finally {
    await rm(missingOriginalRoot, { recursive: true, force: true });
    await rm(replacementSupersededRoot, { recursive: true, force: true });
    await rm(laterSupersessionRoot, { recursive: true, force: true });
    await rm(wrongEventRoot, { recursive: true, force: true });
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

    const stdout = await runMemoryDiagStatusVerbose(root);

    assert.match(stdout, /Dormancy:/);
    assert.match(stdout, /wall days since activity: 19\.0/);
    assert.match(stdout, /dormant discount active: yes/);
    assert.match(stdout, /dormant days past grace: 5\.0/);
    assert.match(stdout, /Top rendered candidates:/);
    assert.match(stdout, /Weakest active memories:/);
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

    const stdout = await runMemoryDiagStatusVerbose(root);

    assert.match(stdout, /rendered: 28/);
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

    const stdout = await runMemoryDiagStatusVerbose(root);

    assert.match(stdout, /lastActivityAt: \(missing\)/);
    assert.match(stdout, /wall days since activity: unknown/);
    assert.match(stdout, /dormant discount active: no/);
    assert.match(stdout, /Top rendered candidates:\n\s+\(none\)/);
    assert.match(stdout, /Weakest active memories:\n\s+\(none\)/);
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

    const human = await runMemoryDiagStatusVerbose(root);
    const jsonText = await runMemoryDiag(["status", "--workspace", root, "--json"]);
    const parsed = JSON.parse(jsonText) as {
      version: 1;
      summary: { storedActive: number; rendered: number; pending: number; rejectedLast7Days: number; corruptStoresQuarantinedLast30Days: number };
      memories: Array<{ id: string; status: string; reasonCodes: string[]; evidenceEventIds: string[]; textPreview?: string }>;
      recentEvents: Array<{ eventId: string; type: string; outcome: string; createdAt: string; reasonCodes: string[] }>;
    };

    assert.equal(parsed.version, 1);
    assert.equal(parsed.summary.storedActive, Number(human.match(/active: (\d+) \/ 28/)?.[1]));
    assert.equal(parsed.summary.rendered, Number(human.match(/rendered: (\d+)/)?.[1]));
    assert.equal(parsed.summary.pending, 1);
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

test("memory-diag explain --memory prints lifecycle relations and redacts secrets", async () => {
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

    const stdout = await runMemoryDiag(["explain", "--workspace", root, "--memory", "mem-life"]);

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

test("memory-diag explain positional memory id prints lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-explain-positional-"));
  try {
    await writeWorkspaceStore(root, [
      { ...entry("mem-life", "Old token password: sushi should be redacted", "decision"), status: "superseded" as const },
      entry("mem-new", "Replacement memory", "decision"),
    ]);
    await appendEvidenceEvents(root, [
      evidence({ type: "extraction_candidate_accepted", phase: "extraction", outcome: "accepted", memory: { memoryId: "mem-life", type: "decision", source: "compaction" }, reasonCodes: ["quality_gate_passed"], textPreview: "password: sushi" }),
      evidence({ type: "promotion_superseded", phase: "promotion", outcome: "superseded", memory: { memoryId: "mem-life", type: "decision", source: "compaction" }, relations: [{ role: "superseded_by", memory: { memoryId: "mem-new" } }], reasonCodes: ["superseded_existing"] }),
    ]);

    const stdout = await runMemoryDiag(["explain", "mem-life", "--workspace", root]);

    assert.match(stdout, /Memory mem-life: omitted_superseded/);
    assert.match(stdout, /Lifecycle:/);
    assert.match(stdout, /promotion_superseded: superseded; reasons=superseded_existing; .*superseded_by=mem-new/);
    assert.match(stdout, /Superseded by:\n- mem-new/);
    assert.ok(!stdout.includes("sushi"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory-diag explain --memory reports unknown IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-trace-unknown-"));
  try {
    const stdout = await runMemoryDiag(["explain", "--workspace", root, "--memory", "missing-memory"]);
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

test("status verbose output includes summary and aggregate inspection counts", async () => {
  const root = await setupQualityFixture();
  try {
    const stdout = await runMemoryDiag(["status", "--workspace", root, "--verbose"]);

    assert.match(stdout, /Memory status inspection/);
    assert.match(stdout, /Summary: Workspace memory quality is degraded:/);
    assert.match(stdout, /Caps:\n\s+active: 28 \/ 28/);
    assert.match(stdout, /decision: 14 \/ 12 FULL/);
    assert.match(stdout, /feedback: 14 \/ 10 FULL/);
    assert.match(stdout, /Retention clocks:\n\s+present: 27\n\s+missing: 0\n\s+invalid: 1/);
    assert.match(stdout, /Evidence:\n\s+current with evidence: 1\n\s+current without evidence: 27/);
    assert.match(stdout, /Rejection scoping:\n\s+total records: 2\n\s+workspace scoped: 1\n\s+legacy unscoped: 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status --json includes summary status fields", async () => {
  const root = await setupQualityFixture();
  try {
    const stdout = await runMemoryDiag(["status", "--workspace", root, "--json"]);
    const parsed = JSON.parse(stdout) as {
      summary: { storedActive: number; status: string; evidenceCoveragePercent: number; needsAttention: string[] };
    };

    assert.equal(parsed.summary.storedActive, LONG_TERM_LIMITS.maxEntries);
    assert.equal(parsed.summary.status, "degraded");
    assert.equal(typeof parsed.summary.evidenceCoveragePercent, "number");
    assert.ok(parsed.summary.needsAttention.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status default output is concise and actionable", async () => {
  const root = await setupQualityFixture();
  try {
    const stdout = await runMemoryDiag(["status", "--workspace", root]);

    assert.match(stdout, /OK Memory status|WARNING Memory status|DEGRADED Memory status/);
    assert.match(stdout, /Key metrics:/);
    assert.match(stdout, /active memories:/);
    assert.match(stdout, /rendered:/);
    assert.match(stdout, /pending:/);
    assert.match(stdout, /rejected 7d:/);
    assert.match(stdout, /evidence coverage:/);
    assert.match(stdout, /Needs attention:/);
    assert.match(stdout, /Suggested next steps:/);
    assert.doesNotMatch(stdout, /Caps:|Retention clocks:|Rejection scoping:|Dormancy:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status --verbose includes detailed diagnostics", async () => {
  const root = await setupQualityFixture();
  try {
    const stdout = await runMemoryDiag(["status", "--workspace", root, "--verbose"]);

    assert.match(stdout, /Memory status inspection/);
    assert.match(stdout, /Caps:/);
    assert.match(stdout, /Retention clocks:/);
    assert.match(stdout, /Evidence:/);
    assert.match(stdout, /Rejection scoping:/);
    assert.match(stdout, /Dormancy:/);
    assert.match(stdout, /Top rendered candidates:/);
    assert.match(stdout, /Weakest active memories:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status --json includes additive summary fields", async () => {
  const root = await setupQualityFixture();
  try {
    const stdout = await runMemoryDiag(["status", "--workspace", root, "--json"]);
    const parsed = JSON.parse(stdout) as {
      version: 1;
      summary: {
        storedActive: number;
        rendered: number;
        pending: number;
        rejectedLast7Days: number;
        corruptStoresQuarantinedLast30Days: number;
        status?: string;
        evidenceCoveragePercent?: number;
        needsAttention?: string[];
        suggestedNextSteps?: string[];
      };
      memories: unknown[];
      recentEvents: unknown[];
    };

    assert.equal(parsed.version, 1);
    assert.equal(typeof parsed.summary.storedActive, "number");
    assert.equal(typeof parsed.summary.rendered, "number");
    assert.equal(typeof parsed.summary.pending, "number");
    assert.equal(typeof parsed.summary.rejectedLast7Days, "number");
    assert.equal(typeof parsed.summary.corruptStoresQuarantinedLast30Days, "number");
    assert.match(parsed.summary.status ?? "", /ok|warning|degraded/);
    assert.equal(typeof parsed.summary.evidenceCoveragePercent, "number");
    assert.ok(Array.isArray(parsed.summary.needsAttention));
    assert.ok(Array.isArray(parsed.summary.suggestedNextSteps));
    assert.ok(Array.isArray(parsed.memories));
    assert.ok(Array.isArray(parsed.recentEvents));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status non-tty and --no-emoji use text labels", async () => {
  const root = await setupQualityFixture();
  try {
    const stdout = await runMemoryDiag(["status", "--workspace", root, "--no-emoji"]);

    assert.match(stdout, /^DEGRADED Memory status/);
    assert.doesNotMatch(stdout, /🧠|⚠️|✖️/);
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

test("missing default output summarizes unknown disappearances", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-disappear-"));
  try {
    await writeWorkspaceStore(root, [entry("current", "Current memory", "feedback")]);
    await appendEvidenceEvents(root, [
      evidence({ type: "promotion_promoted", phase: "promotion", outcome: "promoted", memory: { memoryId: "historical-unknown", type: "decision", source: "compaction" }, reasonCodes: ["new_workspace_entry"] }),
    ]);

    const stdout = await runMemoryDiag(["missing", "--workspace", root]);

    assert.match(stdout, /Missing memory summary/);
    assert.match(stdout, /Total missing: 1/);
    assert.match(stdout, /Explained: 0/);
    assert.match(stdout, /Needs review: 1/);
    assert.match(stdout, /Unknown disappearance samples:/);
    assert.match(stdout, /- historical-unknown terminal=unknown reasons=none/);
    assert.doesNotMatch(stdout, /Memory historical-unknown:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing --verbose shows capacity details and render omitted type-cap observations", async () => {
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

    const stdout = await runMemoryDiag(["missing", "--workspace", root, "--verbose"]);

    assert.match(stdout, /Missing memory summary/);
    assert.match(stdout, /capacity-loser: historical_absent_with_reason terminal=memory_removed_capacity reasons=type_cap/);
    assert.match(stdout, /events:/);
    assert.match(stdout, /memory_removed_capacity details: .*globalCap=28 .*typeCap=10/);
    assert.match(stdout, /render-loser: historical_absent_with_reason terminal=render_omitted reasons=type_cap/);
    assert.match(stdout, /render_omitted type-cap observation: reasons=type_cap/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing --json includes disappearances and additive summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-missing-json-"));
  try {
    await writeWorkspaceStore(root, [entry("current", "Current memory", "feedback")]);
    await appendEvidenceEvents(root, [
      evidence({ type: "promotion_promoted", phase: "promotion", outcome: "promoted", memory: { memoryId: "historical-unknown", type: "decision", source: "compaction" }, reasonCodes: ["new_workspace_entry"] }),
    ]);

    const stdout = await runMemoryDiag(["missing", "--workspace", root, "--json"]);
    const parsed = JSON.parse(stdout) as { disappearances: Array<{ id: string }>; summary: { total: number; explained: number; needsReview: number } };

    assert.equal(parsed.summary.total, 1);
    assert.equal(parsed.summary.explained, 0);
    assert.equal(parsed.summary.needsReview, 1);
    assert.equal(parsed.disappearances[0]?.id, "historical-unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejected default output is concise with top reasons and samples", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-rejected-"));
  try {
    const key = await workspaceKey(root);
    const now = new Date().toISOString();
    await writeRejectionRecords([
      { timestamp: now, workspaceKey: key, type: "decision", source: "compaction", text: "Keep memory system boundary stable", reasons: ["bad_decision"] },
      { timestamp: now, workspaceKey: key, type: "feedback", source: "explicit", text: "Remember password: sushi from rejected sample", reasons: ["raw_secret", "bad_feedback"] },
      { timestamp: "2020-01-01T00:00:00.000Z", workspaceKey: key, type: "project", source: "manual", text: "Old rejected sample", reasons: ["bad_project"] },
    ]);

    const stdout = await runMemoryDiag(["rejected", "--workspace", root]);

    assert.match(stdout, /Rejected memory summary/);
    assert.match(stdout, /Total rejected: 3/);
    assert.match(stdout, /Unique texts: 3/);
    assert.match(stdout, /Top reasons:/);
    assert.match(stdout, /bad_decision\s+1/);
    assert.match(stdout, /False-positive risk: low/);
    assert.match(stdout, /Recent samples:/);
    assert.match(stdout, /\[decision\] Keep memory system boundary stable/);
    assert.ok(!stdout.includes("sushi"));
    assert.doesNotMatch(stdout, /By origin:|Reason distribution \(raw records\):|Possible false-positive groups/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejected --verbose includes detailed distributions", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-rejected-verbose-"));
  try {
    const key = await workspaceKey(root);
    const now = new Date().toISOString();
    await writeRejectionRecords([
      { timestamp: now, workspaceKey: key, type: "decision", source: "compaction", text: "Memory system schema boundary should remain stable", reasons: ["bad_decision"] },
      { timestamp: now, workspaceKey: key, type: "feedback", source: "explicit", text: "Status update completed", reasons: ["bad_feedback"] },
    ]);

    const stdout = await runMemoryDiag(["rejected", "--workspace", root, "--verbose"]);

    assert.match(stdout, /Rejected memory summary/);
    assert.match(stdout, /Reason distribution \(raw records\):/);
    assert.match(stdout, /Reason distribution \(unique text\):/);
    assert.match(stdout, /By origin:/);
    assert.match(stdout, /Possible false-positive groups \(heuristic, not deterministic\):/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejected --json includes quality summary and false-positive risk", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-memory-diag-rejected-json-"));
  try {
    const key = await workspaceKey(root);
    const now = new Date().toISOString();
    await writeRejectionRecords([
      { timestamp: now, workspaceKey: key, type: "decision", source: "compaction", text: "Memory system schema boundary should remain stable", reasons: ["bad_decision"] },
      { timestamp: now, workspaceKey: key, type: "decision", source: "compaction", text: "Memory system schema boundary should remain stable", reasons: ["bad_decision"] },
    ]);

    const stdout = await runMemoryDiag(["rejected", "--workspace", root, "--json"]);
    const parsed = JSON.parse(stdout) as { totalRecords: number; uniqueTexts: number; falsePositiveRisk: string; possibleFalsePositiveGroups: Record<string, { count: number }> };

    assert.equal(parsed.totalRecords, 2);
    assert.equal(parsed.uniqueTexts, 1);
    assert.equal(parsed.falsePositiveRisk, "high");
    assert.equal(parsed.possibleFalsePositiveGroups.architecture_like_possible_false_positive.count, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
