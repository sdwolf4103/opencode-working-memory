import { HIDDEN_COMMAND_NOTICES, isCommand } from "./command-metadata.ts";
import type { CliOptions, Command, ParsedArgs } from "./types.ts";

export type { ParsedArgs } from "./types.ts";

export function usage(): string {
  return `Usage:
  memory-diag [status] [--workspace <path>] [--verbose] [--json]
  memory-diag rejected [--workspace <path>] [--verbose] [--json]
  memory-diag missing [--workspace <path>] [--verbose] [--json]
  memory-diag explain [memory-id] [--workspace <path>] [--raw]
  memory-diag commands [--workspace <path>] [--verbose] [--json] [--memory <id>]
  memory-diag quality [--workspace <path>] [--verbose] [--json] [--raw] [--no-emoji]
  memory-diag revert (--memory <replacement-id> | --event <event-id>) [--workspace <path>] [--apply]

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
  let deprecationNotice: string | undefined;
  let rest = argv;
  if (first && !first.startsWith("--")) {
    rest = tail;
    if (isCommand(first)) {
      command = first;
      deprecationNotice = HIDDEN_COMMAND_NOTICES[first];
    } else {
      return error(`Unknown subcommand: ${first}`);
    }
  }

  const options: CliOptions = { raw: false, positional: [] };
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
    else if (arg === "--explain") options.explain = true;
    else if (arg === "--apply") options.apply = true;
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
    } else if (arg === "--event") {
      const value = rest[++i];
      if (!value) return error("--event requires an id");
      options.event = value;
    } else if (!arg.startsWith("--") && command === "explain") {
      options.positional?.push(arg);
    } else {
      return error(`Unknown option: ${arg}`);
    }
  }

  if (command === "explain") {
    const positional = options.positional ?? [];
    if (positional.length > 1) return error("explain accepts at most one memory id");
    if (positional.length === 1 && options.memory) return error("Use either explain <memory-id> or --memory, not both");
    if (positional.length === 1) options.memory = positional[0];
  } else if ((options.positional ?? []).length > 0) {
    return error(`Unknown option: ${options.positional?.[0]}`);
  }

  if (command === "status") {
    if (options.all) return error(`${command} does not accept --all`);
  } else if (command === "rejected" || command === "missing" || command === "coverage" || command === "explain" || command === "commands" || command === "quality" || command === "revert") {
    if (options.all) return error(`${command} does not accept --all`);
  } else {
    if (options.all || options.workspace) return error(`${command} does not accept --all or --workspace`);
  }
  if (options.json && command !== "status" && command !== "rejected" && command !== "missing" && command !== "coverage" && command !== "commands" && command !== "quality") {
    return error(`${command} does not accept --json`);
  }
  if (command !== "rejected" && (options.softOnly || options.triggerOnly || options.since)) {
    return error(`${command} does not accept rejection filters`);
  }
  if (command !== "coverage" && options.includeHistorical) return error(`${command} does not accept --include-historical`);
  if (command !== "rejected" && options.reason) return error(`${command} does not accept rejection filters`);
  if (command !== "missing" && options.explain) return error(`${command} does not accept --explain`);
  if (command !== "audit" && options.migration) {
    return error(`${command} does not accept --migration`);
  }
  if (command !== "explain" && command !== "revert" && command !== "commands" && options.memory) {
    return error(`${command} does not accept --memory`);
  }
  if (command !== "revert" && options.event) return error(`${command} does not accept --event`);
  if (command !== "revert" && options.apply) return error(`${command} does not accept --apply`);
  if (command === "revert") {
    if (!options.memory && !options.event) return error("revert requires --memory or --event");
    if (options.memory && options.event) return error("Use either --memory or --event, not both");
  }
  if (command === "rejected" && options.since && !isValidSince(options.since)) {
    return error(`Invalid --since value: ${options.since}`);
  }

  return { ok: true, command, options, deprecationNotice };
}
