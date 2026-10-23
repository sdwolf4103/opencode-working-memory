import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiCommand } from "@opencode-ai/plugin/tui";
import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "../src/types.ts";
import { loadWorkspaceMemory, saveWorkspaceMemory } from "../src/workspace-memory.ts";
import {
  captureMemoryReviewProposalText,
  createMemoryReviewSnapshot,
  MEMORY_REVIEW_PROPOSAL_SET_KIND,
  saveMemoryReviewSnapshot,
} from "../src/memory-review.ts";

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
type MockKeymapCommand = {
  namespace?: string;
  name: string;
  title?: string;
  desc?: string;
  category?: string;
  suggested?: boolean;
  slashName?: string;
  slashAliases?: string[];
  run?: () => void | Promise<void>;
};
type MockKeymapLayer = {
  commands?: MockKeymapCommand[];
  bindings?: Array<Record<string, unknown>>;
};
type MockPromptCall = {
  sessionID: string;
  parts: Array<{ type: "text"; text: string }>;
};

interface MockTuiApi {
  commands: RuntimeCommand[];
  commandRegisterCalls: number;
  keymapLayers: MockKeymapLayer[];
  prompts: MockPromptCall[];
  promptOptions: Array<{ throwOnError: true }>;
  toasts: Array<{ variant?: string; message: string }>;
  dialog: MockDialogContext;
  route: { name: string; params?: Record<string, unknown> };
  state: { path: { directory: string } };
  command: { register: (cb: () => TuiCommand[]) => () => void };
  keymap?: { registerLayer: (layer: MockKeymapLayer) => () => void };
  ui: {
    toast: (input: { variant?: string; message: string }) => void;
    dialog?: Partial<MockDialogContext>;
    DialogAlert?: (props: MockDialogAlertProps) => MockDialogElement;
    DialogSelect?: (props: MockDialogSelectProps) => MockDialogElement;
  };
  client?: { session?: { prompt?: (input: MockPromptCall, options: { throwOnError: true }) => Promise<void> } };
}

function makeMockTuiApi(options: {
  route: { name: string; params?: Record<string, unknown> };
  directory?: string;
  missingDialogAlert?: boolean;
  missingDialogSelect?: boolean;
  missingDialogReplace?: boolean;
  missingDialogSetSize?: boolean;
  dialogReplaceThrows?: boolean;
  missingClient?: boolean;
  missingPrompt?: boolean;
  promptThrows?: boolean;
  missingKeymap?: boolean;
}): MockTuiApi {
  const commands: RuntimeCommand[] = [];
  const keymapLayers: MockKeymapLayer[] = [];
  let commandRegisterCalls = 0;
  const prompts: MockPromptCall[] = [];
  const promptOptions: Array<{ throwOnError: true }> = [];
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

  const client = options.missingClient
    ? undefined
    : {
      session: options.missingPrompt
        ? {}
        : {
          prompt: async (input: MockPromptCall, promptOptionsInput: { throwOnError: true }) => {
            promptOptions.push(promptOptionsInput);
            if (options.promptThrows) throw new Error("prompt failure");
            prompts.push(input);
          },
        },
    };

  const api: MockTuiApi = {
    commands,
    get commandRegisterCalls() { return commandRegisterCalls; },
    keymapLayers,
    prompts,
    promptOptions,
    toasts,
    dialog,
    route: options.route,
    state: { path: { directory: options.directory ?? "/mock/workspace" } },
    command: {
      register: (cb: () => TuiCommand[]) => {
        commandRegisterCalls += 1;
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
    client,
  };

  if (!options.missingKeymap) {
    api.keymap = {
      registerLayer: (layer: MockKeymapLayer) => {
        keymapLayers.push(layer);
        for (const item of layer.commands ?? []) {
          commands.push({
            value: item.name,
            suggested: item.suggested,
            slash: item.slashName ? { name: item.slashName, aliases: item.slashAliases } : undefined,
            onSelect: item.run,
          });
        }
        return () => {};
      },
    };
  }

  return api;
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

async function confirmAlert(api: MockTuiApi): Promise<void> {
  const dialog = lastDialog(api);
  assert.equal(dialog.type, "DialogAlert");
  await dialog.props.onConfirm?.();
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

function proposalSet(snapshotId = "snapshot_1", proposals: Array<Record<string, unknown>> = []) {
  return {
    version: 1,
    kind: MEMORY_REVIEW_PROPOSAL_SET_KIND,
    id: "proposal_set_1",
    snapshotId,
    createdAt: new Date().toISOString(),
    source: "assistant_memory_review",
    status: "sealed",
    sealed: true,
    proposals: proposals.length > 0 ? proposals : [
      {
        id: "proposal_1",
        action: "update",
        targets: ["M1"],
        proposedType: "decision",
        proposedText: "Use the reviewed replacement memory.",
        evidenceRefs: ["E1"],
        risk: "low",
        rationale: "The original memory is stale.",
        futureValue: "Future sessions get the current durable rule.",
        temporaryStateCheck: "This is not transient session state.",
      },
    ],
  };
}

function fencedProposalSet(input: unknown): string {
  return ["```memory-review-proposals", JSON.stringify(input), "```"].join("\n");
}

async function seedReviewProposal(root: string, proposals?: Array<Record<string, unknown>>): Promise<void> {
  const store = await loadWorkspaceMemory(root);
  const snapshot = createMemoryReviewSnapshot(store, { id: "snapshot_1" });
  await saveMemoryReviewSnapshot(root, snapshot);
  await captureMemoryReviewProposalText(root, fencedProposalSet(proposalSet("snapshot_1", proposals)), { source: "cli_import" });
}

// Dynamic import to allow module-level mocking
const { MemoryTuiPlugin } = await import("../src/tui-plugin.ts");

test("registers one unsuggested /memory slash command through keymap when available", async () => {
  const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } } });
  await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

  assert.equal(api.commandRegisterCalls, 0);
  assert.equal(api.keymapLayers.length, 1);
  assert.deepEqual(api.keymapLayers[0].bindings, []);
  assert.deepEqual(api.keymapLayers[0].commands?.map(command => ({
    namespace: command.namespace,
    name: command.name,
    title: command.title,
    desc: command.desc,
    category: command.category,
    slashName: command.slashName,
    suggested: command.suggested,
  })), [{
    namespace: "palette",
    name: "memory.menu",
    title: "Memory",
    desc: "Browse local working memory.",
    category: "Memory",
    slashName: "memory",
    suggested: undefined,
  }]);
  assert.deepEqual(api.commands.map(command => command.value), ["memory.menu"]);
  assert.deepEqual(api.commands.map(command => command.slash?.name).filter(Boolean), ["memory"]);
  assert.deepEqual(api.commands.map(command => command.suggested), [undefined]);
  for (const removedName of ["memory-" + "status", "memory-" + "list", "memory-" + "help"]) {
    assert.equal(api.commands.some(command => command.slash?.name === removedName), false);
  }
});

test("falls back to legacy command registration when keymap API is unavailable", async () => {
  const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } }, missingKeymap: true });
  await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

  assert.equal(api.keymapLayers.length, 0);
  assert.equal(api.commandRegisterCalls, 1);
  assert.deepEqual(api.commands.map(command => command.value), ["memory.menu"]);
  assert.deepEqual(api.commands.map(command => command.slash?.name).filter(Boolean), ["memory"]);

  await selectCommand(api, "memory.menu");
  assert.equal(lastDialog(api).type, "DialogSelect");
  assert.equal(lastDialog(api).props.title, "Memory");
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
  assert.deepEqual(dialog.props.options.map(item => item.title), ["Status", "Current memories", "Review", "Proposals", "Help"]);
  assert.deepEqual(dialog.props.options.map(item => item.value), ["memory.status", "memory.list", "memory.review", "memory.proposals", "memory.help"]);
  assert.equal(dialog.props.options.some(item => /apply/i.test(item.title) || /apply/i.test(item.value)), false);
  assert.ok(api.dialog.events.indexOf("clear") < api.dialog.events.indexOf("replace"));
  assert.ok(api.dialog.events.indexOf("replace") < api.dialog.events.indexOf("setSize:large"));
});

test("auto-submits Memory Review prompt when current session prompt API is available", async () => {
  const root = await tempRoot();
  try {
  await seedWorkspaceMemories(root);
  const before = await loadWorkspaceMemory(root);
  const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } }, directory: root });
  await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

  await selectCommand(api, "memory.menu");
  await chooseSelectOption(api, "memory.review");

  assert.equal(api.prompts.length, 1);
  assert.deepEqual(api.prompts[0].sessionID, "ses_1");
  assert.equal(api.prompts[0].parts[0].type, "text");
  assert.match(api.prompts[0].parts[0].text, /memory-review-proposals/);
  assert.match(api.prompts[0].parts[0].text, /snapshot_/);
  assert.match(api.prompts[0].parts[0].text, /Do not mutate memory/);
  assert.doesNotMatch(api.prompts[0].parts[0].text, /Rollout 0|capability probe only/);
  assert.deepEqual(api.promptOptions, [{ throwOnError: true }]);
  assert.ok(api.toasts.some(t => t.variant === "success" && /Memory Review prompt sent/.test(t.message)));
  assert.equal(api.dialog.renders.some(render => render.type === "DialogSelect" && render.props.options.some(item => /apply/i.test(item.title))), false);
  const after = await loadWorkspaceMemory(root);
  assert.deepEqual(after.entries.map(entry => ({ id: entry.id, text: entry.text, status: entry.status })), before.entries.map(entry => ({ id: entry.id, text: entry.text, status: entry.status })));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shows copyable Memory Review fallback when prompt request rejects", async () => {
  const root = await tempRoot();
  try {
    await seedWorkspaceMemories(root);
    const before = await loadWorkspaceMemory(root);
    const api = makeMockTuiApi({
      route: { name: "session", params: { sessionID: "ses_1" } },
      directory: root,
      promptThrows: true,
    });
    await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

    await selectCommand(api, "memory.menu");
    await chooseSelectOption(api, "memory.review");

    assert.equal(api.prompts.length, 0);
    assert.deepEqual(api.promptOptions, [{ throwOnError: true }]);
    assert.equal(api.toasts.some(toast => toast.variant === "success" && /Memory Review prompt sent/.test(toast.message)), false);
    assert.ok(api.toasts.some(toast => toast.variant === "warning" && /auto-submit failed \(prompt failure\)/.test(toast.message)));
    assert.equal(lastDialog(api).type, "DialogAlert");
    assert.equal(lastDialog(api).props.title, "Memory Review prompt");
    assert.match(lastDialog(api).props.message, /Copy this prompt/);
    const after = await loadWorkspaceMemory(root);
    assert.deepEqual(after.entries.map(entry => ({ id: entry.id, text: entry.text, status: entry.status })), before.entries.map(entry => ({ id: entry.id, text: entry.text, status: entry.status })));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shows copyable Memory Review fallback when prompt API is unavailable", async () => {
  const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } }, missingPrompt: true });
  await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

  await selectCommand(api, "memory.menu");
  await chooseSelectOption(api, "memory.review");

  assert.equal(api.prompts.length, 0);
  assert.ok(api.toasts.some(t => t.variant === "warning" && /auto-submit is unavailable/.test(t.message)));
  assert.equal(lastDialog(api).type, "DialogAlert");
  assert.equal(lastDialog(api).props.title, "Memory Review prompt");
  assert.match(lastDialog(api).props.message, /Copy this prompt/);
  assert.match(lastDialog(api).props.message, /memory-review-proposals/);
  assert.doesNotMatch(lastDialog(api).props.message, /Apply selected|Apply all safe|mutation UI/);
});

test("shows Memory Review fallback and warning when not in a session", async () => {
  const api = makeMockTuiApi({ route: { name: "home" } });
  await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

  await selectCommand(api, "memory.menu");
  await chooseSelectOption(api, "memory.review");

  assert.equal(api.prompts.length, 0);
  assert.ok(api.toasts.some(t => t.variant === "warning" && /Open a session to auto-submit Memory Review/.test(t.message)));
  assert.equal(lastDialog(api).type, "DialogAlert");
  assert.equal(lastDialog(api).props.title, "Memory Review prompt");
  assert.match(lastDialog(api).props.message, /Copy this prompt/);
});

test("shows sealed Memory Review proposals and supports selection dry-run and discard without mutation", async () => {
  const root = await tempRoot();
  try {
    await seedWorkspaceMemories(root);
    await seedReviewProposal(root);
    const before = await loadWorkspaceMemory(root);
    const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } }, directory: root });
    await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

    await selectCommand(api, "memory.menu");
    await chooseSelectOption(api, "memory.proposals");

    let dialog = lastDialog(api);
    assert.equal(dialog.type, "DialogSelect");
    assert.equal(dialog.props.title, "Memory Review proposals");
    assert.ok(dialog.props.options.some(item => item.value === "memory.review.proposal.proposal_1" && item.title.includes("[x] update M1 low")));
    assert.ok(dialog.props.options.some(item => item.value === "memory.review.dry-run"));
    assert.ok(dialog.props.options.some(item => item.value === "memory.review.discard"));

    await chooseSelectOption(api, "memory.review.proposal.proposal_1");
    dialog = lastDialog(api);
    assert.equal(dialog.type, "DialogSelect");
    assert.ok(dialog.props.options.some(item => item.value === "memory.review.proposal.proposal_1" && item.title.includes("[ ] update M1 low")));

    await chooseSelectOption(api, "memory.review.proposal.proposal_1");
    await chooseSelectOption(api, "memory.review.dry-run");
    assert.equal(lastDialog(api).type, "DialogAlert");
    assert.equal(lastDialog(api).props.title, "Memory Review dry-run");
    assert.match(lastDialog(api).props.message, /supersede_and_add/);

    await selectCommand(api, "memory.menu");
    await chooseSelectOption(api, "memory.proposals");
    await chooseSelectOption(api, "memory.review.discard");
    assert.equal(lastDialog(api).type, "DialogAlert");
    assert.equal(lastDialog(api).props.title, "Memory Review discarded");
    const after = await loadWorkspaceMemory(root);
    assert.deepEqual(after.entries.map(entry => ({ id: entry.id, text: entry.text, status: entry.status })), before.entries.map(entry => ({ id: entry.id, text: entry.text, status: entry.status })));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Memory Review apply selected previews before explicit confirmation and mutates only selected proposal", async () => {
  const root = await tempRoot();
  try {
    await seedWorkspaceMemories(root);
    await seedReviewProposal(root, [
      {
        id: "proposal_1",
        action: "update",
        targets: ["M1"],
        proposedType: "decision",
        proposedText: "Use selected replacement memory.",
        evidenceRefs: ["E1"],
        risk: "low",
        rationale: "Decision memory is stale.",
        futureValue: "Future sessions use the selected replacement.",
        temporaryStateCheck: "Durable rule.",
      },
      {
        id: "proposal_2",
        action: "forget",
        targets: ["M4"],
        evidenceRefs: ["E2"],
        risk: "low",
        rationale: "Reference should remain unless selected.",
        futureValue: "Reduces stale context.",
        temporaryStateCheck: "Durable cleanup.",
      },
    ]);
    const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } }, directory: root });
    await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

    await selectCommand(api, "memory.menu");
    await chooseSelectOption(api, "memory.proposals");
    await chooseSelectOption(api, "memory.review.proposal.proposal_2");
    await chooseSelectOption(api, "memory.review.apply-selected");

    assert.equal(lastDialog(api).type, "DialogAlert");
    assert.equal(lastDialog(api).props.title, "Confirm Memory Review apply");
    assert.match(lastDialog(api).props.message, /Confirm to update persistent workspace memory/);
    assert.match(lastDialog(api).props.message, /current frozen prompt refreshes at the next compaction or in a new session/);
    assert.match(lastDialog(api).props.message, /deactivate \(supersede\) memories; retained audit text is not securely erased/);
    let current = await loadWorkspaceMemory(root);
    assert.equal(current.entries.find(entry => entry.id === "mem-decision")?.status, "active");
    assert.equal(current.entries.find(entry => entry.id === "mem-reference")?.status, "active");

    await confirmAlert(api);
    assert.ok(api.toasts.some(toast => /persistent workspace memory/.test(toast.message)));
    assert.ok(api.toasts.some(toast => /current frozen prompt will refresh at the next compaction or in a new session/.test(toast.message)));
    assert.ok(api.toasts.some(toast => /deactivate memories; retained audit text is not securely erased/.test(toast.message)));
    current = await loadWorkspaceMemory(root);
    assert.equal(current.entries.find(entry => entry.id === "mem-decision")?.status, "superseded");
    assert.equal(current.entries.find(entry => entry.id === "mem-reference")?.status, "active");
    assert.ok(current.entries.some(entry => entry.text === "Use selected replacement memory." && entry.source === "manual"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Memory Review apply all safe excludes high risk proposals", async () => {
  const root = await tempRoot();
  try {
    await seedWorkspaceMemories(root);
    await seedReviewProposal(root, [
      {
        id: "proposal_low",
        action: "update",
        targets: ["M1"],
        proposedType: "decision",
        proposedText: "Use low risk replacement memory.",
        evidenceRefs: ["E1"],
        risk: "low",
        rationale: "Low risk update.",
        futureValue: "Future sessions benefit.",
        temporaryStateCheck: "Durable rule.",
      },
      {
        id: "proposal_high",
        action: "forget",
        targets: ["M4"],
        evidenceRefs: ["E2"],
        risk: "high",
        rationale: "High risk forget.",
        futureValue: "Potentially useful but risky.",
        temporaryStateCheck: "Durable cleanup.",
      },
    ]);
    const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } }, directory: root });
    await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

    await selectCommand(api, "memory.menu");
    await chooseSelectOption(api, "memory.proposals");
    await chooseSelectOption(api, "memory.review.apply-all-safe");
    assert.match(lastDialog(api).props.message, /proposal_low/);
    assert.doesNotMatch(lastDialog(api).props.message, /proposal_high/);
    await confirmAlert(api);

    const current = await loadWorkspaceMemory(root);
    assert.equal(current.entries.find(entry => entry.id === "mem-decision")?.status, "superseded");
    assert.equal(current.entries.find(entry => entry.id === "mem-reference")?.status, "active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Memory Review edit selected validates replacement text before recording edit", async () => {
  const root = await tempRoot();
  try {
    await seedWorkspaceMemories(root);
    await seedReviewProposal(root, [{
      id: "proposal_1",
      action: "update",
      targets: ["M1"],
      proposedType: "decision",
      proposedText: "password: sushi",
      evidenceRefs: ["E1"],
      risk: "low",
      rationale: "Invalid edit should be blocked.",
      futureValue: "Future value.",
      temporaryStateCheck: "Durable rule.",
    }]);
    const api = makeMockTuiApi({ route: { name: "session", params: { sessionID: "ses_1" } }, directory: root });
    await MemoryTuiPlugin(api as any, undefined, { id: "test", source: "file", spec: "test", target: "./tui", first_time: Date.now(), last_time: Date.now(), time_changed: Date.now(), load_count: 1, fingerprint: "test", state: "first" });

    await selectCommand(api, "memory.menu");
    await chooseSelectOption(api, "memory.proposals");
    await chooseSelectOption(api, "memory.review.edit-selected");
    assert.ok(api.toasts.some(t => t.variant === "error" && /redaction_changed_text/.test(t.message)));
    const current = await loadWorkspaceMemory(root);
    assert.equal(current.entries.find(entry => entry.id === "mem-decision")?.status, "active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
