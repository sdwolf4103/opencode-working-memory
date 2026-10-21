import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkingMemoryPlugin } from "../src/plugin-v2.ts";
import { MemoryTuiPluginV2 } from "../src/tui-plugin.ts";
import dualEntry from "../index.ts";
import { loadSessionState, saveSessionState } from "../src/session-state.ts";
import { loadWorkspaceMemory, updateWorkspaceMemory } from "../src/workspace-memory.ts";
import { sessionStatePath } from "../src/paths.ts";

type Hook = (event: any) => Promise<void> | void;

type FakeEventStream = {
  push(event: unknown): void;
  close(): void;
  [Symbol.asyncIterator](): AsyncGenerator<unknown>;
};

function createEventStream(): FakeEventStream {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let closed = false;

  return {
    push(event: unknown): void {
      queue.push(event);
      wake?.();
      wake = undefined;
    },
    close(): void {
      closed = true;
      wake?.();
      wake = undefined;
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      while (!closed || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        await new Promise<void>(resolve => {
          wake = resolve;
        });
      }
    },
  };
}

async function createContext(options: {
  directory: string;
  messages?: Array<Record<string, unknown>>;
  parentID?: string | null;
  events?: FakeEventStream;
  pluginOptions?: Record<string, unknown>;
}) {
  const sessionHooks: Record<string, Hook> = {};
  const toolHooks: Record<string, Hook> = {};

  const ctx = {
    location: { directory: options.directory },
    options: options.pluginOptions ?? {},
    session: {
      hook: async (name: string, callback: Hook) => {
        sessionHooks[name] = callback;
        return { dispose: async () => undefined };
      },
      get: async () => ({ parentID: options.parentID ?? null }),
      context: async () => options.messages ?? [],
    },
    tool: {
      hook: async (name: string, callback: Hook) => {
        toolHooks[name] = callback;
        return { dispose: async () => undefined };
      },
    },
    event: {
      subscribe: () => options.events ?? createEventStream(),
    },
  };

  await WorkingMemoryPlugin.setup(ctx as never);
  return { ctx, sessionHooks, toolHooks };
}

async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met before timeout");
}

async function withWorkspace<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "memory-plugin-v2-test-"));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("dual entrypoint exposes both V2 setup and V1 server", () => {
  assert.equal(dualEntry.id, "working-memory");
  assert.equal(typeof dualEntry.setup, "function");
  assert.equal(typeof dualEntry.server, "function");
});

test("V2 setup registers context, tool, and compaction hooks", async () => {
  await withWorkspace(async directory => {
    const { sessionHooks, toolHooks } = await createContext({ directory });
    assert.deepEqual(Object.keys(sessionHooks).sort(), ["compaction", "context"]);
    assert.deepEqual(Object.keys(toolHooks), ["execute.after"]);
  });
});

test("V2 context hook appends frozen workspace memory as system parts", async () => {
  await withWorkspace(async directory => {
    const now = new Date().toISOString();
    await updateWorkspaceMemory(directory, store => {
      store.entries.push({
        id: "v2-memory",
        type: "project",
        text: "V2 memory adapter injects workspace memory.",
        source: "manual",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return store;
    });

    const { sessionHooks } = await createContext({ directory });
    const event = { sessionID: "session-v2-context", system: [] as Array<{ type: string; text: string }> };
    await sessionHooks.context(event);

    assert.equal(event.system.length, 1);
    assert.equal(event.system[0].type, "text");
    assert.match(event.system[0].text, /V2 memory adapter injects workspace memory/);
  });
});

test("V2 tool hook tracks active files from read results", async () => {
  await withWorkspace(async directory => {
    const { toolHooks } = await createContext({ directory });

    await toolHooks["execute.after"]({
      tool: "read",
      sessionID: "session-v2-read",
      input: { path: "/workspace/src/index.ts" },
      status: "completed",
      result: { content: [{ type: "text", text: "file contents" }], metadata: {} },
    });

    const state = await loadSessionState(directory, "session-v2-read");
    assert.equal(state.activeFiles.length, 1);
    assert.equal(state.activeFiles[0].path, "/workspace/src/index.ts");
    assert.equal(state.activeFiles[0].action, "read");
  });
});

test("V2 tool hook records shell errors from metadata.exit", async () => {
  await withWorkspace(async directory => {
    const { toolHooks } = await createContext({ directory });

    await toolHooks["execute.after"]({
      tool: "shell",
      sessionID: "session-v2-shell",
      input: { command: "npm test" },
      status: "completed",
      result: {
        content: [{ type: "text", text: "Error: expected 1 test to pass" }],
        metadata: { status: "completed", exit: 1 },
      },
    });

    const state = await loadSessionState(directory, "session-v2-shell");
    assert.equal(state.openErrors.length, 1);
    assert.match(state.openErrors[0].summary, /Error/);
  });
});

test("V2 tool hook clears shell errors on exit 0", async () => {
  await withWorkspace(async directory => {
    const { toolHooks } = await createContext({ directory });

    await toolHooks["execute.after"]({
      tool: "shell",
      sessionID: "session-v2-clear",
      input: { command: "npm test" },
      status: "completed",
      result: {
        content: [{ type: "text", text: "Error: expected 1 test to pass" }],
        metadata: { status: "completed", exit: 1 },
      },
    });
    await toolHooks["execute.after"]({
      tool: "shell",
      sessionID: "session-v2-clear",
      input: { command: "npm test" },
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }], metadata: { status: "completed", exit: 0 } },
    });

    const state = await loadSessionState(directory, "session-v2-clear");
    assert.equal(state.openErrors.length, 0);
  });
});

test("V2 compaction hook appends memory instructions and numbered refs", async () => {
  await withWorkspace(async directory => {
    const now = new Date().toISOString();
    await updateWorkspaceMemory(directory, store => {
      store.entries.push({
        id: "v2-compaction-memory",
        type: "decision",
        text: "Keep V2 compaction on the host prompt.",
        source: "compaction",
        confidence: 0.9,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return store;
    });

    const { sessionHooks } = await createContext({ directory });
    const event = { sessionID: "session-v2-compaction", system: [] as Array<{ type: string; text: string }> };
    await sessionHooks.compaction(event);

    assert.equal(event.system.length, 1);
    assert.match(event.system[0].text, /Memory candidates:/);
    assert.match(event.system[0].text, /\[M1\] Keep V2 compaction on the host prompt\./);
    assert.match(event.system[0].text, /Memory ref snapshot id:/);

    const state = await loadSessionState(directory, "session-v2-compaction");
    assert.equal(state.compactionMemoryRefs.length, 1);
  });
});

test("V2 todowrite snapshots are rendered in compaction context", async () => {
  await withWorkspace(async directory => {
    const { sessionHooks, toolHooks } = await createContext({ directory });

    await toolHooks["execute.after"]({
      tool: "todowrite",
      sessionID: "session-v2-todos",
      input: {
        todos: [
          { content: "Port the compaction hook", status: "in_progress", priority: "high" },
          { content: "Write V2 tests", status: "pending", priority: "medium" },
        ],
      },
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }], metadata: {} },
    });

    const event = { sessionID: "session-v2-todos", system: [] as Array<{ type: string; text: string }> };
    await sessionHooks.compaction(event);

    assert.match(event.system[0].text, /Pending todos:/);
    assert.match(event.system[0].text, /Port the compaction hook/);
  });
});

test("V2 compaction.ended event parses summary and promotes memory candidates", async () => {
  await withWorkspace(async directory => {
    const events = createEventStream();
    await createContext({
      directory,
      events,
      messages: [{ type: "compaction", id: "msg-compaction", status: "completed", summary: "summary" }],
    });

    events.push({
      type: "session.compaction.ended",
      data: {
        sessionID: "session-v2-event",
        text: [
          "## Goal",
          "",
          "Port the plugin.",
          "",
          "Memory candidates:",
          "- [project] This fork adds an OpenCode V2 adapter.",
        ].join("\n"),
      },
    });

    await eventually(async () => {
      const memory = await loadWorkspaceMemory(directory);
      return memory.entries.some(entry => entry.text === "This fork adds an OpenCode V2 adapter.");
    });

    events.close();
  });
});

test("V2 session.deleted event removes per-session state", async () => {
  await withWorkspace(async directory => {
    const events = createEventStream();
    const { ctx } = await createContext({ directory, events });

    await saveSessionState(directory, {
      version: 1,
      sessionID: "session-v2-deleted",
      turn: 0,
      updatedAt: new Date().toISOString(),
      activeFiles: [],
      openErrors: [],
      recentDecisions: [],
      pendingMemories: [],
      compactionMemoryRefs: [],
    });

    const statePath = await sessionStatePath(ctx.location.directory, "session-v2-deleted");
    assert.equal((await stat(statePath)).isFile(), true);

    events.push({ type: "session.deleted", data: { sessionID: "session-v2-deleted" } });

    await eventually(async () => {
      try {
        await stat(statePath);
        return false;
      } catch {
        return true;
      }
    });

    events.close();
  });
});

test("V2 TUI plugin registers the /memory slash command", () => {
  let layer: any;
  const ctx = {
    keymap: {
      layer(factory: () => unknown) {
        layer = factory();
      },
    },
  };

  MemoryTuiPluginV2.setup(ctx as never);

  assert.equal(layer.mode, "global");
  assert.equal(layer.commands.length, 1);
  assert.equal(layer.commands[0].slash.name, "memory");
  assert.equal(typeof layer.commands[0].run, "function");
});

test("V2 context hook bridges CodeBuddy markdown memory in both directions", async () => {
  await withWorkspace(async directory => {
    const home = join(directory, "codebuddy-home");
    const compressed = resolve(directory)
      .replace(/[/\\:]/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .replace(/-+/g, "-");
    const memoryDir = join(home, "projects", compressed, "memory");
    await mkdir(memoryDir, { recursive: true });

    await writeFile(join(memoryDir, "codebuddy_topic.md"), [
      "---",
      "name: CodeBuddy bridge topic",
      "description: Topic visible to OpenCode",
      "type: reference",
      "---",
      "",
      "CodeBuddy bridge body.",
      "",
    ].join("\n"), "utf8");

    const now = new Date().toISOString();
    await updateWorkspaceMemory(directory, store => {
      store.entries.push({
        id: "v2_bridge_entry",
        type: "project",
        text: "OpenCode bridge export.",
        source: "manual",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return store;
    });

    const { sessionHooks } = await createContext({
      directory,
      pluginOptions: {
        codeBuddyBridge: { homeDir: home, syncIntervalMs: 0 },
      },
    });
    const event = { sessionID: "session-v2-bridge", system: [] as Array<{ type: string; text: string }> };
    await sessionHooks.context(event);

    const systemText = event.system.map(part => part.text).join("\n");
    assert.match(systemText, /Shared CodeBuddy memory/);
    assert.match(systemText, /CodeBuddy bridge topic/);

    const exported = await readFile(join(memoryDir, "opencode-v2_bridge_entry.md"), "utf8");
    assert.match(exported, /opencode_id: v2_bridge_entry/);
    assert.match(exported, /OpenCode bridge export\./);

    const index = await readFile(join(memoryDir, "MEMORY.md"), "utf8");
    assert.match(index, /<!-- opencode-working-memory:start -->/);
    assert.match(index, /OpenCode bridge export\./);
  });
});

test("V2 adapter wires the oh-my-pi local memory bridge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-plugin-v2-omp-test-"));
  try {
    const home = join(directory, "omp-home");
    const encoded = resolve(directory)
      .replace(/^[/\\]/, "")
      .replace(/[/\\:]/g, "-");
    const memoryDir = join(home, "agent", "memories", `--${encoded}--`);
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, "learned.md"), "- Use the staging gateway for deploys.\n", "utf8");

    const now = new Date().toISOString();
    await updateWorkspaceMemory(directory, store => {
      store.entries.push({
        id: "v2_omp_entry",
        type: "project",
        text: "OpenCode omp export.",
        source: "manual",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return store;
    });

    const { sessionHooks } = await createContext({
      directory,
      pluginOptions: {
        ohMyPiBridge: { homeDir: home, syncIntervalMs: 0 },
      },
    });
    const event = { sessionID: "session-v2-omp-bridge", system: [] as Array<{ type: string; text: string }> };
    await sessionHooks.context(event);

    const systemText = event.system.map(part => part.text).join("\n");
    assert.match(systemText, /Shared oh-my-pi memory/);
    assert.match(systemText, /Use the staging gateway for deploys\./);

    const learned = await readFile(join(memoryDir, "learned.md"), "utf8");
    assert.match(learned, /- \[opencode:v2_omp_entry\] OpenCode omp export\./);
    assert.match(learned, /Use the staging gateway for deploys\./);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


