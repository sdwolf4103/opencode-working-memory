import { runAudit } from "./commands/audit.ts";
import { runCoverage } from "./commands/coverage.ts";
import { runDisappearances } from "./commands/disappearances.ts";
import { runExplain } from "./commands/explain.ts";
import { runHealth } from "./commands/health.ts";
import { runMissing } from "./commands/missing.ts";
import { runQuality } from "./commands/quality.ts";
import { runRejected } from "./commands/rejected.ts";
import { runRejections } from "./commands/rejections.ts";
import { runStatus } from "./commands/status.ts";
import { runTrace } from "./commands/trace.ts";
import type { CliOptions, Command, CommandResult } from "./types.ts";

export async function dispatch(command: Command, options: CliOptions): Promise<CommandResult> {
  if (options.legacyCommand === "health") return runHealth(options);
  if (options.legacyCommand === "quality") return runQuality(options);
  if (options.legacyCommand === "rejections") return runRejections(options);
  if (options.legacyCommand === "disappearances") return runDisappearances(options);
  if (options.legacyCommand === "trace") return runTrace(options);

  switch (command) {
    case "status": return runStatus(options);
    case "rejected": return runRejected(options);
    case "missing": return runMissing(options);
    case "coverage": return runCoverage(options);
    case "audit": return runAudit(options);
    case "explain": return runExplain(options);
  }
}
