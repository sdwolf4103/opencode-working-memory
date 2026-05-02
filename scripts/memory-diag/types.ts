import type { EvidenceEventType, EvidenceEventV1, EvidenceOutcome } from "../../src/evidence-log.ts";
import type { LongTermMemoryEntry, LongTermSource, LongTermType, PendingMemoryJournalStore, WorkspaceMemoryStore } from "../../src/types.ts";

export type MemoryRenderStatus =
  | "rendered"
  | "omitted_superseded"
  | "omitted_type_cap"
  | "omitted_global_cap"
  | "omitted_char_budget"
  | "omitted_absorbed_duplicate"
  | "pending_retry"
  | "pending_rejected_capacity"
  | "quarantined_corrupt_store";

export type MemoryDiagJSON = {
  version: 1;
  workspace: { rootHash: string; key: string };
  generatedAt: string;
  summary: {
    storedActive: number;
    rendered: number;
    pending: number;
    rejectedLast7Days: number;
    corruptStoresQuarantinedLast30Days: number;
    status?: "ok" | "warning" | "degraded";
    evidenceCoveragePercent?: number;
    needsAttention?: string[];
    suggestedNextSteps?: string[];
  };
  memories: Array<{
    id: string;
    type: "feedback" | "project" | "decision" | "reference";
    source: "explicit" | "compaction" | "manual";
    status: MemoryRenderStatus;
    strength?: number;
    reasonCodes: string[];
    textPreview?: string;
    evidenceEventIds: string[];
  }>;
  recentEvents: Array<{
    eventId: string;
    type: EvidenceEventType;
    outcome: EvidenceOutcome;
    createdAt: string;
    memoryId?: string;
    reasonCodes: string[];
  }>;
};

export type Command = "status" | "rejected" | "missing" | "explain" | "coverage" | "audit";
export type LegacyCommand = "health" | "quality" | "rejections" | "disappearances" | "trace";
export type Origin = "explicit_trigger" | "compaction_candidate" | "manual" | "migration_check" | "unknown";

export type CliOptions = {
  raw: boolean;
  json?: boolean;
  verbose?: boolean;
  noEmoji?: boolean;
  workspace?: string;
  all?: boolean;
  softOnly?: boolean;
  triggerOnly?: boolean;
  includeHistorical?: boolean;
  quality?: boolean;
  reason?: string;
  unique?: boolean;
  explain?: boolean;
  since?: string;
  migration?: string;
  memory?: string;
  legacyCommand?: LegacyCommand;
  positional?: string[];
  auditMode?: "coverage" | "migrations";
};

export type ParsedArgs =
  | { ok: true; command: Command; options: CliOptions; deprecationNotice?: string }
  | { ok: true; help: true; usage: string }
  | { ok: false; message: string; usage: string; exitCode: number };

export type CommandResult = { stdout: string; stderr?: string; exitCode?: number };

export class CliInputError extends Error {}

export type RejectionLogRecord = {
  timestamp?: string;
  workspaceKey?: string;
  workspaceRoot?: string;
  workspaceRootHash?: string;
  type?: LongTermType;
  source?: LongTermSource | string;
  origin?: string;
  fromTrigger?: boolean;
  text?: string;
  reasons?: string[];
};

export type NormalizedRejection = Required<Pick<RejectionLogRecord, "timestamp" | "type" | "text" | "reasons">> & {
  workspaceKey?: string;
  workspaceRoot?: string;
  workspaceRootHash?: string;
  source?: string;
  origin: Origin;
  fromTrigger: boolean;
};

export type MigrationLogRecord = {
  migrationId?: string;
  timestamp?: string;
  workspaceKey?: string;
  workspaceRoot?: string;
  entryId?: string;
  type?: LongTermType;
  source?: LongTermSource | string;
  text?: string;
  reasons?: string[];
  hardReasons?: string[];
  beforeStatus?: string;
  afterStatus?: string;
};

export type RetentionDiagItem = {
  entry: LongTermMemoryEntry;
  strength: number;
};

export type WorkspaceDiagSnapshot = {
  store: WorkspaceMemoryStore;
  journal: PendingMemoryJournalStore;
  retention: {
    sorted: RetentionDiagItem[];
    rendered: RetentionDiagItem[];
    typeCapped: RetentionDiagItem[];
    globalCapped: RetentionDiagItem[];
  };
  memories: MemoryDiagJSON["memories"];
  recentEvents: MemoryDiagJSON["recentEvents"];
  allEvents: EvidenceEventV1[];
  summary: MemoryDiagJSON["summary"];
};

export type MemoryInspectionReadModel = {
  snapshot: WorkspaceDiagSnapshot;
  store: WorkspaceMemoryStore;
  pending: PendingMemoryJournalStore;
  evidenceEvents: EvidenceEventV1[];
  rejectionRecords: NormalizedRejection[];
  currentById: Map<string, LongTermMemoryEntry>;
  evidenceByMemoryId: Map<string, EvidenceEventV1[]>;
};

export type CoverageClass = "full_lifecycle" | "render_only" | "no_evidence" | "historical_absent_with_reason" | "historical_absent_unknown_reason";

export type DisappearanceReason = {
  classification: "historical_absent_with_reason" | "historical_absent_unknown_reason";
  terminalType: EvidenceEventType | "unknown";
  reasonCodes: string[];
  event?: EvidenceEventV1;
};
