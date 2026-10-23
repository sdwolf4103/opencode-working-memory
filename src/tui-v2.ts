import type { Plugin } from "@opencode/plugin/tui";
import { MemoryTuiPlugin } from "./tui-plugin.ts";

type Context = Plugin.Context;
type LegacyDialogElement =
  | { type: "DialogAlert"; props: { title: string; message: string; onConfirm?: () => void | Promise<void> } }
  | {
      type: "DialogSelect";
      props: {
        title: string;
        placeholder?: string;
        options: Array<{
          title: string;
          value: string;
          description?: string;
          footer?: string;
          category?: string;
          disabled?: boolean;
          onSelect?: () => void | Promise<void>;
        }>;
      };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCallback(value: unknown): value is () => void | Promise<void> {
  return typeof value === "function";
}

function legacyDialogElement(value: unknown): LegacyDialogElement | undefined {
  if (!isRecord(value) || !isRecord(value.props)) return undefined;
  const props = value.props;
  if (value.type === "DialogAlert" && typeof props.title === "string" && typeof props.message === "string") {
    return {
      type: "DialogAlert",
      props: {
        title: props.title,
        message: props.message,
        onConfirm: isCallback(props.onConfirm) ? props.onConfirm : undefined,
      },
    };
  }
  if (value.type !== "DialogSelect" || typeof props.title !== "string" || !Array.isArray(props.options)) return undefined;
  const options = props.options.flatMap(option => {
    if (!isRecord(option) || typeof option.title !== "string" || typeof option.value !== "string") return [];
    return [{
      title: option.title,
      value: option.value,
      description: typeof option.description === "string" ? option.description : undefined,
      footer: typeof option.footer === "string" ? option.footer : undefined,
      category: typeof option.category === "string" ? option.category : undefined,
      disabled: typeof option.disabled === "boolean" ? option.disabled : undefined,
      onSelect: isCallback(option.onSelect) ? option.onSelect : undefined,
    }];
  });
  return {
    type: "DialogSelect",
    props: {
      title: props.title,
      placeholder: typeof props.placeholder === "string" ? props.placeholder : undefined,
      options,
    },
  };
}

function locationDirectory(context: Context): string | undefined {
  const route = context.ui.router.current();
  if (route.type === "session") {
    const directory = context.data.session.get(route.sessionID)?.location.directory;
    return typeof directory === "string" && directory.length > 0 ? directory : undefined;
  }
  const directory = context.location?.directory ?? context.data.location.default().directory;
  return typeof directory === "string" && directory.length > 0 ? directory : undefined;
}

async function bridgeContext(context: Context): Promise<() => void> {
  let generation = 0;
  let size: "medium" | "large" | "xlarge" = "medium";
  let disposed = false;
  let ownsDialog = false;
  let unregister = () => {};

  const toast = (input: { variant?: "info" | "success" | "warning" | "error"; message: string }): void => {
    context.ui.toast.show(input);
  };

  const showBridgeError = (error: unknown): void => {
    toast({ variant: "error", message: `Unable to show memory dialog: ${error instanceof Error ? error.message : String(error)}` });
  };

  const replaceDialog = (render: () => unknown): void => {
    const token = ++generation;
    if (disposed) return;
    const element = legacyDialogElement(render());
    if (!element) {
      showBridgeError(new Error("Unsupported memory dialog content."));
      return;
    }
    const isCurrent = (): boolean => !disposed && generation === token;
    const settled = (): void => {
      if (isCurrent()) ownsDialog = false;
    };

    try {
      if (element.type === "DialogAlert") {
        const { title, message, onConfirm } = element.props;
        const pending = onConfirm
          ? context.ui.dialog.confirm({ title, message }).then(confirmed => {
              if (confirmed && isCurrent()) return onConfirm();
            })
          : context.ui.dialog.alert({ title, message });
        ownsDialog = true;
        context.ui.dialog.set({ size });
        void pending.then(settled, error => {
          if (isCurrent()) showBridgeError(error);
          settled();
        });
        return;
      }

      const pending = context.ui.dialog.select({
        title: element.props.title,
        placeholder: element.props.placeholder,
        options: element.props.options.map(({ title, value, description, footer, category, disabled }) => ({
          title, value, description, footer, category, disabled,
        })),
      }).then(async value => {
        if (value === undefined || !isCurrent()) return;
        const selected = element.props.options.find(option => option.value === value);
        if (selected?.onSelect) await selected.onSelect();
      });
      ownsDialog = true;
      context.ui.dialog.set({ size });
      void pending.then(settled, error => {
        if (isCurrent()) showBridgeError(error);
        settled();
      });
    } catch (error) {
      ownsDialog = false;
      if (isCurrent()) showBridgeError(error);
    }
  };

  const api: Parameters<typeof MemoryTuiPlugin>[0] = {
    command: { register: () => () => {} },
    route: {
      get current() {
        const current = context.ui.router.current();
        return current.type === "session"
          ? { name: "session", params: { sessionID: current.sessionID } }
          : { name: current.type };
      },
    },
    ui: {
      toast,
      DialogAlert: props => ({ type: "DialogAlert", props }),
      DialogSelect: props => ({ type: "DialogSelect", props }),
      dialog: {
        clear: () => {
          generation++;
          if (ownsDialog) context.ui.dialog.clear();
          ownsDialog = false;
        },
        replace: replaceDialog,
        setSize: next => {
          size = next;
          if (ownsDialog) context.ui.dialog.set({ size });
        },
      },
    },
    state: { path: {
      get directory(): string {
        const current = locationDirectory(context);
        if (!current) throw new Error("Workspace location is unavailable for the current session.");
        return current;
      },
    } },
    client: {
      session: {
        prompt: async input => {
          await context.client.session.prompt({ sessionID: input.sessionID, text: input.parts.map(part => part.text).join("\n") });
        },
      },
    },
    keymap: {
      registerLayer: layer => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: layer.commands.map(command => ({
            id: command.name,
            title: command.title,
            description: command.desc,
            group: command.category,
            palette: true,
            slash: command.slashName ? { name: command.slashName, aliases: command.slashAliases } : undefined,
            suggested: command.suggested,
            run: () => disposed ? undefined : command.run(),
          })),
        }));
        return () => {};
      },
    },
  };

  unregister = await MemoryTuiPlugin(api, undefined, undefined);
  return () => {
    if (disposed) return;
    disposed = true;
    generation++;
    unregister();
    if (ownsDialog) context.ui.dialog.clear();
    ownsDialog = false;
  };
}

export const MemoryTuiPluginV2 = {
  id: "working-memory-tui",
  async setup(context: Context): Promise<() => void> {
    // Session data arrives after plugin activation. Resolve the workspace when
    // a command runs so startup and subsequent navigation use current data.
    return bridgeContext(context);
  },
} satisfies Plugin.Definition;

export default MemoryTuiPluginV2;
