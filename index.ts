import { WorkingMemoryPlugin } from "./src/plugin-v2.ts";
import { MemoryV2Plugin } from "./src/plugin.ts";

/**
 * Dual entrypoint:
 * - OpenCode V2 calls `setup(ctx)`.
 * - OpenCode V1 (>= 1.18.29) calls `server(input, options)`.
 * - Older V1 releases can import the `./server` export directly.
 */
export default {
  ...WorkingMemoryPlugin,
  server: MemoryV2Plugin,
};
