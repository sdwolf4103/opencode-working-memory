/**
 * Memory V2 Plugin for OpenCode
 *
 * Architecture:
 * - Layer 1: Stable Workspace Memory (frozen per session cache epoch, refreshed at compaction)
 * - Layer 2: Frozen Hot Session State (active files, open errors, recent decisions, pending memories)
 * - Layer 3: Native OpenCode State (todos owned by OpenCode, read during compaction)
 *
 * Cache Epoch Model:
 * - Each session creates frozen workspace memory and hot session snapshots on first transform.
 * - Normal turns reuse the exact rendered strings (pre-history system prompts remain stable).
 * - Normal tool/user churn updates session storage but does not mutate pre-history prompts
 *   until compaction, session restart, or process restart starts a new epoch; conversation
 *   and tool history are the source of truth for newer events after epoch start.
 * - Compaction starts a new cache epoch: pending memories are promoted, caches are cleared,
 *   and the next transform re-renders workspace memory and hot session state.
 * - Explicit memory ("remember X") goes to SessionState.pendingMemories + durable journal,
 *   visible in the hot snapshot only if processed before epoch creation, promoted after compaction.
 *
 * This plugin:
 * - Caches frozen workspace memory and hot session state per sessionID epoch
 * - Processes explicit memory from latest user text once per message id
 * - Injects frozen workspace memory and frozen hot session state into system prompt
 * - Updates session state after tool execution
 * - Augments compaction context with numbered memory refs, todos, and instruction
 * - Parses compaction summaries for memory candidates and merges them
 */

import { createHash, randomUUID } from "node:crypto";
import { realpath, rm } from "fs/promises";
import type { Plugin } from "@opencode-ai/plugin";
import {
  extractExplicitMemoriesWithEvidence,
  extractActiveFiles,
  extractErrorsFromBash,
  parseWorkspaceMemoryCandidatesWithEvidence,
  staleAfterDaysFor,
  type WorkspaceMemoryCommand,
} from "./extractors.ts";
import { assessMemoryQuality } from "./memory-quality.ts";
import {
  loadWorkspaceMemory,
  updateWorkspaceMemoryWithAccounting,
  accountWorkspaceMemoryRender,
  accountWorkspaceMemoryCompactionRefs,
  workspaceMemoryExactKey,
  workspaceMemoryIdentityKey,
} from "./workspace-memory.ts";
import { REINFORCEMENT_MAX_COUNT, tryReinforceMemory, type ReinforcementDecision } from "./retention.ts";
import {
  appendPendingMemories,
  clearPendingMemories,
  hasPendingJournalEntries,
  loadPendingJournal,
  memoryKey,
  recordPromotionRejections,
} from "./pending-journal.ts";
import {
  loadSessionState,
  updateSessionState,
  touchActiveFile,
  upsertOpenError,
  clearErrorsForSuccessfulCommand,
  markErrorsMaybeFixedForFile,
  addRecentDecision,
  renderHotSessionState,
} from "./session-state.ts";
import { sessionStatePath, workspaceKey } from "./paths.ts";
import {
  latestUserText,
  latestCompactionSummary,
  pendingTodos,
} from "./opencode.ts";
import { accountPendingPromotions, promotionAccountingEvidenceEvents } from "./promotion-accounting.ts";
import { appendEvidenceEvent, appendEvidenceEvents, type EvidenceEventInput, type MemoryEvidenceRef } from "./evidence-log.ts";
import { type CompactionMemoryRef, type LongTermMemoryEntry, LONG_TERM_LIMITS, WORKSPACE_MEMORY_CACHE_LIMITS } from "./types.ts";

/**
 * Build the complete compaction prompt.
 *
 * Replaces OpenCode's default template (which uses --- separators that trigger
 * YAML frontmatter comment scope in markdown rendering, producing purple italic text).
 * Our template uses only ## Markdown headings and explicitly forbids YAML frontmatter,
 * horizontal rules, and delimiter lines.
 *
 * @param privateContext - Background context (numbered workspace memory refs,
 *   pending todos) from our plugin and any other plugins. Shown to the model to
 *   inform the summary but not copied verbatim.
 */
function buildCompactionPrompt(privateContext: string, compactionId?: string): string {
  const snapshotInstruction = compactionId
    ? `- If you emit any REINFORCE or REPLACE command, include \`Memory ref snapshot id: ${compactionId}\` as the first line under \"Memory candidates:\" so numbered refs match the correct compaction snapshot.`
    : "";
  return [
    "Provide a detailed summary for continuing our conversation above.",
    "Focus on information that would help another agent continue the work: the goal, user instructions, completed work, current state, decisions, relevant files, and next steps.",
    "",
    "Do not call any tools. Respond only with the summary text.",
    "Respond in the same language as the user's messages in the conversation.",
    "",
    "Formatting rules:",
    "- Start the response with \"## Goal\".",
    "- Use Markdown headings only.",
    "- Do not output YAML frontmatter.",
    "- Do not output horizontal rules.",
    "- Do not wrap the summary in delimiter lines such as ---.",
    "- Do not use code fences around the summary.",
    ...(snapshotInstruction ? [snapshotInstruction] : []),
    "",
    "Use this structure:",
    "",
    "## Goal",
    "",
    "## Instructions",
    "",
    "## Progress",
    "",
    "## Key Decisions",
    "",
    "## Discoveries",
    "",
    "## Next Steps",
    "",
    "## Relevant Files",
    "",
    "At the end of the summary, include a Memory candidates section only if there are durable facts that will change future behavior.",
    "",
    "CRITICAL MEMORY RULES:",
    "- Most compactions should produce ZERO memories. Empty is correct when nothing durable changed.",
    "- Existing memories are numbered [M#]. If an existing memory is still accurate, emit at most 3 lines like `REINFORCE [M#]`; do not rephrase it.",
    "- Use `REPLACE [M#] [type] text` only for eligible unreinforced compaction-sourced memories where the old text itself needs correction; this is rarely the right choice.",
    "- To supplement or correct a memory, REINFORCE the existing [M#] if it is still accurate, and also emit a new complete [type] candidate with the addition or correction. Do not use REPLACE for additions; do not reinforce a memory that is now inaccurate.",
    "- NO completion or progress statements: do not extract completed work, passing tests, commits, PR status, wave/task/phase completion, or current state.",
    "- NO session-internal implementation notes: do not extract what files were edited, what bug was just fixed, what command just ran, or what the assistant reviewed.",
    "- decision = future rule/architecture choice; reference = stable lookup fact; project = stable project fact; feedback = stable user preference.",
    "- Do not use decision for service names, IDs, URLs, file paths, or one-off session status; use reference/project or skip.",
    "- If unsure, skip it.",
    "",
    "Good memory examples:",
    "- REINFORCE [M1]",
    "- [feedback] User prefers architecture reviews in Traditional Chinese.",
    "- [decision] Keep memory dedupe exact-only for decisions.",
    "- [project] This repository is an OpenCode plugin using local JSON stores.",
    "- [reference] Workspace memory is rendered as frozen system[1]; pending memories remain in hot state until compaction.",
    "",
    "Bad memory examples to skip:",
    "- Wave 2 completed successfully.",
    "- 180 tests passed and CI is green.",
    "- Implemented owner-aware cleanup in plugin.ts.",
    "- The assistant reviewed code reviewer feedback and updated the plan.",
    "- Commit a762e86 contains the owner scope fix.",
    "",
    "Format when there ARE REINFORCE/REPLACE commands or durable new candidates:",
    "Memory candidates:",
    "REINFORCE [M#]",
    "REPLACE [M#] [feedback|decision|project|reference] corrected durable fact",
    "- [feedback|decision|project|reference] new future-facing durable fact",
    "",
    "Format when there are NO REINFORCE/REPLACE commands or durable candidates:",
    "Memory candidates:",
    "(none)",
    "",
    "Background context, use this to inform the summary above.",
    "Do not output this context verbatim:",
    "",
    privateContext,
  ].join("\n");
}

/**
 * Render todos for compaction context (plain text format, no Markdown headers).
 */
function renderTodosForCompaction(todos: Array<{ content: string; status: string; priority?: string }>): string {
  if (todos.length === 0) return "";
  const lines = ["Pending todos:"];
  for (const todo of todos) {
    const priority = todo.priority ? ` [${todo.priority}]` : "";
    const status = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "→" : "○";
    lines.push(`- ${status} ${todo.content}${priority}`);
  }
  return lines.join("\n");
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240);
}

type CompactionRefResolution =
  | {
      ok: true;
      refSnapshot: CompactionMemoryRef;
      target: LongTermMemoryEntry;
      targetIndex: number;
    }
  | {
      ok: false;
      reason: "missing_memory_ref_snapshot" | "invalid_memory_ref" | "memory_ref_target_unavailable" | "memory_ref_target_changed";
      refSnapshot?: CompactionMemoryRef;
      target?: LongTermMemoryEntry;
    };

async function warnMemoryHook(scope: string, error: unknown, root?: string): Promise<void> {
  const message = safeErrorMessage(error);
  console.error(`[memory] ${scope} failed: ${message}`);
  if (root) {
    await appendEvidenceEvent(root, {
      type: "hook_failed",
      phase: "hook",
      outcome: "failed",
      reasonCodes: [scope],
      details: { message },
    }).catch(() => undefined);
  }
}

async function workspaceRootHash(root: string): Promise<string> {
  const resolved = await realpath(root).catch(() => root);
  return createHash("sha256").update(resolved).digest("hex").slice(0, 16);
}

async function workspaceIdentity(root: string): Promise<{ workspaceKey: string; workspaceRootHash: string }> {
  const [workspaceKeyValue, workspaceRootHashValue] = await Promise.all([
    workspaceKey(root),
    workspaceRootHash(root),
  ]);
  return { workspaceKey: workspaceKeyValue, workspaceRootHash: workspaceRootHashValue };
}

function compactionIdFromSummary(summary: string): string | undefined {
  return summary.match(/Memory ref snapshot id:\s*([a-zA-Z0-9_-]+)/i)?.[1];
}

export const MemoryV2Plugin: Plugin = async (input) => {
  const { directory, client } = input;

  // Cache for sub-agent detection — avoids repeated API calls per session.
  // Maps sessionID → parentID (string) or null (root session).
  const sessionParentCache = new Map<string, string | null>();

  async function isSubAgent(sessionID: string): Promise<boolean> {
    if (sessionParentCache.has(sessionID)) {
      return sessionParentCache.get(sessionID) !== null;
    }
    try {
      const result = await client.session.get({ path: { id: sessionID } });
      const parentID = result.data?.parentID ?? null;
      sessionParentCache.set(sessionID, parentID);
      return parentID !== null;
    } catch {
      // If we can't determine, assume it's NOT a sub-agent (safe default).
      sessionParentCache.set(sessionID, null);
      return false;
    }
  }

  // Cache for frozen workspace memory per session
  const frozenWorkspaceMemoryCache = new Map<
    string,
    {
      store: Awaited<ReturnType<typeof loadWorkspaceMemory>>;
      renderedPrompt: string;
      loadedAt: number;
      lastAccessedAt: number;
    }
  >();

  // Cache for frozen hot session state per session epoch.
  // Lifecycle is unified with frozenWorkspaceMemoryCache; do not clear independently.
  const frozenHotSessionStateCache = new Map<
    string,
    {
      renderedPrompt: string;
      loadedAt: number;
      lastAccessedAt: number;
    }
  >();

  // Cache for processed user message IDs (to avoid duplicate processing)
  const processedUserMessages = new Map<string, Set<string>>();

  function memoryEvidenceRef(memory: LongTermMemoryEntry): MemoryEvidenceRef {
    return {
      memoryId: memory.id,
      memoryKeyHash: memoryKey(memory),
      identityKeyHash: workspaceMemoryIdentityKey(memory),
      type: memory.type,
      source: memory.source,
      status: memory.status,
    };
  }

  function pendingAppendedEvidence(memory: LongTermMemoryEntry): EvidenceEventInput {
    return {
      type: "pending_memory_appended",
      phase: "pending_journal",
      outcome: "accepted",
      memory: memoryEvidenceRef(memory),
      relations: [{ role: "pending", memory: memoryEvidenceRef(memory) }],
      reasonCodes: ["pending_journal_append"],
      textPreview: memory.text,
    };
  }

  function memoryReinforcedEvidence(
    memory: LongTermMemoryEntry | undefined,
    ref: string,
    outcome: "reinforced" | "rejected",
    reasonCodes: string[],
    details: EvidenceEventInput["details"] = {},
  ): EvidenceEventInput {
    const relationRole = outcome === "rejected" ? "target" : "reinforced";
    return {
      type: "memory_reinforced",
      phase: "reinforcement",
      outcome,
      memory: memory ? memoryEvidenceRef(memory) : undefined,
      relations: memory ? [{ role: relationRole, memory: memoryEvidenceRef(memory) }] : undefined,
      reasonCodes,
      details: {
        ref,
        ...details,
      },
      textPreview: memory?.text,
    };
  }

  function reinforcementDecisionTimingDetails(decision: ReinforcementDecision): EvidenceEventInput["details"] {
    return {
      attemptedAtMs: decision.attemptedAt,
      attemptedAtIso: new Date(decision.attemptedAt).toISOString(),
      ...(decision.lastReinforcedAt !== undefined ? {
        lastReinforcedAtMs: decision.lastReinforcedAt,
        lastReinforcedAtIso: new Date(decision.lastReinforcedAt).toISOString(),
      } : {}),
      ...(decision.elapsedMs !== undefined ? { elapsedMs: decision.elapsedMs } : {}),
      requiredElapsedMs: decision.requiredElapsedMs,
      sameSession: decision.sameSession,
      ...(decision.legacyMissingTimestamp ? { legacyMissingTimestamp: true } : {}),
    };
  }

  function replacementMemoryId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function memoryReplacedEvidence(
    oldMemory: LongTermMemoryEntry | undefined,
    newMemory: LongTermMemoryEntry | undefined,
    ref: string,
    outcome: "superseded" | "rejected",
    reasonCodes: string[],
    details: EvidenceEventInput["details"] = {},
  ): EvidenceEventInput {
    const relations = outcome === "rejected"
      ? [
        ...(oldMemory ? [{ role: "target" as const, memory: memoryEvidenceRef(oldMemory) }] : []),
      ]
      : [
        ...(oldMemory ? [{ role: "superseded" as const, memory: memoryEvidenceRef(oldMemory) }] : []),
        ...(newMemory ? [{ role: "superseded_by" as const, memory: memoryEvidenceRef(newMemory) }] : []),
      ];
    return {
      type: "memory_replaced_numbered_ref",
      phase: "storage",
      outcome,
      memory: oldMemory ? memoryEvidenceRef(oldMemory) : undefined,
      relations: relations.length > 0 ? relations : undefined,
      reasonCodes,
      details: {
        ref,
        ...details,
      },
      textPreview: newMemory?.text ?? oldMemory?.text,
    };
  }

  function compactionRefByLabel(refs: CompactionMemoryRef[]): Map<string, CompactionMemoryRef> {
    return new Map(refs.map(ref => [ref.ref.toUpperCase(), ref]));
  }

  function compactionSnapshotStatus(
    refs: CompactionMemoryRef[],
    expectedCompactionId: string | undefined,
  ): { ok: true } | { ok: false; storedCompactionId: string } {
    if (refs.length === 0) return { ok: false, storedCompactionId: "none" };

    const ids = new Set(refs.map(ref => ref.compactionId).filter((id): id is string => typeof id === "string" && id.length > 0));
    if (!expectedCompactionId) return { ok: true };
    if (ids.size === 1 && ids.has(expectedCompactionId)) return { ok: true };
    if (ids.size === 0) return { ok: false, storedCompactionId: "none" };
    if (ids.size === 1) return { ok: false, storedCompactionId: [...ids][0] };
    return { ok: false, storedCompactionId: "mixed" };
  }

  function resolveCompactionMemoryRef(
    refs: CompactionMemoryRef[],
    refsByLabel: Map<string, CompactionMemoryRef>,
    entries: LongTermMemoryEntry[],
    ref: string,
  ): CompactionRefResolution {
    if (refs.length === 0) {
      return { ok: false, reason: "missing_memory_ref_snapshot" };
    }

    const refSnapshot = refsByLabel.get(ref.toUpperCase());
    if (!refSnapshot) {
      return { ok: false, reason: "invalid_memory_ref" };
    }

    const targetIndex = entries.findIndex(entry => entry.id === refSnapshot.memoryId);
    const target = targetIndex >= 0 ? entries[targetIndex] : undefined;
    if (!target || target.status !== "active") {
      return { ok: false, reason: "memory_ref_target_unavailable", refSnapshot, target };
    }

    if (workspaceMemoryExactKey(target) !== refSnapshot.exactKey) {
      return { ok: false, reason: "memory_ref_target_changed", refSnapshot, target };
    }

    return { ok: true, refSnapshot, target, targetIndex };
  }

  async function applyCompactionMemoryCommands(
    sessionID: string,
    commands: WorkspaceMemoryCommand[],
    compactionId: string | undefined,
  ): Promise<void> {
    if (commands.length === 0) return;

    const sessionState = await loadSessionState(directory, sessionID);
    const snapshotStatus = compactionSnapshotStatus(sessionState.compactionMemoryRefs, compactionId);
    const refs = snapshotStatus.ok ? sessionState.compactionMemoryRefs : [];
    const refsByLabel = compactionRefByLabel(refs);
    const evidence: EvidenceEventInput[] = [];
    const now = Date.now();
    let snapshotMismatchDetails: EvidenceEventInput["details"] = {};
    if ("storedCompactionId" in snapshotStatus) {
      snapshotMismatchDetails = {
        ...(compactionId ? { compactionId } : {}),
        storedCompactionId: snapshotStatus.storedCompactionId,
      };
    }

    const updateResult = await updateWorkspaceMemoryWithAccounting(directory, workspaceMemory => {
      for (const command of commands) {
        const resolution = resolveCompactionMemoryRef(refs, refsByLabel, workspaceMemory.entries, command.ref);
        if (resolution.ok === false) {
          const memoryId = resolution.refSnapshot?.memoryId;
          const details = memoryId ? { ...snapshotMismatchDetails, memoryId } : snapshotMismatchDetails;
          if (command.kind === "REINFORCE") {
            evidence.push(memoryReinforcedEvidence(resolution.target, command.ref, "rejected", [resolution.reason], details));
          } else {
            evidence.push(memoryReplacedEvidence(resolution.target, undefined, command.ref, "rejected", [resolution.reason], details));
          }
          continue;
        }

        const { refSnapshot, target, targetIndex } = resolution;
        if (command.kind === "REINFORCE") {
          const decision = tryReinforceMemory(target, sessionID, now);
          if (decision.outcome === "blocked") {
            evidence.push(memoryReinforcedEvidence(target, command.ref, "rejected", ["numbered_ref_reinforce", "reinforcement_window_blocked", `reinforcement_block_${decision.blockReason}`], {
              memoryId: refSnapshot.memoryId,
              blockReason: decision.blockReason,
              ...reinforcementDecisionTimingDetails(decision),
              reinforcementCount: decision.reinforcementCount,
              maxReinforcementCount: decision.maxReinforcementCount,
            }));
            continue;
          }

          const reinforced = decision.memory;
          workspaceMemory.entries[targetIndex] = reinforced;
          const reasonCodes = ["numbered_ref_reinforce", "reinforcement_window_allowed"];
          if (decision.reinforcementMode === "refresh_only") {
            reasonCodes.push("reinforcement_saturation_refresh");
          }
          evidence.push(memoryReinforcedEvidence(reinforced, command.ref, "reinforced", reasonCodes, {
            memoryId: refSnapshot.memoryId,
            reinforcementOutcome: decision.reinforcementMode === "refresh_only" ? "refreshed" : "reinforced",
            reinforcementMode: decision.reinforcementMode,
            ...reinforcementDecisionTimingDetails(decision),
            previousReinforcementCount: decision.previousReinforcementCount,
            newReinforcementCount: decision.newReinforcementCount,
            reinforcementCount: decision.newReinforcementCount,
            maxReinforcementCount: REINFORCEMENT_MAX_COUNT,
          }));
          continue;
        }

        if (target.source !== "compaction") {
          evidence.push(memoryReplacedEvidence(target, undefined, command.ref, "rejected", ["protected_memory_source"], {
            memoryId: refSnapshot.memoryId,
            source: target.source,
          }));
          continue;
        }

        if ((target.reinforcementCount ?? 0) > 0) {
          evidence.push(memoryReplacedEvidence(target, undefined, command.ref, "rejected", ["protected_reinforced_target"], {
            memoryId: refSnapshot.memoryId,
            reinforcementCount: target.reinforcementCount ?? 0,
          }));
          continue;
        }

        const quality = assessMemoryQuality({ type: command.type, text: command.text, source: "compaction" });
        if (!quality.accepted) {
          evidence.push(memoryReplacedEvidence(target, undefined, command.ref, "rejected", quality.reasons, {
            memoryId: refSnapshot.memoryId,
          }));
          continue;
        }

        const supersededTarget: LongTermMemoryEntry = {
          ...target,
          status: "superseded",
          updatedAt: new Date(now).toISOString(),
        };
        const replacement: LongTermMemoryEntry = {
          id: replacementMemoryId(),
          type: command.type,
          text: command.text.slice(0, LONG_TERM_LIMITS.maxEntryTextChars),
          source: "compaction",
          confidence: 0.75,
          status: "active",
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          retentionClock: now,
          staleAfterDays: staleAfterDaysFor(command.type),
          supersedes: [target.id],
        };

        workspaceMemory.entries[targetIndex] = supersededTarget;
        workspaceMemory.entries.push(replacement);
        evidence.push(memoryReplacedEvidence(supersededTarget, replacement, command.ref, "superseded", [
          "numbered_ref_replace",
          command.type === target.type ? "same_type_replace" : "cross_type_replace",
        ], {
          oldMemoryId: target.id,
          newMemoryId: replacement.id,
          oldType: target.type,
          newType: command.type,
        }));
      }

      return workspaceMemory;
    });

    await appendEvidenceEvents(directory, [...updateResult.evidence, ...evidence].map(event => ({
      ...event,
      sessionHash: sessionID,
    })));
  }

  function clearFrozenPromptEpoch(sessionID: string): void {
    frozenWorkspaceMemoryCache.delete(sessionID);
    frozenHotSessionStateCache.delete(sessionID);
  }

  function pruneFrozenPromptEpochCaches(): void {
    const lastAccessedAtBySession = new Map<string, number>();
    for (const [sessionID, cached] of frozenWorkspaceMemoryCache) {
      lastAccessedAtBySession.set(
        sessionID,
        Math.max(lastAccessedAtBySession.get(sessionID) ?? cached.lastAccessedAt, cached.lastAccessedAt),
      );
    }
    for (const [sessionID, cached] of frozenHotSessionStateCache) {
      lastAccessedAtBySession.set(
        sessionID,
        Math.max(lastAccessedAtBySession.get(sessionID) ?? cached.lastAccessedAt, cached.lastAccessedAt),
      );
    }

    const sorted = [...lastAccessedAtBySession.entries()].sort((a, b) => a[1] - b[1]);
    while (lastAccessedAtBySession.size > WORKSPACE_MEMORY_CACHE_LIMITS.maxFrozenSessions) {
      const [oldestSessionID] = sorted.shift() ?? [];
      if (!oldestSessionID) break;
      lastAccessedAtBySession.delete(oldestSessionID);
      clearFrozenPromptEpoch(oldestSessionID);
    }

    for (const sessionID of frozenWorkspaceMemoryCache.keys()) {
      if (!lastAccessedAtBySession.has(sessionID)) frozenWorkspaceMemoryCache.delete(sessionID);
    }
    for (const sessionID of frozenHotSessionStateCache.keys()) {
      if (!lastAccessedAtBySession.has(sessionID)) frozenHotSessionStateCache.delete(sessionID);
    }
  }

  function pruneProcessedUserMessagesCache(): void {
    for (const [sessionID, messages] of processedUserMessages) {
      while (messages.size > WORKSPACE_MEMORY_CACHE_LIMITS.maxProcessedMessagesPerSession) {
        const oldest = messages.values().next().value as string | undefined;
        if (!oldest) break;
        messages.delete(oldest);
      }

      if (messages.size === 0) {
        processedUserMessages.delete(sessionID);
      }
    }

    while (processedUserMessages.size > WORKSPACE_MEMORY_CACHE_LIMITS.maxProcessedSessionIDs) {
      const oldestSessionID = processedUserMessages.keys().next().value as string | undefined;
      if (!oldestSessionID) break;
      processedUserMessages.delete(oldestSessionID);
    }
  }

  function rememberProcessedUserMessage(sessionID: string, messageID: string, processedForSession: Set<string>): void {
    processedForSession.add(messageID);
    while (processedForSession.size > WORKSPACE_MEMORY_CACHE_LIMITS.maxProcessedMessagesPerSession) {
      const oldest = processedForSession.values().next().value as string | undefined;
      if (!oldest) break;
      processedForSession.delete(oldest);
    }

    if (processedUserMessages.has(sessionID)) {
      processedUserMessages.delete(sessionID);
    }
    processedUserMessages.set(sessionID, processedForSession);
    pruneProcessedUserMessagesCache();
  }

  async function processLatestUserMessage(sessionID: string): Promise<void> {
    const processedForSession = processedUserMessages.get(sessionID) ?? new Set<string>();
    const latestMessage = await latestUserText(client, sessionID);

    if (!latestMessage?.id || processedForSession.has(latestMessage.id)) return;

    const extraction = extractExplicitMemoriesWithEvidence(latestMessage.text);
    await appendEvidenceEvents(directory, extraction.evidence.map(event => ({
      ...event,
      sessionHash: sessionID,
      messageHash: latestMessage.id,
    })));

    const memories = extraction.entries.map(memory => ({
      ...memory,
      pendingOwnerSessionID: sessionID,
      pendingMessageID: latestMessage.id,
    }));
    const decisions = memories.filter(memory => memory.type === "decision");

    if (memories.length > 0) {
      await updateSessionState(directory, sessionID, state => {
        state.pendingMemories.push(...memories);
        return state;
      });
      await appendPendingMemories(directory, memories);
      await appendEvidenceEvents(directory, memories.map(memory => ({
        ...pendingAppendedEvidence(memory),
        sessionHash: sessionID,
        messageHash: latestMessage.id,
      })));
    }

    if (decisions.length > 0) {
      await updateSessionState(directory, sessionID, state => {
        for (const decision of decisions) {
          addRecentDecision(state, {
            text: decision.text,
            rationale: decision.rationale,
            source: "user",
          });
        }
        return state;
      });
    }

    rememberProcessedUserMessage(sessionID, latestMessage.id, processedForSession);
  }

  function dedupePendingPromotionMemories(
    memories: LongTermMemoryEntry[],
  ): LongTermMemoryEntry[] {
    const seen = new Set<string>();
    const deduped: LongTermMemoryEntry[] = [];

    for (const memory of memories) {
      const key = memoryKey(memory);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(memory);
    }

    return deduped;
  }

  async function promotePendingMemories(
    sessionID?: string,
    options: { includeUnownedJournal?: boolean; includeOwnedJournal?: boolean } = {},
  ): Promise<void> {
    const includeUnownedJournal = options.includeUnownedJournal ?? !sessionID;
    const includeOwnedJournal = options.includeOwnedJournal ?? Boolean(sessionID);
    const [journal, sessionState] = await Promise.all([
      loadPendingJournal(directory),
      sessionID ? loadSessionState(directory, sessionID) : Promise.resolve(undefined),
    ]);

    const journalPending = journal.entries.filter(memory => {
      if (sessionID && includeOwnedJournal && memory.pendingOwnerSessionID === sessionID) return true;
      if (includeUnownedJournal && !memory.pendingOwnerSessionID) return true;
      return false;
    });

    const pending = dedupePendingPromotionMemories([
      ...(sessionState?.pendingMemories ?? []),
      ...journalPending,
    ]);
    if (pending.length === 0) return;

    let beforeEntries: Awaited<ReturnType<typeof loadWorkspaceMemory>>["entries"] = [];

    const updateResult = await updateWorkspaceMemoryWithAccounting(directory, workspaceMemory => {
      beforeEntries = [...workspaceMemory.entries];
      const existingByKey = new Map<string, { memory: typeof workspaceMemory.entries[number]; index: number }>();
      workspaceMemory.entries.forEach((memory, index) => {
        if (memory.status === "superseded") return;
        existingByKey.set(memoryKey(memory), { memory, index });
      });

      const promotedAt = Date.now();
      for (const memory of pending) {
        const key = memoryKey(memory);
        const existing = existingByKey.get(key);
        if (existing) {
          const decision = tryReinforceMemory(
            existing.memory,
            sessionID ?? memory.pendingOwnerSessionID ?? "workspace-promotion",
            promotedAt,
          );
          const reinforced = decision.memory;
          if (reinforced !== existing.memory) {
            workspaceMemory.entries[existing.index] = reinforced;
            existingByKey.set(key, { memory: reinforced, index: existing.index });
          }
        } else {
          workspaceMemory.entries.push({
            ...memory,
            retentionClock: memory.retentionClock ?? promotedAt,
          });
          existingByKey.set(key, {
            memory: workspaceMemory.entries[workspaceMemory.entries.length - 1],
            index: workspaceMemory.entries.length - 1,
          });
        }
      }

      return workspaceMemory;
    });

    const accounting = accountPendingPromotions({
      pending,
      before: beforeEntries,
      after: updateResult.store.entries,
      events: updateResult.events,
    });

    const exhaustedRejectedKeys = await recordPromotionRejections(
      directory,
      accounting.retryableRejectedKeys,
      "rejected_capacity",
      {
        ownerSessionID: sessionID,
        includeUnownedOnly: !sessionID,
      },
    );

    await appendEvidenceEvents(directory, [
      ...updateResult.evidence,
      ...promotionAccountingEvidenceEvents({
        pending,
        after: updateResult.store.entries,
        events: updateResult.events,
        accounting,
        exhaustedRejectedKeys,
      }),
    ].map(event => ({
      ...event,
      sessionHash: sessionID,
    })));

    const sessionRemovalKeys = new Set([
      ...accounting.clearableKeys,
      ...exhaustedRejectedKeys,
    ]);

    if (sessionID) {
      await updateSessionState(directory, sessionID, state => {
        state.pendingMemories = state.pendingMemories.filter(memory => {
          const key = memoryKey(memory);
          if (!sessionRemovalKeys.has(key)) return true;

          if (accounting.clearableKeys.has(key)) return false;
          if (exhaustedRejectedKeys.has(key)) return false;

          return true;
        });
        return state;
      });
      clearFrozenPromptEpoch(sessionID);
    }

    if (accounting.clearableKeys.size > 0) {
      await clearPendingMemories(directory, accounting.clearableKeys, {
        ownerSessionID: sessionID,
        clearUnowned: !sessionID || includeUnownedJournal === true,
      });
    }
  }

  function bashExitCode(hookOutput: unknown): number | undefined {
    const output = hookOutput as {
      exitCode?: unknown;
      metadata?: Record<string, unknown>;
      output?: string;
    };
    const candidates = [
      output.exitCode,
      output.metadata?.exitCode,
      output.metadata?.exit_code,
      output.metadata?.code,
      output.metadata?.status,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "number") return candidate;
      if (typeof candidate === "string" && /^-?\d+$/.test(candidate)) return Number(candidate);
    }
    const text = output.output ?? "";
    const match = text.match(/(?:exit\s*code|exitCode|status)[:=]\s*(-?\d+)/i);
    return match ? Number(match[1]) : undefined;
  }

  /**
   * Get frozen workspace memory snapshot for a session.
   * Loads and renders from disk once per session, then reuses the exact rendered string.
   */
  async function getFrozenWorkspaceMemorySnapshot(
    root: string,
    sessionID: string
  ): Promise<{
    store: Awaited<ReturnType<typeof loadWorkspaceMemory>>;
    renderedPrompt: string;
  }> {
    const now = Date.now();
    const cached = frozenWorkspaceMemoryCache.get(sessionID);

    // Cache is valid for the current session cache epoch.
    // It is intentionally invalidated after compaction so promoted memories
    // become visible in the next compacted context (new epoch starts).
    if (cached) {
      cached.lastAccessedAt = now;
      return { store: cached.store, renderedPrompt: cached.renderedPrompt };
    }

    const store = await loadWorkspaceMemory(root);
    const renderAccounting = accountWorkspaceMemoryRender(store);
    const renderedPrompt = renderAccounting.prompt;
    await appendEvidenceEvents(root, renderAccounting.evidence.map(event => ({
      ...event,
      sessionHash: sessionID,
    })));
    frozenWorkspaceMemoryCache.set(sessionID, { store, renderedPrompt, loadedAt: now, lastAccessedAt: now });
    pruneFrozenPromptEpochCaches();
    return { store, renderedPrompt };
  }

  /**
   * Get frozen hot session state snapshot for a session.
   * Loads and renders from disk once per prompt epoch, then reuses the exact rendered string.
   */
  async function getFrozenHotSessionStateSnapshot(
    root: string,
    sessionID: string,
  ): Promise<{ renderedPrompt: string }> {
    const now = Date.now();
    const cached = frozenHotSessionStateCache.get(sessionID);
    if (cached) {
      cached.lastAccessedAt = now;
      return { renderedPrompt: cached.renderedPrompt };
    }

    const sessionState = await loadSessionState(root, sessionID);
    const renderedPrompt = renderHotSessionState(sessionState, root);
    frozenHotSessionStateCache.set(sessionID, { renderedPrompt, loadedAt: now, lastAccessedAt: now });
    pruneFrozenPromptEpochCaches();
    return { renderedPrompt };
  }

  async function promoteUnownedBacklogForEpochSnapshot(sessionID: string): Promise<void> {
    if (frozenWorkspaceMemoryCache.has(sessionID) || frozenHotSessionStateCache.has(sessionID)) return;
    if (!await hasPendingJournalEntries(directory)) return;

    try {
      await promotePendingMemories(undefined, { includeUnownedJournal: true, includeOwnedJournal: false });
    } catch (error) {
      await warnMemoryHook("chat.system.transform.promote_unowned", error, directory);
    }
  }

  function sessionIDFromEventProperties(properties: unknown): string | undefined {
    const props = properties as { sessionID?: string; info?: { id?: string } } | undefined;
    return props?.sessionID ?? props?.info?.id;
  }

  async function clearCompactionMemoryRefs(sessionID: string): Promise<void> {
    await updateSessionState(directory, sessionID, state => {
      state.compactionMemoryRefs = [];
      return state;
    });
  }

  return {
    // Inject frozen workspace memory and frozen hot session state into system prompt
    "experimental.chat.system.transform": async (hookInput, output) => {
      const { sessionID } = hookInput;
      if (!sessionID) return;

      try {
        pruneFrozenPromptEpochCaches();
        pruneProcessedUserMessagesCache();

        // Sub-agents are short-lived - skip memory system
        if (await isSubAgent(sessionID)) return;

        // Process explicit user memory even on no-tool turns. Keep this after the
        // sub-agent guard so child sessions never append to the parent journal.
        await processLatestUserMessage(sessionID);

        // Before first snapshot in this session, best-effort promote durable
        // unowned backlog from prior sessions. Current-turn owned explicit memory
        // remains pending and appears in hot state only if the epoch snapshot is new.
        await promoteUnownedBacklogForEpochSnapshot(sessionID);

        let workspaceSnapshot: Awaited<ReturnType<typeof getFrozenWorkspaceMemorySnapshot>> | undefined;
        try {
          workspaceSnapshot = await getFrozenWorkspaceMemorySnapshot(directory, sessionID);
        } catch (error) {
          await warnMemoryHook("chat.system.transform.workspace_snapshot", error, directory);
        }

        let hotSnapshot: Awaited<ReturnType<typeof getFrozenHotSessionStateSnapshot>> | undefined;
        try {
          hotSnapshot = await getFrozenHotSessionStateSnapshot(directory, sessionID);
        } catch (error) {
          await warnMemoryHook("chat.system.transform.hot_snapshot", error, directory);
        }

        // Inject frozen workspace memory snapshot
        if (workspaceSnapshot?.renderedPrompt) {
          output.system.push(workspaceSnapshot.renderedPrompt);
        }

        // Inject frozen hot session state snapshot
        if (hotSnapshot?.renderedPrompt) {
          output.system.push(hotSnapshot.renderedPrompt);
        }
      } catch (error) {
        await warnMemoryHook("chat.system.transform", error, directory);
      }
    },

    // Track tool usage and update session state
    "tool.execute.after": async (hookInput, hookOutput) => {
      const { sessionID, tool: toolName, args } = hookInput;
      const { output: toolOutput } = hookOutput;
      if (!sessionID) return;

      // Sub-agents don't need memory tracking
      if (await isSubAgent(sessionID)) return;

      try {
        await updateSessionState(directory, sessionID, state => {
          // Track active files from tool usage
          if (toolName === "read" || toolName === "edit" || toolName === "write" || toolName === "grep") {
            const files = extractActiveFiles(
              toolName,
              args as Record<string, unknown>,
              toolOutput ?? ""
            );
            for (const { path, action } of files) {
              touchActiveFile(state, path, action);
              if (action === "edit" || action === "write") {
                markErrorsMaybeFixedForFile(state, path, directory);
              }
            }
          }

          // Track errors from failed bash commands
          if (toolName === "bash") {
            const argsRecord = args as Record<string, unknown>;
            const command: string = typeof argsRecord?.command === "string"
              ? argsRecord.command
              : "";
            const outputText: string = toolOutput ?? "";

            // Check if command succeeded - clear errors for that category
            const exitCode = bashExitCode(hookOutput);
            if (typeof exitCode !== "number") {
              // Unknown exit status: do not extract and do not clear
            } else if (exitCode === 0 && command) {
              clearErrorsForSuccessfulCommand(state, command);
            } else if (command) {
              // Only extract errors for commands with explicit non-zero exit
              const errors = extractErrorsFromBash(command, outputText);
              for (const error of errors) {
                upsertOpenError(state, error);
              }
            }
          }
          return state;
        });

        // Process explicit memory from latest user message
        // Only process once per message ID
        await processLatestUserMessage(sessionID);
      } catch (error) {
        await warnMemoryHook("tool.execute.after", error, directory);
      }
    },

    /**
     * Replace the default compaction prompt with a ---free template.
     *
     * OpenCode's default template wraps sections in --- separators. When the
     * model follows the template (which our structured context encourages),
     * the TUI renders --- at position 0 as YAML frontmatter, applying the
     * "comment" syntax scope (purple italic in palenight theme).
     *
     * We set output.prompt to replace the entire prompt, removing all ---
     * and explicitly forbidding YAML frontmatter / horizontal rules.
     */
    "experimental.session.compacting": async (hookInput, output) => {
      const { sessionID } = hookInput;
      if (!sessionID) return;

      try {
        // Sub-agents don't need compaction support
        if (await isSubAgent(sessionID)) return;

        // Preserve context injected by other plugins that ran before us.
        // Setting output.prompt bypasses the default prompt + context join,
        // so we must explicitly carry forward any existing output.context.
        const otherContext = output.context.filter(Boolean).join("\n\n");

        // Build our private context (numbered workspace memory refs, todos)
        const contextParts: string[] = [];

        // 1. Compaction-only numbered workspace memory snapshot
        const compactionId = randomUUID();
        const workspaceStore = await loadWorkspaceMemory(directory);
        const compactionRefs = accountWorkspaceMemoryCompactionRefs(workspaceStore);
        const refsWithCompactionId = compactionRefs.refs.map(ref => ({ ...ref, compactionId }));
        await updateSessionState(directory, sessionID, state => {
          state.compactionMemoryRefs = refsWithCompactionId;
          return state;
        });
        await appendEvidenceEvents(directory, compactionRefs.evidence.map(event => ({
          ...event,
          sessionHash: sessionID,
        })));
        if (compactionRefs.prompt) {
          contextParts.push(compactionRefs.prompt);
        }

        // 2. Pending todos from OpenCode
        const todos = await pendingTodos(client, sessionID);
        const todosPrompt = renderTodosForCompaction(todos);
        if (todosPrompt) {
          contextParts.push(todosPrompt);
        }

        // Combine: other plugins' context first, then our private context
        const privateContext = [otherContext, ...contextParts]
          .filter(Boolean)
          .join("\n\n");

        // Replace the default prompt entirely with our ---free template
        output.prompt = buildCompactionPrompt(privateContext, compactionId);

        // Clear context array since we consumed it into output.prompt.
        // Subsequent plugins that set output.prompt will also need to check
        // output.context if they want to preserve other plugin contributions.
        output.context.length = 0;
      } catch (error) {
        await warnMemoryHook("session.compacting", error, directory);
      }
    },

    // Handle session events
    event: async ({ event }) => {
      if (event.type === "session.compacted") {
        let sessionID: string | undefined;
        try {
          sessionID = sessionIDFromEventProperties(event.properties);
          if (!sessionID) return;

          // Sub-agents don't need post-compaction processing
          if (await isSubAgent(sessionID)) return;

          try {
            // Parse latest compaction summary for memory candidates, stage them into
            // durable pending journal, then promote pending memories.
            const summary = await latestCompactionSummary(client, sessionID);
            const compactionId = summary ? compactionIdFromSummary(summary) : undefined;
            const parseResult = summary
              ? parseWorkspaceMemoryCandidatesWithEvidence(summary, await workspaceIdentity(directory))
              : { entries: [], commands: [], evidence: [] };
            await appendEvidenceEvents(directory, parseResult.evidence.map(event => ({
              ...event,
              sessionHash: sessionID,
            })));
            await applyCompactionMemoryCommands(sessionID, parseResult.commands, compactionId);
            const candidates = parseResult.entries;
            if (candidates.length > 0) {
              await appendPendingMemories(directory, candidates);
              await appendEvidenceEvents(directory, candidates.map(memory => ({
                ...pendingAppendedEvidence(memory),
                sessionHash: sessionID,
              })));
            }

            await promotePendingMemories(sessionID, { includeUnownedJournal: true });
          } finally {
            await clearCompactionMemoryRefs(sessionID);
            clearFrozenPromptEpoch(sessionID);
          }
        } catch (error) {
          // Keep pending memories in session/journal for retry on next event/session.
          await warnMemoryHook("event.session.compacted", error, directory);
        }
      }

      if (event.type === "session.deleted") {
        try {
          const sessionID = sessionIDFromEventProperties(event.properties);
          if (sessionID) {
          // Promote pending memories before deleting per-session state.
          // If promotion fails, leave session state and journal intact.
            let promoted = false;
            await promotePendingMemories(sessionID, { includeOwnedJournal: true, includeUnownedJournal: false });
            promoted = true;
            if (promoted) {
              clearFrozenPromptEpoch(sessionID);
              processedUserMessages.delete(sessionID);
              sessionParentCache.delete(sessionID);
            }

            await rm(await sessionStatePath(directory, sessionID), { force: true });
          }
        } catch (error) {
          await warnMemoryHook("event.session.deleted", error, directory);
        }
      }
    },
  };
}
