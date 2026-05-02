import { cleanPath, cleanText, countBy, formatWorkspaceIdentity, sortedCounts, truncate } from "../text.ts";
import type { MigrationLogRecord } from "../types.ts";

export type MigrationAuditReport = {
  migrationId: string;
  path: string;
  invalidLines: number;
  superseded: MigrationLogRecord[];
  hardReasons: string[];
  risky: Array<{ record: MigrationLogRecord; reasons: string[] }>;
};

export function formatMigrationAudit(reports: MigrationAuditReport[], options: { raw: boolean }): string {
  const lines: string[] = [];
  lines.push("Migration audit report");
  lines.push("");
  if (reports.length === 0) {
    lines.push("No migration logs found.");
    return lines.join("\n");
  }

  for (let i = 0; i < reports.length; i += 1) {
    const report = reports[i];
    if (i > 0) lines.push("");
    lines.push(`Migration: ${report.migrationId}`);
    lines.push(`logPath=${cleanPath(report.path, options.raw)}`);
    if (report.invalidLines > 0) lines.push(`Invalid JSONL lines skipped: ${report.invalidLines}`);
    lines.push(`Superseded entries: ${report.superseded.length}`);
    lines.push("");

    lines.push("By hard reason:");
    const byHardReason = sortedCounts(countBy(report.hardReasons));
    if (byHardReason.length === 0) lines.push("  (none)");
    else for (const [reason, count] of byHardReason) lines.push(`  ${reason.padEnd(24)} ${count}`);
    lines.push("");

    lines.push("Potentially risky supersedes:");
    lines.push(`  ${report.risky.length}`);
    for (const item of report.risky.slice(0, 10)) {
      const record = item.record;
      const hard = Array.isArray(record.hardReasons) ? record.hardReasons : [];
      const identity = formatWorkspaceIdentity(record.workspaceKey, record.workspaceRoot, options.raw);
      lines.push(`  - [${record.type ?? "unknown"}] hardReasons=${JSON.stringify(hard)} risk=${item.reasons.join(",")} ${JSON.stringify(truncate(cleanText(record.text ?? "", options.raw)))}`);
      if (identity) lines.push(`    ${identity}`);
    }
  }
  return lines.join("\n");
}
