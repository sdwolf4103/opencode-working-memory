#!/usr/bin/env bun
/**
 * Maintainer-only offline diagnostics for memory quality calibration.
 * Does not send telemetry, make API calls, or affect plugin runtime behavior.
 */

import { parseArgs, type ParsedArgs } from "./memory-diag/cli.ts";
import { dispatch } from "./memory-diag/command-registry.ts";
import { CliInputError } from "./memory-diag/types.ts";

type ParsedError = Extract<ParsedArgs, { ok: false }>;
type ParsedHelp = Extract<ParsedArgs, { ok: true; help: true }>;

function isParsedError(parsed: ParsedArgs): parsed is ParsedError {
  return parsed.ok === false;
}

function isParsedHelp(parsed: ParsedArgs): parsed is ParsedHelp {
  return parsed.ok === true && "help" in parsed;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (isParsedError(parsed)) {
    console.error(parsed.message);
    console.error(parsed.usage);
    return parsed.exitCode;
  }
  if (isParsedHelp(parsed)) {
    console.log(parsed.usage);
    return 0;
  }

  try {
    const result = await dispatch(parsed.command, parsed.options);
    const stderr = [parsed.deprecationNotice, result.stderr].filter(Boolean).join("\n");
    if (stderr) process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
    if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    return result.exitCode ?? 0;
  } catch (error) {
    if (error instanceof CliInputError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    if (error instanceof Error) {
      process.stderr.write(`memory-diag failed: ${error.message}\n`);
      return 1;
    }
    process.stderr.write(`memory-diag failed: ${String(error)}\n`);
    return 1;
  }
}

process.exitCode = await main();
