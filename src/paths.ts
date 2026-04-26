import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { realpath } from "fs/promises";

export function dataHome(): string {
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

export async function workspaceKey(root: string): Promise<string> {
  const resolved = await realpath(root).catch(() => root);
  return createHash("sha256").update(resolved).digest("hex").slice(0, 16);
}

export async function memoryRoot(root: string): Promise<string> {
  return join(dataHome(), "opencode-working-memory", "workspaces", await workspaceKey(root));
}

export async function workspaceMemoryPath(root: string): Promise<string> {
  return join(await memoryRoot(root), "workspace-memory.json");
}

export async function workspacePendingJournalPath(root: string): Promise<string> {
  return join(await memoryRoot(root), "workspace-pending-journal.json");
}

export async function sessionStatePath(root: string, sessionID: string): Promise<string> {
  const safeSessionID = createHash("sha256").update(sessionID).digest("hex").slice(0, 32);
  return join(await memoryRoot(root), "sessions", `${safeSessionID}.json`);
}
