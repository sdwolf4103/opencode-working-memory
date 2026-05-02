import { calculateRetentionStrength } from "../../src/retention.ts";
import {
  queryEvidenceEvents,
  type EvidenceEventV1,
} from "../../src/evidence-log.ts";
import { workspaceKey, workspaceMemoryPath, workspacePendingJournalPath } from "../../src/paths.ts";
import { accountWorkspaceMemoryRender } from "../../src/workspace-memory.ts";
import type { LongTermMemoryEntry, PendingMemoryJournalStore, WorkspaceMemoryStore } from "../../src/types.ts";
import { LONG_TERM_LIMITS } from "../../src/types.ts";
import { readJSONFile } from "./io.ts";
import { groupEvidenceByMemoryId } from "./evidence-model.ts";
import { promotionLimit, retentionCandidatesForDiag } from "./retention-model.ts";
import { cleanText, truncate, uniqueStrings, workspaceRootHash } from "./text.ts";
import type { CliOptions, MemoryDiagJSON, MemoryRenderStatus, WorkspaceDiagSnapshot } from "./types.ts";

export function emptyStore(root: string, key: string): WorkspaceMemoryStore {
  return {
    version: 1,
    workspace: { root, key },
    limits: { maxRenderedChars: LONG_TERM_LIMITS.maxRenderedChars, maxEntries: LONG_TERM_LIMITS.maxEntries },
    entries: [],
    migrations: [],
    updatedAt: new Date(0).toISOString(),
  };
}

export function normalizedStore(store: WorkspaceMemoryStore | null, root: string, key: string): WorkspaceMemoryStore {
  const fallback = emptyStore(root, key);
  return {
    ...fallback,
    ...(store ?? {}),
    workspace: store?.workspace ?? fallback.workspace,
    limits: {
      maxRenderedChars: store?.limits?.maxRenderedChars ?? fallback.limits.maxRenderedChars,
      maxEntries: store?.limits?.maxEntries ?? fallback.limits.maxEntries,
    },
    entries: Array.isArray(store?.entries) ? store.entries : [],
    migrations: Array.isArray(store?.migrations) ? store.migrations : [],
  };
}

export function normalizedJournal(journal: PendingMemoryJournalStore | null): PendingMemoryJournalStore {
  return {
    version: 1,
    workspace: journal?.workspace ?? { root: "", key: "" },
    entries: Array.isArray(journal?.entries) ? journal.entries : [],
    updatedAt: journal?.updatedAt ?? new Date(0).toISOString(),
  };
}

export function eventMemoryId(event: EvidenceEventV1): string | undefined {
  return event.memory?.memoryId
    ?? event.relations?.map(relation => relation.memory?.memoryId).find((id): id is string => Boolean(id));
}

export function isWithinDays(iso: string, days: number, now = Date.now()): boolean {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) && ms >= now - days * 86_400_000;
}

export function renderStatusReason(status: MemoryRenderStatus, fallback?: string): string[] {
  switch (status) {
    case "rendered": return ["within_caps", "within_char_budget"];
    case "omitted_superseded": return ["superseded"];
    case "omitted_type_cap": return ["type_cap"];
    case "omitted_global_cap": return ["global_cap"];
    case "omitted_char_budget": return [fallback === "empty_render_budget" ? "empty_render_budget" : "char_budget"];
    case "omitted_absorbed_duplicate": return ["absorbed_duplicate"];
    case "pending_retry": return ["retryable_capacity_rejection"];
    case "pending_rejected_capacity": return ["capacity_rejected", "max_attempts_reached"];
    case "quarantined_corrupt_store": return ["invalid_json"];
  }
}

export function statusFromOmissionReason(reason: string | undefined): MemoryRenderStatus {
  if (reason === "superseded") return "omitted_superseded";
  if (reason === "type_cap") return "omitted_type_cap";
  if (reason === "global_cap") return "omitted_global_cap";
  return "omitted_char_budget";
}

export function pendingStatus(entry: LongTermMemoryEntry): MemoryRenderStatus {
  const attempts = entry.promotionAttempts ?? 0;
  return attempts >= promotionLimit(entry.source) ? "pending_rejected_capacity" : "pending_retry";
}

export function safeTextPreview(text: string): string {
  return truncate(cleanText(text, false), 120);
}

function evidenceSummaryForMemory(grouped: Map<string, EvidenceEventV1[]>, memoryId: string): { eventIds: string[]; reasonCodes: string[] } {
  const events = grouped.get(memoryId) ?? [];
  const reasonCodes = new Set<string>();
  for (const event of events) {
    for (const reason of event.reasonCodes) reasonCodes.add(reason);
  }
  return {
    eventIds: events.map(event => event.eventId),
    reasonCodes: [...reasonCodes],
  };
}

export async function buildWorkspaceDiagSnapshot(input: {
  root: string;
  key: string;
  memoryPath: string;
  pendingPath: string;
}, now = Date.now()): Promise<WorkspaceDiagSnapshot> {
  const rawStore = await readJSONFile<WorkspaceMemoryStore>(input.memoryPath);
  const storeRoot = rawStore?.workspace?.root ?? input.root;
  const storeKey = rawStore?.workspace?.key ?? input.key;
  const store = normalizedStore(rawStore, storeRoot, storeKey);
  const journal = normalizedJournal(await readJSONFile<PendingMemoryJournalStore>(input.pendingPath));
  const retention = retentionCandidatesForDiag(store, now);
  const renderAccounting = accountWorkspaceMemoryRender(store);
  const renderedIds = new Set(renderAccounting.rendered.map(memory => memory.id));
  const omittedById = new Map(renderAccounting.omitted.map(item => [item.memory.id, item.reason]));
  const allEvents = await queryEvidenceEvents(input.root);
  const evidenceByMemoryId = groupEvidenceByMemoryId(allEvents);
  const recentEvidence = await queryEvidenceEvents(input.root, { newestFirst: true, limit: 50 });
  const memoryRows: MemoryDiagJSON["memories"] = [];
  const seenIds = new Set<string>();

  for (const entry of store.entries) {
    const omissionReason = omittedById.get(entry.id);
    const status: MemoryRenderStatus = renderedIds.has(entry.id)
      ? "rendered"
      : statusFromOmissionReason(omissionReason ?? (entry.status === "superseded" ? "superseded" : undefined));
    const summary = evidenceSummaryForMemory(evidenceByMemoryId, entry.id);
    memoryRows.push({
      id: entry.id,
      type: entry.type,
      source: entry.source,
      status,
      strength: calculateRetentionStrength(entry, now, store.lastActivityAt),
      reasonCodes: uniqueStrings([...renderStatusReason(status, omissionReason), ...summary.reasonCodes]),
      textPreview: safeTextPreview(entry.text),
      evidenceEventIds: summary.eventIds,
    });
    seenIds.add(entry.id);
  }

  for (const entry of journal.entries) {
    const status = pendingStatus(entry);
    const summary = evidenceSummaryForMemory(evidenceByMemoryId, entry.id);
    memoryRows.push({
      id: entry.id,
      type: entry.type,
      source: entry.source,
      status,
      strength: calculateRetentionStrength(entry, now, store.lastActivityAt),
      reasonCodes: uniqueStrings([...renderStatusReason(status), entry.lastPromotionFailureReason ?? "", ...summary.reasonCodes]),
      textPreview: safeTextPreview(entry.text),
      evidenceEventIds: summary.eventIds,
    });
    seenIds.add(entry.id);
  }

  for (const event of allEvents) {
    if (event.outcome !== "absorbed") continue;
    const memory = event.memory;
    if (!memory?.memoryId || !memory.type || !memory.source || seenIds.has(memory.memoryId)) continue;
    const summary = evidenceSummaryForMemory(evidenceByMemoryId, memory.memoryId);
    memoryRows.push({
      id: memory.memoryId,
      type: memory.type,
      source: memory.source,
      status: "omitted_absorbed_duplicate",
      reasonCodes: uniqueStrings([...renderStatusReason("omitted_absorbed_duplicate"), ...summary.reasonCodes]),
      evidenceEventIds: summary.eventIds.length > 0 ? summary.eventIds : [event.eventId],
    });
    seenIds.add(memory.memoryId);
  }

  const recentEvents = recentEvidence.map(event => ({
    eventId: event.eventId,
    type: event.type,
    outcome: event.outcome,
    createdAt: event.createdAt,
    memoryId: eventMemoryId(event),
    reasonCodes: uniqueStrings([
      ...event.reasonCodes,
      ...(event.type === "storage_corrupt_json_quarantined" ? ["quarantined_corrupt_store"] : []),
    ]),
  }));

  return {
    store,
    journal,
    retention,
    memories: memoryRows,
    recentEvents,
    allEvents,
    summary: {
      storedActive: store.entries.filter(entry => entry.status !== "superseded").length,
      rendered: retention.rendered.length,
      pending: journal.entries.length,
      rejectedLast7Days: allEvents.filter(event => event.outcome === "rejected" && isWithinDays(event.createdAt, 7, now)).length,
      corruptStoresQuarantinedLast30Days: allEvents.filter(event => event.type === "storage_corrupt_json_quarantined" && isWithinDays(event.createdAt, 30, now)).length,
    },
  };
}

export async function buildMemoryDiagJSON(root: string): Promise<MemoryDiagJSON> {
  const key = await workspaceKey(root);
  const snapshot = await buildWorkspaceDiagSnapshot({
    root,
    key,
    memoryPath: await workspaceMemoryPath(root),
    pendingPath: await workspacePendingJournalPath(root),
  });

  return memoryDiagJSONFromSnapshot(root, snapshot);
}

export function memoryDiagJSONFromSnapshot(root: string, snapshot: WorkspaceDiagSnapshot, generatedAt = new Date().toISOString()): MemoryDiagJSON {
  return {
    version: 1,
    workspace: { rootHash: workspaceRootHash(snapshot.store.workspace.root || root), key: snapshot.store.workspace.key },
    generatedAt,
    summary: snapshot.summary,
    memories: snapshot.memories,
    recentEvents: snapshot.recentEvents,
  };
}

export async function snapshotForOptions(options: CliOptions): Promise<WorkspaceDiagSnapshot> {
  const root = options.workspace ?? process.cwd();
  const key = await workspaceKey(root);
  return buildWorkspaceDiagSnapshot({
    root,
    key,
    memoryPath: await workspaceMemoryPath(root),
    pendingPath: await workspacePendingJournalPath(root),
  });
}
