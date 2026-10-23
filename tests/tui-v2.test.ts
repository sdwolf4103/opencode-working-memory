import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin/tui";
import { loadMemoryReviewSnapshot } from "../src/memory-review.ts";
import { MemoryTuiPluginV2 } from "../src/tui-v2.ts";

// Structural native-context mock matching @opencode/plugin/tui@2.1.4.
type SelectOption = { title: string; value: string; disabled?: boolean };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function makeContext(directory?: string, promptReject = false, sessionDirectory = directory) {
  const route = { type: "session", sessionID: "child-session" };
  let activeSessionDirectory = sessionDirectory;
  const selects: Array<{ options: SelectOption[]; deferred: Deferred<string | undefined> }> = [];
  const alerts: Array<{ title: string; message: string }> = [];
  const confirms: Array<{ title: string; message: string }> = [];
  const toasts: Array<{ variant?: string; message: string }> = [];
  const sizes: Array<{ size?: string }> = [];
  const calls: Array<{ sessionID: string; text: string }> = [];
  const layers: Array<{ mode?: string; commands: Array<{ id: string; slash?: { name: string }; run: () => void | Promise<void> }> }> = [];
  let clears = 0;
  const context = {
    location: directory ? { directory } : undefined,
    data: {
      location: { default: () => directory ? { directory } : undefined },
      session: {
        get: (id: string) => id === "child-session" && activeSessionDirectory ? { location: { directory: activeSessionDirectory } } : undefined,
      },
    },
    client: {
      session: {
        prompt: async (input: { sessionID: string; text: string }) => {
          calls.push(input);
          if (promptReject) throw new Error("prompt rejected");
        },
      },
    },
    keymap: { layer: (factory: () => { mode?: string; commands: typeof layers[number]["commands"] }) => { layers.push(factory()); } },
    ui: {
      router: { current: () => route },
      toast: { show: (input: { variant?: "info" | "success" | "warning" | "error"; message: string }) => toasts.push(input) },
      dialog: {
        show: () => {},
        set: (input: { size?: string }) => sizes.push(input),
        clear: () => { clears++; },
        alert: async (input: { title: string; message: string }) => { alerts.push(input); },
        confirm: async (input: { title: string; message: string }) => { confirms.push(input); return true; },
        select: (input: { options: SelectOption[] }) => {
          const pending = deferred<string | undefined>();
          selects.push({ options: input.options, deferred: pending });
          return pending.promise;
        },
      },
    },
  };
  return { context, selects, alerts, confirms, toasts, sizes, calls, layers, setSessionDirectory: (directory?: string) => { activeSessionDirectory = directory; }, get clears() { return clears; } };
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 5));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.ok(predicate(), "condition did not become true in time");
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "memory-tui-v2-test-"));
}

test("native menu select dispatches status using current session workspace", async () => {
  const root = await tempRoot();
  try {
    const mock = makeContext(root);
    const cleanup = await MemoryTuiPluginV2.setup(mock.context as Plugin.Context);
    assert.equal(mock.layers.length, 1);
    assert.equal(mock.layers[0].mode, "global");
    assert.equal(mock.layers[0].commands[0].id, "memory.menu");
    assert.equal(mock.layers[0].commands[0].slash?.name, "memory");

    await mock.layers[0].commands[0].run();
    assert.equal(mock.selects.length, 1);
    assert.deepEqual(mock.sizes.at(-1), { size: "large" });
    mock.selects[0].deferred.resolve("memory.status");
    await waitFor(() => mock.alerts.length === 1);
    assert.equal(mock.alerts[0].title, "Memory status");
    assert.match(mock.alerts[0].message, /workspace|memory/i);
    cleanup?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Review submits via native client with current session ID and session workspace location", async () => {
  const configuredRoot = await tempRoot();
  const sessionRoot = await tempRoot();
  try {
    const mock = makeContext(configuredRoot, false, sessionRoot);
    const cleanup = await MemoryTuiPluginV2.setup(mock.context as Plugin.Context);
    await mock.layers[0].commands[0].run();
    mock.selects[0].deferred.resolve("memory.review");
    await waitFor(() => mock.calls.length === 1);
    assert.equal(mock.calls[0].sessionID, "child-session");
    const snapshotID = /Snapshot ID: ([^\n]+)/.exec(mock.calls[0].text)?.[1];
    assert.ok(snapshotID);
    assert.ok(await loadMemoryReviewSnapshot(sessionRoot, snapshotID));
    assert.equal(await loadMemoryReviewSnapshot(configuredRoot, snapshotID), null);
    assert.ok(mock.toasts.some(toast => toast.variant === "success" && /prompt sent/.test(toast.message)));
    cleanup?.();
  } finally {
    await rm(configuredRoot, { recursive: true, force: true });
    await rm(sessionRoot, { recursive: true, force: true });
  }
});

test("startup session data arriving after setup enables Review", async () => {
  const root = await tempRoot();
  try {
    const mock = makeContext(root, false, undefined);
    const cleanup = await MemoryTuiPluginV2.setup(mock.context as Plugin.Context);
    assert.equal(mock.layers.length, 1);
    mock.setSessionDirectory(root);
    await mock.layers[0].commands[0].run();
    mock.selects[0].deferred.resolve("memory.review");
    await waitFor(() => mock.calls.length === 1);
    cleanup?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Review navigation resolves and snapshots the current workspace", async () => {
  const workspaceA = await tempRoot();
  const workspaceB = await tempRoot();
  try {
    const mock = makeContext(workspaceA);
    const cleanup = await MemoryTuiPluginV2.setup(mock.context as Plugin.Context);
    await mock.layers[0].commands[0].run();
    mock.setSessionDirectory(workspaceB);
    mock.selects[0].deferred.resolve("memory.review");
    mock.selects[0].deferred.resolve("memory.review");
    await waitFor(() => mock.calls.length === 1);
    const snapshotID = /Snapshot ID: ([^\n]+)/.exec(mock.calls[0].text)?.[1];
    assert.ok(snapshotID);
    assert.ok(await loadMemoryReviewSnapshot(workspaceB, snapshotID));
    assert.equal(await loadMemoryReviewSnapshot(workspaceA, snapshotID), null);
    cleanup?.();
  } finally {
    await rm(workspaceA, { recursive: true, force: true });
    await rm(workspaceB, { recursive: true, force: true });
  }
});

test("unknown current session workspace fails closed for Review", async () => {
  const root = await tempRoot();
  try {
    const mock = makeContext(root);
    const cleanup = await MemoryTuiPluginV2.setup(mock.context as Plugin.Context);
    mock.setSessionDirectory(undefined);
    await mock.layers[0].commands[0].run();
    mock.selects[0].deferred.resolve("memory.review");
    await waitFor(() => mock.toasts.some(toast => /Workspace location is unavailable/.test(toast.message)));
    assert.equal(mock.calls.length, 0);
    cleanup?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

 test("Review rejection reports warning and shows copyable prompt fallback", async () => {
  const root = await tempRoot();
  try {
    const mock = makeContext(root, true);
    const cleanup = await MemoryTuiPluginV2.setup(mock.context as Plugin.Context);
    await mock.layers[0].commands[0].run();
    mock.selects[0].deferred.resolve("memory.review");
    await waitFor(() => mock.alerts.length === 1);

    assert.ok(mock.toasts.some(toast => toast.variant === "warning" && /auto-submit failed/.test(toast.message)));
    assert.equal(mock.alerts[0].title, "Memory Review prompt");
    assert.match(mock.alerts[0].message, /Copy this prompt/);
    cleanup?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new dialogs and cleanup invalidate stale select callbacks; missing workspace fails closed", async () => {
  const root = await tempRoot();
  try {
    const mock = makeContext(root);
    const cleanup = await MemoryTuiPluginV2.setup(mock.context as Plugin.Context);
    await mock.layers[0].commands[0].run();
    const stale = mock.selects[0];
    await mock.layers[0].commands[0].run();
    stale.deferred.resolve("memory.review");
    await tick();
    assert.equal(mock.calls.length, 0);
    assert.equal(mock.selects.length, 2);

    cleanup?.();
    assert.equal(mock.clears, 2);
    await mock.layers[0].commands[0].run();
    assert.equal(mock.selects.length, 2);
    mock.selects[1].deferred.resolve("memory.review");
    await tick();
    assert.equal(mock.calls.length, 0);

    const missing = makeContext(undefined);
    const missingCleanup = await MemoryTuiPluginV2.setup(missing.context as Plugin.Context);
    assert.equal(missing.layers.length, 1);
    await missing.layers[0].commands[0].run();
    missing.selects[0].deferred.resolve("memory.review");
    await waitFor(() => missing.toasts.some(toast => /Workspace location is unavailable/.test(toast.message)));
    assert.equal(missing.calls.length, 0);
    missingCleanup?.();

    const idle = makeContext(root);
    const idleCleanup = await MemoryTuiPluginV2.setup(idle.context as Plugin.Context);
    idleCleanup?.();
    assert.equal(idle.clears, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
