import { renderMemoryCommand, type MemoryVisibilityCommand } from "./memory-visibility.ts";

type DialogContext = {
  clear?: () => void;
};

type TextPartInput = {
  type: "text";
  text: string;
};

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
    toast: (input: { variant?: "info" | "success" | "warning" | "error"; message: string }) => void;
    dialog?: DialogContext;
  };
  state: {
    path: {
      directory: string;
    };
  };
  client: {
    session: {
      prompt: (parameters: { sessionID: string; noReply?: boolean; parts?: TextPartInput[] }) => Promise<unknown> | unknown;
    };
  };
};

type TuiPlugin = (api: TuiPluginApi, options: unknown, meta: unknown) => Promise<void>;

function currentRoute(api: TuiPluginApi): TuiRouteCurrent {
  const route = api.route as ({ readonly current?: TuiRouteCurrent } & Partial<TuiRouteCurrent>);
  return route.current ?? (route as TuiRouteCurrent);
}

function commandFromValue(value: string): MemoryVisibilityCommand {
  if (value === "memory.status") return "status";
  if (value === "memory.list") return "list";
  if (value === "memory.help") return "help";
  return "help";
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

async function injectMemoryOutput(api: TuiPluginApi, value: string, dialog?: DialogContext): Promise<void> {
  const route = currentRoute(api);

  if (route.name !== "session" || typeof route.params?.sessionID !== "string") {
    api.ui.toast({
      variant: "warning",
      message: "Open a session to use memory commands.",
    });
    return;
  }

  const sessionID = route.params.sessionID;
  let text: string;

  try {
    text = await renderMemoryCommand(api.state.path.directory, sessionID, commandFromValue(value));
  } catch (error) {
    text = renderErrorReport(error);
  }

  try {
    await api.client.session.prompt({
      sessionID,
      noReply: true,
      parts: [{ type: "text", text }],
    });
    dialog?.clear?.();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    api.ui.toast({
      variant: "error",
      message: `Unable to inject memory text: ${detail}`,
    });
  }
}

function memoryCommands(api: TuiPluginApi): TuiCommand[] {
  return [
    {
      title: "Memory status",
      value: "memory.status",
      description: "Show working memory statistics in the current session.",
      category: "Memory",
      slash: { name: "memory-status" },
      onSelect: (dialog?: DialogContext) => injectMemoryOutput(api, "memory.status", dialog),
    },
    {
      title: "Memory list",
      value: "memory.list",
      description: "Show current workspace memories with display-local refs.",
      category: "Memory",
      slash: { name: "memory-list" },
      onSelect: (dialog?: DialogContext) => injectMemoryOutput(api, "memory.list", dialog),
    },
    {
      title: "Memory help",
      value: "memory.help",
      description: "Show working memory help.",
      category: "Memory",
      slash: { name: "memory-help" },
      onSelect: (dialog?: DialogContext) => injectMemoryOutput(api, "memory.help", dialog),
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
