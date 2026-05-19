export type AnswerabilityLevel = "supported" | "partial" | "inventory_only" | "not_instrumented";

export type ProducerVersionGroup = "current" | "previous" | "unknown_unversioned";

export type ProducerBearingRecord = {
  producerName?: string;
  producerVersion?: string;
  instrumentationVersion?: number;
};

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

export const VERSION_ANALYSIS_SAMPLE_THRESHOLD = 5;
export const VERSION_GROUPS: ProducerVersionGroup[] = ["current", "previous", "unknown_unversioned"];
export const VERSION_GROUPING_CAVEAT = "Version grouping is based only on producerVersion strings in evidence" as const;

export type VersionedMechanismInference = {
  status:
    | "current_recurrence_detected"
    | "pattern_persists_across_versions"
    | "no_current_evidence_observed"
    | "no_current_evidence_sample_small"
    | "no_current_version_opportunities"
    | "no_previous_pattern_observed";
  message: string;
  caveat: typeof VERSION_GROUPING_CAVEAT;
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

export function buildVersionBuckets<TRecord extends ProducerBearingRecord, TFacts>(
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

export function computeVersionedInference<TFacts>(
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

export function hasProducerFields(record: ProducerBearingRecord): boolean {
  return typeof record.producerName === "string"
    && record.producerName.length > 0
    && typeof record.producerVersion === "string"
    && record.producerVersion.length > 0
    && typeof record.instrumentationVersion === "number";
}

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

export function buildVersionCoverage(records: ProducerBearingRecord[], currentPackageVersion: string): VersionCoverage {
  const coverage: VersionCoverage = {
    totalEvents: records.length,
    currentVersionEvents: 0,
    previousVersionEvents: 0,
    unknownVersionEvents: 0,
    coveragePercent: 0,
    isTransitional: true,
  };
  for (const record of records) {
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

function inference(status: VersionedMechanismInference["status"], message: string): VersionedMechanismInference {
  return { status, message, caveat: VERSION_GROUPING_CAVEAT };
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
