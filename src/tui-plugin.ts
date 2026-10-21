/**
 * TUI entrypoint.
 *
 * Exports both shapes from one package:
 * - V2 calls `setup(context)` and registers a keymap/slash command.
 * - V1 calls `tui(api)` and registers through the legacy command API.
 */

import {
  formatMemoryHelp,
  formatMemoryList,
  getMemoryList,
  renderMemoryCommand,
} from "./memory-visibility.ts";
import { MEMORY_TYPE_ORDER } from "./memory-kind-policy.ts";
import { MemoryTuiPlugin as MemoryTuiPluginV1 } from "./tui-plugin-v1.ts";

/**
 * Local identity helper. Importing `@opencode/plugin/tui` pulls in OpenTUI
 * peers at module load time, which a server-only install does not need.
 */
function defineTuiPlugin<T extends { id: string; setup: (context: TuiContext) => unknown }>(plugin: T): T {
  return plugin;
}

type TuiRoute =
  | { type: "home" }
  | { type: "session"; sessionID: string }
  | { type: string; sessionID?: string };

type TuiContext = {
  location?: { directory: string };
  data: { location: { default(): { directory: string } } };
  ui: {
    router: { current(): TuiRoute };
    toast: { show(input: { variant?: string; message: string }): void };
    dialog: {
      alert(input: { title: string; message: string }): Promise<void>;
      select<Value>(input: {
        title: string;
        placeholder?: string;
        options: Array<{ title: string; value: Value; description?: string; category?: string; footer?: string }>;
      }): Promise<Value | undefined>;
    };
  };
  keymap: {
    layer(factory: () => {
      mode?: string;
      priority?: number;
      commands: Array<{
        id: string;
        title?: string;
        description?: string;
        group?: string;
        palette?: true;
        slash?: { name: string; aliases?: string[]; arguments?: true };
        run: () => void | Promise<void>;
      }>;
    }): void;
  };
};

function currentSessionID(ctx: TuiContext): string | undefined {
  const route = ctx.ui.router.current();
  return route.type === "session" ? route.sessionID : undefined;
}

function currentDirectory(ctx: TuiContext): string {
  return ctx.location?.directory ?? ctx.data.location.default().directory;
}

function splitMarkdownHeading(text: string, fallbackTitle: string): { title: string; message: string } {
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

function errorReport(error: unknown): string {
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

async function showStatus(ctx: TuiContext): Promise<void> {
  const sessionID = currentSessionID(ctx);
  if (!sessionID) {
    ctx.ui.toast.show({ variant: "warning", message: "Open a session to use memory commands." });
    return;
  }

  try {
    const text = await renderMemoryCommand(currentDirectory(ctx), sessionID, "status");
    const { title, message } = splitMarkdownHeading(text, "Memory status");
    await ctx.ui.dialog.alert({ title, message });
  } catch (error) {
    const { title, message } = splitMarkdownHeading(errorReport(error), "Memory error");
    await ctx.ui.dialog.alert({ title, message });
  }
}

async function showHelp(ctx: TuiContext): Promise<void> {
  const { title, message } = splitMarkdownHeading(formatMemoryHelp(), "Memory help");
  await ctx.ui.dialog.alert({ title, message });
}

async function showList(ctx: TuiContext): Promise<void> {
  try {
    const model = await getMemoryList(currentDirectory(ctx));
    if (model.renderedMemories === 0) {
      const { title, message } = splitMarkdownHeading(formatMemoryList(model), "Current workspace memories");
      await ctx.ui.dialog.alert({ title, message });
      return;
    }

    const options = MEMORY_TYPE_ORDER.flatMap(type =>
      model.groups[type].map(item => ({
        title: `[${item.ref}] ${item.text}`,
        value: item.ref,
        category: type,
        footer: "display-local",
      })),
    );

    await ctx.ui.dialog.select({
      title: "Current workspace memories",
      placeholder: "Search memory refs",
      options,
    });
  } catch (error) {
    const { title, message } = splitMarkdownHeading(errorReport(error), "Memory error");
    await ctx.ui.dialog.alert({ title, message });
  }
}

async function showMemoryMenu(ctx: TuiContext): Promise<void> {
  const choice = await ctx.ui.dialog.select<string>({
    title: "Memory",
    placeholder: "Search memory actions",
    options: [
      { title: "Status", value: "status", description: "Show local memory statistics" },
      { title: "Current memories", value: "list", description: "Browse active workspace memories" },
      { title: "Help", value: "help", description: "Show memory command help" },
    ],
  });

  if (choice === "status") await showStatus(ctx);
  else if (choice === "list") await showList(ctx);
  else if (choice === "help") await showHelp(ctx);
}

export { MemoryTuiPluginV1 as MemoryTuiPlugin };

export const MemoryTuiPluginV2 = defineTuiPlugin({
  id: "working-memory-tui",

  setup(ctx: TuiContext) {
    ctx.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "working-memory.memory",
          title: "Memory",
          description: "Browse local working memory.",
          group: "Memory",
          palette: true,
          slash: { name: "memory" },
          run: () => showMemoryMenu(ctx),
        },
      ],
    }));
  },
});

export default {
  ...MemoryTuiPluginV2,
  tui: MemoryTuiPluginV1,
};
