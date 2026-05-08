export type LongTermType = "feedback" | "project" | "decision" | "reference";

export type LongTermSource = "explicit" | "compaction" | "manual";

export type LongTermMemoryEntry = {
  id: string;
  type: LongTermType;
  text: string;
  rationale?: string;
  source: LongTermSource;
  confidence: number;
  status: "active" | "superseded";
  createdAt: string;
  updatedAt: string;
  staleAfterDays?: number;
  supersedes?: string[];
  tags?: string[];
  pendingOwnerSessionID?: string;
  pendingMessageID?: string;
  promotionAttempts?: number;
  lastPromotionAttemptAt?: string;
  lastPromotionFailureReason?: string;
  retentionClock?: number;        // Unix timestamp when retention started
  reinforcementCount?: number;    // Number of times this memory was reinforced
  lastReinforcedAt?: number;      // Unix timestamp of last reinforcement
  lastReinforcedSessionID?: string;
  userImportance?: "low" | "normal" | "high";
  safetyCritical?: boolean;
};

export type CompactionMemoryRef = {
  ref: string;
  compactionId?: string;
  memoryId: string;
  type: LongTermType;
  source: LongTermSource;
  exactKey: string;
  identityKey: string;
  textPreview: string;
  capturedAt: number;
};

export type WorkspaceMemoryStore = {
  version: 1;
  workspace: {
    root: string;
    key: string;
  };
  limits: {
    maxRenderedChars: number;
    maxEntries: number;
  };
  entries: LongTermMemoryEntry[];
  migrations?: string[];
  updatedAt: string;
  lastActivityAt?: string;
};

export type PendingMemoryJournalStore = {
  version: 1;
  workspace: {
    root: string;
    key: string;
  };
  entries: LongTermMemoryEntry[];
  updatedAt: string;
};

export type ActiveFile = {
  path: string;
  action: "read" | "grep" | "edit" | "write";
  count: number;
  lastSeen: number;
};

export type OpenError = {
  id: string;
  category: "typecheck" | "test" | "lint" | "build" | "runtime" | "tool";
  summary: string;
  command?: string;
  file?: string;
  fingerprint: string;
  status: "open" | "maybe_fixed";
  firstSeen: number;
  lastSeen: number;
  seenCount: number;
};

export type SessionDecision = {
  id: string;
  text: string;
  rationale?: string;
  source: "assistant" | "user" | "compaction";
  createdAt: number;
  promotedToLongTerm?: boolean;
};

export type SessionState = {
  version: 1;
  sessionID: string;
  turn: number;
  updatedAt: string;
  activeFiles: ActiveFile[];
  openErrors: OpenError[];
  recentDecisions: SessionDecision[];
  pendingMemories: LongTermMemoryEntry[];
  compactionMemoryRefs: CompactionMemoryRef[];
};

export const LONG_TERM_LIMITS = {
  maxRenderedChars: 3600,
  targetRenderedChars: 3000,
  maxEntries: 28,
  maxEntryTextChars: 260,
  maxRationaleChars: 180,
} as const;

export const HOT_STATE_LIMITS = {
  maxRenderedChars: 700,
  maxActiveFilesStored: 20,
  maxActiveFilesRendered: 8,
  maxOpenErrorsStored: 5,
  maxOpenErrorsRendered: 3,
  maxRecentDecisionsStored: 8,
  maxPendingMemoriesStored: 12,
  maxPendingMemoriesRendered: 6,
} as const;

export const PROMOTION_RETRY_LIMITS = {
  maxExplicitAttempts: 3,
  maxManualAttempts: 3,
} as const;

export const WORKSPACE_MEMORY_CACHE_LIMITS = {
  maxFrozenSessions: 50,
  maxProcessedSessionIDs: 200,
  maxProcessedMessagesPerSession: 50,
  frozenTtlMs: 60 * 60 * 1000,
} as const;
