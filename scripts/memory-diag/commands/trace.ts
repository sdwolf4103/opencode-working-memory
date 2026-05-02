import { traceMemoryLifecycle } from "../../../src/evidence-log.ts";
import { formatTrace } from "../formatters/trace.ts";
import { snapshotForOptions } from "../workspace-snapshot.ts";
import type { CliOptions, CommandResult } from "../types.ts";

export async function runTrace(options: CliOptions): Promise<CommandResult> {
  const root = options.workspace ?? process.cwd();
  const memoryId = options.memory;
  if (!memoryId) return { stdout: "", stderr: "--memory requires an id", exitCode: 1 };

  const [snapshot, trace] = await Promise.all([
    snapshotForOptions(options),
    traceMemoryLifecycle(root, { memoryId }),
  ]);
  return { stdout: formatTrace(memoryId, snapshot, trace) };
}
