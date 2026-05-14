import { queryEvidenceEvents, type EvidenceEventV1, type EvidenceOutcome } from "../../../src/evidence-log.ts";
import { workspaceKey, workspaceMemoryPath } from "../../../src/paths.ts";
import type { WorkspaceMemoryStore } from "../../../src/types.ts";
import { accountWorkspaceMemoryRender } from "../../../src/workspace-memory.ts";
import { readJSONFile } from "../io.ts";
import { objectFromCounts, sortedCounts } from "../text.ts";
import type { CliOptions, CommandResult } from "../types.ts";
import { normalizedStore } from "../workspace-snapshot.ts";

type CommandKind = "reinforce" | "replace";

type MemoryCommandSummary = {
  version: 1;
  generatedAt: string;
  compactionsWithCommandEvidence: number;
  commands: Record<CommandKind, number>;
  outcomes: Record<"reinforced" | "superseded" | "rejected" | "blocked", number>;
  invalidMalformedCommands: number;
  replacements: {
    sameType: number;
    crossType: number;
  };
  protectedReplacements: {
    total: number;
    protectedReinforcedTarget: number;
    protectedMemorySource: number;
  };
  rejectionReasons: Record<string, number>;
  latestEvents: Array<{
    eventId: string;
    createdAt: string;
    type: string;
    outcome: EvidenceOutcome;
    ref?: string;
    memoryId?: string;
    reasonCodes: string[];
    textPreview?: string;
  }>;
};

type MemoryCommandDetail = {
  version: 1;
  generatedAt: string;
  memoryId: string;
  current: {
    present: boolean;
    status?: string;
    renderStatus?: "rendered" | "not_rendered" | "unknown";
    type?: string;
    source?: string;
  };
  summary: {
    attempts: number;
    reinforced: number;
    rejectedOrBlocked: number;
    windowBlocked: number;
    blocksByReason: Record<string, number>;
    blockDetailsMissing: number;
    refs: string[];
    sameSessionCrossUtcDayBlocks: number;
  };
  events: Array<{
    eventId: string;
    createdAt: string;
    outcome: EvidenceOutcome;
    ref?: string;
    blockReason?: string;
    reasonCodes: string[];
    attemptedAtIso?: string;
    lastReinforcedAtIso?: string;
    crossUtcDay?: boolean | "unknown";
    producerVersion?: string;
    instrumentationVersion?: number;
  }>;
};

const INVALID_COMMAND_REASONS = new Set([
  "invalid_memory_command",
  "invalid_memory_ref",
  "invalid_memory_type",
  "empty_replacement_text",
]);

function hasReason(event: EvidenceEventV1, reason: string): boolean {
  return event.reasonCodes.includes(reason);
}

function isInvalidMalformedCommandEvent(event: EvidenceEventV1): boolean {
  return event.type === "extraction_candidate_rejected"
    && event.reasonCodes.some(reason => INVALID_COMMAND_REASONS.has(reason));
}

function isParsedCommandEvent(event: EvidenceEventV1): boolean {
  return event.type === "memory_reinforced" || event.type === "memory_replaced_numbered_ref";
}

function isManualRevertEvent(event: EvidenceEventV1): boolean {
  return event.type === "memory_reverted_numbered_ref";
}

function isCommandEvidenceEvent(event: EvidenceEventV1): boolean {
  return isParsedCommandEvent(event) || isInvalidMalformedCommandEvent(event) || isManualRevertEvent(event);
}

function refFromEvent(event: EvidenceEventV1): string | undefined {
  const ref = event.details?.ref;
  return typeof ref === "string" ? ref : undefined;
}

function isReinforcementEvent(event: EvidenceEventV1): boolean {
  return event.type === "memory_reinforced";
}

function stringDetail(event: EvidenceEventV1, key: string): string | undefined {
  const value = event.details?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRejectedOrBlocked(event: EvidenceEventV1): boolean {
  return event.outcome === "rejected" || hasReason(event, "reinforcement_window_blocked");
}

function blockReasonFor(event: EvidenceEventV1): string | undefined {
  if (!isRejectedOrBlocked(event)) return undefined;
  return stringDetail(event, "blockReason") ?? "unknown";
}

function isCrossUtcDay(attemptedAtIso: string | undefined, lastReinforcedAtIso: string | undefined): boolean | "unknown" {
  if (!attemptedAtIso || !lastReinforcedAtIso) return "unknown";
  const attempted = new Date(attemptedAtIso);
  const lastReinforced = new Date(lastReinforcedAtIso);
  if (Number.isNaN(attempted.getTime()) || Number.isNaN(lastReinforced.getTime())) return "unknown";
  return attempted.toISOString().slice(0, 10) !== lastReinforced.toISOString().slice(0, 10);
}

async function currentMemoryStatus(root: string, memoryId: string): Promise<MemoryCommandDetail["current"]> {
  const rawStore = await readJSONFile<WorkspaceMemoryStore>(await workspaceMemoryPath(root));
  const storeRoot = rawStore?.workspace?.root ?? root;
  const storeKey = rawStore?.workspace?.key ?? await workspaceKey(root);
  const store = normalizedStore(rawStore, storeRoot, storeKey);
  const activeEntry = store.entries.find(entry => entry.id === memoryId && entry.status !== "superseded");
  const renderAccounting = accountWorkspaceMemoryRender(store);
  const renderedIds = new Set(renderAccounting.rendered.map(memory => memory.id));
  const omittedIds = new Set(renderAccounting.omitted.map(item => item.memory.id));
  const renderStatus = renderedIds.has(memoryId)
    ? "rendered"
    : omittedIds.has(memoryId)
      ? "not_rendered"
      : "unknown";

  if (!activeEntry) {
    return { present: false, renderStatus };
  }

  return {
    present: true,
    status: activeEntry.status,
    renderStatus,
    type: activeEntry.type,
    source: activeEntry.source,
  };
}

function detailEventJSON(event: EvidenceEventV1): MemoryCommandDetail["events"][number] {
  const attemptedAtIso = stringDetail(event, "attemptedAtIso");
  const lastReinforcedAtIso = stringDetail(event, "lastReinforcedAtIso");
  const blocked = isRejectedOrBlocked(event);
  const blockReason = blockReasonFor(event);
  return {
    eventId: event.eventId,
    createdAt: event.createdAt,
    outcome: event.outcome,
    ref: refFromEvent(event),
    blockReason,
    reasonCodes: event.reasonCodes,
    attemptedAtIso,
    lastReinforcedAtIso,
    crossUtcDay: blocked ? isCrossUtcDay(attemptedAtIso, lastReinforcedAtIso) : undefined,
    producerVersion: event.producerVersion,
    instrumentationVersion: event.instrumentationVersion,
  };
}

export async function buildMemoryCommandDetail(
  root: string,
  memoryId: string,
  events: EvidenceEventV1[],
  generatedAt = new Date().toISOString(),
): Promise<MemoryCommandDetail> {
  const reinforcementEvents = events.filter(isReinforcementEvent);
  const blockReasonCounts = new Map<string, number>();
  const refs = new Set<string>();
  let blockDetailsMissing = 0;
  let sameSessionCrossUtcDayBlocks = 0;

  for (const event of reinforcementEvents) {
    const ref = refFromEvent(event);
    if (ref) refs.add(ref);
    if (!isRejectedOrBlocked(event)) continue;

    const blockReason = blockReasonFor(event) ?? "unknown";
    blockReasonCounts.set(blockReason, (blockReasonCounts.get(blockReason) ?? 0) + 1);
    if (!stringDetail(event, "blockReason")) blockDetailsMissing += 1;
    if (blockReason === "same_session" && isCrossUtcDay(stringDetail(event, "attemptedAtIso"), stringDetail(event, "lastReinforcedAtIso")) === true) {
      sameSessionCrossUtcDayBlocks += 1;
    }
  }

  return {
    version: 1,
    generatedAt,
    memoryId,
    current: await currentMemoryStatus(root, memoryId),
    summary: {
      attempts: reinforcementEvents.length,
      reinforced: reinforcementEvents.filter(event => event.outcome === "reinforced").length,
      rejectedOrBlocked: reinforcementEvents.filter(isRejectedOrBlocked).length,
      windowBlocked: reinforcementEvents.filter(event => hasReason(event, "reinforcement_window_blocked")).length,
      blocksByReason: objectFromCounts(blockReasonCounts),
      blockDetailsMissing,
      refs: [...refs].sort(),
      sameSessionCrossUtcDayBlocks,
    },
    events: reinforcementEvents.map(detailEventJSON),
  };
}

function latestEventJSON(event: EvidenceEventV1): MemoryCommandSummary["latestEvents"][number] {
  return {
    eventId: event.eventId,
    createdAt: event.createdAt,
    type: event.type,
    outcome: event.outcome,
    ref: refFromEvent(event),
    memoryId: event.memory?.memoryId,
    reasonCodes: event.reasonCodes,
    textPreview: event.textPreview,
  };
}

export function buildMemoryCommandSummary(events: EvidenceEventV1[], generatedAt = new Date().toISOString()): MemoryCommandSummary {
  const commandEvents = events.filter(isCommandEvidenceEvent);
  const compactionCommandEvents = commandEvents.filter(event => !isManualRevertEvent(event));
  const parsedEvents = compactionCommandEvents.filter(isParsedCommandEvent);
  const invalidEvents = compactionCommandEvents.filter(isInvalidMalformedCommandEvent);
  const sessions = new Set(compactionCommandEvents.map(event => event.sessionHash).filter((value): value is string => typeof value === "string" && value.length > 0));
  const replacementSuccesses = parsedEvents.filter(event => event.type === "memory_replaced_numbered_ref" && event.outcome === "superseded");
  const rejectedCommandEvents = commandEvents.filter(event => event.outcome === "rejected");
  const rejectionReasonCounts = new Map<string, number>();

  for (const event of rejectedCommandEvents) {
    for (const reason of event.reasonCodes) {
      rejectionReasonCounts.set(reason, (rejectionReasonCounts.get(reason) ?? 0) + 1);
    }
  }

  const protectedReinforcedTarget = parsedEvents.filter(event => event.type === "memory_replaced_numbered_ref" && hasReason(event, "protected_reinforced_target")).length;
  const protectedMemorySource = parsedEvents.filter(event => event.type === "memory_replaced_numbered_ref" && hasReason(event, "protected_memory_source")).length;
  const parsedRejected = parsedEvents.filter(event => event.outcome === "rejected").length;

  return {
    version: 1,
    generatedAt,
    compactionsWithCommandEvidence: sessions.size > 0 ? sessions.size : compactionCommandEvents.length > 0 ? 1 : 0,
    commands: {
      reinforce: parsedEvents.filter(event => event.type === "memory_reinforced").length,
      replace: parsedEvents.filter(event => event.type === "memory_replaced_numbered_ref").length,
    },
    outcomes: {
      reinforced: parsedEvents.filter(event => event.outcome === "reinforced").length,
      superseded: parsedEvents.filter(event => event.outcome === "superseded").length,
      rejected: parsedRejected,
      blocked: parsedRejected,
    },
    invalidMalformedCommands: invalidEvents.length,
    replacements: {
      sameType: replacementSuccesses.filter(event => hasReason(event, "same_type_replace")).length,
      crossType: replacementSuccesses.filter(event => hasReason(event, "cross_type_replace")).length,
    },
    protectedReplacements: {
      total: parsedEvents.filter(event => event.type === "memory_replaced_numbered_ref" && (hasReason(event, "protected_reinforced_target") || hasReason(event, "protected_memory_source"))).length,
      protectedReinforcedTarget,
      protectedMemorySource,
    },
    rejectionReasons: objectFromCounts(rejectionReasonCounts),
    latestEvents: commandEvents.slice(-10).reverse().map(latestEventJSON),
  };
}

function formatReasonCounts(rejectionReasons: Record<string, number>): string[] {
  const counts = new Map(Object.entries(rejectionReasons));
  const rows = sortedCounts(counts);
  if (rows.length === 0) return ["  (none)"];
  return rows.map(([reason, count]) => `  - ${reason}: ${count}`);
}

function formatLatestEvents(events: MemoryCommandSummary["latestEvents"]): string[] {
  if (events.length === 0) return ["  (none)"];
  return events.map(event => {
    const ref = event.ref ? ` ref=${event.ref}` : "";
    const memoryId = event.memoryId ? ` memory=${event.memoryId}` : "";
    const textPreview = event.textPreview ? ` text=${JSON.stringify(event.textPreview)}` : "";
    return `  - ${event.createdAt} ${event.type} ${event.outcome}${ref}${memoryId} reasons=${event.reasonCodes.join(",") || "none"}${textPreview}`;
  });
}

function formatInlineCounts(counts: Record<string, number>): string {
  const rows = sortedCounts(new Map(Object.entries(counts)));
  return rows.length > 0 ? rows.map(([reason, count]) => `${reason}=${count}`).join(", ") : "(none)";
}

function formatCrossUtcDay(value: boolean | "unknown" | undefined): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

function formatMemoryCommandDetailEvents(events: MemoryCommandDetail["events"]): string[] {
  if (events.length === 0) return ["  (none)"];
  return events.map(event => {
    const ref = event.ref ? ` ref=${event.ref}` : "";
    const blockReason = event.blockReason ? ` blockReason=${event.blockReason}` : "";
    const attemptedAt = event.attemptedAtIso ? ` attemptedAt=${event.attemptedAtIso}` : "";
    const lastReinforcedAt = event.lastReinforcedAtIso ? ` lastReinforcedAt=${event.lastReinforcedAtIso}` : "";
    const crossUtcDay = event.crossUtcDay !== undefined ? ` crossUtcDay=${formatCrossUtcDay(event.crossUtcDay)}` : "";
    return `  - ${event.createdAt} outcome=${event.outcome}${ref}${blockReason}${attemptedAt}${lastReinforcedAt}${crossUtcDay} reasons=${event.reasonCodes.join(",") || "none"}`;
  });
}

export function formatMemoryCommandDetail(detail: MemoryCommandDetail, options: Pick<CliOptions, "verbose"> = {}): string {
  const current = detail.current;
  const lines = [
    `Memory command diagnostics for ${detail.memoryId}`,
    "",
    "Current memory:",
    `  - present: ${current.present ? "yes" : "no"}`,
    `  - status: ${current.status ?? "unknown"}`,
    `  - render: ${current.renderStatus ?? "unknown"}`,
  ];

  if (current.type) lines.push(`  - type: ${current.type}`);
  if (current.source) lines.push(`  - source: ${current.source}`);

  lines.push("");
  if (detail.summary.attempts === 0) {
    lines.push(`No reinforcement command evidence found for ${detail.memoryId}.`);
    return lines.join("\n");
  }

  lines.push(
    "Reinforcement summary:",
    `  - attempts: ${detail.summary.attempts}`,
    `  - reinforced: ${detail.summary.reinforced}`,
    `  - rejected/blocked: ${detail.summary.rejectedOrBlocked}`,
    `  - window blocked: ${detail.summary.windowBlocked}`,
    `  - block reasons: ${formatInlineCounts(detail.summary.blocksByReason)}`,
    `  - block details missing: ${detail.summary.blockDetailsMissing}`,
    `  - same-session cross UTC day blocks: ${detail.summary.sameSessionCrossUtcDayBlocks}`,
    `  - refs: ${detail.summary.refs.length > 0 ? detail.summary.refs.join(", ") : "(none)"}`,
    "",
  );

  const eventRows = options.verbose ? detail.events : detail.events.slice(-10).reverse();
  if (!options.verbose && detail.events.length > eventRows.length) {
    lines.push(`Latest reinforcement events (showing ${eventRows.length} of ${detail.events.length}):`);
  } else {
    lines.push("Latest reinforcement events:");
  }
  lines.push(...formatMemoryCommandDetailEvents(eventRows));

  return lines.join("\n");
}

export function formatMemoryCommandSummary(summary: MemoryCommandSummary, options: Pick<CliOptions, "verbose" | "noEmoji"> = {}): string {
  const warning = options.noEmoji ? "!" : "⚠";
  const lines = [
    "Memory command diagnostics",
    "",
    "Key metrics:",
    `  - compactions with command evidence: ${summary.compactionsWithCommandEvidence}`,
    `  - reinforce: ${summary.commands.reinforce}`,
    `  - replace: ${summary.commands.replace}`,
    `  - reinforced: ${summary.outcomes.reinforced}`,
    `  - superseded: ${summary.outcomes.superseded}`,
    `  - rejected: ${summary.outcomes.rejected}`,
    `  - blocked: ${summary.outcomes.blocked}`,
    `  - invalid/malformed commands: ${summary.invalidMalformedCommands}`,
    `  - same-type replacements: ${summary.replacements.sameType}`,
    `  - cross-type replacements: ${summary.replacements.crossType}`,
    `  - ${warning} Protected REPLACE blocked: ${summary.protectedReplacements.total} (reinforced: ${summary.protectedReplacements.protectedReinforcedTarget}, source: ${summary.protectedReplacements.protectedMemorySource})`,
    "",
    "Rejection reasons:",
    ...formatReasonCounts(summary.rejectionReasons),
  ];

  if (options.verbose) {
    lines.push("", "Latest command events:", ...formatLatestEvents(summary.latestEvents));
  }

  return lines.join("\n");
}

export async function runCommands(options: CliOptions): Promise<CommandResult> {
  const root = options.workspace ?? process.cwd();
  if (options.memory) {
    const events = await queryEvidenceEvents(root, { memoryId: options.memory });
    const detail = await buildMemoryCommandDetail(root, options.memory, events);

    if (options.json) {
      return { stdout: JSON.stringify(detail, null, 2) };
    }

    return { stdout: formatMemoryCommandDetail(detail, options) };
  }

  const events = await queryEvidenceEvents(root);
  const summary = buildMemoryCommandSummary(events);

  if (options.json) {
    return { stdout: JSON.stringify(summary, null, 2) };
  }

  return { stdout: formatMemoryCommandSummary(summary, options) };
}
