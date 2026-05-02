import type { LongTermType } from "../../src/types.ts";
import type { Origin } from "./types.ts";

export const TYPES: LongTermType[] = ["feedback", "decision", "project", "reference"];

export const SUSPICIOUS_REASONS = [
  "progress_snapshot",
  "active_file_snapshot",
  "commit_or_ci_snapshot",
  "temporary_status",
  "raw_error",
  "code_or_api_signature",
] as const;

export const ALLOWED_ORIGINS = new Set<Origin>([
  "explicit_trigger",
  "compaction_candidate",
  "manual",
  "migration_check",
  "unknown",
]);
