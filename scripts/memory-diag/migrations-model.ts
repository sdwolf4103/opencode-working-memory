import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { dataHome, migrationLogPath } from "../../src/paths.ts";
import type { CliOptions, MigrationLogRecord } from "./types.ts";

export function migrationLogsRoot(): string {
  return join(dataHome(), "opencode-working-memory", "migration-logs");
}

export async function migrationLogPaths(options: CliOptions): Promise<string[]> {
  if (options.migration) return [migrationLogPath(options.migration)];
  const root = migrationLogsRoot();
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  return entries.filter(entry => entry.endsWith(".jsonl")).sort().map(entry => join(root, entry));
}

export function migrationIdFromPath(path: string): string {
  return path.split("/").pop()?.replace(/\.jsonl$/, "") ?? "unknown";
}

export function riskySupersedeReasons(record: MigrationLogRecord): string[] {
  const reasons: string[] = [];
  const hardReasonsMissing = !Array.isArray(record.hardReasons);
  const hardReasons = Array.isArray(record.hardReasons) ? record.hardReasons : [];
  const qualityReasons = Array.isArray(record.reasons) ? record.reasons : [];
  const text = record.text ?? "";

  if (hardReasonsMissing || hardReasons.length === 0) reasons.push("missing_or_empty_hardReasons");
  if (qualityReasons.length > 0 && hardReasons.length === 0) reasons.push("soft_reasons_without_hardReasons");
  if (/\b(?:User|user|prefers|requires|wants|insists)\b|用戶|使用者|偏好|要求|不要|不刪除/u.test(text)) reasons.push("user_preference_marker");
  if (/\b(?:must|should|do not|never|is|are|follows)\b|必須|應該|採用|維持|需支援/iu.test(text)) reasons.push("durable_rule_marker");
  if ((record.type === "feedback" || record.type === "decision") && hardReasons.length === 1 && hardReasons[0] === "path_heavy") {
    reasons.push("feedback_or_decision_path_heavy_only");
  }

  return reasons;
}
