/**
 * Memory V2 Plugin for OpenCode
 *
 * Architecture:
 * - Layer 1: Stable Workspace Memory (frozen per session, refreshed at compaction)
 * - Layer 2: Hot Session State (active files, open errors, recent decisions)
 * - Layer 3: Native OpenCode State (todos owned by OpenCode, read during compaction)
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
  renderWorkspaceMemory,
} from "./workspace-memory.ts";
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

/**
 * Strip XML-like tags from text for Markdown-neutral rendering.
 * Converts `<workspace_memory>` blocks to plain "Workspace memory:" sections.
 */
function stripXmlTags(text: string): string {
  if (!text) return "";
  
  // Replace XML tag pairs with Markdown headers
  return text
    .replace(/<workspace_memory>\n?/gi, "## Workspace Memory\n")
    .replace(/<\/workspace_memory>\n?/gi, "")
    .replace(/<hot_session_state>\n?/gi, "## Hot Session State\n")
    .replace(/<\/hot_session_state>\n?/gi, "")
    .replace(/<pending_todos>\n?/gi, "## Pending Todos\n")
    .replace(/<\/pending_todos>\n?/gi, "");
}

/**
 * Generate instructions for the compaction model.
 * IMPORTANT: These instructions make clear what should NOT be in the final output.
 */
function compactionContextHeader(): string {
  return `
[PRIVATE COMPACTION CONTEXT - DO NOT OUTPUT]
The following sections are PRIVATE INPUT for updating the compaction summary.
DO NOT copy these sections, their headings, or their contents verbatim.
Use the facts only to update the normal summary sections (Goal, Progress, etc.).

At the VERY END of your summary, you MAY include ONE output block:

<workspace_memory_candidates>
- [type] content (types: feedback, project, decision, reference)
</workspace_memory_candidates>

Only include truly durable information useful across FUTURE sessions.
If nothing qualifies, omit the block entirely.

[END PRIVATE COMPACTION CONTEXT]
`.trim();
}

/**
 * Generate the memory candidate instruction.
 * This is included in compactionContextHeader() above.
 */
function memoryCandidateInstruction(): string {
  return "";
}

/**
 * Render todos for compaction context (Markdown-neutral format).
 */
function renderTodosForCompaction(todos: Array<{ content: string; status: string; priority?: string }>): string {
  if (todos.length === 0) return "";
  const lines = ["## Pending Todos"];
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
      loadedAt: number;
    }
  >();

  // Cache for processed user message IDs (to avoid duplicate processing)
  const processedUserMessages = new Map<string, Set<string>>();

  async function processLatestUserMessage(sessionID: string): Promise<void> {
    const processedForSession = processedUserMessages.get(sessionID) ?? new Set<string>();
    const latestMessage = await latestUserText(client, sessionID);

    if (!latestMessage?.id || processedForSession.has(latestMessage.id)) return;

    const memories = extractExplicitMemories(latestMessage.text);
    const decisions = memories.filter(memory => memory.type === "decision");
    let workspaceMemory: Awaited<ReturnType<typeof loadWorkspaceMemory>> | undefined;

    if (memories.length > 0) {
      workspaceMemory = await updateWorkspaceMemory(directory, store => {
        store.entries.push(...memories);
        return store;
      });

      // Update frozen cache
      const cached = frozenWorkspaceMemoryCache.get(sessionID);
      if (cached) {
        cached.store = workspaceMemory;
      }
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

    processedForSession.add(latestMessage.id);
    processedUserMessages.set(sessionID, processedForSession);
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
   * Get frozen workspace memory for a session.
   * Loads from disk once per session, then caches in memory.
   */
  async function getFrozenWorkspaceMemory(
    root: string,
    sessionID: string
  ): Promise<Awaited<ReturnType<typeof loadWorkspaceMemory>>> {
    const now = Date.now();
    const cached = frozenWorkspaceMemoryCache.get(sessionID);

    // Cache is valid for the session lifetime
    if (cached) {
      return cached.store;
    }

    const store = await loadWorkspaceMemory(root);
    frozenWorkspaceMemoryCache.set(sessionID, { store, loadedAt: now });
    return store;
  }

  /**
   * Clear frozen workspace memory cache (e.g., after compaction).
   */
  function clearFrozenWorkspaceMemoryCache(sessionID: string): void {
    frozenWorkspaceMemoryCache.delete(sessionID);
  }

  return {
    // Inject workspace memory and hot session state into system prompt
    "experimental.chat.system.transform": async (hookInput, output) => {
      const { sessionID } = hookInput;
      if (!sessionID) return;

      // Sub-agents are short-lived - skip memory system
      if (await isSubAgent(sessionID)) return;

      // Process explicit user memory even on no-tool turns.
      await processLatestUserMessage(sessionID);

      // Get frozen workspace memory (loaded once per session)
      const workspaceMemory = await getFrozenWorkspaceMemory(directory, sessionID);

      // Get current hot session state
      const sessionState = await loadSessionState(directory, sessionID);

      // Render and inject workspace memory
      const workspacePrompt = renderWorkspaceMemory(workspaceMemory);
      if (workspacePrompt) {
        output.system.push(workspacePrompt);
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

    // Add compaction context before summarization
    "experimental.session.compacting": async (hookInput, output) => {
      const { sessionID } = hookInput;
      if (!sessionID) return;

      // Sub-agents don't need compaction support
      if (await isSubAgent(sessionID)) return;

      // Build private context with Markdown-neutral format
      const contextParts: string[] = [];

      // 1. Frozen workspace memory (strip XML tags for compaction context)
      const workspaceMemory = await getFrozenWorkspaceMemory(directory, sessionID);
      const workspacePrompt = renderWorkspaceMemory(workspaceMemory);
      if (workspacePrompt) {
        contextParts.push(stripXmlTags(workspacePrompt));
      }

      // 2. Hot session state (strip XML tags for compaction context)
      const sessionState = await loadSessionState(directory, sessionID);
      const hotPrompt = renderHotSessionState(sessionState, directory);
      if (hotPrompt) {
        contextParts.push(stripXmlTags(hotPrompt));
      }

      // 3. Pending todos from OpenCode (Markdown-neutral format)
      const todos = await pendingTodos(client, sessionID);
      const todosPrompt = renderTodosForCompaction(todos);
      if (todosPrompt) {
        contextParts.push(todosPrompt);
      }

      // Combine into single private context block
      const privateContext = contextParts.length > 0
        ? `${compactionContextHeader()}\n\n${contextParts.join("\n\n")}`
        : compactionContextHeader();

      output.context.push(privateContext);
    },

    // Handle session events
    event: async ({ event }) => {
      if (event.type === "session.compacted") {
        const sessionID = (event.properties as { sessionID?: string; info?: { id?: string } })?.sessionID
          ?? (event.properties as { info?: { id?: string } })?.info?.id;
        if (!sessionID) return;

        // Sub-agents don't need post-compaction processing
        if (await isSubAgent(sessionID)) return;

        // Parse latest compaction summary for memory candidates
        const summary = await latestCompactionSummary(client, sessionID);
        if (summary) {
          const candidates = parseWorkspaceMemoryCandidates(summary);
          if (candidates.length > 0) {
            await updateWorkspaceMemory(directory, workspaceMemory => {
              workspaceMemory.entries.push(...candidates);
              return workspaceMemory;
            });

            // Clear frozen cache so next session reloads with new memories
            clearFrozenWorkspaceMemoryCache(sessionID);
          }
        }
      }

      if (event.type === "session.deleted") {
        const sessionID = (event.properties as { info?: { id?: string } })?.info?.id;
        if (sessionID) {
          // Clean up caches
          frozenWorkspaceMemoryCache.delete(sessionID);
          processedUserMessages.delete(sessionID);
          sessionParentCache.delete(sessionID);
          await rm(await sessionStatePath(directory, sessionID), { force: true });
        }
      }
    },
  };
}
