import type { LongTermMemoryEntry } from "../../src/types.ts";

const now = "2026-04-28T00:00:00.000Z";

function mem(
  id: string,
  type: LongTermMemoryEntry["type"],
  text: string,
  source: LongTermMemoryEntry["source"] = "compaction",
): LongTermMemoryEntry {
  return {
    id,
    type,
    text,
    source,
    confidence: source === "explicit" ? 1 : 0.75,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

export const reviewerCurrent28Fixture: LongTermMemoryEntry[] = [
  // High-value durable entries. These should survive.
  mem("good_feedback_language", "feedback", "User prefers architecture reviews in Traditional Chinese", "explicit"),
  mem("good_feedback_direct", "feedback", "User wants direct architecture feedback with concrete file paths", "explicit"),
  mem("good_feedback_no_manual_cleanup", "feedback", "User prefers automatic memory cleanup over manual cleanup instructions", "explicit"),
  mem("good_decision_no_extra_api", "decision", "Do not add extra LLM API calls for memory consolidation"),
  mem("good_decision_no_semantic_merge", "decision", "Memory dedupe must use exact canonical keys and generic URL/path identity only"),
  mem("good_decision_no_render_tracking", "decision", "Do not use rendered-memory access tracking as evidence"),
  mem("good_reference_frozen", "reference", "Workspace memory is rendered as a frozen system[1] snapshot; pending memories remain in hot session state until compaction"),
  mem("good_project_plugin", "project", "The project is an OpenCode plugin using TypeScript and local JSON stores"),
  mem("good_reference_accounting", "reference", "Promotion accounting reports promoted, absorbed, superseded, and rejected outcomes"),

  // Pseudo feedback/decision/progress snapshots. These should be superseded/rejected.
  mem("bad_feedback_wave_done", "feedback", "Wave 1 completed successfully and all tests passed"),
  mem("bad_feedback_plan_done", "feedback", "Plan 1 critical stability fixes were implemented"),
  mem("bad_feedback_session_note", "feedback", "The assistant reviewed the code reviewer feedback and updated the plan"),
  mem("bad_feedback_impl_note", "feedback", "Implemented owner-aware pending journal cleanup in plugin.ts"),
  mem("bad_decision_commit", "decision", "Commit 53aa6d3 completed consolidation accounting"),
  mem("bad_decision_tests", "decision", "180 tests pass and 0 tests fail after the latest change"),
  mem("bad_decision_pr_status", "decision", "PR1 is done and PR2 is ready to start"),
  mem("bad_project_files", "project", "Modified src/plugin.ts src/workspace-memory.ts src/pending-journal.ts during the last wave"),
  mem("bad_project_wave", "project", "Wave 3 finished after cache bounds and Bearer redaction were added"),
  mem("bad_reference_commit", "reference", "Commit a762e86 contains the owner scope fix"),
  mem("bad_reference_ci", "reference", "CI compatibility run 25033906652 passed"),
  mem("bad_reference_error", "reference", "TypeError: Cannot read properties of undefined"),
  mem("bad_project_current", "project", "Currently running npm test before continuing"),

  // Borderline implementation facts. Reject unless they are written as future rules.
  mem("bad_decision_impl_detail", "decision", "dedupeLongTermEntriesWithAccounting was updated in the previous session"),
  mem("bad_feedback_internal", "feedback", "The migration writes to disk when redaction changes content"),
  mem("bad_reference_tmp", "reference", "storage.test.ts had a flaky cross-process test in CI"),

  // Durable future-facing rules. These should survive.
  mem("good_decision_quality", "decision", "Reject completion and progress statements before storing compaction memory candidates"),
  mem("good_decision_quality_shared", "decision", "Use one shared memory quality gate for extraction and migration"),
  mem("good_reference_quality_migration", "reference", "Quality cleanup migration supersedes low-quality compaction memories and does not touch explicit memories"),
];

export const expectedAcceptedFixtureIds = new Set([
  "good_feedback_language",
  "good_feedback_direct",
  "good_feedback_no_manual_cleanup",
  "good_decision_no_extra_api",
  "good_decision_no_semantic_merge",
  "good_decision_no_render_tracking",
  "good_reference_frozen",
  "good_project_plugin",
  "good_reference_accounting",
  "good_decision_quality",
  "good_decision_quality_shared",
  "good_reference_quality_migration",
]);
