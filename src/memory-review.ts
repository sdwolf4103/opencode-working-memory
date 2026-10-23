import { randomUUID } from "node:crypto";
import { rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { appendEvidenceEvent, type EvidenceEventInput, type EvidenceRelation, type MemoryEvidenceRef } from "./evidence-log.ts";
import { staleAfterDaysFor } from "./extractors.ts";
import { assessMemoryQuality } from "./memory-quality.ts";
import { memoryRoot } from "./paths.ts";
import { redactCredentials } from "./redaction.ts";
import { atomicWriteJSON, readJSON } from "./storage.ts";
import { LONG_TERM_LIMITS, type LongTermSource, type LongTermType, type WorkspaceMemoryStore } from "./types.ts";
import { updateWorkspaceMemoryWithAccounting, workspaceMemoryExactKey, workspaceMemoryIdentityKey } from "./workspace-memory.ts";

export const MEMORY_REVIEW_PROPOSALS_FENCE_INFO = "memory-review-proposals";
export const MEMORY_REVIEW_PROPOSAL_SET_KIND = "opencode_working_memory_review_proposal_set";
export const MEMORY_REVIEW_SNAPSHOT_KIND = "opencode_working_memory_review_snapshot";
export const MEMORY_REVIEW_DECISION_KIND = "opencode_working_memory_review_decision";
export const MEMORY_REVIEW_MAX_PROPOSALS = 6;

// Rollout 6 intentionally defers later candidate actions (`split`, `promote`,
// `keep`) until real usage proves they are needed. MVP proposal mutation remains
// scoped to these three actions only.
export type MemoryReviewProposalAction = "consolidate" | "update" | "forget";
export type MemoryReviewProposalRisk = "low" | "medium" | "high";

export type MemoryReviewProposal = {
  id: string;
  action: MemoryReviewProposalAction;
  targets: string[];
  proposedType?: LongTermType;
  proposedText?: string;
  proposedEntries?: Array<{
    type: LongTermType;
    text: string;
  }>;
  evidenceRefs: string[];
  risk: MemoryReviewProposalRisk;
  rationale: string;
  targetQuotes?: string[];
  futureValue: string;
  temporaryStateCheck: string;
};

export type MemoryReviewProposalSet = {
  version: 1;
  kind: typeof MEMORY_REVIEW_PROPOSAL_SET_KIND;
  id: string;
  snapshotId: string;
  createdAt: string;
  source: "assistant_memory_review";
  status: "sealed";
  sealed: true;
  proposals: MemoryReviewProposal[];
};

export type MemoryReviewSnapshotMemory = {
  ref: string;
  memoryId: string;
  type: LongTermType;
  source: LongTermSource;
  status: "active" | "superseded";
  exactKey: string;
  identityKey: string;
  text: string;
};

export type MemoryReviewSnapshot = {
  version: 1;
  kind: typeof MEMORY_REVIEW_SNAPSHOT_KIND;
  id: string;
  createdAt: string;
  workspace: WorkspaceMemoryStore["workspace"];
  memories: MemoryReviewSnapshotMemory[];
  renderAccounting: {
    rendered: number;
    omitted: Array<{
      memoryId: string;
      reason: "superseded" | "type_cap" | "global_cap" | "char_budget" | "empty_render_budget";
    }>;
    limits: WorkspaceMemoryStore["limits"];
  };
};

export type MemoryReviewValidationCode =
  | "missing_proposal_kind"
  | "proposal_set_unsealed"
  | "snapshot_mismatch"
  | "too_many_proposals"
  | "missing_proposal_id"
  | "unknown_action"
  | "missing_target"
  | "missing_risk"
  | "missing_rationale"
  | "duplicate_target"
  | "forget_has_replacement"
  | "update_target_count"
  | "missing_proposed_text"
  | "invalid_proposed_type"
  | "multiple_proposal_fences"
  | "consolidate_target_count"
  | "missing_target_quotes"
  | "batch_conflict"
  | "redaction_changed_text"
  | "quality_gate_rejected"
  | "edited_text_too_long"
  | "identity_collision"
  | "target_changed"
  | "target_unavailable"
  | "protected_source";

export type MemoryReviewValidationError = {
  code: MemoryReviewValidationCode;
  proposalId?: string;
  message: string;
};

export type MemoryReviewValidationResult = {
  valid: boolean;
  errors: MemoryReviewValidationError[];
};

export type MemoryReviewDryRunOperation = {
  proposalId: string;
  kind: "supersede" | "supersede_and_add";
  action: MemoryReviewProposalAction;
  targetRefs: string[];
  targetMemoryIds: string[];
  replacement?: {
    type: LongTermType;
    text: string;
  };
  description: string;
};

export type MemoryReviewDryRunResult = MemoryReviewValidationResult & {
  operations: MemoryReviewDryRunOperation[];
};

export type MemoryReviewApplyResult = MemoryReviewDryRunResult & {
  applied: boolean;
  applyAttemptId: string;
};

export type MemoryReviewParseResult = {
  ok: boolean;
  proposalSet?: unknown;
  reasonCodes: string[];
};

export type MemoryReviewCaptureContext = {
  source: "hook" | "cli_import";
  sessionID?: string;
  messageID?: string;
  partID?: string;
  activeSnapshotId?: string;
};

export type MemoryReviewCaptureResult = {
  text: string;
  status: "captured" | "ignored" | "rejected";
  detected: boolean;
  proposalBlockCount: number;
  reasonCodes: string[];
  proposalSetId?: string;
  snapshotId?: string;
  validation?: MemoryReviewValidationResult;
};

export type MemoryReviewDecision = "selected" | "unselected" | "rejected" | "approved" | "edited";

export type MemoryReviewDecisionRecord = {
  version: 1;
  kind: typeof MEMORY_REVIEW_DECISION_KIND;
  proposalSetId: string;
  proposalId: string;
  decision: MemoryReviewDecision;
  createdAt: string;
  note?: string;
  userEditedText?: string;
  validation?: MemoryReviewValidationResult;
  applyAttemptId?: string;
};

export type CreateMemoryReviewDecisionRecordInput = Omit<MemoryReviewDecisionRecord, "version" | "kind">;

export type MemoryReviewTextCompleteInput = {
  sessionID: string;
  messageID: string;
  partID: string;
};

export type MemoryReviewTextCompleteOutput = {
  text: string;
};

export type MemoryReviewProposalBlock = {
  raw: string;
  json: unknown;
};

export type MemoryReviewTextCompleteProbeResult = {
  text: string;
  detected: boolean;
  proposalBlockCount: number;
  status?: MemoryReviewCaptureResult["status"];
  reasonCodes?: string[];
  proposalSetId?: string;
};

export const MEMORY_REVIEW_PROBE_PROMPT = [
  "You are reviewing workspace memory quality.",
  "",
  "Your job is to propose memory maintenance actions only.",
  "Do not mutate memory.",
  "Do not invent facts.",
  "Use only the memory snapshot and evidence below.",
  "",
  "If you produce structured review proposals, wrap the JSON in a single fenced block with info string `memory-review-proposals`.",
  "Use this sentinel for the proposal set kind:",
  `\`${MEMORY_REVIEW_PROPOSAL_SET_KIND}\``,
  "",
  "No changes are applied unless the user explicitly approves them later in the Memory Review UI.",
  "Approved changes update persistent workspace memory; this session's frozen prompt refreshes at the next compaction or in a new session.",
  "A `forget` action deactivates (supersedes) the memory; it does not securely erase retained audit text.",
].join("\n");

export function buildMemoryReviewPrompt(snapshot: MemoryReviewSnapshot): string {
  return [
    MEMORY_REVIEW_PROBE_PROMPT,
    "",
    `Snapshot ID: ${snapshot.id}`,
    "Use only the memory snapshot below.",
    "Do not mention the snapshot ID outside the fenced JSON block in your response.",
    "",
    "Memory snapshot:",
    ...snapshot.memories.map(memory => `[${memory.ref}] (${memory.type}/${memory.source}) ${memory.text}`),
  ].join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMemoryType(value: unknown): value is LongTermType {
  return value === "feedback" || value === "project" || value === "decision" || value === "reference";
}

function replacementMemoryType(
  proposal: { proposedType?: unknown },
  fallback?: LongTermType,
): LongTermType | undefined {
  if (!Object.prototype.hasOwnProperty.call(proposal, "proposedType")) return fallback;
  return isMemoryType(proposal.proposedType) ? proposal.proposedType : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function hasReplacement(proposal: Record<string, unknown>): boolean {
  return textValue(proposal.proposedText) !== undefined ||
    (Array.isArray(proposal.proposedEntries) && proposal.proposedEntries.length > 0);
}

function validationError(
  code: MemoryReviewValidationCode,
  message: string,
  proposalId?: string,
): MemoryReviewValidationError {
  return proposalId ? { code, proposalId, message } : { code, message };
}

function hasMemoryReviewProposalKind(value: unknown): boolean {
  return isObject(value) && value.kind === MEMORY_REVIEW_PROPOSAL_SET_KIND;
}

function proposalId(proposal: Record<string, unknown>, index: number): string {
  return textValue(proposal.id) ?? `proposal_${index + 1}`;
}

function targetMemories(snapshot: MemoryReviewSnapshot, targets: string[]): MemoryReviewSnapshotMemory[] {
  const byRef = new Map(snapshot.memories.map(memory => [memory.ref, memory]));
  return targets.map(target => byRef.get(target)).filter((memory): memory is MemoryReviewSnapshotMemory => Boolean(memory));
}

function memoryEvidenceRef(memory: MemoryReviewSnapshotMemory): MemoryEvidenceRef {
  return {
    memoryId: memory.memoryId,
    memoryKeyHash: memory.exactKey,
    identityKeyHash: memory.identityKey,
    type: memory.type,
    source: memory.source,
    status: memory.status,
  };
}

function targetRelations(snapshot: MemoryReviewSnapshot, proposals: MemoryReviewProposal[]): EvidenceRelation[] {
  const relations: EvidenceRelation[] = [];
  const seen = new Set<string>();
  for (const proposal of proposals) {
    for (const memory of targetMemories(snapshot, proposal.targets)) {
      if (seen.has(memory.memoryId)) continue;
      seen.add(memory.memoryId);
      relations.push({ role: "target", memory: memoryEvidenceRef(memory) });
    }
  }
  return relations;
}

function proposalTextPreview(proposals: MemoryReviewProposal[]): string | undefined {
  const previews = proposals
    .map(proposal => proposal.proposedText ?? proposal.rationale ?? proposal.futureValue)
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
  return previews.length > 0 ? previews.join(" | ") : undefined;
}

function proposalTargetRefs(proposals: MemoryReviewProposal[]): string[] {
  return [...new Set(proposals.flatMap(proposal => proposal.targets))];
}

function proposalSetEvidenceDetails(
  proposalSet: Pick<MemoryReviewProposalSet, "id" | "snapshotId" | "proposals">,
  context?: MemoryReviewCaptureContext,
): EvidenceEventInput["details"] {
  return {
    proposalSetId: proposalSet.id,
    snapshotId: proposalSet.snapshotId,
    proposalCount: proposalSet.proposals.length,
    targetRefs: proposalTargetRefs(proposalSet.proposals),
    captureSource: context?.source ?? null,
  };
}

function proposalSetForEvidence(value: Record<string, unknown>, fallbackSnapshotId?: string): Pick<MemoryReviewProposalSet, "id" | "snapshotId" | "proposals"> {
  return {
    id: textValue(value.id) ?? "unknown_proposal_set",
    snapshotId: textValue(value.snapshotId) ?? fallbackSnapshotId ?? "unknown_snapshot",
    proposals: Array.isArray(value.proposals) ? value.proposals.filter(isObject) as unknown as MemoryReviewProposal[] : [],
  };
}

function memoryReviewProposalDetectedEvidence(
  proposalSet: MemoryReviewProposalSet,
  snapshot: MemoryReviewSnapshot,
  context: MemoryReviewCaptureContext,
): EvidenceEventInput {
  return {
    type: "memory_review_proposal_detected",
    phase: "memory_review",
    outcome: "detected",
    reasonCodes: ["proposal_captured"],
    relations: targetRelations(snapshot, proposalSet.proposals),
    details: proposalSetEvidenceDetails(proposalSet, context),
    textPreview: proposalTextPreview(proposalSet.proposals),
    sessionHash: context.sessionID,
    messageHash: context.messageID,
  };
}

function memoryReviewProposalRejectedEvidence(input: {
  reasonCodes: string[];
  context?: MemoryReviewCaptureContext;
  proposalSet?: Pick<MemoryReviewProposalSet, "id" | "snapshotId" | "proposals">;
  snapshot?: MemoryReviewSnapshot;
  snapshotId?: string;
}): EvidenceEventInput {
  return {
    type: "memory_review_proposal_rejected",
    phase: "memory_review",
    outcome: "rejected",
    reasonCodes: input.reasonCodes,
    relations: input.proposalSet && input.snapshot ? targetRelations(input.snapshot, input.proposalSet.proposals) : undefined,
    details: input.proposalSet
      ? proposalSetEvidenceDetails(input.proposalSet, input.context)
      : {
        snapshotId: input.snapshotId ?? input.context?.activeSnapshotId ?? null,
        captureSource: input.context?.source ?? null,
      },
    textPreview: input.proposalSet ? proposalTextPreview(input.proposalSet.proposals) : undefined,
    sessionHash: input.context?.sessionID,
    messageHash: input.context?.messageID,
  };
}

function deepFreeze<T>(value: T): T {
  if (!isObject(value) && !Array.isArray(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    if ((isObject(child) || Array.isArray(child)) && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
}

async function memoryReviewRoot(root: string): Promise<string> {
  return join(await memoryRoot(root), "workspace-memory-review");
}

async function memoryReviewSnapshotPath(root: string, snapshotId: string): Promise<string> {
  return join(await memoryReviewRoot(root), "snapshots", `${snapshotId}.json`);
}

async function memoryReviewProposalPath(root: string, proposalSetId: string): Promise<string> {
  return join(await memoryReviewRoot(root), "proposals", `${proposalSetId}.json`);
}

async function memoryReviewProposalsDir(root: string): Promise<string> {
  return join(await memoryReviewRoot(root), "proposals");
}

export async function memoryReviewDecisionLogPath(root: string, proposalSetId: string): Promise<string> {
  return join(await memoryReviewRoot(root), "decisions", `${proposalSetId}.jsonl`);
}

export async function saveMemoryReviewSnapshot(root: string, snapshot: MemoryReviewSnapshot): Promise<void> {
  await atomicWriteJSON(await memoryReviewSnapshotPath(root, snapshot.id), snapshot);
}

export async function loadMemoryReviewSnapshot(root: string, snapshotId: string): Promise<MemoryReviewSnapshot | null> {
  return readJSON<MemoryReviewSnapshot | null>(await memoryReviewSnapshotPath(root, snapshotId), () => null);
}

async function saveMemoryReviewProposalSet(root: string, proposalSet: MemoryReviewProposalSet): Promise<void> {
  await atomicWriteJSON(await memoryReviewProposalPath(root, proposalSet.id), proposalSet);
}

export async function loadMemoryReviewProposalSet(root: string, proposalSetId: string): Promise<MemoryReviewProposalSet | null> {
  return readJSON<MemoryReviewProposalSet | null>(await memoryReviewProposalPath(root, proposalSetId), () => null);
}

export async function listMemoryReviewProposalSets(root: string): Promise<MemoryReviewProposalSet[]> {
  const dir = await memoryReviewProposalsDir(root);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const proposals: MemoryReviewProposalSet[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const proposal = await readJSON<MemoryReviewProposalSet | null>(join(dir, entry), () => null);
    if (proposal?.sealed === true) proposals.push(proposal);
  }
  return proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function latestMemoryReviewProposalSet(root: string): Promise<MemoryReviewProposalSet | null> {
  return (await listMemoryReviewProposalSets(root)).at(-1) ?? null;
}

export async function discardMemoryReviewProposalSet(root: string, proposalSetId: string): Promise<void> {
  await rm(await memoryReviewProposalPath(root, proposalSetId), { force: true });
}

async function findCapturedProposalForSnapshot(root: string, snapshotId: string): Promise<MemoryReviewProposalSet | null> {
  const dir = await memoryReviewProposalsDir(root);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const proposal = await readJSON<MemoryReviewProposalSet | null>(join(dir, entry), () => null);
    if (proposal?.snapshotId === snapshotId) return proposal;
  }
  return null;
}

export function createMemoryReviewSnapshot(
  store: WorkspaceMemoryStore,
  options: { id?: string; createdAt?: string } = {},
): MemoryReviewSnapshot {
  const omitted: MemoryReviewSnapshot["renderAccounting"]["omitted"] = [];
  const activeEntries = store.entries.filter(entry => {
    if (entry.status === "active") return true;
    omitted.push({ memoryId: entry.id, reason: "superseded" });
    return false;
  });

  return {
    version: 1,
    kind: MEMORY_REVIEW_SNAPSHOT_KIND,
    id: options.id ?? `snapshot_${Date.now()}`,
    createdAt: options.createdAt ?? nowIso(),
    workspace: store.workspace,
    memories: activeEntries.map((entry, index) => ({
      ref: `M${index + 1}`,
      memoryId: entry.id,
      type: entry.type,
      source: entry.source,
      status: entry.status,
      exactKey: workspaceMemoryExactKey(entry),
      identityKey: workspaceMemoryIdentityKey(entry),
      text: entry.text,
    })),
    renderAccounting: {
      rendered: activeEntries.length,
      omitted,
      limits: store.limits,
    },
  };
}

export function sealMemoryReviewProposalSet(input: unknown): MemoryReviewProposalSet {
  if (!isObject(input)) {
    throw new TypeError("Memory Review proposal set must be an object.");
  }

  const sealed = {
    ...input,
    version: 1,
    kind: MEMORY_REVIEW_PROPOSAL_SET_KIND,
    source: "assistant_memory_review",
    status: "sealed",
    sealed: true,
    proposals: Array.isArray(input.proposals) ? input.proposals.map(proposal => ({ ...(proposal as Record<string, unknown>) })) : [],
  } as MemoryReviewProposalSet;

  return deepFreeze(sealed);
}

export function validateMemoryReviewProposalSet(
  input: unknown,
  snapshot: MemoryReviewSnapshot,
): MemoryReviewValidationResult {
  const errors: MemoryReviewValidationError[] = [];
  if (!isObject(input)) {
    return { valid: false, errors: [validationError("missing_proposal_kind", "Proposal set must be an object.")] };
  }

  if (input.kind !== MEMORY_REVIEW_PROPOSAL_SET_KIND) {
    errors.push(validationError("missing_proposal_kind", "Proposal set has the wrong kind sentinel."));
  }

  if (input.status !== "sealed" || input.sealed !== true || input.source !== "assistant_memory_review") {
    errors.push(validationError("proposal_set_unsealed", "Proposal set must be sealed and immutable before review."));
  }

  if (input.snapshotId !== snapshot.id) {
    errors.push(validationError("snapshot_mismatch", "Proposal set snapshotId does not match the active snapshot."));
  }

  const proposals = Array.isArray(input.proposals) ? input.proposals : [];
  if (proposals.length > MEMORY_REVIEW_MAX_PROPOSALS) {
    errors.push(validationError("too_many_proposals", `Proposal set contains more than ${MEMORY_REVIEW_MAX_PROPOSALS} proposals.`));
    return { valid: false, errors };
  }

  const knownRefs = new Set(snapshot.memories.map(memory => memory.ref));
  for (let index = 0; index < proposals.length; index += 1) {
    const rawProposal = proposals[index];
    if (!isObject(rawProposal)) {
      errors.push(validationError("missing_proposal_id", "Proposal must be an object.", `proposal_${index + 1}`));
      continue;
    }

    const id = proposalId(rawProposal, index);
    if (!textValue(rawProposal.id)) {
      errors.push(validationError("missing_proposal_id", "Proposal must include an id.", id));
    }

    const action = rawProposal.action;
    const targets = stringArray(rawProposal.targets);
    const proposedText = textValue(rawProposal.proposedText);
    if (Object.prototype.hasOwnProperty.call(rawProposal, "proposedType") && !isMemoryType(rawProposal.proposedType)) {
      errors.push(validationError("invalid_proposed_type", "Proposal proposedType must be feedback, project, decision, or reference when supplied.", id));
    }

    if (!targets.length || targets.some(target => !knownRefs.has(target))) {
      errors.push(validationError("missing_target", "Proposal must target refs present in the snapshot.", id));
    }
    if (new Set(targets).size !== targets.length) {
      errors.push(validationError("duplicate_target", "Proposal must not repeat the same target ref.", id));
    }

    if (rawProposal.risk !== "low" && rawProposal.risk !== "medium" && rawProposal.risk !== "high") {
      errors.push(validationError("missing_risk", "Proposal must include risk low, medium, or high.", id));
    }

    if (!textValue(rawProposal.rationale)) {
      errors.push(validationError("missing_rationale", "Proposal must include rationale.", id));
    }

    if (action !== "forget" && action !== "update" && action !== "consolidate") {
      errors.push(validationError("unknown_action", "Proposal action must be consolidate, update, or forget.", id));
      continue;
    }

    if (action === "forget") {
      if (hasReplacement(rawProposal)) {
        errors.push(validationError("forget_has_replacement", "Forget proposals must not include replacement text or entries.", id));
      }
      continue;
    }

    if (action === "update") {
      if (targets.length !== 1) {
        errors.push(validationError("update_target_count", "Update proposals must target exactly one memory ref.", id));
      }
      if (!proposedText) {
        errors.push(validationError("missing_proposed_text", "Update proposals must include proposedText.", id));
      }
      continue;
    }

    if (targets.length < 2) {
      errors.push(validationError("consolidate_target_count", "Consolidate proposals must target multiple memory refs.", id));
    }
    if (!proposedText) {
      errors.push(validationError("missing_proposed_text", "Consolidate proposals must include proposedText.", id));
    }
    const quotes = stringArray(rawProposal.targetQuotes);
    const targetsWithText = targetMemories(snapshot, targets);
    if (targetsWithText.length !== targets.length || targetsWithText.some(memory => !quotes.includes(memory.text))) {
      errors.push(validationError("missing_target_quotes", "Consolidate proposals must quote every target memory verbatim.", id));
    }
  }

  return { valid: errors.length === 0, errors };
}

export function dryRunMemoryReviewProposalSet(
  input: unknown,
  snapshot: MemoryReviewSnapshot,
): MemoryReviewDryRunResult {
  const validation = validateMemoryReviewProposalSet(input, snapshot);
  if (!validation.valid || !isObject(input) || !Array.isArray(input.proposals)) {
    return { ...validation, operations: [] };
  }

  const byRef = new Map(snapshot.memories.map(memory => [memory.ref, memory]));
  const operations: MemoryReviewDryRunOperation[] = [];
  for (const proposal of input.proposals as Array<Record<string, unknown>>) {
    const action = proposal.action as MemoryReviewProposalAction;
    const targets = stringArray(proposal.targets);
    const memories = targets.map(target => byRef.get(target)).filter((memory): memory is MemoryReviewSnapshotMemory => Boolean(memory));
    const replacementText = textValue(proposal.proposedText);
    const replacementType = replacementMemoryType(proposal, memories[0]?.type);

    if (action === "forget") {
      operations.push({
        proposalId: proposal.id as string,
        kind: "supersede",
        action,
        targetRefs: targets,
        targetMemoryIds: memories.map(memory => memory.memoryId),
        description: `Supersede ${targets.join(", ")} without adding replacement memory.`,
      });
      continue;
    }

    operations.push({
      proposalId: proposal.id as string,
      kind: "supersede_and_add",
      action,
      targetRefs: targets,
      targetMemoryIds: memories.map(memory => memory.memoryId),
      replacement: replacementText && replacementType ? { type: replacementType, text: replacementText } : undefined,
      description: `Supersede ${targets.join(", ")} and add one ${replacementType ?? "memory"} replacement.`,
    });
  }

  return { ...validation, operations };
}

export function validateMemoryReviewUserEdit(
  proposal: MemoryReviewProposal,
  snapshot: MemoryReviewSnapshot,
  editedText: string,
  currentStore?: WorkspaceMemoryStore,
): MemoryReviewValidationResult {
  const errors: MemoryReviewValidationError[] = [];
  const target = targetMemories(snapshot, proposal.targets)[0];
  const validProposedType = replacementMemoryType(proposal, target?.type);
  const trimmed = editedText.trim();

  if (Object.prototype.hasOwnProperty.call(proposal, "proposedType") && !validProposedType) {
    errors.push(validationError("invalid_proposed_type", "Proposal proposedType must be feedback, project, decision, or reference when supplied.", proposal.id));
  }

  if (redactCredentials(editedText) !== editedText) {
    errors.push(validationError("redaction_changed_text", "Edited replacement text contains redacted sensitive content.", proposal.id));
  }

  if (trimmed.length > LONG_TERM_LIMITS.maxEntryTextChars) {
    errors.push(validationError("edited_text_too_long", "Edited replacement text exceeds the memory text limit.", proposal.id));
  }

  if (validProposedType) {
    const quality = assessMemoryQuality({ type: validProposedType, text: trimmed, source: "manual" });
    if (!quality.accepted) {
      errors.push(validationError("quality_gate_rejected", `Edited replacement text failed quality gates: ${quality.reasons.join(", ")}.`, proposal.id));
    }
  }

  if (currentStore && validProposedType) {
    const targetIds = new Set(targetMemories(snapshot, proposal.targets).map(memory => memory.memoryId));
    const candidate = { type: validProposedType, text: trimmed };
    const exactKey = workspaceMemoryExactKey(candidate);
    const identityKey = workspaceMemoryIdentityKey(candidate);
    const collision = currentStore.entries.find(entry => (
      entry.status === "active" &&
      !targetIds.has(entry.id) &&
      (workspaceMemoryExactKey(entry) === exactKey || workspaceMemoryIdentityKey(entry) === identityKey)
    ));
    if (collision) {
      errors.push(validationError("identity_collision", "Edited replacement text collides with an unrelated active memory.", proposal.id));
    }
  }

  return { valid: errors.length === 0, errors };
}

export function planMemoryReviewBatchApply(
  input: unknown,
  snapshot: MemoryReviewSnapshot,
  _currentStore?: WorkspaceMemoryStore,
  options: { proposalIds?: string[] } = {},
): MemoryReviewDryRunResult {
  const validation = validateMemoryReviewProposalSet(input, snapshot);
  if (!validation.valid || !isObject(input) || !Array.isArray(input.proposals)) {
    return { ...validation, operations: [] };
  }

  const selectedIds = options.proposalIds ? new Set(options.proposalIds) : undefined;
  const selectedProposals = (input.proposals as MemoryReviewProposal[]).filter(proposal => !selectedIds || selectedIds.has(proposal.id));
  const seenTargets = new Map<string, string>();
  for (const proposal of selectedProposals) {
    for (const target of proposal.targets) {
      const owner = seenTargets.get(target);
      if (owner && owner !== proposal.id) {
        return {
          valid: false,
          errors: [validationError("batch_conflict", `Target ${target} is selected by multiple proposals.`, proposal.id)],
          operations: [],
        };
      }
      seenTargets.set(target, proposal.id);
    }
  }

  return dryRunMemoryReviewProposalSet({ ...input, proposals: selectedProposals }, snapshot);
}

function proposalById(proposalSet: MemoryReviewProposalSet, proposalIds: string[]): MemoryReviewProposal[] {
  const selected = new Set(proposalIds);
  return proposalSet.proposals.filter(proposal => selected.has(proposal.id));
}

function validateProtectedTarget(entry: WorkspaceMemoryStore["entries"][number], proposalId: string): MemoryReviewValidationError | undefined {
  if (entry.status !== "active") return validationError("target_unavailable", "Target memory is not active.", proposalId);
  if (entry.source !== "compaction" || entry.safetyCritical || (entry.reinforcementCount ?? 0) > 0) {
    return validationError("protected_source", "Memory Review MVP can only mutate active unreinforced compaction memories.", proposalId);
  }
  return undefined;
}

function validateCurrentTargets(
  proposal: MemoryReviewProposal,
  snapshot: MemoryReviewSnapshot,
  currentStore: WorkspaceMemoryStore,
): MemoryReviewValidationError[] {
  const errors: MemoryReviewValidationError[] = [];
  const snapshotTargets = targetMemories(snapshot, proposal.targets);
  for (const snapshotMemory of snapshotTargets) {
    const current = currentStore.entries.find(entry => entry.id === snapshotMemory.memoryId);
    if (!current) {
      errors.push(validationError("target_unavailable", "Target memory no longer exists.", proposal.id));
      continue;
    }
    const protectedError = validateProtectedTarget(current, proposal.id);
    if (protectedError) errors.push(protectedError);
    if (workspaceMemoryExactKey(current) !== snapshotMemory.exactKey || workspaceMemoryIdentityKey(current) !== snapshotMemory.identityKey) {
      errors.push(validationError("target_changed", "Target memory changed since the review snapshot.", proposal.id));
    }
  }
  return errors;
}

function validateReplacementForApply(
  proposal: MemoryReviewProposal,
  snapshot: MemoryReviewSnapshot,
  currentStore: WorkspaceMemoryStore,
): MemoryReviewValidationError[] {
  if (proposal.action === "forget") return [];
  return validateMemoryReviewUserEdit(proposal, snapshot, proposal.proposedText ?? "", currentStore).errors;
}

export async function applyMemoryReviewProposalBatch(
  root: string,
  proposalSet: MemoryReviewProposalSet,
  snapshot: MemoryReviewSnapshot,
  proposalIds: string[],
): Promise<MemoryReviewApplyResult> {
  const applyAttemptId = `memory_review_apply_${randomUUID()}`;
  const selectedProposals = proposalById(proposalSet, proposalIds);
  const selectedSet: MemoryReviewProposalSet = { ...proposalSet, proposals: selectedProposals };
  const initialPlan = planMemoryReviewBatchApply(selectedSet, snapshot, undefined, { proposalIds });
  if (!initialPlan.valid || selectedProposals.length === 0) {
    const result = { ...initialPlan, applied: false, applyAttemptId };
    await appendEvidenceEvent(root, memoryReviewBatchFailureEvidence(result, selectedSet, snapshot));
    return result;
  }

  await appendEvidenceEvent(root, memoryReviewBatchStartedEvidence(selectedSet, snapshot, proposalIds, applyAttemptId));

  let finalPlan: MemoryReviewDryRunResult | undefined;
  let applied = false;
  await updateWorkspaceMemoryWithAccounting(root, currentStore => {
    const errors: MemoryReviewValidationError[] = [];
    const targetIds = new Set<string>();
    for (const proposal of selectedProposals) {
      for (const error of validateCurrentTargets(proposal, snapshot, currentStore)) errors.push(error);
      for (const error of validateReplacementForApply(proposal, snapshot, currentStore)) errors.push(error);
      for (const memory of targetMemories(snapshot, proposal.targets)) {
        if (targetIds.has(memory.memoryId)) errors.push(validationError("batch_conflict", "Target selected more than once.", proposal.id));
        targetIds.add(memory.memoryId);
      }
    }

    if (errors.length > 0) {
      finalPlan = { valid: false, errors, operations: [] };
      return currentStore;
    }

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const nextEntries = currentStore.entries.map(entry => targetIds.has(entry.id)
      ? { ...entry, status: "superseded" as const, updatedAt: now }
      : entry);

    for (const proposal of selectedProposals) {
      if (proposal.action === "forget") continue;
      const firstTarget = targetMemories(snapshot, proposal.targets)[0];
      const proposedType = replacementMemoryType(proposal, firstTarget?.type);
      if (!proposedType || !proposal.proposedText) continue;
      nextEntries.push({
        id: `mem_review_${randomUUID()}`,
        type: proposedType,
        text: redactCredentials(proposal.proposedText),
        rationale: proposal.rationale,
        source: "manual",
        confidence: 0.8,
        status: "active",
        createdAt: now,
        updatedAt: now,
        retentionClock: nowMs,
        staleAfterDays: staleAfterDaysFor(proposedType),
        supersedes: targetMemories(snapshot, proposal.targets).map(memory => memory.memoryId),
      });
    }

    finalPlan = dryRunMemoryReviewProposalSet(selectedSet, snapshot);
    applied = true;
    return { ...currentStore, entries: nextEntries, updatedAt: now };
  });

  if (!applied || !finalPlan?.valid) {
    const result = { ...(finalPlan ?? { valid: false, errors: [], operations: [] }), applied: false, applyAttemptId };
    await appendEvidenceEvent(root, memoryReviewBatchFailureEvidence(result, selectedSet, snapshot));
    return result;
  }

  await appendEvidenceEvent(root, {
    type: "memory_review_batch_applied",
    phase: "memory_review",
    outcome: "applied",
    reasonCodes: ["user_approved"],
    relations: targetRelations(snapshot, selectedProposals),
    details: { proposalSetId: proposalSet.id, snapshotId: snapshot.id, proposalIds, applyAttemptId },
    textPreview: proposalTextPreview(selectedProposals),
  });

  return { ...finalPlan, applied: true, applyAttemptId };
}

export function createMemoryReviewDecisionRecord(
  input: CreateMemoryReviewDecisionRecordInput,
): MemoryReviewDecisionRecord {
  return {
    version: 1,
    kind: MEMORY_REVIEW_DECISION_KIND,
    ...input,
  };
}

export function memoryReviewDecisionEvidence(record: MemoryReviewDecisionRecord): EvidenceEventInput | undefined {
  if (record.decision === "approved") {
    return {
      type: "memory_review_proposal_approved",
      phase: "memory_review",
      outcome: "approved",
      reasonCodes: ["user_approved"],
      details: {
        proposalSetId: record.proposalSetId,
        proposalId: record.proposalId,
        applyAttemptId: record.applyAttemptId ?? null,
      },
      textPreview: record.note,
    };
  }

  if (record.decision === "rejected") {
    return {
      type: "memory_review_proposal_rejected",
      phase: "memory_review",
      outcome: "rejected",
      reasonCodes: ["user_rejected"],
      details: {
        proposalSetId: record.proposalSetId,
        proposalId: record.proposalId,
      },
      textPreview: record.note,
    };
  }

  if (record.decision === "edited") {
    return {
      type: "memory_review_proposal_edited",
      phase: "memory_review",
      outcome: "edited",
      reasonCodes: ["user_edited"],
      details: {
        proposalSetId: record.proposalSetId,
        proposalId: record.proposalId,
        validationValid: record.validation?.valid ?? null,
      },
      textPreview: record.userEditedText ?? record.note,
    };
  }

  return undefined;
}

export async function appendMemoryReviewDecisionEvidence(
  root: string,
  record: MemoryReviewDecisionRecord,
): Promise<void> {
  const event = memoryReviewDecisionEvidence(record);
  if (event) await appendEvidenceEvent(root, event);
}

export function memoryReviewBatchFailureEvidence(
  result: MemoryReviewValidationResult,
  proposalSet: MemoryReviewProposalSet,
  snapshot: MemoryReviewSnapshot,
): EvidenceEventInput {
  const reasonCodes = [...new Set(result.errors.map(error => error.code))];
  return {
    type: "memory_review_batch_apply_failed",
    phase: "memory_review",
    outcome: "failed",
    reasonCodes: reasonCodes.length > 0 ? reasonCodes : ["batch_failed"],
    relations: targetRelations(snapshot, proposalSet.proposals),
    details: proposalSetEvidenceDetails(proposalSet),
    textPreview: proposalTextPreview(proposalSet.proposals),
  };
}

function memoryReviewBatchStartedEvidence(
  proposalSet: MemoryReviewProposalSet,
  snapshot: MemoryReviewSnapshot,
  proposalIds: string[],
  applyAttemptId: string,
): EvidenceEventInput {
  return {
    type: "memory_review_batch_apply_started",
    phase: "memory_review",
    outcome: "approved",
    reasonCodes: ["apply_started"],
    relations: targetRelations(snapshot, proposalSet.proposals),
    details: {
      ...proposalSetEvidenceDetails(proposalSet),
      proposalIds,
      applyAttemptId,
    },
    textPreview: proposalTextPreview(proposalSet.proposals),
  };
}

function parseFenceStart(line: string): { marker: string; info: string } | undefined {
  const match = /^(?:[ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  return { marker: match[1], info: match[2].trim() };
}

function isFenceClose(line: string, openingMarker: string): boolean {
  const fenceChar = openingMarker[0];
  const minLength = openingMarker.length;
  const pattern = new RegExp(`^[ \\t]*\\${fenceChar}{${minLength},}[ \\t]*$`);
  return pattern.test(line);
}

function extractMemoryReviewProposalFenceBodies(text: string): string[] {
  const bodies: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const start = parseFenceStart(lines[index]);
    if (!start) continue;

    const content: string[] = [];
    let closeIndex = index + 1;
    while (closeIndex < lines.length && !isFenceClose(lines[closeIndex], start.marker)) {
      content.push(lines[closeIndex]);
      closeIndex += 1;
    }

    if (closeIndex >= lines.length) break;
    if (start.info === MEMORY_REVIEW_PROPOSALS_FENCE_INFO) {
      bodies.push(content.join("\n"));
    }
    index = closeIndex;
  }

  return bodies;
}

export function extractMemoryReviewProposalBlocks(text: string): MemoryReviewProposalBlock[] {
  const blocks: MemoryReviewProposalBlock[] = [];
  for (const raw of extractMemoryReviewProposalFenceBodies(text)) {
    try {
      const json = JSON.parse(raw);
      if (hasMemoryReviewProposalKind(json)) {
        blocks.push({ raw, json });
      }
    } catch {
      // Rollout 0 is a capability probe: malformed fenced JSON is ignored and
      // must never affect the assistant-visible text.
    }
  }

  return blocks;
}

export function parseMemoryReviewProposalText(text: string): MemoryReviewParseResult {
  const bodies = extractMemoryReviewProposalFenceBodies(text);
  if (bodies.length === 0) return { ok: false, reasonCodes: ["missing_proposal_fence"] };
  if (bodies.length > 1) return { ok: false, reasonCodes: ["multiple_proposal_fences"] };

  try {
    const proposalSet = JSON.parse(bodies[0]) as unknown;
    if (!hasMemoryReviewProposalKind(proposalSet)) {
      return { ok: false, proposalSet, reasonCodes: ["missing_proposal_kind"] };
    }
    return { ok: true, proposalSet, reasonCodes: [] };
  } catch {
    return { ok: false, reasonCodes: ["malformed_proposal_json"] };
  }
}

export async function captureMemoryReviewProposalText(
  root: string,
  text: string,
  context: MemoryReviewCaptureContext,
): Promise<MemoryReviewCaptureResult> {
  const originalText = text;
  const proposalBlockCount = extractMemoryReviewProposalFenceBodies(originalText).length;
  const parsed = parseMemoryReviewProposalText(originalText);
  if (!parsed.ok) {
    const reasonCodes = parsed.reasonCodes[0] === "missing_proposal_fence" && context.activeSnapshotId && originalText.includes(context.activeSnapshotId)
      ? ["capture_snapshot_id_outside_fence"]
      : parsed.reasonCodes;
    if (reasonCodes[0] !== "missing_proposal_fence") {
      await appendEvidenceEvent(root, memoryReviewProposalRejectedEvidence({ reasonCodes, context }));
    }
    return {
      text: originalText,
      status: parsed.reasonCodes[0] === "missing_proposal_fence" ? "ignored" : "rejected",
      detected: proposalBlockCount > 0,
      proposalBlockCount,
      reasonCodes,
    };
  }

  const proposalSet = parsed.proposalSet;
  const snapshotId = isObject(proposalSet) ? textValue(proposalSet.snapshotId) : undefined;
  if (!isObject(proposalSet) || !snapshotId) {
    await appendEvidenceEvent(root, memoryReviewProposalRejectedEvidence({ reasonCodes: ["snapshot_mismatch"], context }));
    return {
      text: originalText,
      status: "rejected",
      detected: true,
      proposalBlockCount,
      reasonCodes: ["snapshot_mismatch"],
    };
  }

  const snapshot = await loadMemoryReviewSnapshot(root, snapshotId);
  if (!snapshot) {
    await appendEvidenceEvent(root, memoryReviewProposalRejectedEvidence({
      reasonCodes: ["capture_snapshot_missing"],
      context,
      proposalSet: proposalSetForEvidence(proposalSet, snapshotId),
      snapshotId,
    }));
    return {
      text: originalText,
      status: "ignored",
      detected: true,
      proposalBlockCount,
      reasonCodes: ["capture_snapshot_missing"],
      snapshotId,
    };
  }

  const validation = validateMemoryReviewProposalSet(proposalSet, snapshot);
  if (!validation.valid) {
    const reasonCodes = [...new Set(validation.errors.map(error => error.code))];
    await appendEvidenceEvent(root, memoryReviewProposalRejectedEvidence({
      reasonCodes,
      context,
      proposalSet: proposalSetForEvidence(proposalSet, snapshotId),
      snapshot,
      snapshotId,
    }));
    return {
      text: originalText,
      status: "rejected",
      detected: true,
      proposalBlockCount,
      reasonCodes,
      snapshotId,
      validation,
    };
  }

  const existing = await findCapturedProposalForSnapshot(root, snapshotId);
  if (existing) {
    await appendEvidenceEvent(root, memoryReviewProposalRejectedEvidence({
      reasonCodes: ["capture_already_sealed"],
      context,
      proposalSet: proposalSetForEvidence(proposalSet, snapshotId),
      snapshot,
      snapshotId,
    }));
    return {
      text: originalText,
      status: "ignored",
      detected: true,
      proposalBlockCount,
      reasonCodes: ["capture_already_sealed"],
      proposalSetId: existing.id,
      snapshotId,
    };
  }

  const sealed = sealMemoryReviewProposalSet(proposalSet);
  await saveMemoryReviewProposalSet(root, sealed);
  await appendEvidenceEvent(root, memoryReviewProposalDetectedEvidence(sealed, snapshot, context));
  return {
    text: originalText,
    status: "captured",
    detected: true,
    proposalBlockCount,
    reasonCodes: [],
    proposalSetId: sealed.id,
    snapshotId,
    validation,
  };
}

export async function probeMemoryReviewTextComplete(
  _input: MemoryReviewTextCompleteInput,
  output: MemoryReviewTextCompleteOutput,
  options: { root?: string } = {},
): Promise<MemoryReviewTextCompleteProbeResult> {
  const originalText = output.text;
  const proposalBlockCount = extractMemoryReviewProposalFenceBodies(originalText).length;
  const proposalBlocks = extractMemoryReviewProposalBlocks(originalText);

  // OpenCode text completion hooks can rewrite text. Memory Review treats this
  // hook as read-only transport, so keep both the returned and mutable output
  // text identical to the assistant text received by the hook.
  output.text = originalText;

  if (options.root) {
    const capture = await captureMemoryReviewProposalText(options.root, originalText, {
      source: "hook",
      sessionID: _input.sessionID,
      messageID: _input.messageID,
      partID: _input.partID,
    });
    output.text = originalText;
    return capture;
  }

  return {
    text: originalText,
    detected: proposalBlocks.length > 0,
    proposalBlockCount,
  };
}
