/**
 * OpenCode V1 adapter for the memory runtime.
 *
 * V1 plugins return a map of string hooks. The V2 adapter lives in
 * `plugin-v2.ts`; both share `runtime.ts`.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { createMemoryRuntime, type MemoryRuntimeHost } from "./runtime.ts";
import {
  latestUserText,
  latestCompactionSummary,
  pendingTodos,
} from "./opencode.ts";

export type MemoryPluginOptions = {
  mergeSystemMessages?: boolean;
};

function resolveMergeSystemMessagesOption(options: unknown): boolean {
  const value = (options as { mergeSystemMessages?: unknown } | undefined)?.mergeSystemMessages;
  if (value === true) return true;
  if (value === false) return false;
  return process.env.OPENCODE_WM_MERGE_SYSTEM_MESSAGES === "true";
}

function appendMemorySystemPrompts(
  output: { system: string[] },
  parts: string[],
  mergeSystemMessages: boolean,
): void {
  if (parts.length === 0) return;

  if (!mergeSystemMessages) {
    output.system.push(...parts);
    return;
  }

  const block = parts.join("\n\n---\n\n");
  if (output.system.length === 0) {
    output.system.push(block);
    return;
  }

  output.system[0] = `${output.system[0]}\n\n---\n\n${block}`;
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

function sessionIDFromEventProperties(properties: unknown): string | undefined {
  const props = properties as { sessionID?: string; info?: { id?: string } } | undefined;
  return props?.sessionID ?? props?.info?.id;
}

export const MemoryV2Plugin: Plugin = async (input, options?: MemoryPluginOptions) => {
  const { directory, client } = input;
  const mergeSystemMessages = resolveMergeSystemMessagesOption(options);

  const host: MemoryRuntimeHost = {
    directory,
    async getSessionParentID(sessionID: string): Promise<string | null> {
      const result = await client.session.get({ path: { id: sessionID } });
      return result.data?.parentID ?? null;
    },
    getLatestUserMessage: (sessionID: string) => latestUserText(client, sessionID),
    getPendingTodos: (sessionID: string) => pendingTodos(client, sessionID),
    getLatestCompactionSummary: (sessionID: string) => latestCompactionSummary(client, sessionID),
  };

  const runtime = createMemoryRuntime(host, options);

  return {
    // Inject frozen workspace memory and frozen hot session state into system prompt
    "experimental.chat.system.transform": async (hookInput, output) => {
      const { sessionID } = hookInput;
      if (!sessionID) return;

      const parts = await runtime.buildContextParts(sessionID);
      appendMemorySystemPrompts(output, parts, mergeSystemMessages);
    },

    // Track tool usage and update session state
    "tool.execute.after": async (hookInput, hookOutput) => {
      const { sessionID, tool: toolName } = hookInput;
      if (!sessionID) return;

      const rawOutput = hookOutput?.output;
      const outputText = typeof rawOutput === "string"
        ? rawOutput
        : rawOutput == null
          ? ""
          : JSON.stringify(rawOutput) ?? "";
      await runtime.handleToolAfter({
        sessionID,
        tool: toolName,
        args: (hookInput.args ?? {}) as Record<string, unknown>,
        outputText,
        exitCode: toolName === "bash" ? bashExitCode(hookOutput) : undefined,
      });
    },

    /**
     * Replace the default compaction prompt with a ---free template.
     *
     * OpenCode V1's default template wraps sections in --- separators. When the
     * model follows the template (which our structured context encourages),
     * the TUI renders --- at position 0 as YAML frontmatter, applying the
     * "comment" syntax scope (purple italic in palenight theme).
     */
    "experimental.session.compacting": async (hookInput, output) => {
      const { sessionID } = hookInput;
      if (!sessionID) return;

      // Preserve context injected by other plugins that ran before us.
      // Setting output.prompt bypasses the default prompt + context join,
      // so we must explicitly carry forward any existing output.context.
      const otherContext = output.context.filter(Boolean).join("\n\n");
      const prepared = await runtime.prepareCompaction(sessionID, otherContext);
      if (!prepared) return;

      output.prompt = prepared.prompt;

      // Clear context array since we consumed it into output.prompt.
      // Subsequent plugins that set output.prompt will also need to check
      // output.context if they want to preserve other plugin contributions.
      output.context.length = 0;
    },

    // Handle session events
    event: async ({ event }) => {
      if (event.type === "session.compacted") {
        const sessionID = sessionIDFromEventProperties(event.properties);
        if (sessionID) await runtime.handleSessionCompacted(sessionID);
      }

      if (event.type === "session.deleted") {
        const sessionID = sessionIDFromEventProperties(event.properties);
        if (sessionID) await runtime.handleSessionDeleted(sessionID);
      }
    },
  };
};
