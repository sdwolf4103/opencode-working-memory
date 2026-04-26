import { createHash } from "crypto";
import type { ActiveFile, LongTermMemoryEntry, LongTermType, OpenError } from "./types.ts";
import { LONG_TERM_LIMITS } from "./types.ts";

function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function hash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

/**
 * Check if a memory request is negated (e.g., "不要記住", "don't remember").
 * Uses structured adjacency detection to avoid false positives.
 */
function isNegatedMemoryRequest(text: string, matchIndex: number): boolean {
  const prefix = text.slice(Math.max(0, matchIndex - 30), matchIndex);

  // Chinese negative: 不要/別/不用 + optional 幫我, must be adjacent to trigger
  if (/(?:不要|別|别|不用|不需要|勿)\s*(?:幫我|帮我)?\s*$/u.test(prefix)) {
    return true;
  }

  // English negative: do not / don't / never / not + optional please, must be adjacent to trigger
  if (/(?:do\s+not|don't|dont|never|not)\s+(?:please\s+)?$/i.test(prefix)) {
    return true;
  }

  return false;
}

export function extractExplicitMemories(text: string): LongTermMemoryEntry[] {
  // 注意：所有pattern必須有 g flag，因為使用 matchAll()
  // Pattern 必須在行首匹配，避免匹配到句子中間的非指令式用法
  const patterns = [
    // 中文：請/幫我 + 記住 + 可選後綴
    /(?:^|\n)\s*(?:请|請)?(?:帮我|幫我)?(?:记住|記住)(?:这一点|這一點|这点|這點|这个|這個)?[:：,，]?\s*(.+)$/gim,
    // 英文：remember this/that - 必須在行首，避免 "to remember" 非指令匹配
    /(?:^|\n)\s*(?:please\s+)?remember\s+(?:this|that)?[:：,，]?\s*(.+)$/gim,
    // save/add to memory
    /(?:^|\n)\s*(?:please\s+)?(?:save|add)\s+(?:this|that)?\s*(?:to|in)\s+memory[:：,，]?\s*(.+)$/gim,
    // commit to memory
    /(?:^|\n)\s*(?:please\s+)?commit\s+(?:this|that)?\s*to memory[:：,，]?\s*(.+)$/gim,
    // going forward / from now on
    /(?:从现在开始|從現在開始|从今以后|從今以後|from now on|going forward)[:：,，]?\s*(.+)$/gim,
    // 偏好
    /(?:我的偏好是|我偏好|以后请|以後請|以后都|以後都)[:：,，]?\s*(.+)$/gim,
    /(?:^|\n)\s*(?:my preference is|i prefer)[:：,，]?\s*(.+)$/gim,
  ];

  const now = new Date().toISOString();
  const entries: LongTermMemoryEntry[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const body = match[1]?.trim();
      if (!body || body.length < 8) continue;
      
      // Calculate actual trigger position (after possible newline)
      const triggerIndex = match.index! + (match[0].match(/^[\s\n]*/)?.[0]?.length || 0);
      
      // Check if this is a negated request (e.g., "不要記住")
      if (isNegatedMemoryRequest(text, triggerIndex)) continue;
      
      // Check if it's a deferral (e.g., "later", "next time")
      if (/^(再说|再說|later|next time)$/i.test(body)) continue;

      // Dedupe by canonical body
      const key = body.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(key)) continue;
      seen.add(key);

      const type = classifyExplicitMemory(body);
      entries.push({
        id: id("mem"),
        type,
        text: body.slice(0, LONG_TERM_LIMITS.maxEntryTextChars),
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
        staleAfterDays: staleAfterDaysFor(type),
      });
    }
  }

  return entries;
}

function classifyExplicitMemory(text: string): LongTermType {
  const lower = text.toLowerCase();
  if (/https?:\/\/|linear|slack|notion|dashboard|grafana/.test(lower)) return "reference";
  if (/decide|decision|choose|chosen|决定|決定|选择|選擇/.test(lower)) return "decision";
  if (/project|repo|项目|專案/.test(lower)) return "project";
  return "feedback";
}

export function staleAfterDaysFor(type: LongTermType): number | undefined {
  if (type === "feedback") return undefined;
  if (type === "decision") return 45;
  if (type === "project") return 60;
  return 90;
}

export function extractActiveFiles(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
): Array<{ path: string; action: ActiveFile["action"] }> {
  if (toolName === "read" && typeof args.filePath === "string") return [{ path: args.filePath, action: "read" }];
  if (toolName === "edit" && typeof args.filePath === "string") return [{ path: args.filePath, action: "edit" }];
  if (toolName === "write" && typeof args.filePath === "string") return [{ path: args.filePath, action: "write" }];
  if (toolName === "grep") return extractGrepPaths(output).map(path => ({ path, action: "grep" as const }));
  return [];
}

function extractGrepPaths(output: string): string[] {
  const matches = output.match(/^(\/[^\n]+\.(ts|tsx|js|jsx|json|md|py|go|rs|toml|yml|yaml)):/gm) ?? [];
  return [...new Set(matches.map(match => match.replace(/:$/, "")))].slice(0, 10);
}

function isErrorLine(line: string, knownValidationCommand: boolean): boolean {
  // 無條件捕捉的強訊號
  if (/TS\d{4}|ERR!|Traceback \(most recent call last\):|panic:/i.test(line)) return true;

  // Error 類型前綴（獨立行）
  if (/^\s*(Error|TypeError|ReferenceError|SyntaxError|Exception):/i.test(line)) {
    return true;
  }

  // 已知 validation command 才用寬鬆匹配
  if (knownValidationCommand) {
    return /\b(error|failed|failure|exception)\b/i.test(line);
  }

  return false;
}

export function extractErrorsFromBash(command: string, output: string): OpenError[] {
  const classifiedCategory = classifyCommand(command);
  const knownValidationCommand = classifiedCategory !== null;

  const lines = output
    .split("\n")
    .filter(line => isErrorLine(line, knownValidationCommand))
    .slice(0, 5);
  if (lines.length === 0) return [];

  const category = classifiedCategory ?? "runtime";
  const summary = lines.join(" ").slice(0, 280);
  const fingerprint = hash(`${category}:${summary.toLowerCase().replace(/\s+/g, " ")}`);
  const now = Date.now();

  return [
    {
      id: `err_${fingerprint}`,
      category,
      summary,
      command,
      file: extractFirstPath(summary),
      fingerprint,
      status: "open",
      firstSeen: now,
      lastSeen: now,
      seenCount: 1,
    },
  ];
}

export function classifyCommand(command: string): OpenError["category"] | null {
  const c = command.toLowerCase();
  if (/\b(tsc|typecheck)\b/.test(c)) return "typecheck";
  if (/\b(test|vitest|jest|mocha|pytest|go test|cargo test)\b/.test(c)) return "test";
  if (/\b(lint|eslint|biome)\b/.test(c)) return "lint";
  if (/\b(build|vite build|webpack|tsup)\b/.test(c)) return "build";
  return null;
}

function extractFirstPath(text: string): string | undefined {
  return text.match(/[\w./-]+\.(ts|tsx|js|jsx|json|md|py|go|rs)/)?.[0];
}

/**
 * Quality gate for workspace memory candidates.
 * Rejects low-quality entries like git hashes, error messages, etc.
 */
function shouldAcceptWorkspaceMemoryCandidate(entry: {
  type: LongTermType;
  text: string;
}): boolean {
  const text = entry.text.trim();

  // Too short
  if (text.length < 20) return false;

  // Git history / commit hash
  if (/\b[0-9a-f]{7,40}\b/.test(text)) return false;
  if (/^(fix|feat|chore|docs|refactor|test):/i.test(text)) return false;

  // Raw error / stack trace
  if (/^\s*(Error|TypeError|ReferenceError|SyntaxError):/i.test(text)) return false;
  if (/at \S+ \([^)]+:\d+:\d+\)/.test(text)) return false;

  // Active file list
  if (/^(modified|created|deleted|renamed)\s+\S+\.\S+$/i.test(text)) return false;

  // Temporary progress
  if (/^(currently|now|pending|in progress|todo|wip):/i.test(text)) return false;

  // Code signature / API doc
  if (/^(function|class|interface|type|const|let|var)\s+\w+/.test(text)) return false;
  if (/^(GET|POST|PUT|DELETE|PATCH)\s+\//.test(text)) return false;

  // Path-heavy facts (rediscoverable from repo)
  const pathCount = (text.match(/\/[\w.-]+(\/[\w.-]+)+/g) || []).length;
  if (pathCount > 2) return false;

  return true;
}

export function parseWorkspaceMemoryCandidates(summary: string): LongTermMemoryEntry[] {
  const match = summary.match(/<workspace_memory_candidates>([\s\S]*?)<\/workspace_memory_candidates>/i);
  if (!match) return [];

  const now = new Date().toISOString();
  const entries: LongTermMemoryEntry[] = [];

  for (const line of match[1].split("\n")) {
    const item = line.trim().match(/^-\s*\[(feedback|project|decision|reference)\]\s*(.+)$/i);
    if (!item) continue;
    const type = item[1].toLowerCase() as LongTermType;
    const body = item[2].trim();
    if (body.length < 12) continue;

    // Apply quality gate
    if (!shouldAcceptWorkspaceMemoryCandidate({ type, text: body })) continue;

    entries.push({
      id: id("mem"),
      type,
      text: body.slice(0, LONG_TERM_LIMITS.maxEntryTextChars),
      source: "compaction",
      confidence: 0.75,
      status: "active",
      createdAt: now,
      updatedAt: now,
      staleAfterDays: staleAfterDaysFor(type),
    });
  }

  return entries;
}
