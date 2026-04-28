/**
 * Memory V2 Plugin for OpenCode
 *
 * Architecture:
 * - Layer 1: Stable Workspace Memory (frozen per session cache epoch, refreshed at compaction)
 * - Layer 2: Hot Session State (active files, open errors, recent decisions, pending memories)
 * - Layer 3: Native OpenCode State (todos owned by OpenCode, read during compaction)
 *
 * Cache Epoch Model:
 * - Each session creates a frozen workspace memory snapshot on first transform.
 * - Normal turns reuse the exact rendered string (system[1] remains stable).
 * - Compaction starts a new cache epoch: pending memories are promoted, the cache is cleared,
 *   and the next transform re-renders workspace memory.
 * - Explicit memory ("remember X") goes to SessionState.pendingMemories + durable journal,
 *   visible in ephemeral system[2+] for the current epoch, promoted to system[1] after compaction.
 *
 * This plugin:
 * - Caches frozen workspace memory per sessionID
 * - Processes explicit memory from latest user text once per message id
 * - Injects frozen workspace memory and dynamic hot session state into system prompt
 * - Updates session state after tool execution
 * - Augments compaction context with memory, hot state, todos, and instruction
 * - Parses compaction summaries for memory candidates and merges them
 */

import { rm } from "fs/promises";
import type { Plugin } from "@opencode-ai/plugin";
import {
  extractExplicitMemories,
  extractActiveFiles,
  extractErrorsFromBash,
  parseWorkspaceMemoryCandidates,
} from "./extractors.ts";
import {
  loadWorkspaceMemory,
  updateWorkspaceMemory,
  updateWorkspaceMemoryWithAccounting,
  renderWorkspaceMemory,
} from "./workspace-memory.ts";
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
import { sessionStatePath } from "./paths.ts";
import {
  latestUserText,
  latestCompactionSummary,
  pendingTodos,
} from "./opencode.ts";
import { accountPendingPromotions } from "./promotion-accounting.ts";
import { WORKSPACE_MEMORY_CACHE_LIMITS } from "./types.ts";

/**
 * Build the complete compaction prompt.
 *
 * Replaces OpenCode's default template (which uses --- separators that trigger
 * YAML frontmatter comment scope in markdown rendering, producing purple italic text).
 * Our template uses only ## Markdown headings and explicitly forbids YAML frontmatter,
 * horizontal rules, and delimiter lines.
 *
 * @param privateContext - Background context (workspace memory, hot session state,
 *   pending todos) from our plugin and any other plugins. Shown to the model to
 *   inform the summary but not copied verbatim.
 */
function buildCompactionPrompt(privateContext: string): string {
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
    "At the end of the summary, extract durable memory entries for future sessions.",
    "",
    "Memory quality bar:",
    "Extract only durable facts that will change future behavior: user preferences, decisions with rationale, stable constraints, or hard-to-rediscover references.",
    "",
    "Do not extract trivia: transient IDs/revisions, task progress, test/file counts, bare status updates, local UI details, or facts easily rediscovered from the repo.",
    "",
    "When unsure, skip it. Fewer high-signal memories are better than many low-value ones.",
    "",
    "Good memory examples:",
    "- [feedback] User prefers architecture reviews in Traditional Chinese.",
    "- [decision] Use frozen workspace memory snapshots plus ephemeral hot state for cache stability.",
    "- [project] The plugin should piggyback memory extraction on OpenCode compaction and avoid extra LLM calls.",
    "- [reference] Workspace memory appears in frozen system[1]; pending memories appear in hot session state until compaction.",
    "",
    "Bad memory examples to skip:",
    "- 42 tests passed.",
    "- Wave 2 completed successfully.",
    "- Modified 5 files.",
    "- commit 4309cb8 contains the latest fix.",
    "- TypeError: Cannot read properties of undefined.",
    "- Currently running npm test.",
    "",
    "A memory should still be useful if a new agent opens this workspace next week.",
    "",
    "Only extract facts that are likely to stay true across sessions.",
    "Do not extract session-specific progress like exact test counts, file counts, or phase numbers.",
    "For progress, extract the stable goal or durable milestone, not the current number.",
    "For references, extract configuration values that do not usually change between sessions.",
    "For feedback, extract unresolved issues or user preferences that future sessions need to know.",
    "Use exactly this candidate format, including square brackets around the type:",
    "",
    "Memory candidates:",
    "- [feedback] content",
    "- [project] content",
    "- [decision] content",
    "- [reference] content",
    "",
    "Do not write '- project content'; write '- [project] content'.",
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
    }
  >();

  // Cache for processed user message IDs (to avoid duplicate processing)
  const processedUserMessages = new Map<string, Set<string>>();

  function pruneFrozenWorkspaceMemoryCache(now = Date.now()): void {
    for (const [sessionID, cached] of frozenWorkspaceMemoryCache) {
      if (now - cached.loadedAt > WORKSPACE_MEMORY_CACHE_LIMITS.frozenTtlMs) {
        frozenWorkspaceMemoryCache.delete(sessionID);
      }
    }

    while (frozenWorkspaceMemoryCache.size > WORKSPACE_MEMORY_CACHE_LIMITS.maxFrozenSessions) {
      const oldest = [...frozenWorkspaceMemoryCache.entries()]
        .sort((a, b) => a[1].loadedAt - b[1].loadedAt)[0]?.[0];
      if (!oldest) break;
      frozenWorkspaceMemoryCache.delete(oldest);
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

    const memories = extractExplicitMemories(latestMessage.text).map(memory => ({
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

    const pending = [
      ...(sessionState?.pendingMemories ?? []),
      ...journalPending,
    ];
    if (pending.length === 0) return;

    let beforeEntries: Awaited<ReturnType<typeof loadWorkspaceMemory>>["entries"] = [];

    const updateResult = await updateWorkspaceMemoryWithAccounting(directory, workspaceMemory => {
      beforeEntries = [...workspaceMemory.entries];
      const existingKeys = new Set(
        workspaceMemory.entries
          .filter(memory => memory.status !== "superseded")
          .map(memory => memoryKey(memory)),
      );

      for (const memory of pending) {
        const key = memoryKey(memory);
        if (!existingKeys.has(key)) {
          workspaceMemory.entries.push(memory);
          existingKeys.add(key);
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
      { ownerSessionID: sessionID },
    );

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
      clearFrozenWorkspaceMemoryCache(sessionID);
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
    pruneFrozenWorkspaceMemoryCache(now);
    const cached = frozenWorkspaceMemoryCache.get(sessionID);

    // Cache is valid for the current session cache epoch.
    // It is intentionally invalidated after compaction so promoted memories
    // become visible in the next compacted context (new epoch starts).
    if (cached) {
      return { store: cached.store, renderedPrompt: cached.renderedPrompt };
    }

    const store = await loadWorkspaceMemory(root);
    const renderedPrompt = renderWorkspaceMemory(store);
    frozenWorkspaceMemoryCache.set(sessionID, { store, renderedPrompt, loadedAt: now });
    pruneFrozenWorkspaceMemoryCache(now);
    return { store, renderedPrompt };
  }

  /**
   * Clear frozen workspace memory cache (e.g., after compaction).
   */
  function clearFrozenWorkspaceMemoryCache(sessionID: string): void {
    frozenWorkspaceMemoryCache.delete(sessionID);
  }

  function sessionIDFromEventProperties(properties: unknown): string | undefined {
    const props = properties as { sessionID?: string; info?: { id?: string } } | undefined;
    return props?.sessionID ?? props?.info?.id;
  }

  return {
    // Inject workspace memory and hot session state into system prompt
    "experimental.chat.system.transform": async (hookInput, output) => {
      const { sessionID } = hookInput;
      if (!sessionID) return;

      pruneFrozenWorkspaceMemoryCache();
      pruneProcessedUserMessagesCache();

      // Sub-agents are short-lived - skip memory system
      if (await isSubAgent(sessionID)) return;

      // Process explicit user memory even on no-tool turns. Keep this after the
      // sub-agent guard so child sessions never append to the parent journal.
      await processLatestUserMessage(sessionID);

      // Before first snapshot in this session, promote durable unowned backlog from
      // prior sessions. Current-turn owned explicit memory remains pending and only
      // appears in hot state for this transform.
      if (!frozenWorkspaceMemoryCache.has(sessionID) && await hasPendingJournalEntries(directory)) {
        await promotePendingMemories(undefined, { includeUnownedJournal: true, includeOwnedJournal: false });
      }

      // Get frozen workspace memory snapshot (loaded and rendered once per session)
      const workspaceSnapshot = await getFrozenWorkspaceMemorySnapshot(directory, sessionID);

      // Get current hot session state
      const sessionState = await loadSessionState(directory, sessionID);

      // Inject frozen workspace memory snapshot
      if (workspaceSnapshot.renderedPrompt) {
        output.system.push(workspaceSnapshot.renderedPrompt);
      }

      // Render and inject hot session state
      const hotPrompt = renderHotSessionState(sessionState, directory);
      if (hotPrompt) {
        output.system.push(hotPrompt);
      }
    },

    // Track tool usage and update session state
    "tool.execute.after": async (hookInput, hookOutput) => {
      const { sessionID, tool: toolName, args } = hookInput;
      const { output: toolOutput } = hookOutput;
      if (!sessionID) return;

      // Sub-agents don't need memory tracking
      if (await isSubAgent(sessionID)) return;

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

      // Sub-agents don't need compaction support
      if (await isSubAgent(sessionID)) return;

      // Preserve context injected by other plugins that ran before us.
      // Setting output.prompt bypasses the default prompt + context join,
      // so we must explicitly carry forward any existing output.context.
      const otherContext = output.context.filter(Boolean).join("\n\n");

      // Build our private context (workspace memory, hot state, todos)
      const contextParts: string[] = [];

      // 1. Frozen workspace memory snapshot
      const workspaceSnapshot = await getFrozenWorkspaceMemorySnapshot(directory, sessionID);
      if (workspaceSnapshot.renderedPrompt) {
        contextParts.push(workspaceSnapshot.renderedPrompt);
      }

      // 2. Hot session state
      const sessionState = await loadSessionState(directory, sessionID);
      const hotPrompt = renderHotSessionState(sessionState, directory);
      if (hotPrompt) {
        contextParts.push(hotPrompt);
      }

      // 3. Pending todos from OpenCode
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
      output.prompt = buildCompactionPrompt(privateContext);

      // Clear context array since we consumed it into output.prompt.
      // Subsequent plugins that set output.prompt will also need to check
      // output.context if they want to preserve other plugin contributions.
      output.context.length = 0;
    },

    // Handle session events
    event: async ({ event }) => {
      if (event.type === "session.compacted") {
        const sessionID = sessionIDFromEventProperties(event.properties);
        if (!sessionID) return;

        // Sub-agents don't need post-compaction processing
        if (await isSubAgent(sessionID)) return;

        // Parse latest compaction summary for memory candidates, stage them into
        // durable pending journal, then promote pending memories.
        const summary = await latestCompactionSummary(client, sessionID);
        const candidates = summary ? parseWorkspaceMemoryCandidates(summary) : [];
        if (candidates.length > 0) {
          await appendPendingMemories(directory, candidates);
        }

        try {
          await promotePendingMemories(sessionID, { includeUnownedJournal: true });
        } catch {
          // Keep pending memories in session/journal for retry on next event/session.
        }
      }

      if (event.type === "session.deleted") {
        const sessionID = sessionIDFromEventProperties(event.properties);
        if (sessionID) {
          // Promote pending memories before deleting per-session state.
          // If promotion fails, leave session state and journal intact.
          let promoted = false;
          try {
            await promotePendingMemories(sessionID, { includeOwnedJournal: true, includeUnownedJournal: false });
            promoted = true;
          } catch {
            return;
          } finally {
            if (promoted) {
              frozenWorkspaceMemoryCache.delete(sessionID);
              processedUserMessages.delete(sessionID);
              sessionParentCache.delete(sessionID);
            }
          }

          await rm(await sessionStatePath(directory, sessionID), { force: true });
        }
      }
    },
  };
}
