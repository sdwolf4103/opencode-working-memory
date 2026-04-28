import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { dataHome as defaultDataHome } from "./paths.ts";

export type WorkspaceCleanupClassification =
  | "test_temp_definite"
  | "orphan_unknown"
  | "live_or_existing"
  | "invalid_or_unreadable";

export type WorkspaceCleanupResult = {
  workspaceKey: string;
  workspaceDir: string;
  root?: string;
  rootExists: boolean;
  classification: WorkspaceCleanupClassification;
  reasons: string[];
  entryCount?: number;
  migrations?: string[];
  updatedAt?: string;
};

export type WorkspaceCleanupScanOptions = {
  dataHome?: string;
  nowMs?: number;
  minAgeMs?: number;
  includeOrphans?: boolean;
};

export type WorkspaceCleanupScan = {
  results: WorkspaceCleanupResult[];
  candidates: WorkspaceCleanupResult[];
};

export type WorkspaceCleanupMode = "dry-run" | "quarantine";

export type WorkspaceCleanupOptions = WorkspaceCleanupScanOptions & {
  mode?: WorkspaceCleanupMode;
  now?: Date;
};

export type WorkspaceCleanupQuarantineEvent = WorkspaceCleanupResult & {
  from: string;
  to: string;
  quarantinedAt: string;
};

export type WorkspaceCleanupRunResult = WorkspaceCleanupScan & {
  mode: WorkspaceCleanupMode;
  quarantined: WorkspaceCleanupQuarantineEvent[];
  quarantineDir?: string;
};

type WorkspaceMemoryShape = {
  workspace?: {
    root?: unknown;
    key?: unknown;
  };
  entries?: unknown[];
  migrations?: unknown[];
  updatedAt?: unknown;
};

const DEFAULT_MIN_AGE_MS = 10 * 60 * 1_000;

const KNOWN_TEST_ROOT_PREFIXES = [
  "memory-plugin-test-",
  "memory-plugin-prompt-",
  "wm-",
  "wm-quality-",
  "wm-accounting-",
  "wm-redact-",
  "wm-normalized-",
  "wm-ordering-",
  "wm-extraction-",
];

function normalizePathForComparison(path: string): string {
  return resolve(path).replace(/\/+$/, "");
}

function isInsidePath(path: string, parent: string): boolean {
  const normalizedPath = normalizePathForComparison(path);
  const normalizedParent = normalizePathForComparison(parent);
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

export function isTempRoot(root: string, osTmpdir = tmpdir()): boolean {
  const normalized = normalizePathForComparison(root);
  const normalizedTmp = normalizePathForComparison(osTmpdir);

  if (isInsidePath(normalized, normalizedTmp)) return true;
  if (isInsidePath(normalized, "/tmp")) return true;
  if (isInsidePath(normalized, "/private/tmp")) return true;

  return /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/.test(normalized);
}

export function isKnownTestWorkspaceRoot(root: string): boolean {
  const name = basename(root);
  return KNOWN_TEST_ROOT_PREFIXES.some(prefix => name.startsWith(prefix));
}

function classifyCandidate(result: WorkspaceCleanupResult, includeOrphans: boolean): boolean {
  if (result.reasons.includes("recent_workspace_dir")) return false;
  if (result.reasons.includes("lock_present")) return false;
  if (result.classification === "test_temp_definite") return true;
  return includeOrphans && result.classification === "orphan_unknown";
}

export async function classifyWorkspaceDir(
  workspaceDir: string,
  options: { nowMs?: number; minAgeMs?: number } = {},
): Promise<WorkspaceCleanupResult> {
  const workspaceKey = basename(workspaceDir);
  const reasons: string[] = [];
  const memoryPath = join(workspaceDir, "workspace-memory.json");

  if (existsSync(`${memoryPath}.lock`)) {
    reasons.push("lock_present");
  }

  let stats;
  try {
    stats = await stat(workspaceDir);
  } catch {
    return {
      workspaceKey,
      workspaceDir,
      rootExists: false,
      classification: "invalid_or_unreadable",
      reasons: ["workspace_dir_unreadable"],
    };
  }

  const minAgeMs = options.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const nowMs = options.nowMs ?? Date.now();
  if (minAgeMs > 0 && nowMs - stats.mtimeMs < minAgeMs) {
    reasons.push("recent_workspace_dir");
  }

  let store: WorkspaceMemoryShape;
  try {
    store = JSON.parse(await readFile(memoryPath, "utf8")) as WorkspaceMemoryShape;
  } catch {
    return {
      workspaceKey,
      workspaceDir,
      rootExists: false,
      classification: "invalid_or_unreadable",
      reasons: [...reasons, "invalid_json"],
    };
  }

  const root = typeof store.workspace?.root === "string" ? store.workspace.root : undefined;
  const key = typeof store.workspace?.key === "string" ? store.workspace.key : workspaceKey;
  const entryCount = Array.isArray(store.entries) ? store.entries.length : undefined;
  const migrations = Array.isArray(store.migrations) ? store.migrations.filter((item): item is string => typeof item === "string") : undefined;
  const updatedAt = typeof store.updatedAt === "string" ? store.updatedAt : undefined;

  if (!root) {
    return {
      workspaceKey: key,
      workspaceDir,
      rootExists: false,
      classification: "invalid_or_unreadable",
      reasons: [...reasons, "missing_workspace_root"],
      entryCount,
      migrations,
      updatedAt,
    };
  }

  const rootExists = existsSync(root);
  if (rootExists) {
    return {
      workspaceKey: key,
      workspaceDir,
      root,
      rootExists,
      classification: "live_or_existing",
      reasons: [...reasons, "root_exists"],
      entryCount,
      migrations,
      updatedAt,
    };
  }

  reasons.push("root_missing");
  const tempRoot = isTempRoot(root);
  const testRoot = isKnownTestWorkspaceRoot(root);
  if (tempRoot) reasons.push("root_under_temp");
  if (testRoot) reasons.push(`test_prefix_${KNOWN_TEST_ROOT_PREFIXES.find(prefix => basename(root).startsWith(prefix))?.replace(/-$/, "") ?? basename(root)}`);

  return {
    workspaceKey: key,
    workspaceDir,
    root,
    rootExists,
    classification: tempRoot || testRoot ? "test_temp_definite" : "orphan_unknown",
    reasons,
    entryCount,
    migrations,
    updatedAt,
  };
}

function workspacesDir(dataHome: string): string {
  return join(dataHome, "opencode-working-memory", "workspaces");
}

export async function scanWorkspaceResidues(options: WorkspaceCleanupScanOptions = {}): Promise<WorkspaceCleanupScan> {
  const root = workspacesDir(options.dataHome ?? defaultDataHome());
  const results: WorkspaceCleanupResult[] = [];

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { results, candidates: [] };
  }

  for (const entry of entries) {
    const workspaceDir = join(root, entry);
    const stats = await stat(workspaceDir).catch(() => undefined);
    if (!stats?.isDirectory()) continue;

    results.push(await classifyWorkspaceDir(workspaceDir, {
      nowMs: options.nowMs,
      minAgeMs: options.minAgeMs,
    }));
  }

  return {
    results,
    candidates: results.filter(result => classifyCandidate(result, options.includeOrphans ?? false)),
  };
}

function quarantineName(now: Date): string {
  return `workspace-cleanup-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

export async function cleanupWorkspaceResidues(options: WorkspaceCleanupOptions = {}): Promise<WorkspaceCleanupRunResult> {
  const mode = options.mode ?? "dry-run";
  const now = options.now ?? new Date();
  const scan = await scanWorkspaceResidues({
    dataHome: options.dataHome,
    nowMs: options.nowMs,
    minAgeMs: options.minAgeMs,
    includeOrphans: options.includeOrphans,
  });

  if (mode === "dry-run" || scan.candidates.length === 0) {
    return { ...scan, mode, quarantined: [] };
  }

  const dataHome = options.dataHome ?? defaultDataHome();
  const quarantineDir = join(dataHome, "opencode-working-memory", "quarantine", quarantineName(now));
  const quarantined: WorkspaceCleanupQuarantineEvent[] = [];

  for (const candidate of scan.candidates) {
    const destination = join(quarantineDir, "workspaces", candidate.workspaceKey);
    await mkdir(dirname(destination), { recursive: true });
    await rename(candidate.workspaceDir, destination);

    const event: WorkspaceCleanupQuarantineEvent = {
      ...candidate,
      from: candidate.workspaceDir,
      to: destination,
      quarantinedAt: now.toISOString(),
    };
    quarantined.push(event);

    await mkdir(quarantineDir, { recursive: true });
    await appendFile(join(quarantineDir, "manifest.jsonl"), JSON.stringify(event) + "\n", "utf8");
  }

  return { ...scan, mode, quarantined, quarantineDir };
}
