import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiCommand } from "@opencode-ai/plugin/tui";
import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "../src/types.ts";
import { saveWorkspaceMemory } from "../src/workspace-memory.ts";

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

type MockDialogSize = "medium" | "large" | "xlarge";
type MockDialogAlertProps = { title: string; message: string; onConfirm?: () => void };
type MockDialogSelectOption<Value = string> = {
  title: string;
  value: Value;
  description?: string;
  footer?: string;
  category?: string;
  disabled?: boolean;
  onSelect?: () => void | Promise<void>;
};
type MockDialogSelectProps<Value = string> = {
  title: string;
  placeholder?: string;
  options: MockDialogSelectOption<Value>[];
  onSelect?: (option: MockDialogSelectOption<Value>) => void | Promise<void>;
  skipFilter?: boolean;
};
type MockDialogElement =
  | { type: "DialogAlert"; props: MockDialogAlertProps }
  | { type: "DialogSelect"; props: MockDialogSelectProps };
type MockDialogRender = () => MockDialogElement;
type MockDialogContext = {
  clear: () => void;
  replace?: (render: MockDialogRender, onClose?: () => void) => void;
  setSize?: (size: MockDialogSize) => void;
  renders: MockDialogElement[];
  sizes: MockDialogSize[];
  events: string[];
};
type RuntimeCommand = { value: string; suggested?: boolean; slash?: { name: string; aliases?: string[] }; onSelect?: (dialog: MockDialogContext) => void | Promise<void> };
type MockPromptCall = Record<string, unknown>;

interface MockTuiApi {
  commands: RuntimeCommand[];
  prompts: MockPromptCall[];
  toasts: Array<{ variant?: string; message: string }>;
  dialog: MockDialogContext;
  route: { name: string; params?: Record<string, unknown> };
  state: { path: { directory: string } };
  command: { register: (cb: () => TuiCommand[]) => () => void };
  ui: {
    toast: (input: { variant?: string; message: string }) => void;
    dialog?: Partial<MockDialogContext>;
    DialogAlert?: (props: MockDialogAlertProps) => MockDialogElement;
    DialogSelect?: (props: MockDialogSelectProps) => MockDialogElement;
  };
  client: { session: { prompt: (input: MockPromptCall) => Promise<void> } };
}

function makeMockTuiApi(options: {
  route: { name: string; params?: Record<string, unknown> };
  directory?: string;
  missingDialogAlert?: boolean;
  missingDialogSelect?: boolean;
  missingDialogReplace?: boolean;
  missingDialogSetSize?: boolean;
  dialogReplaceThrows?: boolean;
}): MockTuiApi {
  const commands: RuntimeCommand[] = [];
  const prompts: MockPromptCall[] = [];
  const toasts: Array<{ variant?: string; message: string }> = [];
  const dialog: MockDialogContext = {
    clear: () => { dialog.events.push("clear"); },
    replace: (render: MockDialogRender) => {
      dialog.events.push("replace");
      if (options.dialogReplaceThrows) throw new Error("dialog failure");
      dialog.renders.push(render());
    },
    setSize: (size: MockDialogSize) => {
      dialog.events.push(`setSize:${size}`);
      dialog.sizes.push(size);
    },
    renders: [],
    sizes: [],
    events: [],
  };
  const uiDialog: Partial<MockDialogContext> = {
    clear: dialog.clear,
    replace: options.missingDialogReplace ? undefined : dialog.replace,
    setSize: options.missingDialogSetSize ? undefined : dialog.setSize,
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
          commands.push({
            value: item.value,
            suggested: item.suggested,
            slash: item.slash,
            onSelect: item.onSelect
              ? (dialogContext: MockDialogContext = dialog) => (item.onSelect as (dialog: MockDialogContext) => void | Promise<void>)(dialogContext)
              : undefined,
          });
        }
        return () => {};
      },
    },
    ui: {
      toast: (input: { variant?: string; message: string }) => { toasts.push(input); },
      dialog: uiDialog,
      DialogAlert: options.missingDialogAlert ? undefined : (props: MockDialogAlertProps): MockDialogElement => ({ type: "DialogAlert", props }),
      DialogSelect: options.missingDialogSelect ? undefined : (props: MockDialogSelectProps): MockDialogElement => ({ type: "DialogSelect", props }),
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

function lastDialog(api: MockTuiApi): MockDialogElement {
  const hit = api.dialog.renders.at(-1);
  assert.ok(hit, "expected a rendered dialog");
  return hit;
}

async function chooseSelectOption(api: MockTuiApi, value: string): Promise<void> {
  const dialog = lastDialog(api);
  assert.equal(dialog.type, "DialogSelect");
  const option = dialog.props.options.find(item => item.value === value);
  assert.ok(option, `expected select option ${value}`);
  // Source evidence: OpenCode's plugin API maps option.onSelect to a zero-arg
  // callback and DialogSelect invokes option.onSelect before top-level onSelect.
  await option.onSelect?.();
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "memory-tui-test-"));
}

function memory(id: string, text: string, overrides: Partial<LongTermMemoryEntry> = {}): LongTermMemoryEntry {
  const now = new Date().toISOString();
  return {
    id,
    type: "decision",
    text,
    source: "compaction",
    confidence: 0.8,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function seedWorkspaceMemories(root: string): Promise<void> {
  const now = new Date().toISOString();
  const store: WorkspaceMemoryStore = {
    version: 1,
    workspace: { root, key: "test" },
    limits: { maxRenderedChars: 3600, maxEntries: 28 },
    entries: [
      memory("mem-feedback", "Remember password: sushi for the fake test.", { type: "feedback" }),
      memory("mem-project", "Project memory should render in its group.", { type: "project" }),
      memory("mem-decision", "Decision memory should render in its group.", { type: "decision" }),
      memory("mem-reference", "Reference memory should render in its group.", { type: "reference" }),
      memory("mem-superseded", "Superseded memory should not be active", { type: "reference", status: "superseded" }),
    ],
    migrations: [],
    updatedAt: now,
  };
  await saveWorkspaceMemory(root, store);
}

// Dynamic import to allow module-level mocking
const { MemoryTuiPlugin } = await import("../src/tui-plugin.ts");

test("registers one unsuggested /memory slash command", async () => {
  const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } } });
  await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

  assert.deepEqual(api.commands.map(command => command.value), ["memory.menu"]);
  assert.deepEqual(api.commands.map(command => command.slash?.name).filter(Boolean), ["memory"]);
  assert.deepEqual(api.commands.map(command => command.suggested), [undefined]);
  for (const removedName of ["memory-" + "status", "memory-" + "list", "memory-" + "help"]) {
    assert.equal(api.commands.some(command => command.slash?.name === removedName), false);
  }
});

test("opens the memory submenu without prompt injection", async () => {
  const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } } });
  await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

  await selectCommand(api, "memory.menu");

  assert.equal(api.prompts.length, 0);
  const dialog = lastDialog(api);
  assert.equal(dialog.type, "DialogSelect");
  assert.equal(dialog.props.title, "Memory");
  assert.equal(dialog.props.placeholder, "Search memory actions");
  assert.deepEqual(dialog.props.options.map(item => item.title), ["Status", "Current memories", "Help"]);
  assert.deepEqual(dialog.props.options.map(item => item.value), ["memory.status", "memory.list", "memory.help"]);
  assert.ok(api.dialog.events.indexOf("clear") < api.dialog.events.indexOf("replace"));
  assert.ok(api.dialog.events.indexOf("replace") < api.dialog.events.indexOf("setSize:large"));
});

test("supports home-route menu, list, and help while status warns", async () => {
  const root = await tempRoot();
  try {
    const api = makeMockTuiApi({ route: { name: "home" }, directory: root });
    await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

    await selectCommand(api, "memory.menu");
    assert.equal(lastDialog(api).type, "DialogSelect");
    assert.equal(lastDialog(api).props.title, "Memory");

    await chooseSelectOption(api, "memory.list");
    assert.equal(lastDialog(api).type, "DialogAlert");
    assert.equal(lastDialog(api).props.title, "Current workspace memories");

    await selectCommand(api, "memory.menu");
    await chooseSelectOption(api, "memory.help");
    assert.equal(lastDialog(api).type, "DialogAlert");
    assert.equal(lastDialog(api).props.title, "Memory help");

    await selectCommand(api, "memory.menu");
    const beforeStatusRenders = api.dialog.renders.length;
    await chooseSelectOption(api, "memory.status");
    assert.equal(api.dialog.renders.length, beforeStatusRenders, "status should not render without an active session");
    assert.ok(api.toasts.some(t => t.variant === "warning" && t.message === "Open a session to use memory commands."));
    assert.equal(api.prompts.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shows status and help alerts from the submenu", async () => {
  const root = await tempRoot();
  try {
    const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } }, directory: root });
    await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

    await selectCommand(api, "memory.menu");
    await chooseSelectOption(api, "memory.status");
    assert.equal(lastDialog(api).type, "DialogAlert");
    assert.equal(lastDialog(api).props.title, "Memory status");
    assert.match(lastDialog(api).props.message, /Workspace:/);

    await selectCommand(api, "memory.menu");
    await chooseSelectOption(api, "memory.help");
    assert.equal(lastDialog(api).type, "DialogAlert");
    assert.equal(lastDialog(api).props.title, "Memory help");
    assert.match(lastDialog(api).props.message, /Status/);
    assert.equal(api.prompts.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shows current memories in a grouped DialogSelect with no-op row selection", async () => {
  const root = await tempRoot();
  try {
    await seedWorkspaceMemories(root);
    const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } }, directory: root });
    await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

    await selectCommand(api, "memory.menu");
    await chooseSelectOption(api, "memory.list");

    const dialog = lastDialog(api);
    assert.equal(dialog.type, "DialogSelect");
    assert.equal(dialog.props.title, "Current workspace memories");
    assert.equal(dialog.props.placeholder, "Search memory refs");
    assert.deepEqual([...new Set(dialog.props.options.map(item => item.category))], ["feedback", "project", "decision", "reference"]);
    assert.ok(dialog.props.options.every(item => /^\[M\d+\] /.test(item.title)));
    assert.ok(dialog.props.options.every(item => typeof item.footer === "string"));
    assert.equal(dialog.props.options.some(item => item.title.includes("sushi")), false);
    assert.equal(dialog.props.options.some(item => item.title.includes("Superseded memory should not be active")), false);
    assert.equal(api.dialog.sizes.at(-1), "xlarge");

    const beforeRenders = api.dialog.renders.length;
    const beforeToasts = api.toasts.length;
    await chooseSelectOption(api, dialog.props.options[0].value);
    assert.equal(api.dialog.renders.length, beforeRenders, "memory row selection should not replace dialog in this wave");
    assert.equal(api.toasts.length, beforeToasts, "memory row selection should not expose mutation/action toast");
    assert.equal(api.prompts.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shows empty current memories as an alert", async () => {
  const root = await tempRoot();
  try {
    const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } }, directory: root });
    await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });
    await selectCommand(api, "memory.menu");
    await chooseSelectOption(api, "memory.list");

    assert.equal(lastDialog(api).type, "DialogAlert");
    assert.equal(lastDialog(api).props.title, "Current workspace memories");
    assert.match(lastDialog(api).props.message, /No active workspace memories are stored yet\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shows local read failures in a memory error alert", async () => {
  const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } } });
  api.state.path.directory = undefined as never;
  await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });
  await selectCommand(api, "memory.menu");
  await chooseSelectOption(api, "memory.status");

  assert.equal(api.prompts.length, 0);
  assert.equal(lastDialog(api).type, "DialogAlert");
  assert.equal(lastDialog(api).props.title, "Memory error");
  assert.match(lastDialog(api).props.message, /Unable to render local memory visibility output\./);
});

test("shows error toast when dialog runtime API is unavailable", async () => {
  for (const options of [
    { missingDialogAlert: true },
    { missingDialogSelect: true },
    { missingDialogReplace: true },
    { missingDialogSetSize: true },
  ]) {
    const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } }, ...options });
    await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });
    await selectCommand(api, "memory.menu");

    assert.equal(api.prompts.length, 0, "should not fall back to prompt injection");
    assert.equal(api.dialog.renders.length, 0, "should not partially open a dialog when API guard fails");
    assert.ok(api.toasts.some(t => t.variant === "error" && t.message === "Memory dialog UI is unavailable in this OpenCode runtime."));
  }
});

test("shows error toast when dialog replacement fails without prompt fallback", async () => {
  const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } }, dialogReplaceThrows: true });
  await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });
  await selectCommand(api, "memory.menu");
  assert.equal(api.prompts.length, 0);
  assert.equal(api.dialog.renders.length, 0);
  assert.equal(api.dialog.sizes.length, 0);
  assert.ok(api.toasts.some(t => t.variant === "error" && /^Unable to show memory dialog: dialog failure$/.test(t.message)), "should show error toast on dialog failure");
});
