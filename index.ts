import type { PluginModule } from "@opencode-ai/plugin";
import { MemoryV2Plugin } from "./src/plugin.ts";

const plugin: PluginModule = {
  id: "working-memory",
  server: MemoryV2Plugin,
};

export default plugin;