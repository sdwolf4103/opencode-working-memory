import { createHash } from "crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ActiveFile, LongTermMemoryEntry, LongTermType, OpenError } from "./types.ts";
import { LONG_TERM_LIMITS } from "./types.ts";
import { assessMemoryQuality } from "./memory-quality.ts";
import { extractionRejectionLogPath } from "./paths.ts";
import { redactCredentials } from "./redaction.ts";
import type { EvidenceEventInput } from "./evidence-log.ts";
import { producerFields } from "./instrumentation.ts";

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
  return extractExplicitMemoriesWithEvidence(text).entries;
}

export type WorkspaceMemoryParseResult = {
  entries: LongTermMemoryEntry[];
  commands: WorkspaceMemoryCommand[];
  evidence: EvidenceEventInput[];
};

export type WorkspaceMemoryCommand =
  | { kind: "REINFORCE"; ref: string }
  | { kind: "REPLACE"; ref: string; type: LongTermType; text: string };

function evidenceTextPreview(text: string, maxChars = 120): string {
  return redactCredentials(text).replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function memoryEvidence(memory: LongTermMemoryEntry): EvidenceEventInput["memory"] {
  return {
    memoryId: memory.id,
    type: memory.type,
    source: memory.source,
    status: memory.status,
  };
}

function extractionEvidence(
  input: Pick<EvidenceEventInput, "type" | "phase" | "outcome" | "reasonCodes" | "textPreview" | "memory" | "details">,
): EvidenceEventInput {
  return input;
}

export function extractExplicitMemoriesWithEvidence(text: string): WorkspaceMemoryParseResult {
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

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const entries: LongTermMemoryEntry[] = [];
  const evidence: EvidenceEventInput[] = [];
  const seen = new Set<string>();
  const negatedLinePattern = /(?:^|\n)\s*(?:(?:please\s+)?(?:do\s+not|don't|dont|never)\s+remember(?:\s+(?:this|that))?|不要\s*(?:記住|记住)|別\s*(?:記住|记住)|别\s*(?:記住|记住))[:：,，]?\s*(.+)$/gim;
  for (const match of text.matchAll(negatedLinePattern)) {
    evidence.push(extractionEvidence({
      type: "explicit_memory_ignored",
      phase: "explicit",
      outcome: "rejected",
      reasonCodes: ["negated_request"],
      textPreview: evidenceTextPreview(match[1] ?? match[0], 80),
    }));
  }

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const body = match[1]?.trim();
      if (body && /^(再说|再說|later|next time)$/i.test(body)) {
        evidence.push(extractionEvidence({
          type: "explicit_memory_ignored",
          phase: "explicit",
          outcome: "rejected",
          reasonCodes: ["deferral"],
          textPreview: evidenceTextPreview(body, 80),
        }));
        continue;
      }
      if (!body || body.length < 8) {
        evidence.push(extractionEvidence({
          type: "explicit_memory_ignored",
          phase: "explicit",
          outcome: "rejected",
          reasonCodes: ["too_short"],
          textPreview: evidenceTextPreview(body ?? match[0], 80),
        }));
        continue;
      }
      
      // Calculate actual trigger position (after possible newline)
      const triggerIndex = match.index! + (match[0].match(/^[\s\n]*/)?.[0]?.length || 0);
      
      // Check if this is a negated request (e.g., "不要記住")
      if (isNegatedMemoryRequest(text, triggerIndex)) {
        evidence.push(extractionEvidence({
          type: "explicit_memory_ignored",
          phase: "explicit",
          outcome: "rejected",
          reasonCodes: ["negated_request"],
          textPreview: evidenceTextPreview(body, 80),
        }));
        continue;
      }
      
      // Dedupe by canonical body
      const key = body.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(key)) {
        evidence.push(extractionEvidence({
          type: "explicit_memory_ignored",
          phase: "explicit",
          outcome: "rejected",
          reasonCodes: ["duplicate_in_message"],
          textPreview: evidenceTextPreview(body, 80),
        }));
        continue;
      }
      seen.add(key);

      const type = classifyExplicitMemory(body);
      const memory: LongTermMemoryEntry = {
        id: id("mem"),
        type,
        text: body.slice(0, LONG_TERM_LIMITS.maxEntryTextChars),
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
        retentionClock: nowMs,
        staleAfterDays: staleAfterDaysFor(type),
      };
      entries.push(memory);
      evidence.push(extractionEvidence({
        type: "explicit_memory_detected",
        phase: "explicit",
        outcome: "accepted",
        reasonCodes: ["explicit_trigger_matched"],
        memory: memoryEvidence(memory),
        textPreview: evidenceTextPreview(memory.text),
      }));
    }
  }

  return { entries, commands: [], evidence };
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
type ExtractionRejectionLogEntry = {
  timestamp: string;
  type: LongTermType;
  text: string;
  reasons: string[];
  source: "compaction";
  workspaceKey?: string;
  workspaceRootHash?: string;
  producerName?: string;
  producerVersion?: string;
  instrumentationVersion?: number;
  decisionLogicName?: string;
  decisionLogicVersion?: number;
};

type WorkspaceMemoryCandidateParseOptions = {
  workspaceKey?: string;
  workspaceRootHash?: string;
};

async function logExtractionRejection(entry: ExtractionRejectionLogEntry): Promise<void> {
  try {
    const path = extractionRejectionLogPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
  } catch (error) {
    console.error("[memory] failed to write extraction rejection log:", error);
  }
}

function evaluateWorkspaceMemoryCandidate(
  entry: {
    type: LongTermType;
    text: string;
  },
  options: {
    fromMemoryTrigger?: boolean;
  } & WorkspaceMemoryCandidateParseOptions = {},
): { accepted: boolean; reasons: string[] } {
  const text = entry.text.trim();
  const minLength = options.fromMemoryTrigger ? 6 : 20;

  // Too short (with type-specific allowlist for stable config values)
  if (entry.type === "reference" && /\b(?:admin\s+)?pin\s|scrypt|n=\d+|r=\d+|p=\d+/i.test(text)) {
    // Stable config values can be short — allow below generic min length
  } else if (text.length < minLength) {
    return { accepted: false, reasons: ["too_short"] };
  }

  const quality = assessMemoryQuality({ type: entry.type, text, source: "compaction" });
  if (!quality.accepted) {
    void logExtractionRejection({
      timestamp: new Date().toISOString(),
      type: entry.type,
      text: redactCredentials(text),
      reasons: quality.reasons,
      source: "compaction",
      workspaceKey: options.workspaceKey,
      workspaceRootHash: options.workspaceRootHash,
      ...producerFields(),
      decisionLogicName: "assessMemoryQuality",
      decisionLogicVersion: 1,
    });
    return { accepted: false, reasons: quality.reasons };
  }

  return { accepted: true, reasons: ["quality_gate_passed"] };
}

function commandAttemptReason(line: string): string {
  const normalized = line.replace(/^\s*-\s*/, "").trim();
  const reinforceMatch = normalized.match(/^REINFORCE\s+(.+)$/i);
  if (reinforceMatch) {
    return /^\[M[1-9]\d*\]$/i.test(reinforceMatch[1]?.trim() ?? "")
      ? "invalid_memory_command"
      : "invalid_memory_ref";
  }

  const replaceMatch = normalized.match(/^REPLACE\s+(.*)$/i);
  if (!replaceMatch) return "invalid_memory_command";

  const rest = replaceMatch[1]?.trim() ?? "";
  const refMatch = rest.match(/^(\[[^\]]+\]|\S+)(?:\s+(.*))?$/);
  const ref = refMatch?.[1] ?? "";
  if (!/^\[M[1-9]\d*\]$/i.test(ref)) return "invalid_memory_ref";

  const afterRef = refMatch?.[2]?.trim() ?? "";
  const typeMatch = afterRef.match(/^(\[[^\]]+\]|\S+)(?:\s+(.*))?$/);
  const typeToken = typeMatch?.[1] ?? "";
  if (!/^\[(feedback|project|decision|reference)\]$/i.test(typeToken)) {
    return "invalid_memory_type";
  }

  const replacementText = typeMatch?.[2]?.trim() ?? "";
  return replacementText ? "invalid_memory_command" : "empty_replacement_text";
}

function isCommandAttempt(line: string): boolean {
  const normalized = line.replace(/^\s*-\s*/, "").trim();
  return /^(REINFORCE|REPLACE)\b/i.test(normalized)
    || /\b(REINFORCE|REPLACE)\b.*\[?\w+\]?/i.test(normalized);
}

function parseWorkspaceMemoryCommand(line: string): WorkspaceMemoryCommand | null {
  const normalized = line.replace(/^\s*-\s*/, "").trim();
  const reinforce = normalized.match(/^REINFORCE\s+\[(M[1-9]\d*)\]\s*$/i);
  if (reinforce) {
    return { kind: "REINFORCE", ref: reinforce[1].toUpperCase() };
  }

  const replace = normalized.match(/^REPLACE\s+\[(M[1-9]\d*)\]\s+\[(feedback|project|decision|reference)\]\s+(.+)$/i);
  if (replace) {
    const text = replace[3].trim();
    if (!text) return null;
    return {
      kind: "REPLACE",
      ref: replace[1].toUpperCase(),
      type: replace[2].toLowerCase() as LongTermType,
      text,
    };
  }

  return null;
}

function parseCandidateLine(line: string): { type: LongTermType; body: string } | null {
  const bracketed = line.trim().match(/^\s*-?\s*\[(feedback|project|decision|reference)\]\s+(.+)$/i);
  if (bracketed) {
    return { type: bracketed[1].toLowerCase() as LongTermType, body: bracketed[2] };
  }

  return null;
}

function isUnsupportedBracketlessCandidateLine(line: string): boolean {
  return /^\s*-\s*(feedback|project|decision|reference)\b\s+.+$/i.test(line.trim());
}

/**
 * Extract the final candidate block from summary using supported formats.
 * Supports: plain text label, Markdown sections, and legacy XML.
 */
type SummaryLine = {
  text: string;
  inFence: boolean;
  isQuote: boolean;
};

function summaryLines(summary: string): SummaryLine[] {
  let inFence = false;
  return summary.split("\n").map(line => {
    const isFenceDelimiter = /^\s*(?:```|~~~)/.test(line);
    const lineInFence = inFence || isFenceDelimiter;
    const result = {
      text: line,
      inFence: lineInFence,
      isQuote: /^\s*>/.test(line),
    };
    if (isFenceDelimiter) inFence = !inFence;
    return result;
  });
}

function isPlainCandidateLabel(line: string): boolean {
  return /^\s*Memory candidates:\s*$/i.test(line);
}

function isMemoryCandidatesHeading(line: string): boolean {
  return /^\s*##\s*Memory Candidates\s*$/i.test(line);
}

function isWorkspaceMemoryCandidatesHeading(line: string): boolean {
  return /^\s*##\s*Workspace Memory Candidates\s*$/i.test(line);
}

function isMarkdownHeading(line: string): boolean {
  return /^\s*##\s+/.test(line);
}

function isXmlCandidateOpen(line: string): boolean {
  return /<workspace_memory_candidates>/i.test(line);
}

function isSupportedCandidateLabel(line: string): boolean {
  return isPlainCandidateLabel(line)
    || isMemoryCandidatesHeading(line)
    || isWorkspaceMemoryCandidatesHeading(line)
    || isXmlCandidateOpen(line);
}

function candidateBlockEnd(lines: SummaryLine[], startIndex: number): number {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.inFence || line.isQuote) continue;
    if (isSupportedCandidateLabel(line.text) || isMarkdownHeading(line.text)) return index;
  }
  return lines.length;
}

function extractCandidateBlock(summary: string): string | null {
  const lines = summaryLines(summary);
  const blocks: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.inFence || line.isQuote) continue;

    if (isXmlCandidateOpen(line.text)) {
      const afterOpen = line.text.replace(/^.*?<workspace_memory_candidates>/i, "");
      const sameLineClose = afterOpen.match(/([\s\S]*?)<\/workspace_memory_candidates>/i);
      if (sameLineClose) {
        blocks.push(sameLineClose[1] ?? "");
        continue;
      }

      const bodyLines: string[] = [];
      if (afterOpen.trim()) bodyLines.push(afterOpen);
      let closeIndex: number | undefined;
      for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
        const bodyLine = lines[bodyIndex];
        if (!bodyLine.inFence && !bodyLine.isQuote && /<\/workspace_memory_candidates>/i.test(bodyLine.text)) {
          bodyLines.push(bodyLine.text.replace(/<\/workspace_memory_candidates>.*$/i, ""));
          closeIndex = bodyIndex;
          break;
        }
        bodyLines.push(bodyLine.text);
      }
      if (closeIndex !== undefined) {
        blocks.push(bodyLines.join("\n"));
        index = closeIndex;
      }
      continue;
    }

    if (isPlainCandidateLabel(line.text) || isMemoryCandidatesHeading(line.text) || isWorkspaceMemoryCandidatesHeading(line.text)) {
      const start = index + 1;
      const end = candidateBlockEnd(lines, start);
      blocks.push(lines.slice(start, end).map(summaryLine => summaryLine.text).join("\n"));
    }
  }

  return blocks.at(-1) ?? null;
}

function isMemoryRefSnapshotIdLine(line: string): boolean {
  return /^\s*Memory ref snapshot id:\s*(?:[a-zA-Z0-9_-]+)?\s*$/i.test(line);
}

function isAllowedCandidateBlockLine(line: string): boolean {
  if (!line.trim()) return true;
  if (/^\s*\(?none\)?\s*$/i.test(line)) return true;
  if (isMemoryRefSnapshotIdLine(line)) return true;
  if (parseWorkspaceMemoryCommand(line)) return true;
  if (parseCandidateLine(line)) return true;
  return false;
}

function isCleanCandidateBlock(block: string): boolean {
  return block.split("\n").every(isAllowedCandidateBlockLine);
}

function unsupportedCandidateSyntaxEvidence(block: string): EvidenceEventInput[] {
  const evidence: EvidenceEventInput[] = [];

  for (const line of block.split("\n")) {
    if (isAllowedCandidateBlockLine(line)) continue;
    if (!isUnsupportedBracketlessCandidateLine(line)) return [];
    evidence.push(extractionEvidence({
      type: "extraction_candidate_rejected",
      phase: "extraction",
      outcome: "rejected",
      reasonCodes: ["unsupported_candidate_syntax"],
      textPreview: evidenceTextPreview(line, 80),
    }));
  }

  return evidence;
}

export function parseWorkspaceMemoryCandidates(
  summary: string,
  options?: WorkspaceMemoryCandidateParseOptions,
): LongTermMemoryEntry[] {
  return parseWorkspaceMemoryCandidatesWithEvidence(summary, options).entries;
}

export function parseWorkspaceMemoryCandidatesWithEvidence(
  summary: string,
  options: WorkspaceMemoryCandidateParseOptions = {},
): WorkspaceMemoryParseResult {
  const block = extractCandidateBlock(summary);
  if (!block) return { entries: [], commands: [], evidence: [] };
  if (!isCleanCandidateBlock(block)) {
    return { entries: [], commands: [], evidence: unsupportedCandidateSyntaxEvidence(block) };
  }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const entries: LongTermMemoryEntry[] = [];
  const commands: WorkspaceMemoryCommand[] = [];
  const evidence: EvidenceEventInput[] = [];

  for (const line of block.split("\n")) {
    if (!line.trim() || /^\s*\(?none\)?\s*$/i.test(line)) continue;
    if (isMemoryRefSnapshotIdLine(line)) continue;

    const command = parseWorkspaceMemoryCommand(line);
    if (command) {
      commands.push(command);
      continue;
    }

    // Accept strict bracketed candidate syntax: "- [type] text" or "[type] text".
    const item = parseCandidateLine(line);
    if (!item) {
      if (isCommandAttempt(line)) {
        evidence.push(extractionEvidence({
          type: "extraction_candidate_rejected",
          phase: "extraction",
          outcome: "rejected",
          reasonCodes: [commandAttemptReason(line)],
          textPreview: evidenceTextPreview(line, 80),
        }));
      }
      continue;
    }
    const type = item.type;
    const normalizedBody = normalizeCandidateBody(item.body);
    if (!normalizedBody) {
      evidence.push(extractionEvidence({
        type: "extraction_candidate_rejected",
        phase: "extraction",
        outcome: "rejected",
        reasonCodes: ["negated_request"],
        memory: { type, source: "compaction" },
        textPreview: evidenceTextPreview(item.body, 80),
      }));
      continue;
    }

    const minLength = normalizedBody.hadTrigger ? 6 : 12;
    if (normalizedBody.text.length < minLength) {
      evidence.push(extractionEvidence({
        type: "extraction_candidate_rejected",
        phase: "extraction",
        outcome: "rejected",
        reasonCodes: ["too_short"],
        memory: { type, source: "compaction" },
        textPreview: evidenceTextPreview(normalizedBody.text, 80),
      }));
      continue;
    }

    // Apply quality gate
    const quality = evaluateWorkspaceMemoryCandidate(
      { type, text: normalizedBody.text },
      {
        fromMemoryTrigger: normalizedBody.hadTrigger,
        workspaceKey: options.workspaceKey,
        workspaceRootHash: options.workspaceRootHash,
      },
    );
    if (!quality.accepted) {
      evidence.push(extractionEvidence({
        type: "extraction_candidate_rejected",
        phase: "extraction",
        outcome: "rejected",
        reasonCodes: quality.reasons,
        memory: { type, source: "compaction" },
        textPreview: evidenceTextPreview(normalizedBody.text, 80),
      }));
      continue;
    }

    const memory: LongTermMemoryEntry = {
      id: id("mem"),
      type,
      text: normalizedBody.text.slice(0, LONG_TERM_LIMITS.maxEntryTextChars),
      source: "compaction",
      confidence: 0.75,
      status: "active",
      createdAt: now,
      updatedAt: now,
      retentionClock: nowMs,
      staleAfterDays: staleAfterDaysFor(type),
    };
    entries.push(memory);
    evidence.push(extractionEvidence({
      type: "extraction_candidate_accepted",
      phase: "extraction",
      outcome: "accepted",
      reasonCodes: ["quality_gate_passed", "valid_candidate_format"],
      memory: memoryEvidence(memory),
      textPreview: evidenceTextPreview(memory.text),
    }));
  }

  return { entries, commands, evidence };
}
