#!/usr/bin/env node
/**
 * Safely inspect or quarantine stale test/temp workspace memory stores.
 *
 * Default mode is dry-run. Quarantine moves only definite temp/test residues.
 * Unknown missing roots are reported but skipped unless --include-orphans is set.
 */

import { cleanupWorkspaceResidues } from "../../src/workspace-cleanup.ts";

type CliOptions = {
  mode: "dry-run" | "quarantine";
  dataHome?: string;
  olderThanDays?: number;
  includeOrphans: boolean;
};

function usage(): string {
  return `Usage:
  npm run cleanup:workspaces -- --dry-run
  npm run cleanup:workspaces -- --quarantine
  npm run cleanup:workspaces -- --quarantine --older-than-days 1

Options:
  --dry-run             List candidates without moving anything (default)
  --quarantine          Move definite temp/test residues to quarantine
  --data-home <path>    Override XDG data home for testing/admin work
  --older-than-days <n> Only consider workspace dirs older than n days
  --include-orphans     Also quarantine missing non-temp roots (off by default)
  --help                Show this help
`;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { mode: "dry-run", includeOrphans: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        options.mode = "dry-run";
        break;
      case "--quarantine":
        options.mode = "quarantine";
        break;
      case "--data-home":
        options.dataHome = argv[++i];
        if (!options.dataHome) throw new Error("--data-home requires a path");
        break;
      case "--older-than-days": {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value < 0) throw new Error("--older-than-days requires a non-negative number");
        options.olderThanDays = value;
        break;
      }
      case "--include-orphans":
        options.includeOrphans = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}\n${usage()}`);
    }
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));
const result = await cleanupWorkspaceResidues({
  dataHome: options.dataHome,
  mode: options.mode,
  includeOrphans: options.includeOrphans,
  minAgeMs: options.olderThanDays === undefined ? undefined : options.olderThanDays * 24 * 60 * 60 * 1_000,
});

console.log(`Mode: ${result.mode}`);
console.log(`Scanned: ${result.results.length}`);
console.log(`Candidates: ${result.candidates.length}`);

if (result.candidates.length > 0) {
  console.log("\nCandidates:");
  for (const candidate of result.candidates) {
    console.log(`- ${candidate.workspaceKey} ${candidate.classification} root=${candidate.root ?? "<missing>"}`);
    console.log(`  reasons=${candidate.reasons.join(",")}`);
  }
}

if (result.quarantined.length > 0) {
  console.log(`\nQuarantined: ${result.quarantined.length}`);
  console.log(`Quarantine dir: ${result.quarantineDir}`);
}

const unknownOrphans = result.results.filter(item => item.classification === "orphan_unknown");
if (unknownOrphans.length > 0 && !options.includeOrphans) {
  console.log(`\nUnknown missing-root workspaces skipped: ${unknownOrphans.length}`);
  console.log("Use --include-orphans only after manually confirming they are safe to quarantine.");
}
