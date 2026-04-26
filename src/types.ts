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
};

export const LONG_TERM_LIMITS = {
  maxRenderedChars: 5200,
  targetRenderedChars: 4200,
  maxEntries: 28,
  maxEntryTextChars: 260,
  maxRationaleChars: 180,
} as const;

export const HOT_STATE_LIMITS = {
  maxRenderedChars: 1200,
  maxActiveFilesStored: 20,
  maxActiveFilesRendered: 8,
  maxOpenErrorsStored: 5,
  maxOpenErrorsRendered: 3,
  maxRecentDecisionsStored: 8,
  maxPendingMemoriesStored: 12,
  maxPendingMemoriesRendered: 6,
} as const;
