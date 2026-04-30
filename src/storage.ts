import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "fs/promises";
import type { FileHandle } from "fs/promises";
import { dirname } from "path";
import { appendEvidenceEventForWorkspaceKey } from "./evidence-log.ts";

const fileLocks = new Map<string, Promise<unknown>>();
const LOCK_WAIT_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 1_000;

function workspaceKeyFromStorePath(path: string): string | undefined {
  return path.match(/[\\/]opencode-working-memory[\\/]workspaces[\\/]([a-f0-9]{16})[\\/]/i)?.[1];
}

function storeKindFromPath(path: string): string {
  if (path.endsWith("workspace-memory.json")) return "workspace_memory";
  if (path.endsWith("workspace-pending-journal.json")) return "pending_journal";
  if (path.includes(`${"/"}sessions${"/"}`) || path.includes(`${"\\"}sessions${"\\"}`)) return "session_state";
  return "unknown";
}

async function emitStorageEvidence(path: string, event: Parameters<typeof appendEvidenceEventForWorkspaceKey>[1]): Promise<void> {
  const key = workspaceKeyFromStorePath(path);
  if (!key) return;
  await appendEvidenceEventForWorkspaceKey(key, event).catch(() => undefined);
}

async function quarantineCorruptJSON(path: string): Promise<string | null> {
  const quarantinePath = `${path}.corrupt-${Date.now()}-${process.pid}-${randomUUID()}`;

  try {
    await rename(path, quarantinePath);
    return quarantinePath;
  } catch {
    return null;
  }
}

export async function readJSON<T>(path: string, fallback: () => T): Promise<T> {
  if (!existsSync(path)) return fallback();

  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const quarantinePath = await quarantineCorruptJSON(path);

    if (quarantinePath) {
      console.error(`[memory] invalid JSON in ${path}; quarantined to ${quarantinePath}: ${message}`);
      await emitStorageEvidence(path, {
        type: "storage_corrupt_json_quarantined",
        phase: "storage",
        outcome: "quarantined",
        reasonCodes: ["invalid_json"],
        details: {
          storeKind: storeKindFromPath(path),
          quarantined: true,
        },
      });
    } else {
      console.error(`[memory] invalid JSON in ${path}; using fallback without quarantine: ${message}`);
    }

    return fallback();
  }
}

async function readJSONStrict<T>(path: string, fallback: () => T): Promise<T> {
  if (!existsSync(path)) return fallback();
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${(error as Error).message}`);
  }
}

async function isLockStale(lockPath: string, now = Date.now()): Promise<boolean> {
  try {
    const stats = await stat(lockPath);

    if (now - stats.mtimeMs > LOCK_STALE_MS) return true;

    const content = await readFile(lockPath, "utf8");
    const [, createdText] = content.split("\n");
    const createdAt = Number(createdText);

    return Number.isFinite(createdAt) && now - createdAt > LOCK_STALE_MS;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function writeLockInfo(handle: FileHandle): Promise<void> {
  const content = `${process.pid}\n${Date.now()}\n`;
  await handle.truncate(0);
  await handle.write(content, 0, "utf8");
}

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const started = Date.now();

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      let heartbeat: NodeJS.Timeout | undefined;
      let heartbeatWrite: Promise<void> = Promise.resolve();
      const queueHeartbeat = (): void => {
        heartbeatWrite = heartbeatWrite
          .catch(() => undefined)
          .then(() => writeLockInfo(handle))
          .catch(() => undefined);
      };

      try {
        await writeLockInfo(handle);
        heartbeat = setInterval(queueHeartbeat, LOCK_HEARTBEAT_MS);
        return await fn();
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        await heartbeatWrite.catch(() => undefined);
        await handle.close();
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      if (await isLockStale(lockPath)) {
        await rm(lockPath, { force: true });
        await emitStorageEvidence(path, {
          type: "storage_stale_lock_recovered",
          phase: "storage",
          outcome: "recovered",
          reasonCodes: ["stale_lock"],
          details: {
            storeKind: storeKindFromPath(path),
            waitMs: Date.now() - started,
          },
        });
        continue;
      }

      if (Date.now() - started > LOCK_WAIT_TIMEOUT_MS) {
        await emitStorageEvidence(path, {
          type: "storage_lock_timeout",
          phase: "storage",
          outcome: "failed",
          reasonCodes: ["lock_wait_timeout"],
          details: {
            storeKind: storeKindFromPath(path),
            waitMs: LOCK_WAIT_TIMEOUT_MS,
          },
        });
        throw new Error(`Timed out waiting for lock ${lockPath}`);
      }

      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

export async function atomicWriteJSON(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

export async function updateJSON<T>(
  path: string,
  fallback: () => T,
  updater: (current: T) => T | Promise<T>,
): Promise<T> {
  const previous = fileLocks.get(path) ?? Promise.resolve();
  let release: () => void = () => {};
  const currentLock = new Promise<void>(resolve => {
    release = resolve;
  });
  const queued = previous.then(() => currentLock, () => currentLock);
  fileLocks.set(path, queued);

  try {
    await previous.catch(() => undefined);
    return await withFileLock(path, async () => {
      const current = await readJSONStrict(path, fallback);
      const updated = await updater(current);
      await atomicWriteJSON(path, updated);
      return updated;
    });
  } finally {
    release();
    if (fileLocks.get(path) === queued) {
      fileLocks.delete(path);
    }
  }
}
