import { runAudit } from "./commands/audit.ts";
import { runCommands } from "./commands/commands.ts";
import { runCoverage } from "./commands/coverage.ts";
import { runExplain } from "./commands/explain.ts";
import { runMissing } from "./commands/missing.ts";
import { runRejected } from "./commands/rejected.ts";
import { runRevert } from "./commands/revert.ts";
import { runStatus } from "./commands/status.ts";
import type { CliOptions, Command, CommandResult } from "./types.ts";

export async function dispatch(command: Command, options: CliOptions): Promise<CommandResult> {
  switch (command) {
    case "status": return runStatus(options);
    case "rejected": return runRejected(options);
    case "missing": return runMissing(options);
    case "coverage": return runCoverage(options);
    case "audit": return runAudit(options);
    case "explain": return runExplain(options);
    case "commands": return runCommands(options);
    case "revert": return runRevert(options);
  }
}
