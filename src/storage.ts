import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";

const fileLocks = new Map<string, Promise<unknown>>();

export async function readJSON<T>(path: string, fallback: () => T): Promise<T> {
  if (!existsSync(path)) return fallback();
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback();
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
    const current = await readJSON(path, fallback);
    const updated = await updater(current);
    await atomicWriteJSON(path, updated);
    return updated;
  } finally {
    release();
    if (fileLocks.get(path) === queued) {
      fileLocks.delete(path);
    }
  }
}
