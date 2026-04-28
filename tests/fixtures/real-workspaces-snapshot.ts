import type { LongTermMemoryEntry } from "../../src/types.ts";

export type RealWorkspaceFixtureEntry = LongTermMemoryEntry & {
  expectedAfterMigration: "active" | "superseded";
  expectation: string;
};

const baseTimestamp = "2026-04-28T00:00:00.000Z";

function mem(
  id: string,
  type: LongTermMemoryEntry["type"],
  text: string,
  expectedAfterMigration: "active" | "superseded",
  expectation: string,
): RealWorkspaceFixtureEntry {
  return {
    id,
    type,
    text,
    source: "compaction",
    confidence: 0.75,
    status: "active",
    createdAt: baseTimestamp,
    updatedAt: baseTimestamp,
    staleAfterDays: type === "feedback" ? undefined : 45,
    expectedAfterMigration,
    expectation,
  };
}

export const REAL_WORKSPACE_FIXTURES: Record<string, RealWorkspaceFixtureEntry[]> = {
  "workspace-alpha": [
    mem("alpha_ui_rule", "feedback", "UI should have consistent style: both tables scrollable, about 20 rows", "active", "durable UI rule without user preference keyword"),
    mem("alpha_csp_rule", "feedback", "Architecture recommendation: migrate the content security policy to nonce or hash rules rather than unsafe inline scripts", "active", "durable architecture recommendation"),
    mem("alpha_form_rule", "decision", "Form uses defensive action and method attributes so the fallback does not navigate to the home page when scripts fail", "active", "declarative design rule"),
    mem("alpha_logging_rule", "decision", "Cloud logging filter supports multiple log formats: structured event type, structured message, and text payload", "active", "durable declarative logging spec"),
  ],
  "workspace-beta": [
    mem("beta_phase_snapshot", "project", "Backend health improvement plan completed Phase 1-4", "superseded", "progress snapshot"),
    mem("beta_test_snapshot", "project", "Test suite: 1237 tests pass, 226 suites", "superseded", "test count snapshot"),
    mem("beta_sync_snapshot", "project", "External drive synced 37 files including bundles, service, frontend, tests, and docs", "superseded", "file sync snapshot"),
  ],
  "workspace-gamma": [
    mem("gamma_need_check", "feedback", "Architecture recommendation: confirm actual demand before executing the later priority phase", "active", "durable plan decision"),
    mem("gamma_review_fallback", "feedback", "Primary review automation can be unreliable; use phase verification as the fallback", "active", "durable workaround rule"),
    mem("gamma_wave_rule", "feedback", "Each wave should end with verifier confirmation, and the full implementation should end with code review", "active", "durable workflow rule"),
    mem("gamma_remote_headers", "decision", "Remote headers are passed through the HTTP transport request initialization headers option", "active", "declarative API rule"),
    mem("gamma_signal_order", "decision", "Graceful process cleanup signal order: interrupt for 300ms, terminate for 700ms, then kill", "active", "durable process cleanup spec"),
    mem("gamma_ownership", "decision", "Runtime state ownership model: the command-line entrypoint owns both runtime objects, and disposal order is primary runtime first", "active", "durable ownership model"),
    mem("gamma_retry_policy", "decision", "Recovery retry policy: only once per tool call, only for transport or session failures", "active", "durable retry policy"),
  ],
  "workspace-delta": [
    mem("delta_user_cycle", "feedback", "User requires a complete plan, review, feedback, modify, and verify loop rather than direct execution", "active", "user workflow preference"),
    mem("delta_batching", "feedback", "Large-batch embedding requires controlled batch size around 20 to 50 items and a delay between requests", "active", "durable operational knowledge"),
    mem("delta_option_b", "decision", "Phase 2 fix adopted Option B: grouped search across multiple profiles", "active", "design decision using adopted"),
    mem("delta_single_source", "decision", "MCP source keeps a single generic source type, with item identity encoded in the source ID", "active", "design constraint using keeps"),
    mem("delta_endpoint", "decision", "Embedding service endpoint is `/api/embed` rather than `/api/embeddings`, with the input field in the request body", "active", "declarative API fact"),
    mem("delta_filter_pipeline", "decision", "Filter pipeline uses pre-chunk filtering rather than post-chunk filtering to prevent embedding contamination", "active", "durable architecture rule"),
    mem("delta_do_not_delete", "decision", "Do not delete isolated reference-like lines because citation fragments in body text can be valid references", "active", "do-not rule"),
  ],
  "workspace-epsilon": [
    mem("epsilon_author_credit", "feedback", "User insists on preserving external contributor author credit and uses merge workflow", "active", "durable preference using insists"),
    mem("epsilon_branding", "decision", "Product branding is \"Generic Working Memory\" without \"Plugin\" in the name", "active", "durable branding rule"),
    mem("epsilon_changelog", "decision", "Changelog version scope follows release tags: changes from the previous version tag through the current branch belong to the next version", "active", "durable release rule"),
  ],
};
