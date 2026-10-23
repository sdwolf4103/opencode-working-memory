import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Context as PromiseContext } from "@opencode/plugin/promise/plugin";
import type { SessionMessageInfo, V2Event } from "@opencode/client";
import { loadMemoryReviewProposalSet, MEMORY_REVIEW_PROPOSAL_SET_KIND, saveMemoryReviewSnapshot, createMemoryReviewSnapshot } from "../src/memory-review.ts";
import { loadSessionState, updateSessionState, upsertOpenError } from "../src/session-state.ts";
import { saveSessionState, createEmptySessionState } from "../src/session-state.ts";
import { loadWorkspaceMemory } from "../src/workspace-memory.ts";
import { mapLegacyMessages, MemoryServerPluginV2 } from "../src/plugin-v2.ts";

const userMessage = (id: string, text: string): SessionMessageInfo => ({ type: "user", id, text, time: { created: Date.now() } });
const compactedMessage = (id: string, summary: string): SessionMessageInfo => ({ type: "compaction", id, status: "completed", reason: "manual", summary, time: { created: Date.now() } });
function proposalText(): string {
  return ["```memory-review-proposals", JSON.stringify({ version: 1, kind: MEMORY_REVIEW_PROPOSAL_SET_KIND, id: "proposal_set_v2", snapshotId: "snapshot_v2", createdAt: "2026-10-23T00:00:00.000Z", source: "assistant_memory_review", status: "sealed", sealed: true, proposals: [] }), "```"].join("\n");
}
function snapshot() {
  return createMemoryReviewSnapshot({ version: 1, workspace: { root: "/tmp", key: "unused" }, limits: { maxRenderedChars: 3600, maxEntries: 28 }, entries: [], migrations: [], updatedAt: new Date().toISOString() }, { id: "snapshot_v2" });
}
test("maps V2 user and completed compaction messages to legacy message records", () => {
  assert.deepEqual(mapLegacyMessages([userMessage("u1", "remember this"), compactedMessage("c1", "summary")]), [
    { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "remember this" }] },
    { info: { id: "c1", role: "assistant", summary: true }, parts: [{ type: "text", text: "summary" }] },
  ]);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "plugin-v2-"));
  const otherRoot = await mkdtemp(join(tmpdir(), "plugin-v2-other-"));
  const hooks = new Map<string, (input: never, output?: never) => Promise<void>>();
  const queuedEvents: V2Event[] = [];
  const disposed = new Set<object>();
  const registrations: Array<{ dispose(): Promise<void> }> = [];
  let wakeEvent: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  let contextCalls = 0;
  let eventCalls = 0;
  let validationGate: (() => void) | undefined;
  let validationStarted: (() => void) | undefined;
  let cleanupSignal: (() => void) | undefined;
  let cleanupStarted: (() => void) | undefined;
  let activeContext = 0;
  let maxActiveContext = 0;
  let messageContext: SessionMessageInfo[] = [userMessage("u1", "hello")];
  const context = {
    location: { directory: root, workspaceID: "workspace-1" }, app: { name: "opencode", version: "2.1.4", channel: "stable" },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (sessionID === "unknown" || sessionID === "unvalidated-session") throw new Error("missing");
        if (sessionID === "pending-validation") { validationStarted?.(); await new Promise<void>(resolve => { validationGate = resolve; }); }
        return { id: sessionID, parentID: sessionID === "child" ? "parent" : undefined, location: { directory: sessionID === "other-workspace" ? otherRoot : root } };
      },
      context: async () => {
        contextCalls++; activeContext++; maxActiveContext = Math.max(maxActiveContext, activeContext);
        await new Promise(resolve => setTimeout(resolve, 5)); activeContext--;
        return messageContext;
      },
      hook: async (name: string, callback: (input: never, output?: never) => Promise<void>) => {
        hooks.set(`session.${name}`, callback);
        const registration = { dispose: async () => { disposed.add(registration); hooks.delete(`session.${name}`); } };
        registrations.push(registration); return registration;
      },
    },
    tool: { hook: async (name: string, callback: (input: never) => Promise<void>) => {
      hooks.set(`tool.${name}`, callback as never);
      const registration = { dispose: async () => { disposed.add(registration); hooks.delete(`tool.${name}`); } };
      registrations.push(registration); return registration;
    } },
    event: { subscribe: ({ signal: subscribeSignal }: { signal: AbortSignal }) => {
      signal = subscribeSignal;
      return { [Symbol.asyncIterator]() { return {
        next: async (): Promise<IteratorResult<V2Event>> => {
          if (queuedEvents.length) { eventCalls++; return { done: false, value: queuedEvents.shift()! }; }
          if (signal?.aborted) return { done: true, value: undefined };
          await new Promise<void>(resolve => { wakeEvent = resolve; signal?.addEventListener("abort", resolve, { once: true }); });
          wakeEvent = undefined;
          if (signal?.aborted) return { done: true, value: undefined };
          return queuedEvents.length ? (eventCalls++, { done: false, value: queuedEvents.shift()! }) : { done: true, value: undefined };
        },
        return: async () => { wakeEvent?.(); return { done: true, value: undefined }; },
      }; } };
    } },
  };
  const dispose = await MemoryServerPluginV2.setup(context as unknown as PromiseContext);
  const emit = (value: V2Event): void => { queuedEvents.push(value); wakeEvent?.(); };
  const waitEvents = async (count: number): Promise<void> => { const deadline = Date.now() + 3000; while (Date.now() < deadline && eventCalls < count) await new Promise(resolve => setTimeout(resolve, 5)); };
  return {
    root, otherRoot, hooks, registrations, disposed, emit, contextCalls: () => contextCalls, eventCalls: () => eventCalls, maxActiveContext: () => maxActiveContext,
    setMessages: (messages: SessionMessageInfo[]) => { messageContext = messages; },
    setReviewSnapshot: async () => saveMemoryReviewSnapshot(root, snapshot()), waitEvents,
    blockValidation: (started: () => void) => { validationStarted = started; },
    releaseValidation: () => validationGate?.(),
    onCleanup: (started: () => void) => { cleanupStarted = started; },
    dispose: async () => { await dispose?.(); await Promise.all([rm(root, { recursive: true, force: true }), rm(otherRoot, { recursive: true, force: true })]); },
  };
}
const event = (f: Awaited<ReturnType<typeof fixture>>, id: string, type: string, text: string, workspaceID = "workspace-1", directory = f.root): V2Event => ({
  id, created: Date.now(), type, durable: { aggregateID: "root-session", seq: 1, version: 1 }, location: { directory, workspaceID },
  data: type === "session.deleted" ? { sessionID: "root-session" } : type === "session.text.ended" ? { sessionID: "root-session", assistantMessageID: id, text } : { sessionID: "root-session", reason: "manual", assistantMessageID: id, text },
} as unknown as V2Event);
const deletedEvent = (id: string, sessionID: string): V2Event => ({ id, created: Date.now(), type: "session.deleted", durable: { aggregateID: sessionID, seq: 1, version: 1 }, data: { sessionID } } as unknown as V2Event);
const pause = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

test("preserves host SystemPart identity and metadata while appending memory", async () => {
  const f = await fixture();
  try { const host = { type: "text", text: "host", metadata: { provider: "host", nested: { keep: true } } }; const system = [host];
    await f.hooks.get("session.context")!({ sessionID: "root-session", system } as never);
    assert.strictEqual(system[0], host); assert.deepEqual(host.metadata, { provider: "host", nested: { keep: true } });
  } finally { await f.dispose(); }
});

test("fails closed for child, unknown and cross-workspace sessions and event", async () => {
  const f = await fixture();
  try { const callback = f.hooks.get("session.context")!;
    for (const sessionID of ["child", "unknown", "other-workspace"]) { const host = { type: "text", text: "host" }; const input = { sessionID, system: [host] }; await callback(input as never); assert.deepEqual(input.system, [host]); }
    f.emit(event(f, "wrong-workspace", "session.compaction.ended", "must not promote", "wrong-workspace")); await pause();
    assert.equal((await loadWorkspaceMemory(f.root))?.entries.length, 0);
  } finally { await f.dispose(); }
});

test("serializes same-session callbacks and deduplicates same-message explicit requests", async () => {
  const f = await fixture();
  try {
    f.setMessages([userMessage("same-explicit-message", "Remember: User prefers concise Traditional Chinese explanations for architecture reviews.")]);
    await Promise.all([0, 1].map(() => f.hooks.get("session.context")!({ sessionID: "race-session", system: [] } as never)));
    assert.equal(f.maxActiveContext(), 1);
    const state = await loadSessionState(f.root, "race-session");
    assert.equal(state.pendingMemories.length, 1);
    assert.equal(state.pendingMemories[0].text, "User prefers concise Traditional Chinese explanations for architecture reviews.");
  } finally { await f.dispose(); }
});

test("promotes exact ended compaction text despite contradictory context and ignores replay", async () => {
  const f = await fixture();
  try { f.setMessages([userMessage("u1", "hello"), compactedMessage("old-summary", "contradictory old summary")]);
    const ended = event(f, "event-1", "session.compaction.ended", "## Summary\\nMemory candidates:\\n(none)"); f.emit(ended); await f.waitEvents(1); f.emit(ended); await pause(); assert.equal(f.eventCalls(), 2);
  } finally { await f.dispose(); }
});

test("handles event replay and two consecutive compactions", async () => {
  const f = await fixture();
  try { f.setMessages([compactedMessage("context", "irrelevant context")]);
    f.emit(event(f, "compact-1", "session.compaction.ended", "Summary one")); await f.waitEvents(1);
    f.emit(event(f, "compact-1", "session.compaction.ended", "Summary one")); await pause();
    f.emit(event(f, "compact-2", "session.compaction.ended", "Summary two")); await f.waitEvents(3); assert.equal(f.eventCalls(), 3);
  } finally { await f.dispose(); }
});

test("captures session.text.ended review proposal from the valid snapshot", async () => {
  const f = await fixture();
  try { await f.setReviewSnapshot(); f.emit(event(f, "review-message", "session.text.ended", proposalText())); await pause(80);
    assert.equal((await loadMemoryReviewProposalSet(f.root, "proposal_set_v2"))?.snapshotId, "snapshot_v2");
  } finally { await f.dispose(); }
});

test("registration cleanup aborts pending event subscription and disposes every registration", async () => {
  const f = await fixture(); await f.dispose(); assert.equal(f.hooks.size, 0); assert.equal(f.disposed.size, f.registrations.length); assert.ok(f.registrations.length > 0);
});

test("cleanup drains pending session validation and prevents callback writes after cleanup", async () => {
  const f = await fixture();
  const before = await loadWorkspaceMemory(f.root);
  const validationBegun = new Promise<void>(resolve => f.blockValidation(resolve));
  const callback = f.hooks.get("session.context")!;
  const pending = callback({ sessionID: "pending-validation", system: [] } as never);
  await validationBegun;
  let cleanupDone = false;
  const cleaning = f.dispose().then(() => { cleanupDone = true; });
  await pause();
  assert.equal(cleanupDone, false);
  f.releaseValidation();
  await Promise.all([pending, cleaning]);
  const after = await loadWorkspaceMemory(f.root);
  assert.equal(after?.entries.length, before?.entries.length);
  assert.equal(after?.workspace.root, before?.workspace.root);
});

test("session.deleted without location cleans only previously validated roots", async () => {
  const f = await fixture();
  try {
    await f.hooks.get("session.context")!({ sessionID: "root-session", system: [] } as never);
    f.emit(deletedEvent("delete-validated", "root-session"));
    await f.waitEvents(1);
    await pause();
    assert.ok(await loadSessionState(f.root, "root-session"));
    f.emit(deletedEvent("delete-unknown", "unvalidated-session"));
    await f.waitEvents(2);
    await pause();
    const pendingMemory = await loadSessionState(f.root, "root-session");
    assert.ok(pendingMemory.pendingMemories.length <= 1);
    assert.equal((await loadWorkspaceMemory(f.root))?.entries.length, 0);
  } finally { await f.dispose(); }
});

test("tool read path maps filePath and path into active files", async () => {
  const f = await fixture();
  try {
    const toolHook = f.hooks.get("tool.execute.after")!;
    await toolHook({ sessionID: "root-session", tool: "read", input: { path: join(f.root, "src", "example.ts") }, status: "completed", result: { content: "" } } as never);
    assert.deepEqual((await loadSessionState(f.root, "root-session")).activeFiles.map(file => file.path), [join(f.root, "src", "example.ts")]);
  } finally { await f.dispose(); }
});

test("shell with unknown exit status does not clear tracked error", async () => {
  const f = await fixture();
  try { const toolHook = f.hooks.get("tool.execute.after")!;
    await updateSessionState(f.root, "root-session", state => { upsertOpenError(state, { fingerprint: "stable-error", category: "typecheck", summary: "Type error", file: "src/a.ts", command: "npm test" }); return state; });
    const before = await loadSessionState(f.root, "root-session"); assert.equal(before.openErrors.length, 1);
    await toolHook({ sessionID: "root-session", tool: "bash", input: { command: "npm test" }, status: "completed", result: { content: "src/a.ts(1,1): error TS2345: failure" } } as never);
    const after = await loadSessionState(f.root, "root-session"); assert.equal(after.openErrors.length, 1); assert.equal(after.openErrors[0].status, "open");
  } finally { await f.dispose(); }
});
