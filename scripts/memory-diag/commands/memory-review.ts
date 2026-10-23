import { readFile } from "node:fs/promises";
import { captureMemoryReviewProposalText } from "../../../src/memory-review.ts";
import type { CliOptions, CommandResult } from "../types.ts";

export async function runMemoryReview(options: CliOptions): Promise<CommandResult> {
  const [subcommand, proposalPath] = options.positional ?? [];
  if (subcommand !== "import" || !proposalPath) {
    return { stdout: "", stderr: "memory-review supports only: import <proposal-json-file>", exitCode: 1 };
  }

  const root = options.workspace ?? process.cwd();
  let text: string;
  try {
    text = await readFile(proposalPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      stdout: "",
      stderr: `Unable to read memory-review import file ${proposalPath}: ${detail}`,
      exitCode: 1,
    };
  }
  const result = await captureMemoryReviewProposalText(root, text, { source: "cli_import" });

  if (result.status === "captured") {
    return { stdout: `memory-review captured ${result.proposalSetId} for snapshot ${result.snapshotId}` };
  }

  return {
    stdout: `memory-review ${result.status}: ${result.reasonCodes.join(", ") || "no proposal captured"}`,
    exitCode: result.status === "rejected" ? 1 : 0,
  };
}
