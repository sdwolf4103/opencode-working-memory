import {
  appendMemoryReviewDecisionEvidence,
  applyMemoryReviewProposalBatch,
  buildMemoryReviewPrompt,
  createMemoryReviewDecisionRecord,
  createMemoryReviewSnapshot,
  discardMemoryReviewProposalSet,
  latestMemoryReviewProposalSet,
  loadMemoryReviewSnapshot,
  MEMORY_REVIEW_PROBE_PROMPT,
  planMemoryReviewBatchApply,
  saveMemoryReviewSnapshot,
  validateMemoryReviewProposalSet,
  validateMemoryReviewUserEdit,
  type MemoryReviewDryRunResult,
  type MemoryReviewProposal,
  type MemoryReviewProposalSet,
  type MemoryReviewSnapshot,
} from "./memory-review.ts";
import { MEMORY_TYPE_ORDER } from "./memory-kind-policy.ts";
import { formatMemoryHelp, formatMemoryList, getMemoryList, renderMemoryCommand, type MemoryVisibilityCommand } from "./memory-visibility.ts";
import { loadWorkspaceMemory } from "./workspace-memory.ts";

type DialogContext = {
  clear?: () => void;
};

type DialogSize = "medium" | "large" | "xlarge";
type DialogElement = unknown;
type DialogStackContext = {
  clear?: () => void;
  replace?: (render: () => DialogElement, onClose?: () => void) => void;
  setSize?: (size: DialogSize) => void;
};
type DialogAlertComponent = (props: { title: string; message: string; onConfirm?: () => void | Promise<void> }) => DialogElement;
type DialogSelectOption<Value = string> = {
  title: string;
  value: Value;
  description?: string;
  footer?: string;
  category?: string;
  disabled?: boolean;
  onSelect?: () => void | Promise<void>;
};
type DialogSelectProps<Value = string> = {
  title: string;
  placeholder?: string;
  options: DialogSelectOption<Value>[];
  onSelect?: (option: DialogSelectOption<Value>) => void | Promise<void>;
  skipFilter?: boolean;
};
type DialogSelectComponent = <Value = string>(props: DialogSelectProps<Value>) => DialogElement;

type TuiCommand = {
  title: string;
  value: string;
  description?: string;
  category?: string;
  suggested?: boolean;
  slash?: {
    name: string;
    aliases?: string[];
  };
  onSelect?: (dialog?: DialogContext) => void | Promise<void>;
};

type TuiKeymapCommand = {
  namespace: "palette";
  name: string;
  title: string;
  desc?: string;
  category?: string;
  suggested?: boolean;
  slashName?: string;
  slashAliases?: string[];
  run: () => void | Promise<void>;
};

type TuiKeymapLayer = {
  commands: TuiKeymapCommand[];
  bindings: Array<Record<string, unknown>>;
};

type TuiKeymapApi = {
  registerLayer: (layer: TuiKeymapLayer) => () => void;
};

type TuiRouteCurrent =
  | { name: "home" }
  | { name: "session"; params: { sessionID: string; prompt?: unknown } }
  | { name: string; params?: Record<string, unknown> };

type TuiPluginApi = {
  command?: {
    register: (cb: () => TuiCommand[]) => () => void;
  };
  keymap?: TuiKeymapApi;
  route: ({ readonly current: TuiRouteCurrent } | TuiRouteCurrent);
  ui: {
    DialogAlert?: DialogAlertComponent;
    DialogSelect?: DialogSelectComponent;
    toast: (input: { variant?: "info" | "success" | "warning" | "error"; message: string }) => void;
    dialog?: DialogStackContext;
  };
  state: {
    path: {
      directory: string;
    };
  };
  client?: unknown;
};

type SessionPromptInput = { sessionID: string; parts: Array<{ type: "text"; text: string }> };
type SessionPrompt = (input: SessionPromptInput, options: { throwOnError: true }) => Promise<unknown>;

type TuiPlugin = (api: TuiPluginApi, options: unknown, meta: unknown) => Promise<() => void>;

type MemoryReviewTuiState = {
  selectedByProposalSet: Map<string, Set<string>>;
};

function currentRoute(api: TuiPluginApi): TuiRouteCurrent {
  const route = api.route as ({ readonly current?: TuiRouteCurrent } & Partial<TuiRouteCurrent>);
  return route.current ?? (route as TuiRouteCurrent);
}

function renderErrorReport(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return [
    "## Memory error",
    "",
    "Unable to render local memory visibility output.",
    `Error: ${detail}`,
    "",
    "Local only: no LLM request was made.",
  ].join("\n");
}

function dialogSizeForCommand(command: MemoryVisibilityCommand): DialogSize {
  if (command === "list") return "xlarge";
  if (command === "status") return "large";
  return "medium";
}

function fallbackTitleForCommand(command: MemoryVisibilityCommand): string {
  if (command === "list") return "Current workspace memories";
  if (command === "status") return "Memory status";
  return "Memory help";
}

function dialogCopyFromMarkdown(text: string, fallbackTitle: string): { title: string; message: string } {
  const match = /^##\s+(.+)$/m.exec(text);
  if (!match) return { title: fallbackTitle, message: text };

  const headingStart = match.index;
  const headingEnd = text.indexOf("\n", headingStart);
  const before = text.slice(0, headingStart);
  const after = headingEnd === -1 ? "" : text.slice(headingEnd + 1);

  return {
    title: match[1].trim(),
    message: `${before}${after}`.replace(/^\s+/, ""),
  };
}

function getDialogApi(api: TuiPluginApi): {
  DialogAlert: DialogAlertComponent;
  DialogSelect: DialogSelectComponent;
  dialog: Required<Pick<DialogStackContext, "replace" | "setSize">>;
} | undefined {
  if (
    typeof api.ui.DialogAlert !== "function" ||
    typeof api.ui.DialogSelect !== "function" ||
    typeof api.ui.dialog?.replace !== "function" ||
    typeof api.ui.dialog?.setSize !== "function"
  ) {
    api.ui.toast({
      variant: "error",
      message: "Memory dialog UI is unavailable in this OpenCode runtime.",
    });
    return undefined;
  }

  return {
    DialogAlert: api.ui.DialogAlert,
    DialogSelect: api.ui.DialogSelect,
    dialog: {
      replace: api.ui.dialog.replace,
      setSize: api.ui.dialog.setSize,
    },
  };
}

function showDialogError(api: TuiPluginApi, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  api.ui.toast({
    variant: "error",
    message: `Unable to show memory dialog: ${detail}`,
  });
}

function showAlertFromMarkdown(api: TuiPluginApi, text: string, fallbackTitle: string, size: DialogSize): void {
  const dialogApi = getDialogApi(api);
  if (!dialogApi) return;
  const { title, message } = dialogCopyFromMarkdown(text, fallbackTitle);

  try {
    dialogApi.dialog.replace(() => dialogApi.DialogAlert({ title, message }));
    dialogApi.dialog.setSize(size);
  } catch (error) {
    showDialogError(api, error);
  }
}

function currentSessionID(api: TuiPluginApi): string | undefined {
  const route = currentRoute(api);
  return route.name === "session" && typeof route.params?.sessionID === "string"
    ? route.params.sessionID
    : undefined;
}

function sessionPrompt(api: TuiPluginApi): SessionPrompt | undefined {
  const session = (api.client as { session?: { prompt?: unknown } } | undefined)?.session;
  return typeof session?.prompt === "function"
    ? session.prompt.bind(session) as SessionPrompt
    : undefined;
}

function showMemoryReviewPromptFallback(api: TuiPluginApi): void {
  const dialogApi = getDialogApi(api);
  if (!dialogApi) return;

  try {
    dialogApi.dialog.replace(() => dialogApi.DialogAlert({
      title: "Memory Review prompt",
      message: [
        "Copy this prompt into the current session to run the Memory Review transport probe.",
        "",
        MEMORY_REVIEW_PROBE_PROMPT,
      ].join("\n"),
    }));
    dialogApi.dialog.setSize("xlarge");
  } catch (error) {
    showDialogError(api, error);
  }
}

async function showMemoryReview(api: TuiPluginApi): Promise<void> {
  const sessionID = currentSessionID(api);
  const prompt = sessionPrompt(api);

  if (!sessionID) {
    api.ui.toast({
      variant: "warning",
      message: "Open a session to auto-submit Memory Review. Showing copyable prompt fallback.",
    });
    showMemoryReviewPromptFallback(api);
    return;
  }

  if (!prompt) {
    api.ui.toast({
      variant: "warning",
      message: "Memory Review auto-submit is unavailable; copy the prompt manually.",
    });
    showMemoryReviewPromptFallback(api);
    return;
  }

  try {
    const root = api.state.path.directory;
    const store = await loadWorkspaceMemory(root);
    const snapshot = createMemoryReviewSnapshot(store);
    await saveMemoryReviewSnapshot(root, snapshot);
    await prompt({ sessionID, parts: [{ type: "text", text: buildMemoryReviewPrompt(snapshot) }] }, { throwOnError: true });
    api.ui.toast({
      variant: "success",
      message: "Memory Review prompt sent to the current session.",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    api.ui.toast({
      variant: "warning",
      message: `Memory Review auto-submit failed (${detail}); copy the prompt manually.`,
    });
    showMemoryReviewPromptFallback(api);
  }
}

function selectedProposalIds(state: MemoryReviewTuiState, proposalSet: MemoryReviewProposalSet): Set<string> {
  let selected = state.selectedByProposalSet.get(proposalSet.id);
  if (!selected) {
    selected = new Set(proposalSet.proposals.map(proposal => proposal.id));
    state.selectedByProposalSet.set(proposalSet.id, selected);
  }
  return selected;
}

async function loadMemoryReviewContext(api: TuiPluginApi): Promise<{
  proposalSet: MemoryReviewProposalSet;
  snapshot: MemoryReviewSnapshot;
} | undefined> {
  const root = api.state.path.directory;
  const proposalSet = await latestMemoryReviewProposalSet(root);
  if (!proposalSet) {
    showAlertFromMarkdown(api, "## Memory Review proposals\n\nNo sealed Memory Review proposals are available.", "Memory Review proposals", "medium");
    return undefined;
  }

  const snapshot = await loadMemoryReviewSnapshot(root, proposalSet.snapshotId);
  if (!snapshot) {
    showAlertFromMarkdown(api, `## Memory Review proposals\n\nSnapshot ${proposalSet.snapshotId} is missing; proposals cannot be applied.`, "Memory Review proposals", "medium");
    return undefined;
  }

  const validation = validateMemoryReviewProposalSet(proposalSet, snapshot);
  if (!validation.valid) {
    showAlertFromMarkdown(api, [
      "## Memory Review proposals",
      "",
      "The latest proposal set failed validation and cannot be applied.",
      "",
      ...validation.errors.map(error => `- ${error.proposalId ? `${error.proposalId}: ` : ""}${error.code}`),
    ].join("\n"), "Memory Review proposals", "large");
    return undefined;
  }

  return { proposalSet, snapshot };
}

function formatDryRun(plan: MemoryReviewDryRunResult): string {
  if (!plan.valid) {
    return [
      "Dry-run preview failed validation.",
      "",
      ...plan.errors.map(error => `- ${error.proposalId ? `${error.proposalId}: ` : ""}${error.code} — ${error.message}`),
    ].join("\n");
  }

  if (plan.operations.length === 0) {
    return "Dry-run preview\n\nNo proposals are selected.";
  }

  return [
    "Dry-run preview",
    "",
    ...plan.operations.map(operation => [
      `- ${operation.proposalId}: ${operation.kind}`,
      `  Targets: ${operation.targetRefs.join(", ")}`,
      `  ${operation.description}`,
      operation.replacement ? `  Replacement: (${operation.replacement.type}) ${operation.replacement.text}` : undefined,
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

function selectedIdsFromSet(selected: Set<string>, proposalSet: MemoryReviewProposalSet): string[] {
  return proposalSet.proposals.map(proposal => proposal.id).filter(id => selected.has(id));
}

function showMemoryReviewDryRun(api: TuiPluginApi, proposalSet: MemoryReviewProposalSet, snapshot: MemoryReviewSnapshot, proposalIds: string[]): void {
  const dialogApi = getDialogApi(api);
  if (!dialogApi) return;
  const plan = planMemoryReviewBatchApply(proposalSet, snapshot, undefined, { proposalIds });
  try {
    dialogApi.dialog.replace(() => dialogApi.DialogAlert({
      title: "Memory Review dry-run",
      message: formatDryRun(plan),
    }));
    dialogApi.dialog.setSize("xlarge");
  } catch (error) {
    showDialogError(api, error);
  }
}

function showMemoryReviewApplyConfirm(api: TuiPluginApi, proposalSet: MemoryReviewProposalSet, snapshot: MemoryReviewSnapshot, proposalIds: string[]): void {
  const dialogApi = getDialogApi(api);
  if (!dialogApi) return;
  const plan = planMemoryReviewBatchApply(proposalSet, snapshot, undefined, { proposalIds });
  if (!plan.valid || plan.operations.length === 0) {
    showMemoryReviewDryRun(api, proposalSet, snapshot, proposalIds);
    return;
  }

  try {
    dialogApi.dialog.replace(() => dialogApi.DialogAlert({
      title: "Confirm Memory Review apply",
      message: [formatDryRun(plan), "", "Confirm to update persistent workspace memory. The current frozen prompt refreshes at the next compaction or in a new session. Forget actions deactivate (supersede) memories; retained audit text is not securely erased."].join("\n"),
      onConfirm: async () => {
        const result = await applyMemoryReviewProposalBatch(api.state.path.directory, proposalSet, snapshot, proposalIds);
        if (result.applied) {
          api.ui.toast({ variant: "success", message: `Applied ${result.operations.length} Memory Review proposal(s) to persistent workspace memory. The current frozen prompt will refresh at the next compaction or in a new session. Forget actions deactivate memories; retained audit text is not securely erased.` });
        } else {
          api.ui.toast({ variant: "error", message: `Memory Review apply failed: ${result.errors.map(error => error.code).join(", ") || "unknown"}` });
          showMemoryReviewDryRun(api, proposalSet, snapshot, proposalIds);
        }
      },
    }));
    dialogApi.dialog.setSize("xlarge");
  } catch (error) {
    showDialogError(api, error);
  }
}

async function editSelectedMemoryReviewProposals(api: TuiPluginApi, proposalSet: MemoryReviewProposalSet, snapshot: MemoryReviewSnapshot, proposalIds: string[]): Promise<void> {
  const currentStore = await loadWorkspaceMemory(api.state.path.directory);
  const selected = proposalSet.proposals.filter(proposal => proposalIds.includes(proposal.id) && proposal.action !== "forget");
  if (selected.length === 0) {
    api.ui.toast({ variant: "warning", message: "Select at least one update/consolidate proposal to edit." });
    return;
  }

  const errors = selected.flatMap(proposal => validateMemoryReviewUserEdit(proposal, snapshot, proposal.proposedText ?? "", currentStore).errors);
  if (errors.length > 0) {
    api.ui.toast({ variant: "error", message: `Memory Review edit invalid: ${[...new Set(errors.map(error => error.code))].join(", ")}` });
    return;
  }

  for (const proposal of selected) {
    await appendMemoryReviewDecisionEvidence(api.state.path.directory, createMemoryReviewDecisionRecord({
      proposalSetId: proposalSet.id,
      proposalId: proposal.id,
      decision: "edited",
      createdAt: new Date().toISOString(),
      userEditedText: proposal.proposedText,
      validation: { valid: true, errors: [] },
    }));
  }
  api.ui.toast({ variant: "success", message: `Recorded ${selected.length} Memory Review edit(s).` });
}

function proposalTitle(proposal: MemoryReviewProposal, selected: boolean): string {
  return `${selected ? "[x]" : "[ ]"} ${proposal.action} ${proposal.targets.join(",")} ${proposal.risk}`;
}

async function showMemoryReviewProposals(api: TuiPluginApi, state: MemoryReviewTuiState): Promise<void> {
  const dialogApi = getDialogApi(api);
  if (!dialogApi) return;

  try {
    // Keep proposal loading and later confirmation in the same workspace even
    // when the terminal navigates while a dialog or file operation is pending.
    api = { ...api, state: { path: { directory: api.state.path.directory } } };
    const context = await loadMemoryReviewContext(api);
    if (!context) return;
    const { proposalSet, snapshot } = context;
    const selected = selectedProposalIds(state, proposalSet);

    const rerender = () => showMemoryReviewProposals(api, state);
    const selectedIds = () => selectedIdsFromSet(selectedProposalIds(state, proposalSet), proposalSet);
    const safeIds = () => proposalSet.proposals.filter(proposal => proposal.risk !== "high").map(proposal => proposal.id);

    const options: DialogSelectOption[] = [
      ...proposalSet.proposals.map(proposal => ({
        title: proposalTitle(proposal, selected.has(proposal.id)),
        value: `memory.review.proposal.${proposal.id}`,
        description: proposal.rationale,
        footer: proposal.futureValue,
        category: "Proposals",
        onSelect: async () => {
          const current = selectedProposalIds(state, proposalSet);
          if (current.has(proposal.id)) current.delete(proposal.id);
          else current.add(proposal.id);
          await rerender();
        },
      })),
      {
        title: "Dry-run selected",
        value: "memory.review.dry-run",
        description: "Preview selected operations without mutating memory",
        category: "Actions",
        onSelect: () => showMemoryReviewDryRun(api, proposalSet, snapshot, selectedIds()),
      },
      {
        title: "Edit selected",
        value: "memory.review.edit-selected",
        description: "Validate selected replacement text before apply",
        category: "Actions",
        onSelect: () => editSelectedMemoryReviewProposals(api, proposalSet, snapshot, selectedIds()),
      },
      {
        title: "Apply selected",
        value: "memory.review.apply-selected",
        description: "Preview, confirm, then apply selected proposals",
        category: "Actions",
        onSelect: () => showMemoryReviewApplyConfirm(api, proposalSet, snapshot, selectedIds()),
      },
      {
        title: "Apply all safe",
        value: "memory.review.apply-all-safe",
        description: "Apply low/medium risk proposals only after confirmation",
        category: "Actions",
        onSelect: () => showMemoryReviewApplyConfirm(api, proposalSet, snapshot, safeIds()),
      },
      {
        title: "Discard proposal set",
        value: "memory.review.discard",
        description: "Discard the sealed proposal set without changing memory",
        category: "Actions",
        onSelect: async () => {
          await discardMemoryReviewProposalSet(api.state.path.directory, proposalSet.id);
          state.selectedByProposalSet.delete(proposalSet.id);
          dialogApi.dialog.replace(() => dialogApi.DialogAlert({
            title: "Memory Review discarded",
            message: `Discarded ${proposalSet.id}. Workspace memory was not changed.`,
          }));
          dialogApi.dialog.setSize("medium");
        },
      },
    ];

    dialogApi.dialog.replace(() => dialogApi.DialogSelect({
      title: "Memory Review proposals",
      placeholder: "Search proposals",
      options,
    }));
    dialogApi.dialog.setSize("xlarge");
  } catch (error) {
    showDialogError(api, error);
  }
}

function showMemoryMenu(api: TuiPluginApi, state: MemoryReviewTuiState, dialog?: DialogContext): void {
  const dialogApi = getDialogApi(api);
  if (!dialogApi) return;

  const options: DialogSelectOption[] = [
    {
      title: "Status",
      value: "memory.status",
      description: "Show local memory statistics",
      onSelect: () => showMemoryStatus(api),
    },
    {
      title: "Current memories",
      value: "memory.list",
      description: "Browse active workspace memories with display-local refs",
      onSelect: () => showMemoryList(api),
    },
    {
      title: "Review",
      value: "memory.review",
      description: "Probe Memory Review prompt transport; no memory changes are applied",
      onSelect: () => showMemoryReview(api),
    },
    {
      title: "Proposals",
      value: "memory.proposals",
      description: "Review sealed proposals before any explicit apply",
      onSelect: () => showMemoryReviewProposals(api, state),
    },
    {
      title: "Help",
      value: "memory.help",
      description: "Show memory command help",
      onSelect: () => showMemoryHelp(api),
    },
  ];

  try {
    dialog?.clear?.();
    dialogApi.dialog.replace(() => dialogApi.DialogSelect({
      title: "Memory",
      placeholder: "Search memory actions",
      options,
    }));
    dialogApi.dialog.setSize("large");
  } catch (error) {
    showDialogError(api, error);
  }
}

async function showMemoryStatus(api: TuiPluginApi): Promise<void> {
  const route = currentRoute(api);

  if (route.name !== "session" || typeof route.params?.sessionID !== "string") {
    api.ui.toast({
      variant: "warning",
      message: "Open a session to use memory commands.",
    });
    return;
  }

  const sessionID = route.params.sessionID;
  const dialogApi = getDialogApi(api);
  if (!dialogApi) return;

  let text: string;
  let fallbackTitle = fallbackTitleForCommand("status");

  try {
    text = await renderMemoryCommand(api.state.path.directory, sessionID, "status");
  } catch (error) {
    text = renderErrorReport(error);
    fallbackTitle = "Memory error";
  }

  const { title, message } = dialogCopyFromMarkdown(text, fallbackTitle);

  try {
    dialogApi.dialog.replace(() => dialogApi.DialogAlert({ title, message }));
    dialogApi.dialog.setSize(dialogSizeForCommand("status"));
  } catch (error) {
    showDialogError(api, error);
  }
}

function showMemoryHelp(api: TuiPluginApi): void {
  showAlertFromMarkdown(api, formatMemoryHelp(), "Memory help", "medium");
}

async function showMemoryList(api: TuiPluginApi): Promise<void> {
  const dialogApi = getDialogApi(api);
  if (!dialogApi) return;

  try {
    const model = await getMemoryList(api.state.path.directory);
    if (model.renderedMemories === 0) {
      showAlertFromMarkdown(api, formatMemoryList(model), "Current workspace memories", "medium");
      return;
    }

    const options: DialogSelectOption[] = [];
    for (const type of MEMORY_TYPE_ORDER) {
      for (const item of model.groups[type]) {
        options.push({
          title: `[${item.ref}] ${item.text}`,
          value: item.ref,
          category: type,
          footer: "display-local",
        });
      }
    }

    dialogApi.dialog.replace(() => dialogApi.DialogSelect({
      title: "Current workspace memories",
      placeholder: "Search memory refs",
      options,
    }));
    dialogApi.dialog.setSize("xlarge");
  } catch (error) {
    showAlertFromMarkdown(api, renderErrorReport(error), "Memory error", "medium");
  }
}

function memoryCommands(api: TuiPluginApi, state: MemoryReviewTuiState): TuiCommand[] {
  return [
    {
      title: "Memory",
      value: "memory.menu",
      description: "Browse local working memory.",
      category: "Memory",
      slash: { name: "memory" },
      onSelect: (dialog?: DialogContext) => showMemoryMenu(api, state, dialog),
    },
  ];
}

function keymapCommandFromLegacyCommand(api: TuiPluginApi, command: TuiCommand): TuiKeymapCommand {
  return {
    namespace: "palette",
    name: command.value,
    title: command.title,
    desc: command.description,
    category: command.category,
    suggested: command.suggested,
    slashName: command.slash?.name,
    slashAliases: command.slash?.aliases,
    run: () => command.onSelect?.(api.ui.dialog),
  };
}

function registerMemoryCommands(api: TuiPluginApi, state: MemoryReviewTuiState): () => void {
  const commands = memoryCommands(api, state);
  if (typeof api.keymap?.registerLayer === "function") {
    return api.keymap.registerLayer({
      commands: commands.map(command => keymapCommandFromLegacyCommand(api, command)),
      bindings: [],
    });
  }

  if (typeof api.command?.register === "function") {
    return api.command.register(() => commands);
  }

  api.ui.toast({
    variant: "error",
    message: "Memory command registration API is unavailable in this OpenCode runtime.",
  });
  return () => {};
}

export const MemoryTuiPlugin: TuiPlugin = async (api) => {
  const state: MemoryReviewTuiState = { selectedByProposalSet: new Map() };
  return registerMemoryCommands(api, state);
};

export default {
  id: "working-memory-tui",
  tui: MemoryTuiPlugin,
};
