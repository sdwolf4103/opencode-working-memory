import { createHash } from "node:crypto";
import type { EvidenceEventV1 } from "../../src/evidence-log.ts";
import { RETENTION_TYPE_MAX } from "../../src/retention.ts";
import type { LongTermMemoryEntry, LongTermType } from "../../src/types.ts";
import { TYPES } from "./constants.ts";
import { disappearanceRows } from "./inspection-model.ts";
import { rejectionQualitySummary, uniqueByCanonicalText } from "./rejections-model.ts";
import { canonicalMemoryText, cleanText, countBy, objectFromCounts, truncate, uniqueStrings, workspaceRootHash } from "./text.ts";
import type { MemoryInspectionReadModel, NormalizedRejection } from "./types.ts";

export type ReviewBoardReport = {
  version: 1;
  generatedAt: string;
  workspace: { rootHash: string; key: string };
  purpose: "review_evidence_only";
  languageGuidance: {
    nonAuthoritative: true;
    mutation: "none";
    rawReasonCodesAreEvidence: true;
    producerVersionRecorded: false;
    provenanceInferenceOnly: true;
    primaryReviewPurpose: "system_mechanism_observations";
    secondaryReviewPurpose: "memory_content_quality";
  };
  provenanceContext: {
    method: "migration_timestamp_and_format_inference";
    confidenceDisclaimer: string;
    falseCurrentRiskBias: "prefer_unversioned_ambiguous_when_uncertain";
    producerVersionAvailable: false;
    migrationTimeline: Array<{ migrationId: string; presentInStore: boolean; firstEvidenceAt?: string }>;
    lastActivityAt?: string;
    countsByClassification: Record<ProvenanceClassification, number>;
    candidateLimit?: number;
    candidateDisplay?: {
      shown: number;
      total: number;
      byMechanism: Record<string, { shown: number; total: number }>;
    };
  };
  facts: {
    systemMechanisms: {
      rejectionFilters: {
        totalRecords: number;
        uniqueTexts: number;
        byRawReasonCode: Record<string, number>;
        byType: Record<string, number>;
        ambiguousOrArchitectureLike: number;
        hardReasonOrNoiseHeuristic: number;
        reabsorbedRejectedTexts: number;
      };
      reinforcementRules: {
        reinforceEvents: number;
        reinforcedEvents: number;
        rejectedOrBlockedEvents: number;
        windowBlockedEvents: number;
        windowBlockRate: number;
        repeatedBlocksByMemory: Array<{ memoryId: string; count: number; refs: string[]; rawReasonCodes: string[] }>;
        malformedCommandEvents: number;
      };
      evictionAndCaps: {
        activeMemories: number;
        maxEntries: number;
        renderedMemories: number;
        typeCounts: Record<string, number>;
        typeCaps: Record<string, number>;
        fullCaps: string[];
        missingEvidenceOnly: number;
        unknownDisappearances: number;
        removedByCapacity: number;
        removedByGlobalCap: number;
        removedByTypeCap: number;
        recentEvictionsByType: Record<string, number>;
        recentEvictedContentShown: number;
      };
      identityAndDedup: {
        replacementEvents: number;
        sameTypeReplacementEvents: number;
        crossTypeReplacementEvents: number;
        supersededEntries: number;
        duplicateTextOrIdentityGroups: number;
      };
    };
    memoryContent: {
      activeMemories: number;
      renderedMemories: number;
      evidenceCoverage: { covered: number; total: number };
      typeCounts: Record<string, number>;
      typeCaps: Record<string, number>;
      weakestActiveMemories: Array<{ id: string; type: string; strength?: number; textPreview: string }>;
      strongestActiveMemories: Array<{ id: string; type: string; strength?: number; textPreview: string }>;
    };
  };
  activeMemoryDisplay: {
    threshold: number;
    mode: "all" | "sample";
    shown: number;
    total: number;
    items: ReviewBoardActiveMemory[];
  };
  reviewCandidates: ReviewBoardCandidate[];
  reviewQuestions: {
    systemMechanism: string[];
    memoryContent: string[];
  };
  nextCommands: string[];
};

export type ReviewBoardActiveMemory = {
  id: string;
  type: string;
  source: string;
  status: string;
  strength?: number;
  text: string;
  evidence: { eventCount: number; eventIds: string[]; rawReasonCodes: string[] };
  provenance?: CandidateProvenance;
  heuristicFlags: HeuristicFlag[];
  reviewQuestions: string[];
};

export type ReviewBoardCandidate = {
  concernKind: "system_mechanism" | "memory_content";
  mechanism?: "rejection_filter" | "reinforcement_rule" | "eviction_cap" | "identity_dedup" | "retention_rendering";
  source:
    | "active_memory"
    | "rejection_rule_evidence"
    | "missing_evidence"
    | "numbered_command_evidence"
    | "eviction_cap_evidence"
    | "reabsorption_evidence"
    | "identity_dedup_evidence";
  id: string;
  facts: Record<string, unknown>;
  evidence: { eventIds?: string[]; rawReasonCodes?: string[]; textPreview?: string; textAvailable: boolean };
  provenance?: CandidateProvenance;
  heuristicFlags: HeuristicFlag[];
  reviewQuestions: string[];
  nextCommands: string[];
};

export type ProvenanceClassification =
  | "explicit_migration_evidence"
  | "legacy_unversioned_format"
  | "reabsorbed_post_rejection"
  | "suspected_pre_migration_legacy"
  | "likely_current_behavior"
  | "unversioned_ambiguous";

export type CandidateProvenance = {
  classification: ProvenanceClassification;
  confidence: "high" | "medium" | "low";
  basis: string[];
  interpretationCaveat: string;
};

export type HeuristicFlag = {
  id: string;
  label: string;
  evidence: string;
  caveat: string;
};

export const ACTIVE_MEMORY_FULL_TEXT_THRESHOLD = 40;
export const REPRESENTATIVE_CANDIDATE_LIMIT = 10;
export const RECENT_EVICTION_DAYS = 7;

const KNOWN_MIGRATION_IDS = [
  "2026-04-26-p0-cleanup",
  "2026-04-28-quality-cleanup",
  "2026-05-01-retention-clock-backfill",
] as const;

const PROVENANCE_CLASSIFICATIONS: ProvenanceClassification[] = [
  "explicit_migration_evidence",
  "legacy_unversioned_format",
  "reabsorbed_post_rejection",
  "suspected_pre_migration_legacy",
  "likely_current_behavior",
  "unversioned_ambiguous",
];

const HARD_OR_NOISE_REASON_CODES = new Set([
  "progress_snapshot",
  "active_file_snapshot",
  "commit_or_ci_snapshot",
  "temporary_status",
  "raw_error",
  "code_or_api_signature",
  "bad_feedback",
]);

const MALFORMED_COMMAND_REASON_CODES = new Set([
  "invalid_memory_command",
  "invalid_memory_ref",
  "invalid_memory_type",
  "empty_replacement_text",
]);

type ReabsorbedMatch = {
  key: string;
  record: NormalizedRejection;
  activeMemory: LongTermMemoryEntry;
};

type ProvenanceContextInputs = {
  firstMigrationBoundary?: string;
  latestMigrationBoundary?: string;
  lastActivityAt?: string;
};

type DatedCandidateInput = {
  candidate: ReviewBoardCandidate;
  timestamp?: string;
  tieId: string;
  textHash?: string;
};

export function buildQualityReviewBoard(
  model: MemoryInspectionReadModel,
  options: { verbose?: boolean; raw?: boolean; noEmoji?: boolean; json?: boolean },
  generatedAt = new Date().toISOString(),
): ReviewBoardReport {
  const raw = options.raw === true;
  const activeMemories = model.store.entries.filter(entry => entry.status !== "superseded");
  const typeCounts = typeCountsFor(activeMemories);
  const typeCaps = Object.fromEntries(TYPES.map(type => [type, RETENTION_TYPE_MAX[type]]));
  const rejectionSummary = rejectionQualitySummary(model.rejectionRecords);
  const rejectionGroups = rejectionSummary.possibleFalsePositiveGroups;
  const migrationTimeline = buildMigrationTimeline(model);
  const provenanceInputs = migrationBoundaries(model);
  const activeKeyMatches = reabsorbedRejectedMatches(activeMemories, model.rejectionRecords);
  const reabsorbedKeys = new Set(activeKeyMatches.map(match => match.key));
  const activeMemoryByKey = new Map(activeKeyMatches.map(match => [match.key, match.activeMemory]));
  const disappearances = disappearanceRows(model);
  const reinforcementFacts = buildReinforcementFacts(model.evidenceEvents);
  const evictionFacts = buildEvictionFacts(model, activeMemories, typeCounts, typeCaps, disappearances, generatedAt);
  const identityFacts = buildIdentityFacts(model, activeMemories);
  const memoryContentFacts = buildMemoryContentFacts(model, activeMemories, typeCounts, typeCaps, raw);
  const systemMechanismCandidateInputs = {
    rejection_filter: [
      ...buildRejectionCandidates(model.rejectionRecords, provenanceInputs, raw),
      ...buildReabsorptionCandidates(activeKeyMatches, provenanceInputs, raw),
    ],
    reinforcement_rule: buildReinforcementCandidates(model.evidenceEvents, provenanceInputs, raw),
    eviction_cap: buildEvictionCandidates(disappearances, model.evidenceEvents, provenanceInputs, raw, generatedAt),
    identity_dedup: buildIdentityCandidates(model, activeMemories, provenanceInputs, raw),
  };
  const showAllSystemMechanismCandidates = options.verbose === true || options.json === true;
  const systemCandidateDisplay = buildSystemCandidateDisplay(systemMechanismCandidateInputs, showAllSystemMechanismCandidates);
  const allSystemMechanismCandidates = Object.values(systemMechanismCandidateInputs)
    .flatMap(inputs => selectRepresentative(inputs, true).map(item => item.candidate));
  const reviewCandidates = [
    ...systemCandidateDisplay.candidates,
    ...buildMemoryContentCandidates(model, activeMemories, raw),
  ];
  const activeMemoryDisplay = buildActiveMemoryDisplay(model, activeMemories, reabsorbedKeys, activeMemoryByKey, provenanceInputs, raw, options.verbose === true);
  const countsByClassification = countProvenanceClassifications(allSystemMechanismCandidates);

  return {
    version: 1,
    generatedAt,
    workspace: {
      rootHash: workspaceRootHash(model.snapshot?.store?.workspace?.root ?? model.store.workspace.root),
      key: model.snapshot?.store?.workspace?.key ?? model.store.workspace.key,
    },
    purpose: "review_evidence_only",
    languageGuidance: {
      nonAuthoritative: true,
      mutation: "none",
      rawReasonCodesAreEvidence: true,
      producerVersionRecorded: false,
      provenanceInferenceOnly: true,
      primaryReviewPurpose: "system_mechanism_observations",
      secondaryReviewPurpose: "memory_content_quality",
    },
    provenanceContext: {
      method: "migration_timestamp_and_format_inference",
      confidenceDisclaimer: "Producer version is not recorded in historical evidence; provenance is inferred and should not be used as proof of current behavior.",
      falseCurrentRiskBias: "prefer_unversioned_ambiguous_when_uncertain",
      producerVersionAvailable: false,
      migrationTimeline,
      lastActivityAt: model.store.lastActivityAt,
      countsByClassification,
      ...(systemCandidateDisplay.limited ? { candidateLimit: REPRESENTATIVE_CANDIDATE_LIMIT, candidateDisplay: systemCandidateDisplay.summary } : {}),
    },
    facts: {
      systemMechanisms: {
        rejectionFilters: {
          totalRecords: rejectionSummary.totalRecords,
          uniqueTexts: rejectionSummary.uniqueTexts,
          byRawReasonCode: rejectionSummary.reasonDistribution,
          byType: objectFromCounts(countBy(model.rejectionRecords.map(record => record.type))),
          ambiguousOrArchitectureLike:
            (rejectionGroups.architecture_like_possible_false_positive?.count ?? 0)
            + (rejectionGroups.ambiguous?.count ?? 0),
          hardReasonOrNoiseHeuristic: rejectionGroups.clearly_garbage?.count ?? 0,
          reabsorbedRejectedTexts: new Set(activeKeyMatches.map(match => match.key)).size,
        },
        reinforcementRules: reinforcementFacts,
        evictionAndCaps: evictionFacts,
        identityAndDedup: identityFacts,
      },
      memoryContent: memoryContentFacts,
    },
    activeMemoryDisplay,
    reviewCandidates,
    reviewQuestions: {
      systemMechanism: systemMechanismQuestions(),
      memoryContent: memoryContentQuestions(),
    },
    nextCommands: nextCommands(),
  };
}

function typeCountsFor(entries: LongTermMemoryEntry[]): Record<string, number> {
  return Object.fromEntries(TYPES.map(type => [type, entries.filter(entry => entry.type === type).length]));
}

function buildMigrationTimeline(model: MemoryInspectionReadModel): ReviewBoardReport["provenanceContext"]["migrationTimeline"] {
  const present = new Set(model.store.migrations ?? []);
  return KNOWN_MIGRATION_IDS.map(migrationId => {
    const matchingTimes = model.evidenceEvents
      .filter(event => event.details?.migrationId === migrationId)
      .map(event => event.createdAt)
      .sort();
    const row: { migrationId: string; presentInStore: boolean; firstEvidenceAt?: string } = {
      migrationId,
      presentInStore: present.has(migrationId),
    };
    if (matchingTimes[0]) row.firstEvidenceAt = matchingTimes[0];
    return row;
  });
}

function migrationBoundaries(model: MemoryInspectionReadModel): ProvenanceContextInputs {
  const present = new Set(model.store.migrations ?? []);
  const matchingTimes = model.evidenceEvents
    .filter(event => typeof event.details?.migrationId === "string" && present.has(event.details.migrationId))
    .map(event => event.createdAt)
    .sort();
  return {
    firstMigrationBoundary: matchingTimes[0],
    latestMigrationBoundary: matchingTimes[matchingTimes.length - 1],
    lastActivityAt: model.store.lastActivityAt,
  };
}

function classifyProvenance(input: {
  event?: EvidenceEventV1;
  rejection?: NormalizedRejection;
  reabsorbed?: boolean;
}, context: ProvenanceContextInputs): CandidateProvenance {
  if (input.event?.details?.migrationId) {
    return provenance("explicit_migration_evidence", "high", [`migration evidence event ${String(input.event.details.migrationId)}`]);
  }
  if (input.rejection && !hasWorkspaceScope(input.rejection)) {
    return provenance("legacy_unversioned_format", "high", ["rejection record without workspace scope fields"]);
  }
  if (input.reabsorbed) {
    return provenance("reabsorbed_post_rejection", "high", ["typed canonical rejected text appears in active memory"]);
  }

  const timestamp = input.event?.createdAt ?? input.rejection?.timestamp;
  if (timestamp && context.firstMigrationBoundary && compareIso(timestamp, context.firstMigrationBoundary) < 0) {
    return provenance("suspected_pre_migration_legacy", "medium", ["evidence timestamp predates first known migration boundary"]);
  }
  if (timestamp && context.latestMigrationBoundary && compareIso(timestamp, context.latestMigrationBoundary) >= 0) {
    if (!context.lastActivityAt || compareIso(timestamp, context.lastActivityAt) >= 0) {
      return provenance("likely_current_behavior", "medium", ["evidence timestamp is after known migration evidence and workspace last activity"]);
    }
  }
  return provenance("unversioned_ambiguous", "low", ["no producer version or decisive migration/timestamp signal is recorded"]);
}

function provenance(classification: ProvenanceClassification, confidence: CandidateProvenance["confidence"], basis: string[]): CandidateProvenance {
  return {
    classification,
    confidence,
    basis,
    interpretationCaveat: "Producer version is not recorded; treat this as inferred review context rather than proof of current behavior.",
  };
}

function hasWorkspaceScope(record: NormalizedRejection): boolean {
  return Boolean(record.workspaceKey || record.workspaceRoot || record.workspaceRootHash);
}

function compareIso(a: string, b: string): number {
  const aTime = new Date(a).getTime();
  const bTime = new Date(b).getTime();
  if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) return 0;
  return aTime - bTime;
}

function reabsorbedRejectedMatches(activeMemories: LongTermMemoryEntry[], records: NormalizedRejection[]): ReabsorbedMatch[] {
  const activeByKey = new Map(activeMemories.map(memory => [typedCanonicalKey(memory.type, memory.text), memory]));
  const matches: ReabsorbedMatch[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const key = typedCanonicalKey(record.type, record.text);
    const activeMemory = activeByKey.get(key);
    if (!activeMemory || seen.has(key)) continue;
    seen.add(key);
    matches.push({ key, record, activeMemory });
  }
  return matches;
}

function typedCanonicalKey(type: LongTermType | string, text: string): string {
  return `${type}:${canonicalMemoryText(text)}`;
}

function buildReinforcementFacts(events: EvidenceEventV1[]): ReviewBoardReport["facts"]["systemMechanisms"]["reinforcementRules"] {
  const attempts = events.filter(isReinforcementEvent);
  const windowBlocked = attempts.filter(event => event.reasonCodes.includes("reinforcement_window_blocked"));
  const grouped = new Map<string, { memoryId: string; count: number; refs: Set<string>; rawReasonCodes: Set<string>; eventIds: string[] }>();
  for (const event of windowBlocked) {
    const memoryId = event.memory?.memoryId ?? "unknown";
    const current = grouped.get(memoryId) ?? { memoryId, count: 0, refs: new Set<string>(), rawReasonCodes: new Set<string>(), eventIds: [] };
    current.count += 1;
    current.eventIds.push(event.eventId);
    const ref = typeof event.details?.ref === "string" ? event.details.ref : undefined;
    if (ref) current.refs.add(ref);
    for (const reason of event.reasonCodes) current.rawReasonCodes.add(reason);
    grouped.set(memoryId, current);
  }

  return {
    reinforceEvents: attempts.length,
    reinforcedEvents: attempts.filter(event => event.outcome === "reinforced" || event.type === "memory_reinforced" && event.outcome !== "rejected").length,
    rejectedOrBlockedEvents: attempts.filter(event => event.outcome === "rejected" || event.reasonCodes.includes("reinforcement_window_blocked")).length,
    windowBlockedEvents: windowBlocked.length,
    windowBlockRate: attempts.length === 0 ? 0 : windowBlocked.length / attempts.length,
    repeatedBlocksByMemory: [...grouped.values()]
      .filter(group => group.count > 1)
      .sort((a, b) => b.count - a.count || a.memoryId.localeCompare(b.memoryId))
      .map(group => ({ memoryId: group.memoryId, count: group.count, refs: [...group.refs].sort(), rawReasonCodes: [...group.rawReasonCodes].sort() })),
    malformedCommandEvents: events.filter(isMalformedCommandEvent).length,
  };
}

function isReinforcementEvent(event: EvidenceEventV1): boolean {
  const type = String(event.type);
  return type === "memory_reinforced"
    || type === "reinforce_memory"
    || type === "reinforced"
    || event.phase === "reinforcement";
}

function isMalformedCommandEvent(event: EvidenceEventV1): boolean {
  return event.type === "extraction_candidate_rejected"
    && event.reasonCodes.some(reason => MALFORMED_COMMAND_REASON_CODES.has(reason));
}

function buildEvictionFacts(
  model: MemoryInspectionReadModel,
  activeMemories: LongTermMemoryEntry[],
  typeCounts: Record<string, number>,
  typeCaps: Record<string, number>,
  disappearances: ReturnType<typeof disappearanceRows>,
  generatedAt: string,
): ReviewBoardReport["facts"]["systemMechanisms"]["evictionAndCaps"] {
  const capacityEvents = model.evidenceEvents.filter(event => event.type === "memory_removed_capacity");
  const recentCapacityEvents = capacityEvents.filter(event => isWithinDaysOf(event.createdAt, generatedAt, RECENT_EVICTION_DAYS));
  const fullCaps = [
    ...(activeMemories.length >= model.store.limits.maxEntries ? ["global"] : []),
    ...TYPES.filter(type => (typeCounts[type] ?? 0) >= (typeCaps[type] ?? Number.POSITIVE_INFINITY)),
  ];

  return {
    activeMemories: activeMemories.length,
    maxEntries: model.store.limits.maxEntries,
    renderedMemories: model.snapshot.retention.rendered.length,
    typeCounts,
    typeCaps,
    fullCaps,
    missingEvidenceOnly: disappearances.length,
    unknownDisappearances: disappearances.filter(row => row.classification === "historical_absent_unknown_reason").length,
    removedByCapacity: capacityEvents.length,
    removedByGlobalCap: capacityEvents.filter(event => event.reasonCodes.includes("global_cap")).length,
    removedByTypeCap: capacityEvents.filter(event => event.reasonCodes.includes("type_cap")).length,
    recentEvictionsByType: objectFromCounts(countBy(recentCapacityEvents.map(event => event.memory?.type ?? "unknown"))),
    recentEvictedContentShown: recentCapacityEvents.length,
  };
}

function isWithinDaysOf(iso: string, referenceIso: string, days: number): boolean {
  const time = new Date(iso).getTime();
  const reference = new Date(referenceIso).getTime();
  return Number.isFinite(time) && Number.isFinite(reference) && time >= reference - days * 86_400_000;
}

function buildIdentityFacts(model: MemoryInspectionReadModel, activeMemories: LongTermMemoryEntry[]): ReviewBoardReport["facts"]["systemMechanisms"]["identityAndDedup"] {
  const replacementEvents = model.evidenceEvents.filter(event => event.type === "memory_replaced_numbered_ref");
  return {
    replacementEvents: replacementEvents.length,
    sameTypeReplacementEvents: replacementEvents.filter(isSameTypeReplacement).length,
    crossTypeReplacementEvents: replacementEvents.filter(isCrossTypeReplacement).length,
    supersededEntries: model.store.entries.filter(entry => entry.status === "superseded").length,
    duplicateTextOrIdentityGroups: duplicateGroups(activeMemories, model.evidenceEvents).length,
  };
}

function isSameTypeReplacement(event: EvidenceEventV1): boolean {
  if (event.reasonCodes.includes("same_type_replace")) return true;
  const types = relationTypes(event);
  return types.length >= 2 && new Set(types).size === 1;
}

function isCrossTypeReplacement(event: EvidenceEventV1): boolean {
  if (event.reasonCodes.includes("cross_type_replace")) return true;
  const types = relationTypes(event);
  return types.length >= 2 && new Set(types).size > 1;
}

function relationTypes(event: EvidenceEventV1): string[] {
  return uniqueStrings(event.relations?.map(relation => relation.memory?.type ?? "") ?? []);
}

function duplicateGroups(activeMemories: LongTermMemoryEntry[], events: EvidenceEventV1[]): Array<{ id: string; memoryIds: string[]; basis: string }> {
  const groups: Array<{ id: string; memoryIds: string[]; basis: string }> = [];
  const byText = groupBy(activeMemories, memory => typedCanonicalKey(memory.type, memory.text));
  for (const [key, memories] of byText.entries()) {
    if (memories.length > 1) groups.push({ id: `text:${hashText(key)}`, memoryIds: memories.map(memory => memory.id).sort(), basis: "exact typed canonical text" });
  }
  const identityRefs = events
    .map(event => event.memory)
    .filter((memory): memory is NonNullable<EvidenceEventV1["memory"]> => Boolean(memory?.identityKeyHash && memory.memoryId));
  const byIdentity = groupBy(identityRefs, memory => String(memory.identityKeyHash));
  for (const [key, refs] of byIdentity.entries()) {
    const ids = uniqueStrings(refs.map(ref => ref.memoryId ?? "")).sort();
    if (ids.length > 1) groups.push({ id: `identity:${hashText(key)}`, memoryIds: ids, basis: "shared evidence identity hash" });
  }
  return groups;
}

function groupBy<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

function buildMemoryContentFacts(
  model: MemoryInspectionReadModel,
  activeMemories: LongTermMemoryEntry[],
  typeCounts: Record<string, number>,
  typeCaps: Record<string, number>,
  raw: boolean,
): ReviewBoardReport["facts"]["memoryContent"] {
  const evidenceCovered = activeMemories.filter(memory => (model.evidenceByMemoryId.get(memory.id) ?? []).length > 0).length;
  const weakest = model.snapshot.retention.sorted.slice(-5).reverse();
  const strongest = model.snapshot.retention.sorted.slice(0, 5);
  return {
    activeMemories: activeMemories.length,
    renderedMemories: model.snapshot.retention.rendered.length,
    evidenceCoverage: { covered: evidenceCovered, total: activeMemories.length },
    typeCounts,
    typeCaps,
    weakestActiveMemories: weakest.map(item => retentionPreview(item.entry, item.strength, raw)),
    strongestActiveMemories: strongest.map(item => retentionPreview(item.entry, item.strength, raw)),
  };
}

function retentionPreview(entry: LongTermMemoryEntry, strength: number | undefined, raw: boolean): { id: string; type: string; strength?: number; textPreview: string } {
  return { id: entry.id, type: entry.type, strength, textPreview: truncate(cleanText(entry.text, raw), 120) };
}

function buildActiveMemoryDisplay(
  model: MemoryInspectionReadModel,
  activeMemories: LongTermMemoryEntry[],
  reabsorbedKeys: Set<string>,
  activeMemoryByKey: Map<string, LongTermMemoryEntry>,
  provenanceInputs: ProvenanceContextInputs,
  raw: boolean,
  verbose: boolean,
): ReviewBoardReport["activeMemoryDisplay"] {
  const mode: "all" | "sample" = activeMemories.length <= ACTIVE_MEMORY_FULL_TEXT_THRESHOLD || verbose ? "all" : "sample";
  const shownMemories = mode === "all" ? activeMemories : activeMemories.slice(0, ACTIVE_MEMORY_FULL_TEXT_THRESHOLD);
  const items = shownMemories.map(memory => {
    const events = model.evidenceByMemoryId.get(memory.id) ?? [];
    const key = typedCanonicalKey(memory.type, memory.text);
    const item: ReviewBoardActiveMemory = {
      id: memory.id,
      type: memory.type,
      source: memory.source,
      status: memory.status,
      strength: model.snapshot.retention.sorted.find(candidate => candidate.entry.id === memory.id)?.strength,
      text: cleanText(memory.text, raw),
      evidence: {
        eventCount: events.length,
        eventIds: events.map(event => event.eventId),
        rawReasonCodes: uniqueStrings(events.flatMap(event => event.reasonCodes)).sort(),
      },
      heuristicFlags: activeMemoryFlags(memory, events),
      reviewQuestions: memoryContentQuestions(),
    };
    if (reabsorbedKeys.has(key) && activeMemoryByKey.get(key)?.id === memory.id) {
      item.provenance = classifyProvenance({ reabsorbed: true }, provenanceInputs);
    }
    return item;
  });
  return { threshold: ACTIVE_MEMORY_FULL_TEXT_THRESHOLD, mode, shown: items.length, total: activeMemories.length, items };
}

function activeMemoryFlags(memory: LongTermMemoryEntry, events: EvidenceEventV1[]): HeuristicFlag[] {
  const flags: HeuristicFlag[] = [];
  if (events.length === 0) {
    flags.push(flag("no_evidence", "No linked evidence events", `memory ${memory.id} has no lifecycle evidence events`));
  }
  if ((memory.supersedes ?? []).length > 0) {
    flags.push(flag("supersedes_other_memory", "Supersession relationship present", `memory ${memory.id} supersedes ${memory.supersedes?.length ?? 0} prior entries`));
  }
  return flags;
}

function buildSystemCandidateDisplay(
  candidateInputs: Record<string, DatedCandidateInput[]>,
  showAll: boolean,
): { candidates: ReviewBoardCandidate[]; limited: boolean; summary: NonNullable<ReviewBoardReport["provenanceContext"]["candidateDisplay"]> } {
  const candidates: ReviewBoardCandidate[] = [];
  const byMechanism: Record<string, { shown: number; total: number }> = {};
  let shown = 0;
  let total = 0;
  let limited = false;

  for (const [mechanism, inputs] of Object.entries(candidateInputs)) {
    const selected = selectRepresentative(inputs, showAll);
    candidates.push(...selected.map(item => item.candidate));
    byMechanism[mechanism] = { shown: selected.length, total: inputs.length };
    shown += selected.length;
    total += inputs.length;
    if (selected.length < inputs.length) limited = true;
  }

  return { candidates, limited, summary: { shown, total, byMechanism } };
}

function buildRejectionCandidates(records: NormalizedRejection[], context: ProvenanceContextInputs, raw: boolean): DatedCandidateInput[] {
  const candidateRecords = records
    .filter(record => record.reasons.includes("bad_decision"))
    .map(record => ({ record, label: neutralRejectionLabel(record) }))
    .filter(item => item.label === "architecture_like_rejected_candidate" || item.label === "ambiguous_rejected_candidate")
    .sort((a, b) =>
      timestampValue(b.record.timestamp) - timestampValue(a.record.timestamp)
      || a.record.type.localeCompare(b.record.type)
      || a.record.text.localeCompare(b.record.text)
    );

  const candidates = uniqueByCanonicalText(candidateRecords.map(item => item.record))
    .map(record => ({ record, label: neutralRejectionLabel(record) }))
    .map(({ record, label }) => ({
      candidate: candidate({
        concernKind: "system_mechanism",
        mechanism: "rejection_filter",
        source: "rejection_rule_evidence",
        id: `rejection:${record.timestamp || "unknown"}:${hashText(record.type + record.text)}`,
        facts: { type: record.type, neutralLabel: label, timestamp: record.timestamp || undefined, origin: record.origin },
        evidence: { rawReasonCodes: record.reasons, textPreview: truncate(cleanText(record.text, raw), 120), textAvailable: true },
        provenance: classifyProvenance({ rejection: record }, context),
        heuristicFlags: [flag(label, label.replaceAll("_", " "), "existing rejection summary grouped this record for human review")],
        reviewQuestions: ["Are rejection filters over-filtering durable decisions or under-filtering non-durable candidates for this workspace?"],
        nextCommands: ["memory-diag rejected --verbose"],
      }),
      timestamp: record.timestamp,
      tieId: record.timestamp || "unknown",
      textHash: hashText(record.text),
    }));
  return candidates;
}

function neutralRejectionLabel(record: NormalizedRejection): "architecture_like_rejected_candidate" | "ambiguous_rejected_candidate" | "status_or_hard_reason_evidence" {
  const hardReasons = record.reasons.filter(reason => HARD_OR_NOISE_REASON_CODES.has(reason));
  const statusLike = /\b(?:implemented|added|updated|fixed|completed|reviewed|tests?|CI|commit|wave|phase|task|session)\b/i.test(record.text);
  const architectureLike = /\b(?:architecture|retention|migration|schema|policy|model|dedup|identity|parser|formatter|diagnostic|evidence|cap|window|api|contract)\b/i.test(record.text);
  if (architectureLike && hardReasons.length === 0 && !statusLike) return "architecture_like_rejected_candidate";
  if (hardReasons.length > 0 || statusLike) return "status_or_hard_reason_evidence";
  return "ambiguous_rejected_candidate";
}

function buildReabsorptionCandidates(matches: ReabsorbedMatch[], context: ProvenanceContextInputs, raw: boolean): DatedCandidateInput[] {
  const candidates = matches.map(match => ({
    candidate: candidate({
      concernKind: "system_mechanism",
      mechanism: "rejection_filter",
      source: "reabsorption_evidence",
      id: `reabsorbed:${match.activeMemory.id}:${hashText(match.key)}`,
      facts: { activeMemoryId: match.activeMemory.id, type: match.activeMemory.type, rejectedAt: match.record.timestamp || undefined },
      evidence: { rawReasonCodes: match.record.reasons, textPreview: truncate(cleanText(match.record.text, raw), 120), textAvailable: true },
      provenance: classifyProvenance({ rejection: match.record, reabsorbed: true }, context),
      heuristicFlags: [flag("reabsorbed_rejected_text", "Rejected text appears in active memory", "typed canonical text is present in both rejection records and active memory")],
      reviewQuestions: ["Did later context make this rejected candidate worth reviewing for filter calibration?"],
      nextCommands: ["memory-diag rejected --verbose", `memory-diag explain ${match.activeMemory.id}`],
    }),
    timestamp: match.record.timestamp,
    tieId: match.activeMemory.id,
    textHash: hashText(match.key),
  }));
  return candidates;
}

function buildReinforcementCandidates(events: EvidenceEventV1[], context: ProvenanceContextInputs, raw: boolean): DatedCandidateInput[] {
  const blocked = events.filter(event => isReinforcementEvent(event) && event.reasonCodes.includes("reinforcement_window_blocked"));
  const grouped = [...groupBy(blocked, event => event.memory?.memoryId ?? "unknown").entries()].map(([memoryId, group]) => ({ memoryId, group }));
  const repeated = grouped.filter(item => item.group.length > 1).map(item => {
    const latest = newestEvent(item.group);
    return {
      candidate: candidate({
        concernKind: "system_mechanism",
        mechanism: "reinforcement_rule",
        source: "numbered_command_evidence",
        id: `reinforcement:${item.memoryId}:${item.group.length}`,
        facts: { memoryId: item.memoryId, blockCount: item.group.length, refs: uniqueStrings(item.group.map(event => String(event.details?.ref ?? "")).filter(Boolean)).sort() },
        evidence: { eventIds: item.group.map(event => event.eventId), rawReasonCodes: uniqueStrings(item.group.flatMap(event => event.reasonCodes)).sort(), textAvailable: false },
        provenance: classifyProvenance({ event: latest }, context),
        heuristicFlags: [flag("repeated_reinforcement_window_block", "Repeated reinforcement window block", `${item.group.length} reinforcement attempts were blocked for memory ${item.memoryId}`)],
        reviewQuestions: ["Is the day-based reinforcement window too restrictive when the same memory receives repeated reinforce intent?"],
        nextCommands: ["memory-diag commands --verbose", `memory-diag explain ${item.memoryId}`],
      }),
      timestamp: latest?.createdAt,
      tieId: item.memoryId,
      textHash: item.memoryId,
    };
  });
  const malformed = events.filter(isMalformedCommandEvent).map(event => ({
    candidate: candidate({
      concernKind: "system_mechanism",
      mechanism: "reinforcement_rule",
      source: "numbered_command_evidence",
      id: `malformed-command:${event.eventId}`,
      facts: { eventType: event.type, createdAt: event.createdAt },
      evidence: { eventIds: [event.eventId], rawReasonCodes: event.reasonCodes, textPreview: event.textPreview ? truncate(cleanText(event.textPreview, raw), 120) : undefined, textAvailable: Boolean(event.textPreview) },
      provenance: classifyProvenance({ event }, context),
      heuristicFlags: [flag("malformed_numbered_command", "Malformed numbered-memory command evidence", "command parser rejected a memory command form")],
      reviewQuestions: ["Do numbered-memory command rules match how agents actually express reinforcement intent?"],
      nextCommands: ["memory-diag commands --verbose"],
    }),
    timestamp: event.createdAt,
    tieId: event.eventId,
    textHash: event.eventId,
  }));
  return [...repeated, ...malformed];
}

function buildEvictionCandidates(
  disappearances: ReturnType<typeof disappearanceRows>,
  events: EvidenceEventV1[],
  context: ProvenanceContextInputs,
  raw: boolean,
  generatedAt: string,
): DatedCandidateInput[] {
  const recentCapacity = events.filter(event => event.type === "memory_removed_capacity" && isWithinDaysOf(event.createdAt, generatedAt, RECENT_EVICTION_DAYS));
  const capacityCandidates = recentCapacity.map(event => ({
    candidate: candidate({
      concernKind: "system_mechanism",
      mechanism: "eviction_cap",
      source: "eviction_cap_evidence",
      id: `eviction:${event.eventId}`,
      facts: { ...(safeDetails(event.details, raw) ?? {}), createdAt: event.createdAt, memoryId: event.memory?.memoryId, type: event.memory?.type },
      evidence: { eventIds: [event.eventId], rawReasonCodes: event.reasonCodes, textPreview: event.textPreview ? truncate(cleanText(event.textPreview, raw), 120) : undefined, textAvailable: Boolean(event.textPreview) },
      provenance: classifyProvenance({ event }, context),
      heuristicFlags: [flag("recent_capacity_removal", "Recent capacity-removal evidence", "memory_removed_capacity appeared within the recent eviction window")],
      reviewQuestions: ["Are eviction and cap rules preserving the intended memories under pressure?"],
      nextCommands: ["memory-diag missing --verbose --explain"],
    }),
    timestamp: event.createdAt,
    tieId: event.eventId,
    textHash: event.textPreview ? hashText(event.textPreview) : event.eventId,
  }));

  const unknownCandidates = disappearances
    .filter(row => row.classification === "historical_absent_unknown_reason")
    .map(row => {
      const latest = newestEvent(row.events);
      return {
        candidate: candidate({
          concernKind: "system_mechanism",
          mechanism: "eviction_cap",
          source: "missing_evidence",
          id: `missing:${row.id}`,
          facts: { memoryId: row.id, terminalType: row.terminalType, eventCount: row.events.length },
          evidence: { eventIds: row.events.map(event => event.eventId), rawReasonCodes: uniqueStrings(row.events.flatMap(event => event.reasonCodes)).sort(), textPreview: latest?.textPreview ? truncate(cleanText(latest.textPreview, raw), 120) : undefined, textAvailable: Boolean(latest?.textPreview) },
          provenance: classifyProvenance({ event: latest }, context),
          heuristicFlags: [flag("unknown_disappearance", "Evidence-only disappearance without terminal removal evidence", `memory ${row.id} has evidence but is not active`)],
          reviewQuestions: ["Does missing-memory evidence indicate a cap, retention, or recording rule needs review?"],
          nextCommands: ["memory-diag missing --verbose --explain"],
        }),
        timestamp: latest?.createdAt,
        tieId: row.id,
        textHash: row.id,
      };
    });
  return [...capacityCandidates, ...unknownCandidates];
}

function safeDetails(details: EvidenceEventV1["details"], raw: boolean): Record<string, unknown> | undefined {
  if (!details) return undefined;
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [key, typeof value === "string" ? cleanText(value, raw) : value]));
}

function buildIdentityCandidates(model: MemoryInspectionReadModel, activeMemories: LongTermMemoryEntry[], context: ProvenanceContextInputs, raw: boolean): DatedCandidateInput[] {
  const replacementCandidates = model.evidenceEvents
    .filter(event => event.type === "memory_replaced_numbered_ref" || event.type === "promotion_superseded")
    .map(event => ({
      candidate: candidate({
        concernKind: "system_mechanism",
        mechanism: "identity_dedup",
        source: "identity_dedup_evidence",
        id: `identity-event:${event.eventId}`,
        facts: { eventType: event.type, memoryId: event.memory?.memoryId, relationRoles: event.relations?.map(relation => relation.role) ?? [] },
        evidence: { eventIds: [event.eventId], rawReasonCodes: event.reasonCodes, textPreview: event.textPreview ? truncate(cleanText(event.textPreview, raw), 120) : undefined, textAvailable: Boolean(event.textPreview) },
        provenance: classifyProvenance({ event }, context),
        heuristicFlags: [flag("replacement_or_supersession", "Replacement or supersession evidence", `${event.type} records identity/dedup behavior`)],
        reviewQuestions: ["Are identity and dedup rules preserving separate memories when expected to remain distinct?"],
        nextCommands: ["memory-diag commands --verbose", event.memory?.memoryId ? `memory-diag explain ${event.memory.memoryId}` : "memory-diag missing --verbose --explain"],
      }),
      timestamp: event.createdAt,
      tieId: event.eventId,
      textHash: event.eventId,
    }));
  const duplicateCandidates = duplicateGroups(activeMemories, model.evidenceEvents).map(group => ({
    candidate: candidate({
      concernKind: "system_mechanism",
      mechanism: "identity_dedup",
      source: "identity_dedup_evidence",
      id: `duplicate:${group.id}`,
      facts: { memoryIds: group.memoryIds, basis: group.basis },
      evidence: { eventIds: group.memoryIds.flatMap(id => (model.evidenceByMemoryId.get(id) ?? []).map(event => event.eventId)), rawReasonCodes: [], textAvailable: false },
      provenance: classifyProvenance({}, context),
      heuristicFlags: [flag("exact_duplicate_group", "Exact duplicate text or identity group", `${group.memoryIds.length} memories share ${group.basis}`)],
      reviewQuestions: ["Are exact duplicate text or identity groups expected for this workspace?"],
      nextCommands: group.memoryIds.map(id => `memory-diag explain ${id}`).slice(0, 3),
    }),
    timestamp: undefined,
    tieId: group.id,
    textHash: group.id,
  }));
  return [...replacementCandidates, ...duplicateCandidates];
}

function buildMemoryContentCandidates(model: MemoryInspectionReadModel, activeMemories: LongTermMemoryEntry[], raw: boolean): ReviewBoardCandidate[] {
  return activeMemories.slice(0, ACTIVE_MEMORY_FULL_TEXT_THRESHOLD).map(memory => {
    const events = model.evidenceByMemoryId.get(memory.id) ?? [];
    return candidate({
      concernKind: "memory_content",
      mechanism: "retention_rendering",
      source: "active_memory",
      id: `active:${memory.id}`,
      facts: { id: memory.id, type: memory.type, source: memory.source, status: memory.status },
      evidence: { eventIds: events.map(event => event.eventId), rawReasonCodes: uniqueStrings(events.flatMap(event => event.reasonCodes)).sort(), textPreview: truncate(cleanText(memory.text, raw), 120), textAvailable: true },
      heuristicFlags: activeMemoryFlags(memory, events),
      reviewQuestions: memoryContentQuestions(),
      nextCommands: [`memory-diag explain ${memory.id}`],
    });
  });
}

function candidate(input: ReviewBoardCandidate): ReviewBoardCandidate {
  return input;
}

function selectRepresentative(items: DatedCandidateInput[], verbose: boolean): DatedCandidateInput[] {
  const sorted = [...items].sort((a, b) => {
    const timeDelta = timestampValue(b.timestamp) - timestampValue(a.timestamp);
    if (timeDelta !== 0) return timeDelta;
    const idDelta = a.tieId.localeCompare(b.tieId);
    if (idDelta !== 0) return idDelta;
    return (a.textHash ?? "").localeCompare(b.textHash ?? "");
  });
  return verbose ? sorted : sorted.slice(0, REPRESENTATIVE_CANDIDATE_LIMIT);
}

function timestampValue(iso: string | undefined): number {
  const time = iso ? new Date(iso).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function newestEvent(events: EvidenceEventV1[]): EvidenceEventV1 | undefined {
  return [...events].sort((a, b) => timestampValue(b.createdAt) - timestampValue(a.createdAt) || a.eventId.localeCompare(b.eventId))[0];
}

function flag(id: string, label: string, evidence: string): HeuristicFlag {
  return {
    id,
    label,
    evidence,
    caveat: "This flag is a prompt for review, not a conclusion.",
  };
}

function systemMechanismQuestions(): string[] {
  return [
    "Are rejection rules over-filtering durable decisions or under-filtering non-durable candidates for this workspace?",
    "Is the reinforcement window too restrictive when the same memory receives repeated reinforce intent?",
    "Are eviction and cap rules preserving target memories under full caps?",
    "Are identity and dedup rules collapsing items expected to remain separate, or not collapsing equivalent items?",
  ];
}

function memoryContentQuestions(): string[] {
  return [
    "Does this memory remain durable and actionable for future sessions?",
    "Is this memory non-stale, specific, and supported by available evidence?",
    "Does this memory overlap with other active memories in a way a reviewer should consider?",
  ];
}

function nextCommands(): string[] {
  return [
    "memory-diag rejected --verbose",
    "memory-diag missing --verbose --explain",
    "memory-diag commands --verbose",
    "memory-diag explain <memory-id>",
  ];
}

function countProvenanceClassifications(candidates: ReviewBoardCandidate[]): Record<ProvenanceClassification, number> {
  const counts = Object.fromEntries(PROVENANCE_CLASSIFICATIONS.map(classification => [classification, 0])) as Record<ProvenanceClassification, number>;
  for (const provenanceItem of candidates.map(candidate => candidate.provenance)) {
    if (!provenanceItem) continue;
    counts[provenanceItem.classification] += 1;
  }
  return counts;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
