#!/usr/bin/env node
/**
 * Read-only baseline report for workspace-memory exact/identity key collisions.
 *
 * This script reads workspace-memory.json files from the local workspace memory
 * data directory. It never writes to workspace memory stores; the only optional
 * write is the explicit --json report path.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { workspaceMemoryExactKey, workspaceMemoryIdentityKey } from "../../src/workspace-memory.ts";
import type { LongTermMemoryEntry, LongTermSource, LongTermType } from "../../src/types.ts";

type CliOptions = {
  workspacesDir: string;
  jsonPath?: string;
};

type ReinforcementCountStatistics = {
  min: number;
  max: number;
  mean: number;
  gtZero: number;
};

type MemorySummary = {
  id: string;
  type: LongTermType;
  source: LongTermSource;
  text: string;
  reinforcementCount: number;
};

type WorkspaceSummary = {
  dirName: string;
  dirPath: string;
  key: string;
  root: string;
};

type CollisionGroup = {
  kind: "exact" | "identity";
  workspace: WorkspaceSummary;
  key: string;
  classification: "unclassified";
  memories: MemorySummary[];
};

type ValidationReport = {
  summary: {
    workspaces: number;
    activeMemories: number;
    exactCollisionGroups: number;
    identityCollisionGroups: number;
    reinforcementCountStatistics: ReinforcementCountStatistics;
  };
  groups: CollisionGroup[];
};

type ScannedMemory = {
  entry: LongTermMemoryEntry;
  exactKey: string;
  identityKey: string;
  reinforcementCount: number;
};

const DEFAULT_WORKSPACES_DIR = join(homedir(), ".local", "share", "opencode-working-memory", "workspaces");
const WORKSPACES_DIR_ENV_KEYS = [
  "OPENCODE_WORKING_MEMORY_WORKSPACES_DIR",
  "WORKSPACE_MEMORY_WORKSPACES_DIR",
];

function usage(): string {
  return `Usage:
  node --experimental-strip-types scripts/dev/validate-identity-keys.ts [workspaces-dir] [--json <path>]
  node --experimental-strip-types scripts/dev/validate-identity-keys.ts --data-path <workspaces-dir> [--json <path>]

Defaults:
  workspaces-dir defaults to ${DEFAULT_WORKSPACES_DIR}
  env override: ${WORKSPACES_DIR_ENV_KEYS.join(" or ")}
`;
}

function die(message: string): never {
  console.error(message);
  console.error(usage());
  process.exit(1);
}

function envWorkspacesDir(): string | undefined {
  for (const key of WORKSPACES_DIR_ENV_KEYS) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function parseArgs(argv: string[]): CliOptions {
  let workspacesDir: string | undefined;
  let jsonPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--json") {
      const value = argv[++i];
      if (!value) die("--json requires a path");
      jsonPath = expandHome(value);
      continue;
    }
    if (arg === "--data-path" || arg === "--workspaces-dir") {
      const value = argv[++i];
      if (!value) die(`${arg} requires a path`);
      if (workspacesDir) die("Only one workspaces directory may be provided");
      workspacesDir = expandHome(value);
      continue;
    }
    if (arg.startsWith("--")) die(`Unknown option: ${arg}`);
    if (workspacesDir) die("Only one workspaces directory may be provided");
    workspacesDir = expandHome(arg);
  }

  return {
    workspacesDir: resolve(workspacesDir ?? expandHome(envWorkspacesDir() ?? DEFAULT_WORKSPACES_DIR)),
    jsonPath: jsonPath ? resolve(jsonPath) : undefined,
  };
}

function isLongTermType(value: unknown): value is LongTermType {
  return value === "feedback" || value === "project" || value === "decision" || value === "reference";
}

function isLongTermSource(value: unknown): value is LongTermSource {
  return value === "explicit" || value === "compaction" || value === "manual";
}

function isMemoryEntry(value: unknown): value is LongTermMemoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<LongTermMemoryEntry>;
  return typeof entry.id === "string"
    && isLongTermType(entry.type)
    && typeof entry.text === "string"
    && isLongTermSource(entry.source);
}

function reinforcementCount(entry: LongTermMemoryEntry): number {
  const count = entry.reinforcementCount ?? 0;
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function summarizeMemory(memory: ScannedMemory): MemorySummary {
  return {
    id: memory.entry.id,
    type: memory.entry.type,
    source: memory.entry.source,
    text: memory.entry.text,
    reinforcementCount: memory.reinforcementCount,
  };
}

function addToGroupMap(map: Map<string, ScannedMemory[]>, key: string, memory: ScannedMemory): void {
  const group = map.get(key);
  if (group) {
    group.push(memory);
  } else {
    map.set(key, [memory]);
  }
}

function computeReinforcementStatistics(counts: number[]): ReinforcementCountStatistics {
  if (counts.length === 0) {
    return { min: 0, max: 0, mean: 0, gtZero: 0 };
  }

  const sum = counts.reduce((total, count) => total + count, 0);
  return {
    min: Math.min(...counts),
    max: Math.max(...counts),
    mean: sum / counts.length,
    gtZero: counts.filter(count => count > 0).length,
  };
}

async function readWorkspaceMemory(workspaceDir: string): Promise<unknown | undefined> {
  const path = join(workspaceDir, "workspace-memory.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT" || code === "EISDIR") return undefined;
    throw error;
  }
}

async function scanWorkspaces(workspacesDir: string): Promise<ValidationReport> {
  const dirents = await readdir(workspacesDir, { withFileTypes: true });
  const workspaceDirs = dirents
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name)
    .sort((a, b) => a.localeCompare(b));

  const collisionGroups: CollisionGroup[] = [];
  const reinforcementCounts: number[] = [];
  let workspaces = 0;
  let activeMemories = 0;

  for (const dirName of workspaceDirs) {
    const dirPath = join(workspacesDir, dirName);
    const store = await readWorkspaceMemory(dirPath);
    if (!store || typeof store !== "object") continue;

    const storeObject = store as {
      workspace?: { key?: unknown; root?: unknown };
      entries?: unknown;
    };
    const rawEntries = Array.isArray(storeObject.entries) ? storeObject.entries : [];
    const workspace: WorkspaceSummary = {
      dirName,
      dirPath,
      key: typeof storeObject.workspace?.key === "string" ? storeObject.workspace.key : dirName,
      root: typeof storeObject.workspace?.root === "string" ? storeObject.workspace.root : "<unknown>",
    };

    workspaces += 1;

    const exactGroups = new Map<string, ScannedMemory[]>();
    const identityGroups = new Map<string, ScannedMemory[]>();

    for (const rawEntry of rawEntries) {
      if (!isMemoryEntry(rawEntry)) continue;
      if (rawEntry.status === "superseded") continue;

      const scanned: ScannedMemory = {
        entry: rawEntry,
        exactKey: workspaceMemoryExactKey(rawEntry),
        identityKey: workspaceMemoryIdentityKey(rawEntry),
        reinforcementCount: reinforcementCount(rawEntry),
      };
      activeMemories += 1;
      reinforcementCounts.push(scanned.reinforcementCount);
      addToGroupMap(exactGroups, scanned.exactKey, scanned);
      addToGroupMap(identityGroups, scanned.identityKey, scanned);
    }

    for (const [key, memories] of exactGroups.entries()) {
      if (memories.length < 2) continue;
      collisionGroups.push({
        kind: "exact",
        workspace,
        key,
        classification: "unclassified",
        memories: memories.map(summarizeMemory),
      });
    }

    for (const [key, memories] of identityGroups.entries()) {
      if (memories.length < 2) continue;
      collisionGroups.push({
        kind: "identity",
        workspace,
        key,
        classification: "unclassified",
        memories: memories.map(summarizeMemory),
      });
    }
  }

  const exactCollisionGroups = collisionGroups.filter(group => group.kind === "exact").length;
  const identityCollisionGroups = collisionGroups.filter(group => group.kind === "identity").length;

  return {
    summary: {
      workspaces,
      activeMemories,
      exactCollisionGroups,
      identityCollisionGroups,
      reinforcementCountStatistics: computeReinforcementStatistics(reinforcementCounts),
    },
    groups: collisionGroups,
  };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function renderHumanReport(report: ValidationReport, workspacesDir: string): string {
  const stats = report.summary.reinforcementCountStatistics;
  const lines: string[] = [];
  lines.push("Workspace memory identity key validation baseline");
  lines.push(`Data path: ${workspacesDir}`);
  lines.push("");
  lines.push("Summary:");
  lines.push(`- Workspaces scanned: ${report.summary.workspaces}`);
  lines.push(`- Active memories: ${report.summary.activeMemories}`);
  lines.push(`- Exact collision groups: ${report.summary.exactCollisionGroups}`);
  lines.push(`- Identity collision groups: ${report.summary.identityCollisionGroups}`);
  lines.push(`- Reinforcement counts: min=${stats.min} max=${stats.max} mean=${stats.mean.toFixed(2)} gtZero=${stats.gtZero}`);

  if (report.groups.length === 0) {
    lines.push("");
    lines.push("Collision breakdown: none");
    return lines.join("\n");
  }

  const groupsByWorkspace = new Map<string, CollisionGroup[]>();
  for (const group of report.groups) {
    const key = group.workspace.key;
    const existing = groupsByWorkspace.get(key);
    if (existing) existing.push(group);
    else groupsByWorkspace.set(key, [group]);
  }

  lines.push("");
  lines.push("Collision breakdown:");
  for (const [workspaceKey, groups] of [...groupsByWorkspace.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const workspace = groups[0].workspace;
    const exactCount = groups.filter(group => group.kind === "exact").length;
    const identityCount = groups.filter(group => group.kind === "identity").length;
    lines.push(`- Workspace ${workspaceKey}`);
    lines.push(`  root: ${workspace.root}`);
    lines.push(`  dir: ${workspace.dirPath}`);
    lines.push(`  exactCollisionGroups=${exactCount} identityCollisionGroups=${identityCount}`);

    for (const group of groups.sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key))) {
      lines.push(`  - ${group.kind} key: ${group.key}`);
      lines.push(`    classification: ${group.classification}`);
      for (const memory of group.memories) {
        lines.push(`    - id=${memory.id} type=${memory.type} source=${memory.source} reinforcementCount=${memory.reinforcementCount}`);
        lines.push(`      text: ${oneLine(memory.text)}`);
      }
    }
  }

  return lines.join("\n");
}

async function writeJsonReport(path: string, report: ValidationReport): Promise<void> {
  if (basename(path) === "workspace-memory.json") {
    die("Refusing to write JSON output to a workspace-memory.json file");
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

const options = parseArgs(process.argv.slice(2));
const report = await scanWorkspaces(options.workspacesDir);
console.log(renderHumanReport(report, options.workspacesDir));

if (options.jsonPath) {
  await writeJsonReport(options.jsonPath, report);
  console.log(`\nJSON report written to: ${options.jsonPath}`);
}
