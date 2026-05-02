import { formatExplain } from "../formatters/explain.ts";
import { snapshotForOptions } from "../workspace-snapshot.ts";
import type { CliOptions, CommandResult } from "../types.ts";
import { runTrace } from "./trace.ts";

export async function runExplain(options: CliOptions): Promise<CommandResult> {
  if (options.memory) return runTrace(options);

  const snapshot = await snapshotForOptions(options);
  return { stdout: formatExplain(snapshot) };
}
