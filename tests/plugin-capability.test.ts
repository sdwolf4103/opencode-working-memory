/**
 * Plugin capability test.
 *
 * This is the loud alarm for OpenCode plugin API compatibility.
 * It fails tests, not user runtime.
 *
 * If any required hook key disappears from MemoryV2Plugin output,
 * this test will catch it before release.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { MemoryV2Plugin } from "../src/plugin.ts";

const REQUIRED_PLUGIN_HOOKS = [
  "experimental.chat.system.transform",
  "tool.execute.after",
  "experimental.session.compacting",
  "event",
] as const;

describe("plugin capability", () => {
  it("MemoryV2Plugin has all required hooks", async () => {
    // Create minimal mock client
    const mockClient = {
      session: {
        get: async () => ({ data: { parentID: null } }),
      },
    };

    // Create minimal mock input
    const mockInput = {
      directory: "/tmp/test-workspace",
      client: mockClient,
    };

    // Instantiate plugin
    const plugin = await MemoryV2Plugin(mockInput);

    // Assert all required hooks exist and are functions
    for (const hook of REQUIRED_PLUGIN_HOOKS) {
      assert(
        hook in plugin,
        `Missing required hook: ${hook}`
      );
      assert(
        typeof plugin[hook] === "function",
        `Hook ${hook} is not a function`
      );
    }
  });

  it("MemoryV2Plugin returns exactly the expected hook keys", async () => {
    const mockClient = {
      session: {
        get: async () => ({ data: { parentID: null } }),
      },
    };

    const mockInput = {
      directory: "/tmp/test-workspace",
      client: mockClient,
    };

    const plugin = await MemoryV2Plugin(mockInput);
    const keys = Object.keys(plugin).sort();
    const expected = [...REQUIRED_PLUGIN_HOOKS].sort();

    assert.deepStrictEqual(
      keys,
      expected,
      `Plugin returned unexpected keys: ${keys.join(", ")}`
    );
  });
});