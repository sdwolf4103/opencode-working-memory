#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type PackageManifest = {
  version?: unknown;
};

type PackageLock = {
  version?: unknown;
  packages?: Record<string, { version?: unknown } | undefined>;
};

export type PackageVersionMismatch = {
  field: "package-lock.json version" | "package-lock.json packages[\"\"].version";
  expected: string;
  actual: unknown;
};

export function packageVersionMismatches(
  packageJson: PackageManifest,
  packageLock: PackageLock,
): PackageVersionMismatch[] {
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json version must be a non-empty string");
  }

  const expected = packageJson.version;
  const rootLockVersion = packageLock.version;
  const rootPackageVersion = packageLock.packages?.[""]?.version;

  const candidates = [
    { field: "package-lock.json version" as const, actual: rootLockVersion },
    { field: "package-lock.json packages[\"\"].version" as const, actual: rootPackageVersion },
  ];

  return candidates
    .filter(candidate => candidate.actual !== expected)
    .map(candidate => ({ ...candidate, expected }));
}

export function formatPackageVersionMismatch(mismatch: PackageVersionMismatch): string {
  return `${mismatch.field} (${String(mismatch.actual)}) does not match package.json version (${mismatch.expected})`;
}

export function packageLockReadErrorMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "ENOENT") return "package-lock.json not found; run npm install first";

  const message = error instanceof Error ? error.message : String(error);
  return `Unable to read package-lock.json; run npm install first. ${message}`;
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function main(): Promise<void> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const packageJson = await readJsonFile<PackageManifest>(join(repoRoot, "package.json"));
  let packageLock: PackageLock;
  try {
    packageLock = await readJsonFile<PackageLock>(join(repoRoot, "package-lock.json"));
  } catch (error) {
    console.error(packageLockReadErrorMessage(error));
    process.exit(1);
  }

  const mismatches = packageVersionMismatches(packageJson, packageLock);

  if (mismatches.length > 0) {
    console.error("Package integrity check failed:");
    for (const mismatch of mismatches) {
      console.error(`- ${formatPackageVersionMismatch(mismatch)}`);
    }
    process.exit(1);
  }

  console.log(`PACKAGE_INTEGRITY_PASS version=${packageJson.version}`);
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath ? import.meta.url === pathToFileURL(resolve(invokedPath)).href : false;
}

if (isMainModule()) {
  await main();
}
