import { MemoryTuiPlugin } from "./src/tui-plugin.ts";
import { MemoryTuiPluginV2 } from "./src/tui-v2.ts";

export default {
  id: "working-memory-tui",
  tui: MemoryTuiPlugin,
  setup: MemoryTuiPluginV2.setup,
};
