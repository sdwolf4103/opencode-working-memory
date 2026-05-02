import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export async function readJSONFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function readJSONLFile<T>(path: string): Promise<{ records: T[]; invalidLines: number }> {
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch {
    return { records: [], invalidLines: 0 };
  }

  const records: T[] = [];
  let invalidLines = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch {
      invalidLines += 1;
    }
  }
  return { records, invalidLines };
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}
