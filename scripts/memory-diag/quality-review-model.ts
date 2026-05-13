import { createHash } from "node:crypto";
import type { EvidenceEventV1 } from "../../src/evidence-log.ts";
import { producerFields } from "../../src/instrumentation.ts";
import { RETENTION_TYPE_MAX } from "../../src/retention.ts";
import type { LongTermMemoryEntry, LongTermType } from "../../src/types.ts";
import { TYPES } from "./constants.ts";
import { disappearanceRows } from "./inspection-model.ts";
import { hasWorkspaceScope, rejectionQualitySummary, uniqueByCanonicalText } from "./rejections-model.ts";
import { canonicalMemoryText, cleanText, countBy, objectFromCounts, truncate, uniqueStrings, workspaceRootHash } from "./text.ts";
import type { MemoryInspectionReadModel, NormalizedRejection } from "./types.ts";

export type AnswerabilityLevel = "supported" | "partial" | "inventory_only" | "not_instrumented";

export type ProducerVersionGroup = "current" | "previous" | "unknown_unversioned";

export type VersionSampleAssessment =
  | "observed"
  | "not_observed_but_sample_small"
  | "not_observed_with_sufficient_sample"
  | "no_current_version_opportunities";

export type VersionAvailability = {
  noProducerFields: number;
  unknownProducerVersion: number;
  emptyProducerVersion: number;
  knownProducerVersion: number;
};

export type VersionCoverage = {
  totalEvents: number;
  currentVersionEvents: number;
  previousVersionEvents: number;
  unknownVersionEvents: number;
  coveragePercent: number;
  isTransitional: boolean;
};

export type VersionedMechanismInference = {
  status:
    | "current_recurrence_detected"
    | "pattern_persists_across_versions"
    | "no_current_evidence_observed"
    | "no_current_evidence_sample_small"
    | "no_current_version_opportunities"
    | "no_previous_pattern_observed";
  message: string;
  caveat: "Version grouping is based only on producerVersion strings in evidence";
};

export type VersionBucketFacts<TFacts> = {
  group: ProducerVersionGroup;
  label: string;
  opportunityCount: number;
  observedPatternCount: number;
  producerVersions: Record<string, number>;
  versionAvailability: VersionAvailability;
  answerabilityLevel: AnswerabilityLevel;
  sampleAssessment: VersionSampleAssessment;
  facts: TFacts;
};

export type VersionedMechanismDiagnosticQuestion = {
  mechanism: "reinforcement_rule";
  group: ProducerVersionGroup;
  question: string;
  evidence: string[];
};

export type VersionedMechanismFacts<TFacts> = {
  currentPackageVersion: string;
  opportunityName: string;
  sampleThreshold: number;
  buckets: Record<ProducerVersionGroup, VersionBucketFacts<TFacts>>;
  inference: VersionedMechanismInference;
  diagnosticQuestions?: VersionedMechanismDiagnosticQuestion[];
};

export type RejectionVersionFacts = {
  totalRecords: number;
  candidateRecords: number;
  byRawReasonCode: Record<string, number>;
  byType: Record<string, number>;
  ambiguousOrArchitectureLike: number;
};

export type ReinforcementVersionFacts = {
  reinforceEvents: number;
  reinforcedEvents: number;
  rejectedOrBlockedEvents: number;
  windowBlockedEvents: number;
  windowBlockRate: number;
  repeatedBlocksByMemory: Array<{ memoryId: string; count: number; refs: string[]; rawReasonCodes: string[] }>;
  blocksByExactReason: Record<string, number>;
  windowBlocksByUtcDay: Record<string, number>;
  blockDetailsMissing: number;
  malformedCommandEvents: number;
};

export type EvictionVersionFacts = {
  removedByCapacity: number;
  removedByGlobalCap: number;
  removedByTypeCap: number;
  recentEvictionsByType: Record<string, number>;
  recentCapacityRemovalsWithSnapshot: number;
  capacitySnapshotsMissing: number;
  highestRankRemoved?: { memoryId?: string; rankAtRemoval: number; strengthAtRemoval?: number; type?: string; eventId: string };
};

export type VersionedSystemMechanismFacts = {
  currentPackageVersion: string;
  versionCoverage: VersionCoverage;
  buckets: ProducerVersionGroup[];
  sampleThresholds: {
    rejectionFilters: 5;
    reinforcementRules: 5;
    evictionAndCaps: 5;
  };
  rejectionFilters: VersionedMechanismFacts<RejectionVersionFacts>;
  reinforcementRules: VersionedMechanismFacts<ReinforcementVersionFacts>;
  evictionAndCaps: VersionedMechanismFacts<EvictionVersionFacts>;
};

export type AnswerabilityAssessment = {
  level: AnswerabilityLevel;
  question: string;
  decision: string;
  competingExplanations: string[];
  requiredSignals: string[];
  currentSignals: string[];
  outputPermission: string;
};

export type AnswerabilityReport = {
  rejectionFilters: AnswerabilityAssessment;
  reinforcementRules: AnswerabilityAssessment;
  evictionAndCaps: AnswerabilityAssessment;
  unknownDisappearances: AnswerabilityAssessment;
  identityAndDedup: AnswerabilityAssessment;
  memoryContent: AnswerabilityAssessment;
};

export type ReviewBoardReport = {
  version: 1;
  generatedAt: string;
  workspace: { rootHash: string; key: string };
  purpose: "review_evidence_only";
  languageGuidance: {
    nonAuthoritative: true;
    mutation: "none";
    rawReasonCodesAreEvidence: true;
    producerVersionRecorded: boolean;
    provenanceInferenceOnly: true;
    primaryReviewPurpose: "system_mechanism_observations";
    secondaryReviewPurpose: "memory_content_quality";
  };
  provenanceContext: {
    method: "migration_timestamp_and_format_inference";
    confidenceDisclaimer: string;
    falseCurrentRiskBias: "prefer_unversioned_ambiguous_when_uncertain";
    producerVersionAvailable: boolean;
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
      instrumentation: {
        evidenceEventsTotal: number;
        evidenceEventsWithProducer: number;
        rejectionRecordsTotal: number;
        rejectionRecordsWithProducer: number;
        instrumentationVersions: Record<string, number>;
      };
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
        blocksByExactReason: Record<string, number>;
        windowBlocksByUtcDay: Record<string, number>;
        blockDetailsMissing: number;
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
        recentCapacityRemovalsWithSnapshot: number;
        capacitySnapshotsMissing: number;
        highestRankRemoved?: { memoryId?: string; rankAtRemoval: number; strengthAtRemoval?: number; type?: string; eventId: string };
      };
      identityAndDedup: {
        replacementEvents: number;
        sameTypeReplacementEvents: number;
        crossTypeReplacementEvents: number;
        supersededEntries: number;
        duplicateTextOrIdentityGroups: number;
      };
      versionedFacts?: VersionedSystemMechanismFacts;
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
  answerability?: AnswerabilityReport;
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
  versionContext?: {
    group: ProducerVersionGroup;
    currentPackageVersion: string;
    producerVersion?: string;
    basis: string;
  };
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

const ACTIVE_MEMORY_FULL_TEXT_THRESHOLD = 40;
const REPRESENTATIVE_CANDIDATE_LIMIT = 10;
const RECENT_EVICTION_DAYS = 7;
const VERSION_ANALYSIS_SAMPLE_THRESHOLD = 5;
const VERSION_GROUPS: ProducerVersionGroup[] = ["current", "previous", "unknown_unversioned"];
const VERSION_GROUPING_CAVEAT = "Version grouping is based only on producerVersion strings in evidence" as const;

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
  options: { verbose?: boolean; raw?: boolean; json?: boolean; currentProducerVersion?: string },
  generatedAt = new Date().toISOString(),
): ReviewBoardReport {
  const raw = options.raw === true;
  const currentPackageVersion = options.currentProducerVersion ?? producerFields().producerVersion;
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
  const instrumentationFacts = buildInstrumentationFacts(model.evidenceEvents, model.rejectionRecords);
  const reinforcementFacts = buildReinforcementFacts(model.evidenceEvents);
  const evictionFacts = buildEvictionFacts(model, activeMemories, typeCounts, typeCaps, disappearances, generatedAt);
  const identityFacts = buildIdentityFacts(model, activeMemories);
  const versionedFacts = buildVersionedSystemMechanismFacts(model.evidenceEvents, model.rejectionRecords, currentPackageVersion, generatedAt);
  const memoryContentFacts = buildMemoryContentFacts(model, activeMemories, typeCounts, typeCaps, raw);
  const producerVersionAvailable = [...model.evidenceEvents, ...model.rejectionRecords].some(hasKnownProducerVersion);
  const systemMechanismCandidateInputs = {
    rejection_filter: [
      ...buildRejectionCandidates(model.rejectionRecords, provenanceInputs, raw, currentPackageVersion),
      ...buildReabsorptionCandidates(activeKeyMatches, provenanceInputs, raw, currentPackageVersion),
    ],
    reinforcement_rule: buildReinforcementCandidates(model.evidenceEvents, provenanceInputs, raw, currentPackageVersion),
    eviction_cap: buildEvictionCandidates(disappearances, model.evidenceEvents, provenanceInputs, raw, generatedAt, currentPackageVersion),
    identity_dedup: buildIdentityCandidates(model, activeMemories, provenanceInputs, raw, currentPackageVersion),
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

  const answerabilityReport = buildAnswerabilityReport();
  applyInstrumentedAnswerability(answerabilityReport, model.evidenceEvents, reinforcementFacts, evictionFacts, currentPackageVersion);
  const report: ReviewBoardReport = {
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
      producerVersionRecorded: producerVersionAvailable,
      provenanceInferenceOnly: true,
      primaryReviewPurpose: "system_mechanism_observations",
      secondaryReviewPurpose: "memory_content_quality",
    },
    provenanceContext: {
      method: "migration_timestamp_and_format_inference",
      confidenceDisclaimer: "Producer version is not recorded in historical evidence; provenance is inferred and should not be used as proof of current behavior.",
      falseCurrentRiskBias: "prefer_unversioned_ambiguous_when_uncertain",
      producerVersionAvailable,
      migrationTimeline,
      lastActivityAt: model.store.lastActivityAt,
      countsByClassification,
      ...(systemCandidateDisplay.limited ? { candidateLimit: REPRESENTATIVE_CANDIDATE_LIMIT, candidateDisplay: systemCandidateDisplay.summary } : {}),
    },
    facts: {
      systemMechanisms: {
        instrumentation: instrumentationFacts,
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
        versionedFacts,
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
  report.answerability = answerabilityReport;
  return report;
}

function buildAnswerabilityReport(): AnswerabilityReport {
  return {
    rejectionFilters: {
      level: "partial",
      question: "Are durable memories being rejected?",
      decision: "Tune rejection filter or leave unchanged",
      competingExplanations: [
        "Rejection filter correctly identifies non-durable candidates",
        "Rejection filter over-filters durable architectural decisions",
      ],
      requiredSignals: ["full rejected text", "reason codes", "source/origin", "decision logic version", "later reabsorption"],
      currentSignals: ["redacted text preview", "reason code distribution", "type distribution"],
      outputPermission: "Show candidates and ask for review; do not claim false positives.",
    },
    reinforcementRules: {
      level: "inventory_only",
      question: "Is the reinforcement window appropriate?",
      decision: "Change reinforcement policy or leave unchanged",
      competingExplanations: [
        "Window blocks same-day repeated command inventory",
        "Window blocks legitimate recurring reinforcement across days",
      ],
      requiredSignals: ["per-attempt timestamp", "prior reinforcement timestamp", "exact block reason", "session/day grouping"],
      currentSignals: ["block count", "repeated block groups", "window block rate"],
      outputPermission: "Show counts and event IDs only; do not characterize the policy as strict or lenient.",
    },
    evictionAndCaps: {
      level: "inventory_only",
      question: "Is capacity causing important memory loss?",
      decision: "Raise caps or leave unchanged",
      competingExplanations: [
        "Full caps are naturally occupied with healthy turnover",
        "Full caps are causing premature eviction of important memories",
      ],
      requiredSignals: ["strength/rank at removal", "cutoff context", "age", "source", "reinforcement count"],
      currentSignals: ["removal count", "cap occupancy", "type counts"],
      outputPermission: "Show occupancy and removal counts only; do not infer a capacity problem from full caps.",
    },
    unknownDisappearances: {
      level: "inventory_only",
      question: "Are missing memories current instrumentation defects?",
      decision: "Fix removal logging or accept historical gaps",
      competingExplanations: [
        "Missing memories were removed before terminal-removal instrumentation existed",
        "Missing memories indicate a current data-loss defect",
      ],
      requiredSignals: ["producer/instrumentation version", "terminal-removal instrumentation epoch", "latest event timestamp"],
      currentSignals: ["evidence absence", "latest known event timestamp"],
      outputPermission: "Call them unversioned/ambiguous disappearance inventory unless producer data proves current instrumentation.",
    },
    identityAndDedup: {
      level: "partial",
      question: "Are separate concepts incorrectly merged?",
      decision: "Review identity rules or accept current behavior",
      competingExplanations: [
        "Replacements correctly update semantic duplicates",
        "Replacements incorrectly collapse distinct concepts with similar text",
      ],
      requiredSignals: ["before/after content", "identity keys", "replacement reason"],
      currentSignals: ["replacement events", "superseded entries"],
      outputPermission: "Show replacement/duplicate inventory; do not infer semantic correctness.",
    },
    memoryContent: {
      level: "partial",
      question: "Are active memories useful and current?",
      decision: "Review active memories or leave unchanged",
      competingExplanations: [
        "Low text preview indicates a naturally ephemeral memory",
        "Low text preview indicates potentially stale content",
      ],
      requiredSignals: ["full text", "type", "source", "age", "evidence coverage"],
      currentSignals: ["text preview", "type distribution", "strength distribution"],
      outputPermission: "Show review surface with text previews; invariant heuristic flags only.",
    },
  };
}

function applyInstrumentedAnswerability(
  report: AnswerabilityReport,
  events: EvidenceEventV1[],
  reinforcementFacts: ReviewBoardReport["facts"]["systemMechanisms"]["reinforcementRules"],
  evictionFacts: ReviewBoardReport["facts"]["systemMechanisms"]["evictionAndCaps"],
  currentPackageVersion: string,
): void {
  const hasInstrumentedBlocks = events.some(event =>
    isReinforcementEvent(event)
    && event.reasonCodes.includes("reinforcement_window_blocked")
    && typeof event.details?.blockReason === "string"
    && hasProducerFields(event)
    && producerVersionGroupFor(event, currentPackageVersion) === "current"
  );
  if (hasInstrumentedBlocks && Object.keys(reinforcementFacts.blocksByExactReason).length > 0) {
    report.reinforcementRules.level = "partial";
    report.reinforcementRules.currentSignals = uniqueStrings([
      ...report.reinforcementRules.currentSignals,
      "exact block reasons",
      "UTC day grouping",
    ]);
    report.reinforcementRules.outputPermission = "Show exact block reasons and day grouping; causal fields exist but human content judgment is still required.";
  }

  const hasCapacitySnapshots = evictionFacts.recentCapacityRemovalsWithSnapshot > 0
    && events.some(event => event.type === "memory_removed_capacity" && hasProducerFields(event) && hasCapacitySnapshot(event) && producerVersionGroupFor(event, currentPackageVersion) === "current");
  if (hasCapacitySnapshots) {
    report.evictionAndCaps.level = "partial";
    report.evictionAndCaps.currentSignals = uniqueStrings([
      ...report.evictionAndCaps.currentSignals,
      "rank at removal",
      "strength at removal",
    ]);
    report.evictionAndCaps.outputPermission = "Show removal snapshots with rank/strength/age; causal fields exist but human judgment of importance is still required.";
  }
}

function buildInstrumentationFacts(
  events: EvidenceEventV1[],
  rejections: NormalizedRejection[],
): ReviewBoardReport["facts"]["systemMechanisms"]["instrumentation"] {
  const instrumentedEvents = events.filter(hasProducerFields);
  const instrumentedRejections = rejections.filter(hasProducerFields);
  const instrumentationVersions: Record<string, number> = {};
  for (const record of [...instrumentedEvents, ...instrumentedRejections]) {
    const version = record.instrumentationVersion;
    if (typeof version !== "number") continue;
    const key = String(version);
    instrumentationVersions[key] = (instrumentationVersions[key] ?? 0) + 1;
  }
  return {
    evidenceEventsTotal: events.length,
    evidenceEventsWithProducer: instrumentedEvents.length,
    rejectionRecordsTotal: rejections.length,
    rejectionRecordsWithProducer: instrumentedRejections.length,
    instrumentationVersions,
  };
}

function buildVersionedSystemMechanismFacts(
  events: EvidenceEventV1[],
  rejections: NormalizedRejection[],
  currentPackageVersion: string,
  generatedAt: string,
): VersionedSystemMechanismFacts {
  const versionCoverage = buildVersionCoverage(events, rejections, currentPackageVersion);
  return {
    currentPackageVersion,
    versionCoverage,
    buckets: VERSION_GROUPS,
    sampleThresholds: {
      rejectionFilters: VERSION_ANALYSIS_SAMPLE_THRESHOLD,
      reinforcementRules: VERSION_ANALYSIS_SAMPLE_THRESHOLD,
      evictionAndCaps: VERSION_ANALYSIS_SAMPLE_THRESHOLD,
    },
    rejectionFilters: buildVersionedRejectionFacts(rejections, currentPackageVersion),
    reinforcementRules: buildVersionedReinforcementFacts(events, currentPackageVersion),
    evictionAndCaps: buildVersionedEvictionFacts(events, currentPackageVersion, generatedAt),
  };
}

function buildVersionedRejectionFacts(
  records: NormalizedRejection[],
  currentPackageVersion: string,
): VersionedMechanismFacts<RejectionVersionFacts> {
  const buckets = buildVersionBuckets(records, currentPackageVersion, bucketRecords => {
    const candidateRecords = bucketRecords.filter(isReviewableRejectionCandidate);
    const facts: RejectionVersionFacts = {
      totalRecords: bucketRecords.length,
      candidateRecords: candidateRecords.length,
      byRawReasonCode: objectFromCounts(countBy(bucketRecords.flatMap(record => record.reasons))),
      byType: objectFromCounts(countBy(bucketRecords.map(record => record.type))),
      ambiguousOrArchitectureLike: candidateRecords.length,
    };
    return { facts, opportunityCount: candidateRecords.length, observedPatternCount: candidateRecords.length };
  });
  const base: Omit<VersionedMechanismFacts<RejectionVersionFacts>, "inference"> = {
    currentPackageVersion,
    opportunityName: "rejection candidates",
    sampleThreshold: VERSION_ANALYSIS_SAMPLE_THRESHOLD,
    buckets,
  };
  return {
    ...base,
    inference: computeVersionedInference(base, {
      observedPattern: "rejected candidates",
      patternName: "reviewable_rejection_candidate",
    }),
  };
}

function buildVersionedReinforcementFacts(
  events: EvidenceEventV1[],
  currentPackageVersion: string,
): VersionedMechanismFacts<ReinforcementVersionFacts> {
  const mechanismEvents = events.filter(event => isReinforcementEvent(event) || isMalformedCommandEvent(event));
  const buckets = buildVersionBuckets(mechanismEvents, currentPackageVersion, bucketEvents => {
    const attempts = bucketEvents.filter(isReinforcementEvent);
    const facts = buildReinforcementFacts(bucketEvents) as ReinforcementVersionFacts;
    return {
      facts,
      opportunityCount: attempts.length,
      observedPatternCount: attempts.filter(event => event.reasonCodes.includes("reinforcement_window_blocked")).length,
    };
  });
  const base: Omit<VersionedMechanismFacts<ReinforcementVersionFacts>, "inference"> = {
    currentPackageVersion,
    opportunityName: "attempts",
    sampleThreshold: VERSION_ANALYSIS_SAMPLE_THRESHOLD,
    buckets,
  };
  return {
    ...base,
    inference: computeVersionedInference(base, {
      observedPattern: "blocked",
      patternName: "reinforcement_window_blocked",
    }),
    ...diagnosticQuestionsProperty(buildReinforcementDiagnosticQuestions(mechanismEvents, currentPackageVersion)),
  };
}

function diagnosticQuestionsProperty(questions: VersionedMechanismDiagnosticQuestion[]): { diagnosticQuestions?: VersionedMechanismDiagnosticQuestion[] } {
  return questions.length > 0 ? { diagnosticQuestions: questions } : {};
}

function buildReinforcementDiagnosticQuestions(events: EvidenceEventV1[], currentPackageVersion: string): VersionedMechanismDiagnosticQuestion[] {
  const matching = events
    .filter(event => isReinforcementEvent(event)
      && event.reasonCodes.includes("reinforcement_window_blocked")
      && producerVersionGroupFor(event, currentPackageVersion) === "current"
      && event.details?.blockReason === "same_session")
    .map(event => {
      const attemptedAtIso = stringDetail(event, "attemptedAtIso");
      const lastReinforcedAtIso = stringDetail(event, "lastReinforcedAtIso");
      return { event, attemptedAtIso, lastReinforcedAtIso };
    })
    .filter((item): item is { event: EvidenceEventV1; attemptedAtIso: string; lastReinforcedAtIso: string } =>
      typeof item.attemptedAtIso === "string"
      && typeof item.lastReinforcedAtIso === "string"
      && isValidIsoDate(item.attemptedAtIso)
      && isValidIsoDate(item.lastReinforcedAtIso)
      && item.attemptedAtIso.slice(0, 10) !== item.lastReinforcedAtIso.slice(0, 10)
    )
    .sort((a, b) => compareIso(b.attemptedAtIso, a.attemptedAtIso) || a.event.eventId.localeCompare(b.event.eventId));

  const representative = matching[0];
  if (!representative) return [];
  return [{
    mechanism: "reinforcement_rule",
    group: "current",
    question: "Should same_session reinforcement blocking apply across UTC days?",
    evidence: [
      `count=${matching.length}`,
      `eventId=${representative.event.eventId}`,
      `attemptedAtIso=${representative.attemptedAtIso}`,
      `lastReinforcedAtIso=${representative.lastReinforcedAtIso}`,
    ],
  }];
}

function buildVersionedEvictionFacts(
  events: EvidenceEventV1[],
  currentPackageVersion: string,
  generatedAt: string,
): VersionedMechanismFacts<EvictionVersionFacts> {
  const capacityEvents = events.filter(event => event.type === "memory_removed_capacity");
  const buckets = buildVersionBuckets(capacityEvents, currentPackageVersion, bucketEvents => {
    const facts = buildEvictionVersionFacts(bucketEvents, generatedAt);
    return {
      facts,
      opportunityCount: bucketEvents.length,
      observedPatternCount: facts.capacitySnapshotsMissing,
    };
  });
  const base: Omit<VersionedMechanismFacts<EvictionVersionFacts>, "inference"> = {
    currentPackageVersion,
    opportunityName: "capacity removals",
    sampleThreshold: VERSION_ANALYSIS_SAMPLE_THRESHOLD,
    buckets,
  };
  return {
    ...base,
    inference: computeVersionedInference(base, {
      observedPattern: "missing snapshots",
      patternName: "capacity_snapshot_missing",
    }),
  };
}

function buildVersionBuckets<TRecord extends ProducerBearingRecord, TFacts>(
  records: TRecord[],
  currentPackageVersion: string,
  summarize: (records: TRecord[]) => { facts: TFacts; opportunityCount: number; observedPatternCount: number },
): Record<ProducerVersionGroup, VersionBucketFacts<TFacts>> {
  const grouped = Object.fromEntries(VERSION_GROUPS.map(group => [group, []])) as Record<ProducerVersionGroup, TRecord[]>;
  for (const record of records) grouped[producerVersionGroupFor(record, currentPackageVersion)].push(record);
  return Object.fromEntries(VERSION_GROUPS.map(group => {
    const bucketRecords = grouped[group];
    const summary = summarize(bucketRecords);
    return [group, {
      group,
      label: versionGroupLabel(group, currentPackageVersion),
      opportunityCount: summary.opportunityCount,
      observedPatternCount: summary.observedPatternCount,
      producerVersions: producerVersionCounts(bucketRecords),
      versionAvailability: buildVersionAvailability(bucketRecords),
      answerabilityLevel: group === "current" && summary.opportunityCount > 0 ? "partial" : "inventory_only",
      sampleAssessment: sampleAssessmentFor(group, summary.opportunityCount, summary.observedPatternCount, currentPackageVersion),
      facts: summary.facts,
    } satisfies VersionBucketFacts<TFacts>];
  })) as Record<ProducerVersionGroup, VersionBucketFacts<TFacts>>;
}

function buildEvictionVersionFacts(capacityEvents: EvidenceEventV1[], generatedAt: string): EvictionVersionFacts {
  const recentCapacityEvents = capacityEvents.filter(event => isWithinDaysOf(event.createdAt, generatedAt, RECENT_EVICTION_DAYS));
  const capacityEventsWithSnapshot = capacityEvents.filter(hasCapacitySnapshot);
  const capacityEventsWithRank = capacityEvents.filter(event => numberDetail(event, "rankAtRemoval") !== undefined);
  const highestRankRemovedEvent = [...capacityEventsWithRank]
    .sort((a, b) => (numberDetail(a, "rankAtRemoval") ?? Number.POSITIVE_INFINITY) - (numberDetail(b, "rankAtRemoval") ?? Number.POSITIVE_INFINITY))[0];
  return {
    removedByCapacity: capacityEvents.length,
    removedByGlobalCap: capacityEvents.filter(event => event.reasonCodes.includes("global_cap")).length,
    removedByTypeCap: capacityEvents.filter(event => event.reasonCodes.includes("type_cap")).length,
    recentEvictionsByType: objectFromCounts(countBy(recentCapacityEvents.map(event => event.memory?.type ?? "unknown"))),
    recentCapacityRemovalsWithSnapshot: capacityEventsWithSnapshot.length,
    capacitySnapshotsMissing: capacityEvents.length - capacityEventsWithSnapshot.length,
    ...(highestRankRemovedEvent ? { highestRankRemoved: highestRankRemoved(highestRankRemovedEvent) } : {}),
  };
}

function isReviewableRejectionCandidate(record: NormalizedRejection): boolean {
  if (!record.reasons.includes("bad_decision")) return false;
  const label = neutralRejectionLabel(record);
  return label === "architecture_like_rejected_candidate" || label === "ambiguous_rejected_candidate";
}

function producerVersionCounts(records: ProducerBearingRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    if (!hasKnownProducerVersion(record)) continue;
    const version = String(record.producerVersion).trim();
    counts[version] = (counts[version] ?? 0) + 1;
  }
  return counts;
}

function versionGroupLabel(group: ProducerVersionGroup, currentPackageVersion: string): string {
  if (group === "current") return `current version ${currentPackageVersion}`;
  if (group === "previous") return "previous versions";
  return "unknown/unversioned";
}

function sampleAssessmentFor(
  group: ProducerVersionGroup,
  opportunityCount: number,
  observedPatternCount: number,
  currentPackageVersion: string,
): VersionSampleAssessment {
  if (observedPatternCount > 0) return "observed";
  if (group === "current" && (!isAssessableCurrentPackageVersion(currentPackageVersion) || opportunityCount === 0)) return "no_current_version_opportunities";
  if (opportunityCount < VERSION_ANALYSIS_SAMPLE_THRESHOLD) return "not_observed_but_sample_small";
  return "not_observed_with_sufficient_sample";
}

function isAssessableCurrentPackageVersion(currentPackageVersion: string): boolean {
  const trimmed = currentPackageVersion.trim();
  return trimmed.length > 0 && trimmed !== "unknown";
}

function computeVersionedInference<TFacts>(
  mechanism: Omit<VersionedMechanismFacts<TFacts>, "inference">,
  text: { observedPattern: string; patternName: string },
): VersionedMechanismInference {
  const current = mechanism.buckets.current;
  const previous = mechanism.buckets.previous;
  const currentFact = `Current version: ${current.observedPatternCount} ${text.observedPattern} in ${current.opportunityCount} ${mechanism.opportunityName}.`;
  const previousFact = `Previous versions: ${previous.observedPatternCount} ${text.observedPattern} in ${previous.opportunityCount} ${mechanism.opportunityName}.`;
  const unknownUnversioned = mechanism.buckets.unknown_unversioned;
  if (!isAssessableCurrentPackageVersion(mechanism.currentPackageVersion) || current.opportunityCount === 0) {
    return inference("no_current_version_opportunities", "Current package version is unknown or has no events; cannot assess recurrence.");
  }
  if (current.observedPatternCount > 0 && previous.observedPatternCount === 0 && unknownUnversioned.observedPatternCount === 0) {
    return inference("no_previous_pattern_observed", `${currentFact} No previous pattern observed — this is a new pattern, not a recurrence.`);
  }
  if (current.observedPatternCount > 0) {
    if (previous.observedPatternCount > 0) {
      return inference("pattern_persists_across_versions", `${currentFact} ${previousFact} Current recurrence detected — ${text.patternName} observed in current version. Pattern persists across versions.`);
    }
    // Current has signal, previous has none, but unknown/unversioned has signal
    return inference("current_recurrence_detected", `${currentFact} No known previous-version pattern observed, but unknown/unversioned evidence shows ${unknownUnversioned.observedPatternCount} ${text.observedPattern}. Pattern may persist — version grouping cannot confirm or deny.`);
  }
  if (current.opportunityCount < mechanism.sampleThreshold) {
    return inference("no_current_evidence_sample_small", `${currentFact} ${previousFact} No current evidence observed, but current-version opportunity count is ${current.opportunityCount} (<${mechanism.sampleThreshold}); do not infer absence.`);
  }
  return inference("no_current_evidence_observed", `${currentFact} ${previousFact} No recurrence observed with sufficient current-version sample.`);
}

function inference(status: VersionedMechanismInference["status"], message: string): VersionedMechanismInference {
  return { status, message, caveat: VERSION_GROUPING_CAVEAT };
}

function hasProducerFields(record: Pick<EvidenceEventV1, "producerName" | "producerVersion" | "instrumentationVersion"> | Pick<NormalizedRejection, "producerName" | "producerVersion" | "instrumentationVersion">): boolean {
  return typeof record.producerName === "string"
    && record.producerName.length > 0
    && typeof record.producerVersion === "string"
    && record.producerVersion.length > 0
    && typeof record.instrumentationVersion === "number";
}

type ProducerBearingRecord = Pick<EvidenceEventV1 | NormalizedRejection, "producerName" | "producerVersion" | "instrumentationVersion">;

export function hasKnownProducerVersion(record: ProducerBearingRecord): boolean {
  if (typeof record.producerVersion !== "string") return false;
  const producerVersion = record.producerVersion.trim();
  return producerVersion.length > 0 && producerVersion !== "unknown";
}

export function producerVersionGroupFor(record: ProducerBearingRecord, currentPackageVersion: string): ProducerVersionGroup {
  if (!hasKnownProducerVersion(record)) return "unknown_unversioned";
  const producerVersion = String(record.producerVersion).trim();
  const currentVersion = currentPackageVersion.trim();
  if (currentVersion.length > 0 && currentVersion !== "unknown" && producerVersion === currentVersion) return "current";
  return "previous";
}

function buildVersionAvailability(records: ProducerBearingRecord[]): VersionAvailability {
  const availability: VersionAvailability = {
    noProducerFields: 0,
    unknownProducerVersion: 0,
    emptyProducerVersion: 0,
    knownProducerVersion: 0,
  };
  for (const record of records) {
    const hasAnyProducerField = typeof record.producerName === "string"
      || typeof record.producerVersion === "string"
      || typeof record.instrumentationVersion === "number";
    if (!hasAnyProducerField) {
      availability.noProducerFields += 1;
      continue;
    }
    if (typeof record.producerVersion !== "string" || record.producerVersion.trim().length === 0) {
      availability.emptyProducerVersion += 1;
      continue;
    }
    if (record.producerVersion.trim() === "unknown") {
      availability.unknownProducerVersion += 1;
      continue;
    }
    availability.knownProducerVersion += 1;
  }
  return availability;
}

function buildVersionCoverage(events: EvidenceEventV1[], rejections: NormalizedRejection[], currentPackageVersion: string): VersionCoverage {
  const coverage: VersionCoverage = {
    totalEvents: events.length + rejections.length,
    currentVersionEvents: 0,
    previousVersionEvents: 0,
    unknownVersionEvents: 0,
    coveragePercent: 0,
    isTransitional: true,
  };
  for (const record of [...events, ...rejections]) {
    const group = producerVersionGroupFor(record, currentPackageVersion);
    if (group === "current") coverage.currentVersionEvents += 1;
    if (group === "previous") coverage.previousVersionEvents += 1;
    if (group === "unknown_unversioned") coverage.unknownVersionEvents += 1;
  }
  coverage.coveragePercent = coverage.totalEvents === 0
    ? 0
    : Math.round(((coverage.currentVersionEvents + coverage.previousVersionEvents) / coverage.totalEvents) * 1000) / 10;
  coverage.isTransitional = coverage.coveragePercent < 50;
  return coverage;
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

function versionContextFor(record: ProducerBearingRecord | undefined, currentPackageVersion: string): ReviewBoardCandidate["versionContext"] | undefined {
  if (!record) return undefined;
  const group = producerVersionGroupFor(record, currentPackageVersion);
  const producerVersion = typeof record.producerVersion === "string" ? record.producerVersion.trim() : undefined;
  return {
    group,
    currentPackageVersion,
    ...(producerVersion ? { producerVersion } : {}),
    basis: group === "current"
      ? "producerVersion matches current package version"
      : group === "previous"
        ? "producerVersion differs from current package version"
        : "producerVersion is missing, unknown, or empty",
  };
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
  const blocksByExactReason: Record<string, number> = {};
  const windowBlocksByUtcDay: Record<string, number> = {};
  let blockDetailsMissing = 0;
  for (const event of windowBlocked) {
    const memoryId = event.memory?.memoryId ?? "unknown";
    const current = grouped.get(memoryId) ?? { memoryId, count: 0, refs: new Set<string>(), rawReasonCodes: new Set<string>(), eventIds: [] };
    current.count += 1;
    current.eventIds.push(event.eventId);
    const ref = typeof event.details?.ref === "string" ? event.details.ref : undefined;
    if (ref) current.refs.add(ref);
    for (const reason of event.reasonCodes) current.rawReasonCodes.add(reason);
    grouped.set(memoryId, current);

    const blockReason = typeof event.details?.blockReason === "string" ? event.details.blockReason : undefined;
    if (blockReason) {
      blocksByExactReason[blockReason] = (blocksByExactReason[blockReason] ?? 0) + 1;
      const utcDay = event.createdAt?.slice(0, 10) || "unknown";
      windowBlocksByUtcDay[utcDay] = (windowBlocksByUtcDay[utcDay] ?? 0) + 1;
    } else {
      blockDetailsMissing += 1;
    }
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
    blocksByExactReason,
    windowBlocksByUtcDay,
    blockDetailsMissing,
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
  const capacityEventsWithSnapshot = capacityEvents.filter(hasCapacitySnapshot);
  const capacityEventsWithRank = capacityEvents.filter(event => numberDetail(event, "rankAtRemoval") !== undefined);
  const highestRankRemovedEvent = [...capacityEventsWithRank]
    .sort((a, b) => (numberDetail(a, "rankAtRemoval") ?? Number.POSITIVE_INFINITY) - (numberDetail(b, "rankAtRemoval") ?? Number.POSITIVE_INFINITY))[0];
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
    recentCapacityRemovalsWithSnapshot: capacityEventsWithSnapshot.length,
    capacitySnapshotsMissing: capacityEvents.length - capacityEventsWithSnapshot.length,
    ...(highestRankRemovedEvent ? { highestRankRemoved: highestRankRemoved(highestRankRemovedEvent) } : {}),
  };
}

function hasCapacitySnapshot(event: EvidenceEventV1): boolean {
  return event.type === "memory_removed_capacity"
    && numberDetail(event, "strengthAtRemoval") !== undefined
    && numberDetail(event, "rankAtRemoval") !== undefined;
}

function highestRankRemoved(event: EvidenceEventV1): NonNullable<ReviewBoardReport["facts"]["systemMechanisms"]["evictionAndCaps"]["highestRankRemoved"]> {
  const rankAtRemoval = numberDetail(event, "rankAtRemoval") ?? Number.POSITIVE_INFINITY;
  const strengthAtRemoval = numberDetail(event, "strengthAtRemoval");
  return {
    ...(event.memory?.memoryId ? { memoryId: event.memory.memoryId } : {}),
    rankAtRemoval,
    ...(strengthAtRemoval !== undefined ? { strengthAtRemoval } : {}),
    ...(event.memory?.type ? { type: event.memory.type } : {}),
    eventId: event.eventId,
  };
}

function numberDetail(event: EvidenceEventV1, key: string): number | undefined {
  const value = event.details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringDetail(event: EvidenceEventV1, key: string): string | undefined {
  const value = event.details?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isValidIsoDate(value: string): boolean {
  return Number.isFinite(new Date(value).getTime()) && /^\d{4}-\d{2}-\d{2}/.test(value);
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

function buildRejectionCandidates(records: NormalizedRejection[], context: ProvenanceContextInputs, raw: boolean, currentPackageVersion: string): DatedCandidateInput[] {
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
        versionContext: versionContextFor(record, currentPackageVersion),
        heuristicFlags: [],
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

function buildReabsorptionCandidates(matches: ReabsorbedMatch[], context: ProvenanceContextInputs, raw: boolean, currentPackageVersion: string): DatedCandidateInput[] {
  const candidates = matches.map(match => ({
    candidate: candidate({
      concernKind: "system_mechanism",
      mechanism: "rejection_filter",
      source: "reabsorption_evidence",
      id: `reabsorbed:${match.activeMemory.id}:${hashText(match.key)}`,
      facts: { activeMemoryId: match.activeMemory.id, type: match.activeMemory.type, rejectedAt: match.record.timestamp || undefined },
      evidence: { rawReasonCodes: match.record.reasons, textPreview: truncate(cleanText(match.record.text, raw), 120), textAvailable: true },
      provenance: classifyProvenance({ rejection: match.record, reabsorbed: true }, context),
      versionContext: versionContextFor(match.record, currentPackageVersion),
      heuristicFlags: [],
      reviewQuestions: ["Did later context make this rejected candidate worth reviewing for filter calibration?"],
      nextCommands: ["memory-diag rejected --verbose", `memory-diag explain ${match.activeMemory.id}`],
    }),
    timestamp: match.record.timestamp,
    tieId: match.activeMemory.id,
    textHash: hashText(match.key),
  }));
  return candidates;
}

function buildReinforcementCandidates(events: EvidenceEventV1[], context: ProvenanceContextInputs, raw: boolean, currentPackageVersion: string): DatedCandidateInput[] {
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
        versionContext: versionContextFor(latest, currentPackageVersion),
        heuristicFlags: [flag("repeated_reinforcement_window_block", "Repeated reinforcement window block inventory", `${item.group.length} reinforcement attempts were blocked for memory ${item.memoryId}`)],
        reviewQuestions: ["What reinforcement block patterns are present for repeated reinforce intent?"],
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
      versionContext: versionContextFor(event, currentPackageVersion),
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
  currentPackageVersion: string,
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
      versionContext: versionContextFor(event, currentPackageVersion),
      heuristicFlags: [flag("recent_capacity_removal", "Recent capacity-removal inventory", "memory_removed_capacity appeared within the recent eviction window")],
      reviewQuestions: ["What capacity-removal inventory is present for this memory?"],
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
          versionContext: versionContextFor(latest, currentPackageVersion),
          heuristicFlags: [flag("unknown_disappearance", "Unversioned disappearance inventory", `memory ${row.id} has evidence but is not active`)],
          reviewQuestions: ["What unversioned disappearance inventory exists for this memory?"],
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

function buildIdentityCandidates(model: MemoryInspectionReadModel, activeMemories: LongTermMemoryEntry[], context: ProvenanceContextInputs, raw: boolean, currentPackageVersion: string): DatedCandidateInput[] {
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
        versionContext: versionContextFor(event, currentPackageVersion),
        heuristicFlags: [],
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
      heuristicFlags: [],
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
    "What block patterns are present for repeated reinforcement intent?",
    "What cap occupancy and capacity-removal inventory is present?",
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
