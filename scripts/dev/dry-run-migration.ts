import { loadWorkspaceMemory } from "../../src/workspace-memory.ts";

const roots = [
  "/Users/sd_wo/work/opencode-working-memory",
  "/Users/sd_wo/Documents/projects/Pre-cancer-atlas",
  "/Users/sd_wo/work/opencode-record",
  "/Users/sd_wo/work/pathology-agent-reports",
  "/Users/sd_wo/work/pathology-extraction",
];

for (const root of roots) {
  console.log(`Loading workspace memory: ${root}`);
  const store = await loadWorkspaceMemory(root);
  const active = store.entries.filter(entry => entry.status !== "superseded").length;
  const superseded = store.entries.filter(entry => entry.status === "superseded").length;
  console.log(`  active=${active} superseded=${superseded} migrations=${(store.migrations ?? []).join(",")}`);
}
