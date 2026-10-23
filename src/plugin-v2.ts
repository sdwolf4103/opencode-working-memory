import { realpath } from "node:fs/promises";

import type { Plugin as PromisePlugin, Context } from "@opencode/plugin/promise/plugin";
import type { SessionMessageInfo, V2Event } from "@opencode/client";
import type { PluginInput as LegacyInput } from "@opencode-ai/plugin";

import { captureMemoryReviewProposalText } from "./memory-review.ts";
import { MemoryV2Plugin } from "./plugin.ts";

type LegacyMessage = {
  info: { id: string; role: string; summary?: boolean };
  parts: Array<{ type: string; text: string }>;
};
type Registration = { dispose(): Promise<void> };
const EVENT_CACHE_LIMIT = 256;
const SESSION_CACHE_LIMIT = 512;

export function mapLegacyMessages(messages: SessionMessageInfo[]): LegacyMessage[] {
  return messages.flatMap((message): LegacyMessage[] => {
    if (message.type === "user") {
      return [{ info: { id: message.id, role: "user" }, parts: [{ type: "text", text: message.text }] }];
    }
    if (message.type === "compaction" && message.status === "completed") {
      return [{ info: { id: message.id, role: "assistant", summary: true }, parts: [{ type: "text", text: message.summary }] }];
    }
    return [];
  });
}

function rememberBounded<T>(cache: Set<T>, value: T, limit: number): void {
  cache.add(value);
  if (cache.size > limit) cache.delete(cache.values().next().value!);
}

// V2 appends its required summary template after hooks. Retain only the legacy
// memory instructions so the two integrations share one summary structure.
export function v2CompactionInstructions(prompt: string): string {
  const start = prompt.indexOf("CRITICAL MEMORY RULES:");
  if (start < 0) throw new Error("Memory compaction instructions are unavailable");
  const snapshot = prompt.split("\n").find(line => line.startsWith("- If you emit any REINFORCE"));
  return [
    "Follow OpenCode's required summary structure. Append the following Memory candidates section after that summary.",
    snapshot,
    prompt.slice(start),
  ].filter(Boolean).join("\n\n");
}

export const MemoryServerPluginV2: PromisePlugin = {
  id: "working-memory",
  async setup(context: Context): Promise<() => Promise<void>> {
    const root = await realpath(context.location.directory);
    const controller = new AbortController();
    const registrations: Registration[] = [];
    const verifiedRoots = new Set<string>();
    const successfulEvents = new Set<string>();
    const eventFlights = new Set<string>();
    const queues = new Map<string, Promise<void>>();
    const inflight = new Set<Promise<void>>();
    const snapshots = new Map<string, LegacyMessage[]>();
    let stopped = false;
    let eventLoop: Promise<void> | undefined;
    let iterator: AsyncIterator<V2Event> | undefined;
    let cleaning: Promise<void> | undefined;

    const warn = (error: unknown): void => {
      if (!stopped) console.error(`[memory] v2 adapter: ${error instanceof Error ? error.message : String(error)}`);
    };
    const run = (sessionID: string, work: () => Promise<void>): Promise<void> => {
      if (stopped) return Promise.resolve();
      const previous = queues.get(sessionID) ?? Promise.resolve();
      const current = previous.then(async () => { if (!stopped) await work(); }).catch(warn);
      queues.set(sessionID, current);
      inflight.add(current);
      void current.finally(() => {
        inflight.delete(current);
        if (queues.get(sessionID) === current) queues.delete(sessionID);
      });
      return current;
    };
    const validRoot = async (sessionID: string): Promise<boolean> => {
      try {
        const session = await context.session.get({ sessionID: sessionID as never });
        const valid = session.id === sessionID && !session.parentID &&
          await realpath(session.location.directory) === root;
        if (!valid || stopped) {
          verifiedRoots.delete(sessionID);
          return false;
        }
        rememberBounded(verifiedRoots, sessionID, SESSION_CACHE_LIMIT);
        return true;
      } catch (error) {
        warn(error);
        return false;
      }
    };
    const legacyClient = {
      session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: await context.session.get({ sessionID: path.id as never }) }),
        messages: async ({ path }: { path: { id: string } }) => ({
          data: snapshots.get(path.id) ?? mapLegacyMessages(await context.session.context({ sessionID: path.id as never })),
        }),
        // V2 exposes no public native todo query. OpenCode retains that state.
        todo: async () => ({ data: [] }),
      },
    };
    const legacy = await MemoryV2Plugin({ directory: root, client: legacyClient } as unknown as LegacyInput);

    const cleanup = (): Promise<void> => {
      if (cleaning) return cleaning;
      stopped = true;
      controller.abort();
      cleaning = (async () => {
        await Promise.allSettled(registrations.splice(0).map(registration => registration.dispose()));
        await iterator?.return?.();
        await eventLoop;
        await Promise.allSettled([...inflight]);
        queues.clear();
        verifiedRoots.clear();
        successfulEvents.clear();
        eventFlights.clear();
        snapshots.clear();
      })();
      return cleaning;
    };

    const handleEvent = async (event: V2Event): Promise<void> => {
      if (event.type !== "session.compaction.ended" && event.type !== "session.deleted" && event.type !== "session.text.ended") return;
      if (successfulEvents.has(event.id) || eventFlights.has(event.id)) return;
      eventFlights.add(event.id);
      try {
        await run(event.data.sessionID, async () => {
          if (event.location) {
            if (event.location.workspaceID !== context.location.workspaceID ||
                await realpath(event.location.directory).catch(() => undefined) !== root) return;
          }
          const sessionID = event.data.sessionID;
          if (event.type === "session.deleted") {
            // The session is already gone; only a previously checked root can promote.
            if (!verifiedRoots.has(sessionID) || stopped) return;
            await legacy.event?.({ event: { type: "session.deleted", properties: { sessionID } } } as never);
            verifiedRoots.delete(sessionID);
          } else {
            if (!await validRoot(sessionID) || stopped) return;
            if (event.type === "session.text.ended") {
              await captureMemoryReviewProposalText(root, event.data.text, {
                source: "hook", sessionID, messageID: event.data.assistantMessageID,
              });
            } else {
              snapshots.set(sessionID, [{ info: { id: event.id, role: "assistant", summary: true }, parts: [{ type: "text", text: event.data.text }] }]);
              try {
                await legacy.event?.({ event: { type: "session.compacted", properties: { sessionID } } } as never);
              } finally {
                snapshots.delete(sessionID);
              }
            }
          }
          rememberBounded(successfulEvents, event.id, EVENT_CACHE_LIMIT);
        });
      } finally {
        eventFlights.delete(event.id);
      }
    };

    try {
      registrations.push(await context.session.hook("context", input => run(input.sessionID, async () => {
        if (!await validRoot(input.sessionID) || stopped) return;
        const output = { system: [] as string[] };
        await legacy["experimental.chat.system.transform"]?.({ sessionID: input.sessionID } as never, output);
        input.system.push(...output.system.map(text => ({ type: "text" as const, text })));
      })));
      registrations.push(await context.session.hook("compaction", input => run(input.sessionID, async () => {
        if (!await validRoot(input.sessionID) || stopped) return;
        const output = { context: [] as string[], prompt: "" };
        await legacy["experimental.session.compacting"]?.({ sessionID: input.sessionID } as never, output);
        if (output.prompt) input.system.push({ type: "text", text: v2CompactionInstructions(output.prompt) });
      })));
      registrations.push(await context.tool.hook("execute.after", input => run(input.sessionID, async () => {
        if (!await validRoot(input.sessionID) || stopped) return;
        const result = input.status === "completed" ? input.result : undefined;
        const content = typeof result?.content === "string" ? result.content : result?.content
          ?.filter(part => part.type === "text").map(part => part.text).join("\n");
        const args = input.input && typeof input.input === "object" ? input.input as Record<string, unknown> : {};
        await legacy["tool.execute.after"]?.({
          sessionID: input.sessionID,
          tool: input.tool === "shell" ? "bash" : input.tool,
          args: { ...args, filePath: args.filePath ?? args.path },
        } as never, { output: content, metadata: result?.metadata } as never);
      })));
      iterator = context.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
      eventLoop = (async () => {
        while (!stopped) {
          const item = await iterator!.next();
          if (item.done || stopped) break;
          await handleEvent(item.value);
        }
      })().catch(warn);
    } catch (error) {
      await cleanup();
      throw error;
    }
    return cleanup;
  },
};

export default MemoryServerPluginV2;
