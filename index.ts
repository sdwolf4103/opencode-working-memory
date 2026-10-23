import { MemoryV2Plugin } from "./src/plugin.ts";
import { MemoryServerPluginV2 } from "./src/plugin-v2.ts";

export default {
  id: "working-memory",
  server: MemoryV2Plugin,
  setup: MemoryServerPluginV2.setup,
};