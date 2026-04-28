import { createHash } from "crypto";
import type { ActiveFile, LongTermMemoryEntry, LongTermType, OpenError } from "./types.ts";
import { LONG_TERM_LIMITS } from "./types.ts";
import { assessMemoryQuality } from "./memory-quality.ts";

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

  // Japanese negative
  if (/(?:覚えないで|記憶しないで|メモしないで)\s*$/u.test(prefix)) {
    return true;
  }

  // Korean negative
  if (/(?:기억하지\s*마|기억하지마|메모하지\s*마|메모하지마)\s*$/u.test(prefix)) {
    return true;
  }

  return false;
}

export function extractExplicitMemories(text: string): LongTermMemoryEntry[] {
  // 注意：所有pattern必須有 g flag，因為使用 matchAll()
  // Pattern 必須在行首匹配，避免匹配到句子中間的非指令式用法
  const patterns = [
    // 中文：請/幫我 + 記住 + 可選後綴
    /(?:^|\n)\s*(?:请|請)?(?:帮我|幫我)?(?:记住|記住|记得|記得|记下来|記下來)(?:这一点|這一點|这点|這點|这个|這個)?[:：,，]?\s*(.+)$/gim,
    // 日文（長詞優先）：覚えておいて must come before 覚えて
    /(?:^|\n)\s*(?:覚えておいて|覚えて|忘れないで|メモして)[:：,，]?\s*(.+)$/gim,
    // 韓文（長詞優先）：기억해줘/메모해줘 must come before 기억해/메모해
    /(?:^|\n)\s*(?:기억해줘|기억해|잊지 마|잊지마|메모해줘|메모해)[:：,，]?\s*(.+)$/gim,
    // 英文：remember this/that - 必須在行首，避免 "to remember" 非指令匹配
    /(?:^|\n)\s*(?:please\s+)?remember(?:\s+(?:this|that))?[:：,，]?\s*(.+)$/gim,
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

function normalizeCandidateBody(body: string): { text: string; hadTrigger: boolean } | null {
  const text = body.trim();
  const triggerPatterns = [
    /(?:请|請)?(?:帮我|幫我)?(?:记住|記住|记得|記得|记下来|記下來)(?:这一点|這一點|这点|這點|这个|這個)?[:：,，]?\s*(.+)$/im,
    /(?:覚えておいて|覚えて|忘れないで|メモして)[:：,，]?\s*(.+)$/im,
    /(?:기억해줘|기억해|잊지 마|잊지마|메모해줘|메모해)[:：,，]?\s*(.+)$/im,
    /(?:please\s+)?remember(?:\s+(?:this|that))?[:：,，]?\s*(.+)$/im,
    /(?:please\s+)?(?:save|add)\s+(?:this|that)?\s*(?:to|in)\s+memory[:：,，]?\s*(.+)$/im,
    /(?:please\s+)?commit\s+(?:this|that)?\s*to memory[:：,，]?\s*(.+)$/im,
  ];

  for (const pattern of triggerPatterns) {
    const match = pattern.exec(text);
    if (!match) continue;

    const triggerIndex = match.index + (match[0].match(/^\s*/)?.[0]?.length || 0);
    if (isNegatedMemoryRequest(text, triggerIndex)) return null;

    const extracted = match[1]?.trim();
    return extracted ? { text: extracted, hadTrigger: true } : null;
  }

  return { text, hadTrigger: false };
}

function extractFirstPath(text: string): string | undefined {
  return text.match(/[\w./-]+\.(ts|tsx|js|jsx|json|md|py|go|rs)/)?.[0];
}

/**
 * Acceptance gate for workspace memory candidates.
 * Keeps extraction-specific checks local and delegates memory quality rules to memory-quality.ts.
 */
function shouldAcceptWorkspaceMemoryCandidate(
  entry: {
    type: LongTermType;
    text: string;
  },
  options: {
    fromMemoryTrigger?: boolean;
  } = {},
): boolean {
  const text = entry.text.trim();
  const minLength = options.fromMemoryTrigger ? 6 : 20;

  // Too short (with type-specific allowlist for stable config values)
  if (entry.type === "reference" && /\b(?:admin\s+)?pin\s|scrypt|n=\d+|r=\d+|p=\d+/i.test(text)) {
    // Stable config values can be short — allow below generic min length
  } else if (text.length < minLength) {
    return false;
  }

  // Indirect Prompt Injection / Adversarial Instructions
  // Rejects attempts to overwrite system behavior or "ignore" rules.
  // comparative "instead of" is allowed.
  if (/\b(ignore\s+all|ignore\s+previous|ignore\s+instruction|overwrite\s+system|overwrite\s+rules|forget\s+all|delete\s+root)\b/i.test(text)) return false;
  if (/\b(ignore|instruction|overwrite)\b/i.test(text) && /\b(previous|all|rules|behavior|prompt|system)\b/i.test(text)) return false;

  const quality = assessMemoryQuality({ type: entry.type, text, source: "compaction" });
  if (!quality.accepted) return false;

  return true;
}

/**
 * Extract candidate block from summary using multiple formats.
 * Supports: Plain text label, Markdown section, legacy XML.
 */
function extractCandidateBlock(summary: string): string | null {
  // 1. Plain text label (primary format, no Markdown header)
  const plainMatch = summary.match(/Memory candidates:\s*\n([\s\S]*?)(?:\n[A-Z][a-z]+ [a-z]+:|\n##\s|$)/i);
  if (plainMatch) return plainMatch[1];

  // 2. Markdown section (legacy)
  const markdownMatch = summary.match(/##\s*Memory Candidates\s*\n([\s\S]*?)(?:\n##\s|$)/i);
  if (markdownMatch) return markdownMatch[1];

  // 3. Legacy "Workspace Memory Candidates" section
  const legacyMatch = summary.match(/##\s*Workspace Memory Candidates\s*\n([\s\S]*?)(?:\n##\s|$)/i);
  if (legacyMatch) return legacyMatch[1];

  // 4. Legacy XML block (backward compatible)
  const xmlMatch = summary.match(/<workspace_memory_candidates>([\s\S]*?)<\/workspace_memory_candidates>/i);
  if (xmlMatch) return xmlMatch[1];

  return null;
}

export function parseWorkspaceMemoryCandidates(summary: string): LongTermMemoryEntry[] {
  const block = extractCandidateBlock(summary);
  if (!block) return [];

  const now = new Date().toISOString();
  const entries: LongTermMemoryEntry[] = [];

  for (const line of block.split("\n")) {
    // Accept both "- [type] text" (bracketed) and "- type text" (bracketless)
    const item = line.trim().match(
      /^-\s*(?:\[(feedback|project|decision|reference)\]|(feedback|project|decision|reference)\b)\s+(.+)$/i,
    );
    if (!item) continue;
    const type = (item[1] ?? item[2]).toLowerCase() as LongTermType;
    const normalizedBody = normalizeCandidateBody(item[3]);
    if (!normalizedBody) continue;

    const minLength = normalizedBody.hadTrigger ? 6 : 12;
    if (normalizedBody.text.length < minLength) continue;

    // Apply quality gate
    if (!shouldAcceptWorkspaceMemoryCandidate(
      { type, text: normalizedBody.text },
      { fromMemoryTrigger: normalizedBody.hadTrigger },
    )) continue;

    entries.push({
      id: id("mem"),
      type,
      text: normalizedBody.text.slice(0, LONG_TERM_LIMITS.maxEntryTextChars),
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
