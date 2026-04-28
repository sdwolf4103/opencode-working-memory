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
  "medical-atlas": [
    mem("ma_ui_rule", "feedback", "UI 要統一風格：兩個表格都要 scrollable，約 20 rows", "active", "durable UI rule without user preference keyword"),
    mem("ma_csp_rule", "feedback", "架構師建議中期將 CSP 改為 nonce/hash，而非 'unsafe-inline'", "active", "durable architecture recommendation"),
    mem("ma_form_rule", "decision", "Form 添加防御性 action/method 屬性，避免 JS 失效時 GET 首頁", "active", "declarative design rule"),
    mem("ma_logging_rule", "decision", "Cloud Logging filter 需支援多種 log 格式（jsonPayload.event_type, jsonPayload.message, textPayload）", "active", "durable spec using 需支援"),
  ],
  "opencode-record": [
    mem("or_phase_snapshot", "project", "後端健康改進計劃已完成 Phase 1-4", "superseded", "progress snapshot"),
    mem("or_test_snapshot", "project", "測試套件：1237 tests pass, 226 suites", "superseded", "test count snapshot"),
    mem("or_sync_snapshot", "project", "USB 同步：37 個文件（bundles, server, frontend, tests, docs）", "superseded", "file sync snapshot"),
  ],
  "agent-reports": [
    mem("ar_plan_decision", "feedback", "架構師建議執行 P3 前先確認有實際需求", "active", "durable plan decision"),
    mem("ar_reviewer_fallback", "feedback", "`comprehensive-code-reviewer` subagent unreliable; use `phase-verifier` as fallback", "active", "durable workaround rule"),
    mem("ar_wave_rule", "feedback", "每個 Wave 結束要找 verifier 確認，全部結束找 code review", "active", "durable workflow rule"),
    mem("ar_remote_headers", "decision", "Remote headers 透過 `requestInit: { headers }` 傳入 `StreamableHTTPClientTransport`", "active", "declarative API rule"),
    mem("ar_signal_order", "decision", "Graceful process cleanup signal order: SIGINT (300ms) → SIGTERM (700ms) → SIGKILL", "active", "durable process cleanup spec"),
    mem("ar_ownership", "decision", "`McpRuntimeState` ownership model: CLI owns both runtime and mcpRuntime, dispose order is runtime first", "active", "durable ownership model"),
    mem("ar_retry_policy", "decision", "Recovery retry policy: only once per tool call, only for transport/session failures", "active", "durable retry policy"),
  ],
  "pdf-extraction": [
    mem("pe_user_cycle", "feedback", "User 要求完整的 plan-review-feedback-modify-verify 循環，不是直接執行", "active", "mixed-language user workflow preference"),
    mem("pe_ollama_batch", "feedback", "Ollama 大批量嵌入需要控制批次大小（20-50）和請求間隔", "active", "durable operational knowledge"),
    mem("pe_option_b", "decision", "Phase 2 Fix 採用 Option B：multi-profile search grouping", "active", "design decision using 採用"),
    mem("pe_single_source", "decision", "MCP source 維持單一 `book`，書籍身份在 source ID", "active", "design constraint using 維持"),
    mem("pe_endpoint", "decision", "Ollama endpoint is `/api/embed` (not `/api/embeddings`) with `\"input\"` field", "active", "declarative API fact"),
    mem("pe_filter_pipeline", "decision", "Filter pipeline: pre-chunk filtering (not post-chunk) to prevent embedding contamination", "active", "durable architecture rule"),
    mem("pe_do_not_delete", "decision", "不刪除孤立的 reference-like 行（正文中的 \"et al.\" 等是合法引用）", "active", "do-not rule not matching current 不要 pattern"),
  ],
  "self-repo": [
    mem("sr_author_credit", "feedback", "User insists on preserving external contributor author credit and uses merge workflow", "active", "durable preference using insists"),
    mem("sr_branding", "decision", "Product branding is \"OpenCode Working Memory\" without \"Plugin\" in the name", "active", "durable branding rule"),
    mem("sr_changelog", "decision", "CHANGELOG version scope follows git tags: changes from v1.2.3 tag through HEAD belong to next version", "active", "durable release rule"),
  ],
};
