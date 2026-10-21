/**
 * OpenCode V2 adapter for the memory runtime.
 *
 * V2 plugins default-export a definition with an `id` and `setup(ctx)`; hooks
 * are registered on their owning domain. This adapter translates V2 session,
 * tool, compaction, and event payloads into the shared runtime.
 */

import { Plugin } from "@opencode/plugin";
import {
  createMemoryRuntime,
  type MemoryRuntimeHost,
  type MemoryTodo,
  type ToolAfterEvent,
} from "./runtime.ts";

type V2PluginContext = Plugin.Context;

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240);
}

function toolResultText(result: { content?: unknown; output?: unknown } | undefined): string {
  if (!result) return "";

  const content = result.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: "text"; text: string } =>
        Boolean(part) && typeof part === "object" && (part as { type?: string }).type === "text")
      .map(part => part.text)
      .join("\n");
  }

  const output = result.output;
  if (typeof output === "string") return output;
  if (output !== undefined) {
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }

  return "";
}

function numericMetadataValue(metadata: Record<string, unknown> | undefined): number | undefined {
  if (!metadata) return undefined;
  const candidates = [
    metadata.exit,
    metadata.exitCode,
    metadata.exit_code,
    metadata.code,
    metadata.status,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string" && /^-?\d+$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

function normalizeTodos(value: unknown): MemoryTodo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((todo): todo is Record<string, unknown> => Boolean(todo) && typeof todo === "object")
    .map(todo => ({
      content: String(todo.content ?? ""),
      status: String(todo.status ?? "pending"),
      ...(todo.priority !== undefined ? { priority: String(todo.priority) } : {}),
    }))
    .filter(todo => todo.content.length > 0);
}

function normalizeToolEvent(event: {
  tool: string;
  sessionID: string;
  input: unknown;
  status: "completed" | "error";
  result?: { content?: unknown; output?: unknown; metadata?: Record<string, unknown> };
  error?: { message?: string; metadata?: Record<string, unknown> };
}): ToolAfterEvent {
  const completed = event.status === "completed";
  const input = (event.input ?? {}) as Record<string, unknown>;
  const metadata = completed ? event.result?.metadata : event.error?.metadata;

  return {
    sessionID: event.sessionID,
    tool: event.tool,
    args: input,
    outputText: completed
      ? toolResultText(event.result)
      : (event.error?.message ?? ""),
    // A failed tool call is a non-zero outcome even when the tool omits an exit code.
    exitCode: completed ? numericMetadataValue(metadata) : 1,
    todos: completed && event.tool === "todowrite" ? normalizeTodos(input.todos) : undefined,
  };
}

function buildHost(ctx: V2PluginContext): MemoryRuntimeHost {
  return {
    directory: ctx.location.directory,

    async getSessionParentID(sessionID: string): Promise<string | null> {
      const session = await ctx.session.get({ sessionID });
      return session.parentID ?? null;
    },

    async getLatestUserMessage(sessionID: string): Promise<{ id: string; text: string } | null> {
      const messages = await ctx.session.context({ sessionID });
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.type !== "user") continue;
        if (typeof message.text !== "string" || !message.text.trim()) continue;
        return { id: message.id, text: message.text.trim() };
      }
      return null;
    },

    // V2 has no session todo read API; the runtime records todowrite snapshots.
    async getPendingTodos(): Promise<MemoryTodo[]> {
      return [];
    },

    async getLatestCompactionSummary(sessionID: string): Promise<string | null> {
      const messages = await ctx.session.context({ sessionID });
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.type !== "compaction") continue;
        if (message.status !== "completed") continue;
        if (typeof message.summary !== "string" || !message.summary.trim()) continue;
        return message.summary.trim();
      }
      return null;
    },
  };
}

export const WorkingMemoryPlugin = Plugin.define({
  id: "working-memory",

  async setup(ctx: V2PluginContext) {
    const runtime = createMemoryRuntime(buildHost(ctx), ctx.options);
    const controller = new AbortController();

    await ctx.session.hook("context", async event => {
      const parts = await runtime.buildContextParts(event.sessionID);
      for (const part of parts) {
        event.system.push({ type: "text", text: part });
      }
    });

    await ctx.tool.hook("execute.after", async event => {
      await runtime.handleToolAfter(normalizeToolEvent(event));
    });

    await ctx.session.hook("compaction", async event => {
      const prepared = await runtime.prepareCompaction(event.sessionID, "");
      if (prepared?.systemInstruction) {
        event.system.push({ type: "text", text: prepared.systemInstruction });
      }
    });

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.compaction.ended") {
            const data = event.data as { sessionID?: string; text?: string };
            if (data?.sessionID) {
              await runtime.handleSessionCompacted(data.sessionID, data.text ?? null);
            }
            continue;
          }

          if (event.type === "session.deleted") {
            const data = event.data as { sessionID?: string };
            if (data?.sessionID) {
              await runtime.handleSessionDeleted(data.sessionID);
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error(`[memory] event subscription failed: ${safeErrorMessage(error)}`);
        }
      }
    })();

    return () => controller.abort();
  },
});

export default WorkingMemoryPlugin;
