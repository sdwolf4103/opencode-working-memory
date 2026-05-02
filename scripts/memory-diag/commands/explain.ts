import { traceMemoryLifecycle } from "../../../src/evidence-log.ts";
import { formatExplain } from "../formatters/explain.ts";
import { formatTrace } from "../formatters/trace.ts";
import { snapshotForOptions } from "../workspace-snapshot.ts";
import type { CliOptions, CommandResult } from "../types.ts";

export async function runExplain(options: CliOptions): Promise<CommandResult> {
  if (options.memory) {
    const root = options.workspace ?? process.cwd();
    const [snapshot, trace] = await Promise.all([
      snapshotForOptions(options),
      traceMemoryLifecycle(root, { memoryId: options.memory }),
    ]);
    return { stdout: formatTrace(options.memory, snapshot, trace) };
  }

  const snapshot = await snapshotForOptions(options);
  return { stdout: formatExplain(snapshot) };
}
