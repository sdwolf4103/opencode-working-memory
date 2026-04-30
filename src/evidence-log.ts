import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataHome, workspaceEvidenceLogPath, workspaceKey } from "./paths.ts";
import { redactCredentials } from "./redaction.ts";

export type EvidenceEventType =
  | "extraction_candidate_accepted"
  | "extraction_candidate_rejected"
  | "explicit_memory_detected"
  | "explicit_memory_ignored"
  | "pending_memory_appended"
  | "pending_memory_cleared"
  | "promotion_promoted"
  | "promotion_absorbed_exact"
  | "promotion_absorbed_identity"
  | "promotion_superseded"
  | "promotion_rejected_capacity"
  | "promotion_retry_scheduled"
  | "promotion_retry_exhausted"
  | "memory_reinforced"
  | "render_selected"
  | "render_omitted"
  | "storage_corrupt_json_quarantined"
  | "storage_stale_lock_recovered"
  | "storage_lock_timeout"
  | "hook_failed";

export type EvidencePhase =
  | "extraction"
  | "explicit"
  | "pending_journal"
  | "promotion"
  | "reinforcement"
  | "render"
  | "storage"
  | "hook";

export type EvidenceOutcome =
  | "accepted"
  | "rejected"
  | "promoted"
  | "absorbed"
  | "superseded"
  | "rendered"
  | "omitted"
  | "retried"
  | "exhausted"
  | "reinforced"
  | "quarantined"
  | "failed"
  | "recovered";

export type MemoryEvidenceRef = {
  memoryId?: string;
  memoryKeyHash?: string;
  identityKeyHash?: string;
  type?: "feedback" | "project" | "decision" | "reference";
  source?: "explicit" | "compaction" | "manual";
  status?: "active" | "superseded";
};

export type EvidenceRelation = {
  role:
    | "candidate"
    | "pending"
    | "promoted"
    | "retained"
    | "absorbed"
    | "superseded"
    | "superseded_by"
    | "reinforced"
    | "reinforced_by"
    | "rendered"
    | "omitted";
  memory?: MemoryEvidenceRef;
};

export type EvidenceDetailValue = string | number | boolean | null | string[] | number[];

export type EvidenceEventV1 = {
  version: 1;
  eventId: string;
  createdAt: string;
  workspaceKey: string;
  workspaceRootHash: string;
  sessionHash?: string;
  messageHash?: string;
  type: EvidenceEventType;
  phase: EvidencePhase;
  outcome: EvidenceOutcome;
  memory?: MemoryEvidenceRef;
  relations?: EvidenceRelation[];
  reasonCodes: string[];
  details?: Record<string, EvidenceDetailValue>;
  textPreview?: string;
};

export type EvidenceEventInput = Omit<
  EvidenceEventV1,
  "version" | "eventId" | "createdAt" | "workspaceKey" | "workspaceRootHash"
>;

export type EvidenceQuery = {
  since?: string;
  until?: string;
  types?: EvidenceEventType[];
  phases?: EvidencePhase[];
  outcomes?: EvidenceOutcome[];
  memoryId?: string;
  memoryKeyHash?: string;
  identityKeyHash?: string;
  sessionHash?: string;
  limit?: number;
  newestFirst?: boolean;
};

export type MemoryEvidenceSummary = {
  memoryId?: string;
  memoryKeyHash?: string;
  latestOutcome?: EvidenceOutcome;
  latestRenderStatus?: "rendered" | "omitted";
  reasonCodes: string[];
  eventIds: string[];
  lastEventAt?: string;
};

export type MemoryLifecycleTrace = {
  memoryId?: string;
  memoryKeyHash?: string;
  identityKeyHash?: string;
  events: EvidenceEventV1[];
  createdBy?: EvidenceEventV1;
  acceptedBy?: EvidenceEventV1;
  promotedBy?: EvidenceEventV1;
  absorbedBy?: EvidenceEventV1;
  supersededBy?: EvidenceEventV1;
  reinforcedBy: EvidenceEventV1[];
  latestRender?: EvidenceEventV1;
  currentStatus:
    | "accepted"
    | "pending"
    | "promoted"
    | "absorbed"
    | "superseded"
    | "rendered"
    | "omitted"
    | "rejected"
    | "unknown";
};

export const EVIDENCE_LOG_LIMITS = {
  maxAgeDays: 90,
  maxEventsPerWorkspace: 5000,
  maxBytesPerWorkspace: 2 * 1024 * 1024,
  pruneEveryAppendCount: 100,
} as const;

const appendCounts = new Map<string, number>();
const HASH_PATTERN = /^[a-f0-9]{16}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DETAIL_STRING_CHARS = 240;
const MAX_DETAIL_ARRAY_ITEMS = 25;

function evidenceHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizeHashValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return HASH_PATTERN.test(value) ? value.toLowerCase() : evidenceHash(value);
}

async function resolvedRoot(root: string): Promise<string> {
  return realpath(root).catch(() => root);
}

function evidenceTextPreview(text: string, maxChars = 120): string {
  return redactCredentials(text).replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function sanitizeReasonCode(reason: string): string {
  return reason.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120);
}

function sanitizeMemoryRef(memory: MemoryEvidenceRef | undefined): MemoryEvidenceRef | undefined {
  if (!memory) return undefined;
  const sanitized: MemoryEvidenceRef = {};
  if (typeof memory.memoryId === "string" && memory.memoryId) sanitized.memoryId = memory.memoryId.slice(0, 160);
  if (memory.memoryKeyHash) sanitized.memoryKeyHash = normalizeHashValue(memory.memoryKeyHash);
  if (memory.identityKeyHash) sanitized.identityKeyHash = normalizeHashValue(memory.identityKeyHash);
  if (memory.type) sanitized.type = memory.type;
  if (memory.source) sanitized.source = memory.source;
  if (memory.status) sanitized.status = memory.status;
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeRelations(relations: EvidenceRelation[] | undefined): EvidenceRelation[] | undefined {
  if (!relations) return undefined;
  const sanitized = relations
    .map(relation => ({
      role: relation.role,
      memory: sanitizeMemoryRef(relation.memory),
    }))
    .slice(0, 25);
  return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeDetailString(value: string): string {
  return evidenceTextPreview(value, MAX_DETAIL_STRING_CHARS);
}

function sanitizeDetails(details: EvidenceEventInput["details"]): EvidenceEventV1["details"] {
  if (!details) return undefined;
  const sanitized: Record<string, EvidenceDetailValue> = {};

  for (const [rawKey, rawValue] of Object.entries(details).slice(0, 50)) {
    const key = rawKey.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80);
    if (!key) continue;

    if (typeof rawValue === "string") {
      sanitized[key] = sanitizeDetailString(rawValue);
    } else if (typeof rawValue === "number") {
      if (Number.isFinite(rawValue)) sanitized[key] = rawValue;
    } else if (typeof rawValue === "boolean" || rawValue === null) {
      sanitized[key] = rawValue;
    } else if (Array.isArray(rawValue)) {
      if (rawValue.every(item => typeof item === "string")) {
        sanitized[key] = rawValue.slice(0, MAX_DETAIL_ARRAY_ITEMS).map(item => sanitizeDetailString(item));
      } else if (rawValue.every(item => typeof item === "number" && Number.isFinite(item))) {
        sanitized[key] = rawValue.slice(0, MAX_DETAIL_ARRAY_ITEMS) as number[];
      }
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function buildEvidenceEvent(
  input: EvidenceEventInput,
  workspaceKeyValue: string,
  workspaceRootHash: string,
): EvidenceEventV1 {
  const textPreviewMax = input.type === "extraction_candidate_rejected" ? 80 : 120;
  const event: EvidenceEventV1 = {
    version: 1,
    eventId: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10).padEnd(8, "0")}`,
    createdAt: new Date().toISOString(),
    workspaceKey: workspaceKeyValue,
    workspaceRootHash,
    type: input.type,
    phase: input.phase,
    outcome: input.outcome,
    reasonCodes: input.reasonCodes.map(sanitizeReasonCode).filter(Boolean).slice(0, 25),
  };

  const memory = sanitizeMemoryRef(input.memory);
  const relations = sanitizeRelations(input.relations);
  const details = sanitizeDetails(input.details);
  if (input.sessionHash) event.sessionHash = normalizeHashValue(input.sessionHash);
  if (input.messageHash) event.messageHash = normalizeHashValue(input.messageHash);
  if (memory) event.memory = memory;
  if (relations) event.relations = relations;
  if (details) event.details = details;
  if (input.textPreview) event.textPreview = evidenceTextPreview(input.textPreview, textPreviewMax);

  return event;
}

async function safeAppendEvidenceLine(path: string, line: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${line}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[memory] failed to write evidence event: ${message}`);
  }
}

async function maybePruneEvidenceLog(path: string): Promise<void> {
  const nextCount = (appendCounts.get(path) ?? 0) + 1;
  appendCounts.set(path, nextCount);
  if (nextCount % EVIDENCE_LOG_LIMITS.pruneEveryAppendCount !== 0) return;

  try {
    await pruneEvidenceLogPath(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[memory] failed to prune evidence log: ${message}`);
  }
}

export async function appendEvidenceEvent(root: string, event: EvidenceEventInput): Promise<EvidenceEventV1> {
  const records = await appendEvidenceEvents(root, [event]);
  return records[0];
}

export async function appendEvidenceEvents(root: string, events: EvidenceEventInput[]): Promise<EvidenceEventV1[]> {
  const path = await workspaceEvidenceLogPath(root);
  const rootPath = await resolvedRoot(root);
  const workspaceRootHash = evidenceHash(rootPath);
  const workspaceKeyValue = await workspaceKey(root);
  const records = events.map(event => buildEvidenceEvent(event, workspaceKeyValue, workspaceRootHash));

  for (const record of records) {
    await safeAppendEvidenceLine(path, JSON.stringify(record));
    await maybePruneEvidenceLog(path);
  }

  return records;
}

export async function appendEvidenceEventForWorkspaceKey(
  workspaceKeyValue: string,
  event: EvidenceEventInput,
): Promise<EvidenceEventV1> {
  const path = join(dataHome(), "opencode-working-memory", "workspaces", workspaceKeyValue, "evidence", "events.jsonl");
  const record = buildEvidenceEvent(event, workspaceKeyValue, workspaceKeyValue);
  await safeAppendEvidenceLine(path, JSON.stringify(record));
  await maybePruneEvidenceLog(path);
  return record;
}

type ParsedEvidenceLine = {
  event: EvidenceEventV1;
  index: number;
};

function parseEvidenceLine(line: string): EvidenceEventV1 | null {
  try {
    const parsed = JSON.parse(line) as Partial<EvidenceEventV1>;
    if (parsed.version !== 1 || !parsed.eventId || !parsed.createdAt || !parsed.type) return null;
    return parsed as EvidenceEventV1;
  } catch {
    return null;
  }
}

async function readEvidenceLines(path: string, warnInvalid: boolean): Promise<{ valid: ParsedEvidenceLine[]; invalid: string[] }> {
  if (!existsSync(path)) return { valid: [], invalid: [] };
  const raw = await readFile(path, "utf8");
  const valid: ParsedEvidenceLine[] = [];
  const invalid: string[] = [];

  raw.split(/\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const event = parseEvidenceLine(line);
    if (event) {
      valid.push({ event, index });
    } else {
      invalid.push(line);
      if (warnInvalid) console.warn(`[memory] skipped invalid evidence log line ${index + 1}`);
    }
  });

  return { valid, invalid };
}

function eventTimeMs(event: EvidenceEventV1): number {
  const ms = new Date(event.createdAt).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

async function atomicWriteText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function serializeEvents(events: EvidenceEventV1[]): string {
  return events.map(event => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : "");
}

function trimEventsToByteLimit(events: EvidenceEventV1[]): EvidenceEventV1[] {
  let kept = [...events];
  while (kept.length > 0 && Buffer.byteLength(serializeEvents(kept), "utf8") > EVIDENCE_LOG_LIMITS.maxBytesPerWorkspace) {
    kept = kept.slice(1);
  }
  return kept;
}

async function pruneEvidenceLogPath(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const stats = await stat(path);
  if (stats.isDirectory()) return;

  const { valid, invalid } = await readEvidenceLines(path, false);
  if (invalid.length > 0) {
    const corruptPath = `${path}.corrupt-lines-${Date.now()}.jsonl`;
    await writeFile(corruptPath, invalid.join("\n") + "\n", { encoding: "utf8", mode: 0o600 }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[memory] failed to quarantine invalid evidence lines: ${message}`);
    });
  }

  const cutoff = Date.now() - EVIDENCE_LOG_LIMITS.maxAgeDays * DAY_MS;
  let events = valid
    .filter(item => eventTimeMs(item.event) >= cutoff)
    .sort((a, b) => eventTimeMs(a.event) - eventTimeMs(b.event) || a.index - b.index)
    .map(item => item.event);

  if (events.length > EVIDENCE_LOG_LIMITS.maxEventsPerWorkspace) {
    events = events.slice(events.length - EVIDENCE_LOG_LIMITS.maxEventsPerWorkspace);
  }

  events = trimEventsToByteLimit(events);
  await atomicWriteText(path, serializeEvents(events));
}

function memoryRefMatches(memory: MemoryEvidenceRef | undefined, query: Pick<EvidenceQuery, "memoryId" | "memoryKeyHash" | "identityKeyHash">): boolean {
  if (!memory) return false;
  const memoryKeyHash = normalizeHashValue(query.memoryKeyHash);
  const identityKeyHash = normalizeHashValue(query.identityKeyHash);
  if (query.memoryId && memory.memoryId === query.memoryId) return true;
  if (memoryKeyHash && memory.memoryKeyHash === memoryKeyHash) return true;
  if (identityKeyHash && memory.identityKeyHash === identityKeyHash) return true;
  return false;
}

function eventMatchesMemory(event: EvidenceEventV1, query: Pick<EvidenceQuery, "memoryId" | "memoryKeyHash" | "identityKeyHash">): boolean {
  if (!query.memoryId && !query.memoryKeyHash && !query.identityKeyHash) return true;
  if (memoryRefMatches(event.memory, query)) return true;
  return (event.relations ?? []).some(relation => memoryRefMatches(relation.memory, query));
}

export async function queryEvidenceEvents(
  root: string,
  query: EvidenceQuery = {},
): Promise<EvidenceEventV1[]> {
  const path = await workspaceEvidenceLogPath(root);
  const { valid } = await readEvidenceLines(path, true);
  const sinceMs = query.since ? new Date(query.since).getTime() : undefined;
  const untilMs = query.until ? new Date(query.until).getTime() : undefined;
  const sessionHash = normalizeHashValue(query.sessionHash);

  let events = valid.map(item => item.event).filter(event => {
    const createdAtMs = eventTimeMs(event);
    if (Number.isFinite(sinceMs) && createdAtMs < sinceMs) return false;
    if (Number.isFinite(untilMs) && createdAtMs > untilMs) return false;
    if (query.types && !query.types.includes(event.type)) return false;
    if (query.phases && !query.phases.includes(event.phase)) return false;
    if (query.outcomes && !query.outcomes.includes(event.outcome)) return false;
    if (sessionHash && event.sessionHash !== sessionHash) return false;
    if (!eventMatchesMemory(event, query)) return false;
    return true;
  });

  if (query.newestFirst) events = events.slice().reverse();
  if (typeof query.limit === "number" && query.limit >= 0) events = events.slice(0, query.limit);
  return events;
}

export async function summarizeMemoryEvidence(
  root: string,
  input: { memoryId?: string; memoryKeyHash?: string },
): Promise<MemoryEvidenceSummary> {
  const events = await queryEvidenceEvents(root, input);
  const latest = events.at(-1);
  const latestRender = events.filter(event => event.phase === "render").at(-1);
  const reasonCodes = new Set<string>();
  for (const event of events) {
    for (const reason of event.reasonCodes) reasonCodes.add(reason);
  }

  return {
    memoryId: input.memoryId,
    memoryKeyHash: normalizeHashValue(input.memoryKeyHash),
    latestOutcome: latest?.outcome,
    latestRenderStatus: latestRender?.outcome === "rendered" || latestRender?.outcome === "omitted"
      ? latestRender.outcome
      : undefined,
    reasonCodes: [...reasonCodes],
    eventIds: events.map(event => event.eventId),
    lastEventAt: latest?.createdAt,
  };
}

function currentStatusFromEvent(event: EvidenceEventV1 | undefined): MemoryLifecycleTrace["currentStatus"] {
  if (!event) return "unknown";
  if (event.outcome === "accepted") return "accepted";
  if (event.outcome === "promoted") return "promoted";
  if (event.outcome === "absorbed") return "absorbed";
  if (event.outcome === "superseded") return "superseded";
  if (event.outcome === "rendered") return "rendered";
  if (event.outcome === "omitted") return "omitted";
  if (event.outcome === "rejected") return "rejected";
  if (event.type === "pending_memory_appended") return "pending";
  return "unknown";
}

export async function traceMemoryLifecycle(
  root: string,
  input: { memoryId?: string; memoryKeyHash?: string; identityKeyHash?: string },
): Promise<MemoryLifecycleTrace> {
  const events = await queryEvidenceEvents(root, input);
  const createdBy = events.find(event => event.type === "explicit_memory_detected" || event.type === "pending_memory_appended");
  const acceptedBy = events.find(event => event.type === "extraction_candidate_accepted" || event.type === "explicit_memory_detected");
  const promotedBy = events.find(event => event.type === "promotion_promoted");
  const absorbedBy = events.find(event => event.outcome === "absorbed");
  const supersededBy = events.find(event => event.outcome === "superseded");
  const reinforcedBy = events.filter(event => event.type === "memory_reinforced" || event.outcome === "reinforced");
  const latestRender = events.filter(event => event.phase === "render").at(-1);
  const latest = events.at(-1);

  return {
    memoryId: input.memoryId,
    memoryKeyHash: normalizeHashValue(input.memoryKeyHash),
    identityKeyHash: normalizeHashValue(input.identityKeyHash),
    events,
    createdBy,
    acceptedBy,
    promotedBy,
    absorbedBy,
    supersededBy,
    reinforcedBy,
    latestRender,
    currentStatus: currentStatusFromEvent(latest),
  };
}
