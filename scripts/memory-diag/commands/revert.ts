import { appendEvidenceEvents, queryEvidenceEvents, type EvidenceEventInput, type EvidenceEventV1, type MemoryEvidenceRef } from "../../../src/evidence-log.ts";
import { workspaceMemoryPath } from "../../../src/paths.ts";
import type { LongTermMemoryEntry, WorkspaceMemoryStore } from "../../../src/types.ts";
import { updateWorkspaceMemoryWithAccounting } from "../../../src/workspace-memory.ts";
import { readJSONFile } from "../io.ts";
import { cleanText, truncate } from "../text.ts";
import { CliInputError, type CliOptions, type CommandResult } from "../types.ts";

type ReplacementLink = {
  event: EvidenceEventV1;
  originalId: string;
  replacementId: string;
};

type RevertPlan = ReplacementLink & {
  original: LongTermMemoryEntry;
  replacement: LongTermMemoryEntry;
};

function reject(message: string): never {
  throw new CliInputError(`revert rejected: ${message}`);
}

function memoryRef(memory: LongTermMemoryEntry, status: LongTermMemoryEntry["status"] = memory.status): MemoryEvidenceRef {
  return {
    memoryId: memory.id,
    type: memory.type,
    source: memory.source,
    status,
  };
}

function replacementIdFromEvent(event: EvidenceEventV1): string | undefined {
  return event.relations?.find(relation => relation.role === "superseded_by")?.memory?.memoryId;
}

function originalIdFromEvent(event: EvidenceEventV1): string | undefined {
  return event.memory?.memoryId
    ?? event.relations?.find(relation => relation.role === "superseded")?.memory?.memoryId;
}

function replacementLinkFromEvent(event: EvidenceEventV1): ReplacementLink {
  if (event.type !== "memory_replaced_numbered_ref") {
    reject(`event ${event.eventId} is not a memory_replaced_numbered_ref event`);
  }
  if (event.outcome !== "superseded") {
    reject(`event ${event.eventId} is not a successful numbered replacement`);
  }
  if (!event.reasonCodes.includes("numbered_ref_replace")) {
    reject(`event ${event.eventId} is not a numbered replacement`);
  }

  const originalId = originalIdFromEvent(event);
  const replacementId = replacementIdFromEvent(event);
  if (!originalId || !replacementId) {
    reject(`event ${event.eventId} does not identify original and replacement memories`);
  }

  return { event, originalId, replacementId };
}

function selectReplacementLink(events: EvidenceEventV1[], options: CliOptions): ReplacementLink {
  if (options.event) {
    const event = events.find(item => item.eventId === options.event);
    if (!event) reject(`event ${options.event} was not found`);
    return replacementLinkFromEvent(event);
  }

  const memoryId = options.memory;
  if (!memoryId) reject("missing --memory or --event selector");
  const matches = events
    .filter(event => event.type === "memory_replaced_numbered_ref")
    .filter(event => replacementIdFromEvent(event) === memoryId);

  if (matches.length === 0) {
    reject(`replacement memory ${memoryId} was not created by memory_replaced_numbered_ref`);
  }
  if (matches.length > 1) {
    reject(`replacement memory ${memoryId} has ${matches.length} replacement events; use --event`);
  }

  return replacementLinkFromEvent(matches[0]);
}

function validatePlan(link: ReplacementLink, store: WorkspaceMemoryStore): RevertPlan {
  const byId = new Map(store.entries.map(entry => [entry.id, entry]));
  const original = byId.get(link.originalId);
  const replacement = byId.get(link.replacementId);

  if (!original) reject(`original memory ${link.originalId} is missing`);
  if (!replacement) reject(`replacement memory ${link.replacementId} is missing`);
  if (original.status !== "superseded") reject(`original memory ${original.id} is not superseded`);
  if (replacement.status !== "active") reject(`replacement memory ${replacement.id} is not active`);

  const laterSuperseder = store.entries.find(entry =>
    entry.status === "active"
    && entry.id !== original.id
    && entry.id !== replacement.id
    && (entry.supersedes ?? []).includes(replacement.id)
  );
  if (laterSuperseder) {
    reject(`replacement memory ${replacement.id} is superseded by active memory ${laterSuperseder.id}`);
  }

  return { ...link, original, replacement };
}

async function dryRunPlan(root: string, link: ReplacementLink): Promise<RevertPlan> {
  const rawStore = await readJSONFile<WorkspaceMemoryStore>(await workspaceMemoryPath(root));
  const store: WorkspaceMemoryStore = rawStore ?? {
    version: 1,
    workspace: { root, key: "" },
    limits: { maxRenderedChars: 0, maxEntries: 0 },
    entries: [],
    migrations: [],
    updatedAt: new Date(0).toISOString(),
  };
  return validatePlan(link, store);
}

function revertEvidence(plan: RevertPlan): EvidenceEventInput {
  const replacement = { ...plan.replacement, status: "superseded" as const };
  const original = { ...plan.original, status: "active" as const };
  return {
    type: "memory_reverted_numbered_ref",
    phase: "storage",
    outcome: "recovered",
    memory: memoryRef(replacement, "superseded"),
    relations: [
      { role: "superseded", memory: memoryRef(replacement, "superseded") },
      { role: "recovered", memory: memoryRef(original, "active") },
    ],
    reasonCodes: ["manual_revert_numbered_ref"],
    details: {
      replacementEventId: plan.event.eventId,
      replacementMemoryId: plan.replacementId,
      restoredMemoryId: plan.originalId,
    },
    textPreview: original.text,
  };
}

async function applyPlan(root: string, link: ReplacementLink): Promise<RevertPlan> {
  let applied: RevertPlan | undefined;
  const updateResult = await updateWorkspaceMemoryWithAccounting(root, store => {
    const plan = validatePlan(link, store);
    const nowIso = new Date().toISOString();
    applied = {
      ...plan,
      original: { ...plan.original, status: "active", updatedAt: nowIso },
      replacement: { ...plan.replacement, status: "superseded", updatedAt: nowIso },
    };

    return {
      ...store,
      entries: store.entries.map(entry => {
        if (entry.id === plan.originalId) return applied!.original;
        if (entry.id === plan.replacementId) return applied!.replacement;
        return entry;
      }),
      updatedAt: nowIso,
      lastActivityAt: nowIso,
    };
  });

  if (!applied) reject("unable to apply revert");
  await appendEvidenceEvents(root, [...updateResult.evidence, revertEvidence(applied)]);
  return applied;
}

function formatPlan(plan: RevertPlan, applied: boolean): string {
  const heading = applied ? "Memory revert applied" : "Memory revert dry run";
  const nextStep = applied ? "Changes applied." : "No changes applied. Re-run with --apply to mutate workspace memory.";
  return [
    heading,
    "",
    "Planned changes:",
    `  - replacement: ${plan.replacementId} active -> superseded`,
    `  - original: ${plan.originalId} superseded -> active`,
    `  - replacement event: ${plan.event.eventId}`,
    `  - restored text: ${truncate(cleanText(plan.original.text, false), 100)}`,
    "",
    nextStep,
  ].join("\n");
}

export async function runRevert(options: CliOptions): Promise<CommandResult> {
  const root = options.workspace ?? process.cwd();
  const events = await queryEvidenceEvents(root);
  const link = selectReplacementLink(events, options);
  const plan = options.apply ? await applyPlan(root, link) : await dryRunPlan(root, link);
  return { stdout: formatPlan(plan, options.apply === true) };
}
