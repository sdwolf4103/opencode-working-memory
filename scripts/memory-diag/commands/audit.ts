import { HARD_QUALITY_REASONS } from "../../../src/memory-quality.ts";
import { formatMigrationAudit, type MigrationAuditReport } from "../formatters/audit.ts";
import { readJSONLFile } from "../io.ts";
import { migrationIdFromPath, migrationLogPaths, riskySupersedeReasons } from "../migrations-model.ts";
import type { CliOptions, CommandResult, MigrationLogRecord } from "../types.ts";

export async function runAudit(options: CliOptions): Promise<CommandResult> {
  const paths = await migrationLogPaths(options);
  const reports: MigrationAuditReport[] = [];
  for (const path of paths) {
    const migrationId = options.migration ?? migrationIdFromPath(path);
    const { records, invalidLines } = await readJSONLFile<MigrationLogRecord>(path);
    const superseded = records.filter(record => !record.afterStatus || record.afterStatus === "superseded");
    const hardReasons = superseded.flatMap(record => {
      if (Array.isArray(record.hardReasons)) return record.hardReasons;
      return Array.isArray(record.reasons) ? record.reasons.filter(reason => HARD_QUALITY_REASONS.has(reason)) : [];
    });
    const risky = superseded
      .map(record => ({ record, reasons: riskySupersedeReasons(record) }))
      .filter(item => item.reasons.length > 0);
    reports.push({ migrationId, path, invalidLines, superseded, hardReasons, risky });
  }
  return { stdout: formatMigrationAudit(reports, { raw: options.raw }) };
}
