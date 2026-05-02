import type { CliOptions, Command, LegacyCommand, ParsedArgs } from "./types.ts";

export type { ParsedArgs } from "./types.ts";

export function usage(): string {
  return `Usage:
  memory-diag [status] [--workspace <path>] [--verbose] [--json]
  memory-diag rejected [--workspace <path>] [--verbose] [--json]
  memory-diag missing [--workspace <path>] [--verbose] [--json]
  memory-diag explain [memory-id] [--workspace <path>] [--raw]

Global options:
  --workspace <path>  Workspace path (default: current directory)
  --verbose           Show detailed diagnostics
  --json              Print machine-readable JSON where supported
  --no-emoji          Disable emoji in human output
`;
}

function error(message: string): ParsedArgs {
  return { ok: false, message, usage: usage(), exitCode: 1 };
}

function isCommand(value: string | undefined): value is Command {
  return value === "status"
    || value === "rejected"
    || value === "missing"
    || value === "explain"
    || value === "coverage"
    || value === "audit";
}

function isLegacyCommand(value: string | undefined): value is LegacyCommand {
  return value === "health"
    || value === "quality"
    || value === "rejections"
    || value === "disappearances"
    || value === "trace";
}

function isValidSince(rawSince: string): boolean {
  if (/^(\d+)([dhm])$/i.test(rawSince)) return true;
  return !Number.isNaN(new Date(rawSince).getTime());
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [first, ...tail] = argv;
  if (first === "--help" || first === "-h") {
    return { ok: true, help: true, usage: usage() };
  }

  let command: Command = "status";
  let legacyCommand: LegacyCommand | undefined;
  let deprecationNotice: string | undefined;
  let rest = argv;
  if (first && !first.startsWith("--")) {
    rest = tail;
    if (isCommand(first)) {
      command = first;
      if (first === "coverage") {
        deprecationNotice = "Note: 'coverage' is now a maintainer-only diagnostic. This alias will be removed in v2.0 unless replaced by 'audit evidence'.";
      } else if (first === "audit") {
        deprecationNotice = "Note: 'audit' is now a maintainer-only diagnostic. This alias will be removed in v2.0 unless replaced by 'audit migrations'.";
      }
    } else if (isLegacyCommand(first)) {
      legacyCommand = first;
      if (first === "health") {
        command = "status";
        deprecationNotice = "Note: 'health' is now 'status'. This alias will be removed in v2.0.";
      } else if (first === "quality") {
        command = "status";
        deprecationNotice = "Note: 'quality' is now 'status --verbose'. This alias will be removed in v2.0.";
      } else if (first === "rejections") {
        command = "rejected";
        deprecationNotice = "Note: 'rejections' is now 'rejected'. This alias will be removed in v2.0.";
      } else if (first === "disappearances") {
        command = "missing";
        deprecationNotice = "Note: 'disappearances' is now 'missing'. This alias will be removed in v2.0.";
      } else {
        command = "explain";
        deprecationNotice = "Note: 'trace --memory <id>' is now 'explain <memory-id>'. This alias will be removed in v2.0.";
      }
    } else {
      return error(`Unknown subcommand: ${first}`);
    }
  }

  const options: CliOptions = { raw: false, positional: [] };
  if (legacyCommand) options.legacyCommand = legacyCommand;
  if (legacyCommand === "quality") options.verbose = true;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--raw") options.raw = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--no-emoji") options.noEmoji = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--soft-only") options.softOnly = true;
    else if (arg === "--trigger-only") options.triggerOnly = true;
    else if (arg === "--include-historical") options.includeHistorical = true;
    else if (arg === "--quality") options.quality = true;
    else if (arg === "--unique") options.unique = true;
    else if (arg === "--explain") options.explain = true;
    else if (arg === "--workspace") {
      const value = rest[++i];
      if (!value) return error("--workspace requires a path");
      options.workspace = value;
    } else if (arg === "--since") {
      const value = rest[++i];
      if (!value) return error("--since requires a duration or ISO timestamp");
      options.since = value;
    } else if (arg === "--reason") {
      const value = rest[++i];
      if (!value) return error("--reason requires a reason code");
      options.reason = value;
    } else if (arg === "--migration") {
      const value = rest[++i];
      if (!value) return error("--migration requires an id");
      options.migration = value;
    } else if (arg === "--memory") {
      const value = rest[++i];
      if (!value) return error("--memory requires an id");
      options.memory = value;
    } else if (!arg.startsWith("--") && command === "explain" && legacyCommand !== "trace") {
      options.positional?.push(arg);
    } else {
      return error(`Unknown option: ${arg}`);
    }
  }

  const displayCommand = legacyCommand ?? command;
  if (command === "explain") {
    const positional = options.positional ?? [];
    if (positional.length > 1) return error("explain accepts at most one memory id");
    if (positional.length === 1 && options.memory) return error("Use either explain <memory-id> or --memory, not both");
    if (positional.length === 1) options.memory = positional[0];
  } else if ((options.positional ?? []).length > 0) {
    return error(`Unknown option: ${options.positional?.[0]}`);
  }

  if (legacyCommand === "health") {
    if (options.all && options.workspace) return error("Use either --all or --workspace, not both");
    if (options.json && options.all) return error("health --json does not support --all");
  } else if (command === "status") {
    if (options.all) return error(`${displayCommand} does not accept --all`);
  } else if (command === "rejected" || command === "missing" || command === "coverage" || command === "explain") {
    if (options.all) return error(`${displayCommand} does not accept --all`);
  } else {
    if (options.all || options.workspace) return error(`${displayCommand} does not accept --all or --workspace`);
  }
  if (options.json && command !== "status" && command !== "rejected" && command !== "missing" && command !== "coverage") {
    return error(`${displayCommand} does not accept --json`);
  }
  if (legacyCommand === "rejections" && options.json && !options.quality) return error("rejections --json requires --quality");
  if (command !== "rejected" && (options.softOnly || options.triggerOnly || options.since)) {
    return error(`${displayCommand} does not accept rejection filters`);
  }
  if (command !== "coverage" && options.includeHistorical) return error(`${displayCommand} does not accept --include-historical`);
  if (command !== "rejected" && (options.quality || options.reason || options.unique)) return error(`${displayCommand} does not accept rejection quality filters`);
  if (command !== "missing" && options.explain) return error(`${displayCommand} does not accept --explain`);
  if (command !== "audit" && options.migration) {
    return error(`${displayCommand} does not accept --migration`);
  }
  if (legacyCommand === "trace" && !options.memory) {
    return error("--memory requires an id");
  }
  if (command !== "explain" && options.memory) {
    return error(`${displayCommand} does not accept --memory`);
  }
  if (command === "rejected" && options.since && !isValidSince(options.since)) {
    return error(`Invalid --since value: ${options.since}`);
  }

  return { ok: true, command, options, deprecationNotice };
}
