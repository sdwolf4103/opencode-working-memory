import type { LongTermMemoryEntry, LongTermSource } from "./types.ts";

export type MemoryQualityInput = Pick<LongTermMemoryEntry, "type" | "text"> & {
  source?: LongTermSource;
};

export type MemoryQualityResult = {
  accepted: boolean;
  reasons: string[];
  diagnostics?: string[];
};

export const HARD_QUALITY_REASONS: ReadonlySet<string> = new Set([
  "empty",
  "progress_snapshot",
  "raw_error",
  "commit_or_ci_snapshot",
  "temporary_status",
  "active_file_snapshot",
  "code_or_api_signature",
  "path_heavy",
  "unresolved_question",
  "transient_bug_state",
  "deployment_snapshot",
]);

export function isHardQualityReason(reason: string): boolean {
  return HARD_QUALITY_REASONS.has(reason);
}

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
  if (isUnresolvedQuestionViolation(text)) reasons.push("unresolved_question");
  if (isTransientBugStateViolation(text)) reasons.push("transient_bug_state");
  if (isDeploymentSnapshotViolation(text)) reasons.push("deployment_snapshot");
  if (entry.type === "feedback" && isFeedbackQualityViolation(text)) reasons.push("bad_feedback");
  if (entry.type === "decision" && isDecisionQualityViolation(text)) reasons.push("bad_decision");

  const diagnostics = isTerseLabelDiagnostic(text) ? ["terse_label"] : [];
  return {
    accepted: reasons.length === 0,
    reasons,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
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

export function hasFutureRule(text: string): boolean {
  return /\b(?:use|keep|prefer|avoid|do not|don't|must|should|never|always|require|choose|reject)\b/i.test(text)
    || /(?:使用|保持|避免|不要|必須|必须|應該|应该|選擇|选择)/u.test(text);
}

function textWithoutUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s`"'<>]+/gi, "");
}

function hasDurableRuleMarker(text: string): boolean {
  return /\b(?:must|always|never|use|do\s+not|don't)\b/i.test(text)
    || /\bshould\b(?!\s+we\b)/i.test(text)
    || /(?:必須|必须|應該|应该|不要|使用|保持)/u.test(text);
}

function isUnresolvedQuestionViolation(text: string): boolean {
  if (hasDurableRuleMarker(text)) return false;

  const withoutUrls = textWithoutUrls(text).trim();
  const startsUnresolved = /^(?:question:|open question\b|unresolved\b|pending question\b|todo:\s*decide\b|TBD\b|TODO\b|待確認|未決|待決定)/iu.test(withoutUrls);
  if (startsUnresolved) return true;

  if (/\b(?:need to decide|needs decision|not decided|whether to|should we|do we need)\b/i.test(withoutUrls)) return true;
  if (/(?:尚未決定|需要決定|是否要|要不要)/u.test(withoutUrls)) return true;

  if (/[?？]\s*$/.test(withoutUrls)) return true;

  const hasQuestion = /[?？]/.test(withoutUrls);
  const hasPlanningPhrase = /\b(?:we need|need to|next|later|follow up)\b/i.test(withoutUrls)
    || /(?:確認|决定|決定)/u.test(withoutUrls);
  return hasQuestion && hasPlanningPhrase;
}

export function isArchitectureLikeDecision(text: string): boolean {
  if (/\b(?:[A-Z][A-Z0-9]*_[A-Z0-9_]*|[A-Z][A-Z0-9]{3,})\b/.test(text)) return true;
  if (/\b(?:schema|model|scoring|retention|cap|evidence|normalization|root cause|architecture(?!\s+keywords?)|boundary|rule|memory system)\b/i.test(text)) return true;
  if (/(?:模型|架構|架构|证据|證據|規則|规则|邊界|边界|記憶系統|记忆系统|原因|採用|采用)/u.test(text)) return true;
  return false;
}

export function isImplementationStatusDecision(text: string): boolean {
  if (/\b(?:implemented|added|updated|fixed|completed|reviewed)\b/i.test(text)) return true;
  if (/\b(?:was|were|has been|had been)\b/i.test(text) && /\b(?:previous|last|latest|this session|this wave|already)\b/i.test(text)) return true;
  return false;
}

export function isDecisionQualityViolation(text: string): boolean {
  if (hasFutureRule(text)) {
    if (isImplementationStatusDecision(text)) return true;
    return false;
  }

  if (isArchitectureLikeDecision(text)) {
    if (isImplementationStatusDecision(text)) return true;
    if (/\b(?:session|wave|task|test|CI|compatibility|commit)\b/i.test(text)) return true;
    return false;
  }

  return true;
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

function isTransientBugStateViolation(text: string): boolean {
  return /\b(?:currently debugging|still failing|unresolved bug|temporary workaround|next step is to fix|tests are failing)\b/i.test(text)
    || /(?:待修|暫時|暂时|目前正在)/u.test(text);
}

function isDeploymentSnapshotViolation(text: string): boolean {
  const hasDeploymentContext = /\b(?:deployed|current|latest|active|revision|build|release)\b/i.test(text)
    || /(?:部署|版本|修訂|修订)/u.test(text);
  if (!hasDeploymentContext) return false;

  const highEntropyId = /\b(?:rev|build|release|revision)[-_]?[A-Za-z0-9]{10,}\b/i.test(text)
    || /\b[A-Za-z0-9]*[A-Z][A-Za-z0-9]*\d[A-Za-z0-9]*[A-Za-z0-9_-]{8,}\b/.test(text)
    || /\b[A-Za-z0-9]*\d[A-Za-z0-9]*[A-Z][A-Za-z0-9]*[A-Za-z0-9_-]{8,}\b/.test(text);
  return highEntropyId;
}

function isTerseLabelDiagnostic(text: string): boolean {
  if (/[:：]/u.test(text)) return false;

  const codePoints = [...text].length;
  const tokens = text.split(/\s+/u).filter(Boolean);
  if (codePoints >= 18 && tokens.length >= 4) return false;

  const hasMarker = /\b(?:is|are|was|were|has|have|uses?|keeps?|requires?|prefers?|wants?|supports?|must|should|always|never|do\s+not|don't|because|for|with|when|after|before)\b/i.test(text)
    || /(?:使用|保持|避免|不要|必須|必须|應該|应该|偏好|要求|支援|支持|因為|因为)/u.test(text);
  return !hasMarker;
}

function isActiveFileSnapshotViolation(text: string): boolean {
  return /^(modified|created|deleted|renamed)\s+\S+\.\S+$/i.test(text);
}

function isCodeOrApiSignatureViolation(text: string): boolean {
  if (/^(function|class|interface|type|const|let|var)\s+\w+/.test(text)) return true;
  if (/^(GET|POST|PUT|DELETE|PATCH)\s+\//.test(text)) return true;
  return false;
}
