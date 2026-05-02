import { createHash } from "node:crypto";
import type { EvidenceEventV1 } from "../../src/evidence-log.ts";
import { redactCredentials } from "../../src/redaction.ts";

export function countBy<T extends string>(items: T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

export function sortedCounts<T extends string>(counts: Map<T, number>): Array<[T, number]> {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function workspaceRootHash(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

export function redactAbsolutePaths(text: string): string {
  return text.replace(/(?:^|[\s"'`(=:\[])(\/(?:Users|home|private|tmp|var|opt|Volumes|[^\s"'`)\],;:]+)\/[^\s"'`)\],;:]*)/g, (match, path) => match.replace(path, "<path>"));
}

export function cleanText(text: string, raw: boolean): string {
  if (raw) return text;
  return redactAbsolutePaths(redactCredentials(text));
}

export function cleanPath(path: string, raw: boolean): string {
  return raw ? path : "<path>";
}

export function formatWorkspaceIdentity(workspaceKeyValue: string | undefined, workspaceRoot: string | undefined, raw: boolean): string {
  const parts: string[] = [];
  if (workspaceKeyValue) parts.push(`workspaceKey=${workspaceKeyValue}`);
  if (workspaceRoot) {
    parts.push(raw ? `workspaceRoot=${workspaceRoot}` : `workspaceRootHash=${workspaceRootHash(workspaceRoot)}`);
  }
  return parts.join(" ");
}

export function truncate(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

export function canonicalMemoryText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, " ")
    .trim();
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function objectFromCounts<T extends string>(counts: Map<T, number>): Record<string, number> {
  return Object.fromEntries(sortedCounts(counts));
}

export function formatDetails(details: EvidenceEventV1["details"]): string {
  if (!details || Object.keys(details).length === 0) return "none";
  return Object.entries(details).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("|") : String(value)}`).join(" ");
}
