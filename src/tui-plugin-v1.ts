import {
  formatMemoryHelp,
  formatMemoryList,
  getMemoryList,
  renderMemoryCommand,
  type MemoryVisibilityCommand,
} from "./memory-visibility.ts";
import { MEMORY_TYPE_ORDER } from "./memory-kind-policy.ts";

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
type DialogAlertComponent = (props: { title: string; message: string; onConfirm?: () => void }) => DialogElement;
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

type TuiRouteCurrent =
  | { name: "home" }
  | { name: "session"; params: { sessionID: string; prompt?: unknown } }
  | { name: string; params?: Record<string, unknown> };

type TuiPluginApi = {
  command: {
    register: (cb: () => TuiCommand[]) => () => void;
  };
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

type TuiPlugin = (api: TuiPluginApi, options: unknown, meta: unknown) => Promise<void>;

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

function showMemoryMenu(api: TuiPluginApi, dialog?: DialogContext): void {
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

function memoryCommands(api: TuiPluginApi): TuiCommand[] {
  return [
    {
      title: "Memory",
      value: "memory.menu",
      description: "Browse local working memory.",
      category: "Memory",
      slash: { name: "memory" },
      onSelect: (dialog?: DialogContext) => showMemoryMenu(api, dialog),
    },
  ];
}

export const MemoryTuiPlugin: TuiPlugin = async (api) => {
  api.command.register(() => memoryCommands(api));
};

export default {
  id: "working-memory-tui",
  tui: MemoryTuiPlugin,
};
