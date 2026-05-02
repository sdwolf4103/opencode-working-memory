import { join } from "node:path";
import { workspaceKey, workspaceMemoryPath, workspacePendingJournalPath } from "../../../src/paths.ts";
import { scanWorkspaceResidues } from "../../../src/workspace-cleanup.ts";
import type { PendingMemoryJournalStore, WorkspaceMemoryStore } from "../../../src/types.ts";
import { formatWorkspaceHealth, type WorkspaceHealthInput } from "../formatters/health.ts";
import { pathExists, readJSONFile } from "../io.ts";
import { buildMemoryDiagJSON } from "../workspace-snapshot.ts";
import type { CliOptions, CommandResult } from "../types.ts";

type WorkspaceHealthCommandInput = Omit<WorkspaceHealthInput, "now">;

async function workspaceHealthOutput(input: WorkspaceHealthCommandInput): Promise<string> {
  return formatWorkspaceHealth({ ...input, now: Date.now() }, {
    rawStore: await readJSONFile<WorkspaceMemoryStore>(input.memoryPath),
    rawJournal: await readJSONFile<PendingMemoryJournalStore>(input.pendingPath),
    pendingExists: pathExists(input.pendingPath),
  });
}

export async function runHealth(options: CliOptions): Promise<CommandResult> {
  if (options.json) {
    const root = options.workspace ?? process.cwd();
    return { stdout: JSON.stringify(await buildMemoryDiagJSON(root), null, 2) };
  }

  if (options.all) {
    const scan = await scanWorkspaceResidues({ includeOrphans: true, minAgeMs: 0 });
    const lines: string[] = ["Workspace memory health", ""];
    if (scan.results.length === 0) {
      lines.push("No workspace stores found.");
      return { stdout: lines.join("\n") };
    }
    for (let i = 0; i < scan.results.length; i += 1) {
      const result = scan.results[i];
      if (i > 0) lines.push("");
      lines.push(await workspaceHealthOutput({
        root: result.root,
        key: result.workspaceKey,
        memoryPath: join(result.workspaceDir, "workspace-memory.json"),
        pendingPath: join(result.workspaceDir, "workspace-pending-journal.json"),
        raw: options.raw,
      }));
    }
    return { stdout: lines.join("\n") };
  }

  const root = options.workspace ?? process.cwd();
  const key = await workspaceKey(root);
  return {
    stdout: await workspaceHealthOutput({
      root,
      key,
      memoryPath: await workspaceMemoryPath(root),
      pendingPath: await workspacePendingJournalPath(root),
      raw: options.raw,
      includeTitle: true,
    }),
  };
}
