import { queryEvidenceEvents, type EvidenceEventV1, type EvidenceOutcome } from "../../../src/evidence-log.ts";
import { objectFromCounts, sortedCounts } from "../text.ts";
import type { CliOptions, CommandResult } from "../types.ts";

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
  const events = await queryEvidenceEvents(root);
  const summary = buildMemoryCommandSummary(events);

  if (options.json) {
    return { stdout: JSON.stringify(summary, null, 2) };
  }

  return { stdout: formatMemoryCommandSummary(summary, options) };
}
