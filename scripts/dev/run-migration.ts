/**
 * Local helper to trigger migration on workspace roots.
 *
 * Usage:
 *   MIGRATION_RUN_ROOTS=/path/a:/path/b bun run scripts/dev/run-migration.ts
 *
 * Or create a local file (gitignored):
 *   echo "/path/to/workspace1" > scripts/dev/run-migration-roots.local.txt
 *   echo "/path/to/workspace2" >> scripts/dev/run-migration-roots.local.txt
 *   bun run scripts/dev/run-migration.ts
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadWorkspaceMemory } from "../../src/workspace-memory.ts";

async function getRoots(): Promise<string[]> {
  // Priority 1: environment variable
  const envRoots = process.env.MIGRATION_RUN_ROOTS;
  if (envRoots) {
    return envRoots.split(":").filter(root => root.length > 0);
  }

  // Priority 2: local file
  const localFile = join(import.meta.dirname, "run-migration-roots.local.txt");
  if (existsSync(localFile)) {
    const content = await readFile(localFile, "utf8");
    return content.trim().split("\n").filter(root => root.length > 0);
  }

  // No roots configured
  console.log("No workspace roots configured.");
  console.log("Set MIGRATION_RUN_ROOTS=/path/a:/path/b or create run-migration-roots.local.txt");
  return [];
}

const roots = await getRoots();

if (roots.length === 0) {
  process.exit(0);
}

for (const root of roots) {
  console.log(`Loading workspace memory: ${root}`);
  const store = await loadWorkspaceMemory(root);
  const active = store.entries.filter(entry => entry.status !== "superseded").length;
  const superseded = store.entries.filter(entry => entry.status === "superseded").length;
  console.log(`  active=${active} superseded=${superseded} migrations=${(store.migrations ?? []).join(",")}`);
}
