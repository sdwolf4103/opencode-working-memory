import test from "node:test";
import assert from "node:assert/strict";
import type { TuiCommand } from "@opencode-ai/plugin/tui";

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

type MockDialogContext = { clear: () => void; replace: (...args: unknown[]) => void; stack: unknown[] };
type RuntimeCommand = { value: string; slash?: { name: string; aliases?: string[] }; onSelect?: (dialog: MockDialogContext) => void | Promise<void> };

interface MockPromptCall {
  sessionID: string;
  noReply?: boolean;
  parts?: Array<{ type: string; text?: string; synthetic?: boolean }>;
}

interface MockTuiApi {
  commands: RuntimeCommand[];
  prompts: MockPromptCall[];
  toasts: Array<{ variant?: string; message: string }>;
  dialog: MockDialogContext;
  route: { name: string; params?: Record<string, unknown> };
  state: { path: { directory: string } };
  command: { register: (cb: () => TuiCommand[]) => () => void };
  ui: { toast: (input: { variant?: string; message: string }) => void; dialog: MockDialogContext };
  client: { session: { prompt: (input: MockPromptCall) => Promise<void> } };
}

function makeMockTuiApi(options: {
  route: { name: string; params?: Record<string, unknown> };
  directory?: string;
}): MockTuiApi {
  const commands: RuntimeCommand[] = [];
  const prompts: MockPromptCall[] = [];
  const toasts: Array<{ variant?: string; message: string }> = [];
  const dialog: MockDialogContext = {
    clear: () => { dialog.stack.push("clear"); },
    replace: (...args: unknown[]) => { dialog.stack.push(args); },
    stack: [],
  };

  return {
    commands,
    prompts,
    toasts,
    dialog,
    route: options.route,
    state: { path: { directory: options.directory ?? "/mock/workspace" } },
    command: {
      register: (cb: () => TuiCommand[]) => {
        const items = cb();
        for (const item of items) {
          const runtimeItem: RuntimeCommand = {
            value: item.value,
            slash: item.slash,
            onSelect: item.onSelect
              ? (dialogContext: MockDialogContext = dialog) => (item.onSelect as (dialog: MockDialogContext) => void | Promise<void>)(dialogContext)
              : undefined,
          };
          commands.push(runtimeItem);
        }
        return () => {};
      },
    },
    ui: {
      toast: (input: { variant?: string; message: string }) => { toasts.push(input); },
      dialog,
    },
    client: {
      session: {
        prompt: async (input: MockPromptCall) => { prompts.push(input); },
      },
    },
  };
}

async function selectCommand(api: MockTuiApi, value: string): Promise<void> {
  const command = api.commands.find((item): item is RuntimeCommand => item.value === value);
  assert.ok(command, `registered command ${value}`);
  await command.onSelect?.(api.dialog);
}

// ---------------------------------------------------------------------------
// We must import MemoryTuiPlugin after setting up mocks.
// Mock the @opencode-ai/plugin import to avoid real SDK dependency in tests.
// Since the TUI plugin imports from @opencode-ai/plugin/tui, we need to
// provide a minimal mock.
// ---------------------------------------------------------------------------

// Dynamic import to allow module-level mocking
const { MemoryTuiPlugin } = await import("../src/tui-plugin.ts");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("registers three unique hyphenated memory slash commands", async () => {
  const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } } });
  await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

  const slashNames = api.commands.map(command => command.slash?.name).filter(Boolean);
  assert.deepEqual(slashNames, ["memory-status", "memory-list", "memory-help"]);
  assert.deepEqual(api.commands.map(command => command.slash), [{ name: "memory-status" }, { name: "memory-list" }, { name: "memory-help" }]);
  assert.equal(new Set(slashNames).size, slashNames.length);
  assert.deepEqual(api.commands.map(command => command.value), ["memory.status", "memory.list", "memory.help"]);
  assert.equal(api.commands.some(command => command.value === "memory.activity"), false);
  assert.equal(api.commands.some(command => command.value === "memory.last"), false);
});

test("injects no-reply text into the active session", async () => {
  const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } } });
  await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });
  await selectCommand(api, "memory.status");
  assert.equal(api.prompts.length, 1);
  assert.equal(api.prompts[0].sessionID, "ses_1");
  assert.equal(api.prompts[0].noReply, true);
  assert.equal(api.prompts[0].parts![0].type, "text");
  assert.match(api.prompts[0].parts![0].text ?? "", /^## Memory status/);
  // synthetic must be undefined (not true) so TUI renders the text
  assert.equal(api.prompts[0].parts![0].synthetic, undefined);
});

test("routes memory commands to status, list, and help output", async () => {
  const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } } });
  await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

  await selectCommand(api, "memory.status");
  assert.match(api.prompts.at(-1)?.parts?.[0]?.text ?? "", /^## Memory status/);

  await selectCommand(api, "memory.list");
  assert.match(api.prompts.at(-1)?.parts?.[0]?.text ?? "", /^## Current workspace memories/);

  await selectCommand(api, "memory.help");
  assert.match(api.prompts.at(-1)?.parts?.[0]?.text ?? "", /^## Memory help/);
});

test("shows warning toast when no active session", async () => {
  const api = makeMockTuiApi({ route: { name: "home" } });
  await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });
  await selectCommand(api, "memory.status");
  assert.equal(api.prompts.length, 0, "should not call prompt without session");
  assert.ok(api.toasts.some(t => t.variant === "warning"), "should show warning toast");
});

test("clears dialog after successful command", async () => {
  const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } } });
  await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });
  await selectCommand(api, "memory.status");
  assert.ok(api.dialog.stack.includes("clear"), "dialog should be cleared after command");
});

test("shows error toast when prompt injection fails", async () => {
  const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } } });
  // Override prompt to reject
  api.client.session.prompt = async () => { throw new Error("SDK failure"); };
  await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });
  await selectCommand(api, "memory.status");
  assert.ok(api.toasts.some(t => t.variant === "error"), "should show error toast on SDK failure");
});
