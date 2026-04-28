import type { LongTermMemoryEntry, LongTermSource } from "./types.ts";

export type MemoryQualityInput = Pick<LongTermMemoryEntry, "type" | "text"> & {
  source?: LongTermSource;
};

export type MemoryQualityResult = {
  accepted: boolean;
  reasons: string[];
};

export function assessMemoryQuality(entry: MemoryQualityInput): MemoryQualityResult {
  const reasons: string[] = [];
  const text = entry.text.trim();

  if (text.length === 0) reasons.push("empty");
  if (isProgressSnapshotViolation(text)) reasons.push("progress_snapshot");
  if (isRawErrorViolation(text)) reasons.push("raw_error");
  if (isCommitOrCiViolation(text)) reasons.push("commit_or_ci_snapshot");
  if (isPathHeavyViolation(text)) reasons.push("path_heavy");
  if (isTemporaryStatusViolation(text)) reasons.push("temporary_status");
  if (isActiveFileSnapshotViolation(text)) reasons.push("active_file_snapshot");
  if (isCodeOrApiSignatureViolation(text)) reasons.push("code_or_api_signature");
  if (entry.type === "feedback" && isFeedbackQualityViolation(text)) reasons.push("bad_feedback");
  if (entry.type === "decision" && isDecisionQualityViolation(text)) reasons.push("bad_decision");

  return { accepted: reasons.length === 0, reasons };
}

export function isProgressSnapshotViolation(text: string): boolean {
  if (/\d+\s+tests?\s+pass(?:ed)?/i.test(text)) return true;
  if (/\d+\s+suites?\s+(?:pass|fail)/i.test(text)) return true;

  if (/\d+\s*(?:個|个)?\s*(?:files?|文件)/i.test(text)) {
    const hasSnapshotContext = /同步|synced|uploaded|downloaded|completed|generated|created|modified|processed|完成/i.test(text);
    const hasLimitContext = /limit|max|maximum|min|minimum|supports?|allowed|per\s+(?:batch|request|upload)/i.test(text);
    if (hasSnapshotContext && !hasLimitContext) return true;
  }

  if (/\b(?:completed|done|finished|implemented|added|updated|fixed|reviewed|passed|modified)\b/i.test(text)) {
    if (/\b(?:wave|phase|task|plan|pr|commit|ci|test|suite|implementation|session|change|fix|review|file)\b/i.test(text)) return true;
  }
  if (/(?:已完成|完成|修復|实现|實作).{0,40}(?:wave|phase|task|plan|PR|測試|测试|實作|实现|修復)/iu.test(text)) return true;
  if (/(?:phases?|waves?|sprints?|milestones?|tasks?)\s*\d+(?:\s*[-–]\s*\d+)?/i.test(text)) {
    if (/completed|done|finished|完成|已完成/i.test(text)) return true;
  }
  if (/(?:已完成|完成).{0,30}(?:phases?|waves?|sprints?|milestones?|tasks?)/i.test(text)) return true;
  if (/\b(?:currently|right now|latest change|previous session|last wave|next step)\b/i.test(text)) return true;
  return false;
}

export function isFeedbackQualityViolation(text: string): boolean {
  const stablePreference = /\b(?:user|the user)\s+(?:prefers|wants|asked|expects|requires|likes|dislikes)\b/i.test(text)
    || /\b(?:prefer|preference|going forward|from now on|always|never)\b/i.test(text)
    || /(?:使用者|用戶|用户).{0,12}(?:偏好|希望|要求|想要)/u.test(text)
    || /(?:以後|以后|請|请).{0,20}(?:使用|回答|保持|避免)/u.test(text);

  if (stablePreference) return false;

  const internalNote = /\b(?:implemented|updated|fixed|reviewed|added|changed|modified|created|writes|wrote)\b/i.test(text);
  if (internalNote) return true;

  return true;
}

export function isDecisionQualityViolation(text: string): boolean {
  const futureRule = /\b(?:use|keep|prefer|avoid|do not|don't|must|should|never|always|require|choose|reject)\b/i.test(text)
    || /(?:使用|保持|避免|不要|必須|必须|應該|应该|選擇|选择)/u.test(text);
  if (!futureRule) return true;
  if (/\b(?:implemented|added|updated|fixed|completed|reviewed)\b/i.test(text)) return true;
  if (/\b(?:was|were|has been|had been)\b/i.test(text) && /\b(?:previous|last|latest|this session|this wave|already)\b/i.test(text)) return true;
  return false;
}

function isRawErrorViolation(text: string): boolean {
  if (/^\s*(Error|TypeError|ReferenceError|SyntaxError|Exception):/i.test(text)) return true;
  if (/at \S+ \([^)]+:\d+:\d+\)/.test(text)) return true;
  return false;
}

function isCommitOrCiViolation(text: string): boolean {
  if (/^(fix|feat|chore|docs|refactor|test):/i.test(text)) return true;
  if (/\b[0-9a-f]{7,40}\b/.test(text)) return true;
  if (/\bCI\b.*\b(?:passed|failed|run|compatibility|flaky)\b/i.test(text)) return true;
  if (/\b(?:passed|failed|run|compatibility|flaky)\b.*\bCI\b/i.test(text)) return true;
  if (/\bcompatibility\s+run\s+\d+/i.test(text)) return true;
  return false;
}

function isPathHeavyViolation(text: string): boolean {
  const pathCount = (text.match(/\/[\w.-]+(?:\/[\w.-]+)+/g) || []).length;
  return pathCount > 2;
}

function isTemporaryStatusViolation(text: string): boolean {
  if (/^(currently|now|pending|in progress|todo|wip)\b/i.test(text)) return true;
  if (/\b(?:run npm test|tests? are running|next reply|before continuing)\b/i.test(text)) return true;
  return false;
}

function isActiveFileSnapshotViolation(text: string): boolean {
  return /^(modified|created|deleted|renamed)\s+\S+\.\S+$/i.test(text);
}

function isCodeOrApiSignatureViolation(text: string): boolean {
  if (/^(function|class|interface|type|const|let|var)\s+\w+/.test(text)) return true;
  if (/^(GET|POST|PUT|DELETE|PATCH)\s+\//.test(text)) return true;
  return false;
}
