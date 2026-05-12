import { cleanText, formatDetails } from "../text.ts";
import type {
  CandidateProvenance,
  HeuristicFlag,
  ProvenanceClassification,
  ReviewBoardActiveMemory,
  ReviewBoardCandidate,
  ReviewBoardReport,
} from "../quality-review-model.ts";

const PROVENANCE_ORDER: ProvenanceClassification[] = [
  "explicit_migration_evidence",
  "legacy_unversioned_format",
  "reabsorbed_post_rejection",
  "suspected_pre_migration_legacy",
  "likely_current_behavior",
  "unversioned_ambiguous",
];

const REVIEW_FLAG_CAVEAT = "This flag is a prompt for review, not a conclusion.";

export function buildQualityJSON(report: ReviewBoardReport, raw = false): unknown {
  if (raw) return report;
  return redactUnknown(report);
}

export function formatQualityReviewBoard(
  report: ReviewBoardReport,
  options: { verbose?: boolean; noEmoji?: boolean },
): string {
  const bullet = "-";
  const lines: string[] = [];

  lines.push("Memory quality review board");
  lines.push("Purpose: evidence for human/agent review only; no automatic judgment or cleanup.");
  lines.push("Producer version note: historical records do not include package/plugin version; provenance below is inferred.");
  lines.push("Primary review purpose: SYSTEM MECHANISM observations (filters, reinforcement, eviction/caps, identity/dedup).");
  lines.push("Secondary review purpose: MEMORY CONTENT quality (staleness, durability, redundancy, specificity).");
  lines.push("");

  pushEvidenceProvenance(lines, report, bullet);
  lines.push("");
  pushSystemMechanismFacts(lines, report, bullet);
  lines.push("");
  pushMemoryContentFacts(lines, report, bullet);
  lines.push("");
  pushSystemMechanismCandidates(lines, report, bullet);
  lines.push("");
  pushMemoryContentCandidates(lines, report, bullet, options);
  lines.push("");
  pushReviewQuestions(lines, report, bullet);
  lines.push("");
  pushNextCommands(lines, report, bullet);

  return lines.join("\n");
}

function pushEvidenceProvenance(lines: string[], report: ReviewBoardReport, bullet: string): void {
  const context = report.provenanceContext;
  lines.push("Evidence provenance");
  lines.push(`  ${bullet} method: migration/timestamp/format inference`);
  lines.push(`  ${bullet} confidence: ${context.confidenceDisclaimer}`);
  lines.push(`  ${bullet} migration timeline: ${formatMigrationTimeline(context.migrationTimeline)}`);
  if (context.lastActivityAt) lines.push(`  ${bullet} last activity: ${context.lastActivityAt}`);
}

function pushSystemMechanismFacts(lines: string[], report: ReviewBoardReport, bullet: string): void {
  const facts = report.facts.systemMechanisms;
  lines.push("Facts - system mechanisms");
  lines.push("  Provenance counts for mechanism evidence");
  lines.push(`    ${bullet} ${formatProvenanceCounts(report.provenanceContext.countsByClassification)}`);
  lines.push("  Rejection filters");
  lines.push(`    ${bullet} rejected records: ${facts.rejectionFilters.totalRecords} (unique: ${facts.rejectionFilters.uniqueTexts})`);
  lines.push(`    ${bullet} raw reason-code distribution: ${formatCounts(facts.rejectionFilters.byRawReasonCode)}`);
  lines.push(`    ${bullet} type distribution: ${formatCounts(facts.rejectionFilters.byType)}`);
  lines.push(`    ${bullet} ambiguous/architecture-like rejected candidates: ${facts.rejectionFilters.ambiguousOrArchitectureLike}`);
  lines.push(`    ${bullet} status-or-hard-reason evidence: ${facts.rejectionFilters.hardReasonOrNoiseHeuristic}`);
  lines.push(`    ${bullet} re-absorbed rejected texts: ${facts.rejectionFilters.reabsorbedRejectedTexts}`);
  lines.push("  Reinforcement rules");
  lines.push(`    ${bullet} reinforce attempts: ${facts.reinforcementRules.reinforceEvents}, reinforced: ${facts.reinforcementRules.reinforcedEvents}, rejected/blocked: ${facts.reinforcementRules.rejectedOrBlockedEvents}`);
  lines.push(`    ${bullet} reinforcement-window blocked: ${facts.reinforcementRules.windowBlockedEvents} (rate: ${formatPercent(facts.reinforcementRules.windowBlockRate)})`);
  lines.push(`    ${bullet} repeated blocks by memory: ${formatRepeatedBlocks(facts.reinforcementRules.repeatedBlocksByMemory)}`);
  lines.push(`    ${bullet} malformed command events: ${facts.reinforcementRules.malformedCommandEvents}`);
  lines.push("  Eviction and caps");
  lines.push(`    ${bullet} active memories: ${facts.evictionAndCaps.activeMemories} / ${facts.evictionAndCaps.maxEntries}`);
  lines.push(`    ${bullet} rendered memories: ${facts.evictionAndCaps.renderedMemories}`);
  lines.push(`    ${bullet} full caps: ${formatFullCaps(facts.evictionAndCaps.fullCaps, facts.evictionAndCaps.typeCounts, facts.evictionAndCaps.typeCaps, facts.evictionAndCaps.activeMemories, facts.evictionAndCaps.maxEntries)}`);
  lines.push(`    ${bullet} capacity removals: total=${facts.evictionAndCaps.removedByCapacity}, global=${facts.evictionAndCaps.removedByGlobalCap}, type=${facts.evictionAndCaps.removedByTypeCap}`);
  lines.push(`    ${bullet} recent evictions by type: ${formatCounts(facts.evictionAndCaps.recentEvictionsByType)}`);
  lines.push(`    ${bullet} recent evicted content shown: ${facts.evictionAndCaps.recentEvictedContentShown}`);
  lines.push(`    ${bullet} evidence-only disappearances: ${facts.evictionAndCaps.missingEvidenceOnly} (unknown: ${facts.evictionAndCaps.unknownDisappearances})`);
  lines.push("  Identity and dedup");
  lines.push(`    ${bullet} replacements: total=${facts.identityAndDedup.replacementEvents}, same-type=${facts.identityAndDedup.sameTypeReplacementEvents}, cross-type=${facts.identityAndDedup.crossTypeReplacementEvents}`);
  lines.push(`    ${bullet} superseded entries: ${facts.identityAndDedup.supersededEntries}`);
  lines.push(`    ${bullet} exact duplicate/identity groups identified: ${facts.identityAndDedup.duplicateTextOrIdentityGroups}`);
}

function pushMemoryContentFacts(lines: string[], report: ReviewBoardReport, bullet: string): void {
  const facts = report.facts.memoryContent;
  lines.push("Facts - memory content");
  lines.push(`  ${bullet} rendered memories: ${facts.renderedMemories}`);
  lines.push(`  ${bullet} evidence coverage: ${facts.evidenceCoverage.covered} / ${facts.evidenceCoverage.total}`);
  lines.push(`  ${bullet} type counts: ${formatTypeCountsWithCaps(facts.typeCounts, facts.typeCaps)}`);
  lines.push(`  ${bullet} weakest/strongest active memory previews: weakest=${formatMemoryPreviews(facts.weakestActiveMemories)}; strongest=${formatMemoryPreviews(facts.strongestActiveMemories)}`);
}

function pushSystemMechanismCandidates(lines: string[], report: ReviewBoardReport, bullet: string): void {
  const display = report.provenanceContext.candidateDisplay;
  if (report.provenanceContext.candidateLimit && display && display.shown < display.total) {
    lines.push(`System mechanism review candidates (representative; ${display.shown} shown of ${display.total} total; limit ${report.provenanceContext.candidateLimit} per mechanism category)`);
  } else {
    lines.push("System mechanism review candidates");
  }
  pushCandidateGroup(lines, "Rejection filter evidence", candidatesFor(report, ["rejection_rule_evidence"]), bullet);
  pushCandidateGroup(lines, "Re-absorption evidence", candidatesFor(report, ["reabsorption_evidence"]), bullet);
  pushCandidateGroup(lines, "Reinforcement rule evidence", candidatesFor(report, ["numbered_command_evidence"]), bullet);
  pushCandidateGroup(lines, "Eviction/cap evidence", candidatesFor(report, ["eviction_cap_evidence", "missing_evidence"]), bullet);
  pushCandidateGroup(lines, "Identity/dedup evidence", candidatesFor(report, ["identity_dedup_evidence"]), bullet);
}

function pushCandidateGroup(lines: string[], title: string, candidates: ReviewBoardCandidate[], bullet: string): void {
  lines.push(`  ${title}`);
  if (candidates.length === 0) {
    lines.push("    (none)");
    return;
  }
  const shared = sharedProvenance(candidates);
  if (shared) lines.push(`    shared provenance for displayed candidates in this group: ${formatProvenance(shared)}`);
  for (const candidate of candidates) pushCandidate(lines, candidate, bullet, shared);
}

function pushCandidate(lines: string[], candidate: ReviewBoardCandidate, bullet: string, groupProvenance?: CandidateProvenance): void {
  const rawReasonCodes = candidate.evidence.rawReasonCodes && candidate.evidence.rawReasonCodes.length > 0
    ? candidate.evidence.rawReasonCodes.join(", ")
    : "none";
  const question = candidate.reviewQuestions[0] ?? "What should a reviewer infer from this evidence?";
  lines.push(`    ${bullet} concern=${formatConcern(candidate.concernKind)} id=${candidate.id} source=${candidate.source} mechanism=${candidate.mechanism ?? "unspecified"} raw reason codes=${rawReasonCodes} question=${question}`);
  if (candidate.provenance && (!groupProvenance || formatProvenance(candidate.provenance) !== formatProvenance(groupProvenance))) {
    lines.push(`      provenance: ${formatProvenance(candidate.provenance)}`);
  }
  if (candidate.evidence.eventIds && candidate.evidence.eventIds.length > 0) lines.push(`      event ids: ${candidate.evidence.eventIds.join(", ")}`);
  if (candidate.evidence.textAvailable) {
    lines.push(`      text preview: ${candidate.evidence.textPreview ?? "available but empty after redaction"}`);
  } else {
    lines.push("      text preview: unavailable in historical evidence");
  }
  lines.push(`      facts: ${formatCandidateFacts(candidate.facts)}`);
  pushHeuristicFlags(lines, candidate.heuristicFlags, "      ", bullet);
}

function pushMemoryContentCandidates(lines: string[], report: ReviewBoardReport, bullet: string, options: { verbose?: boolean }): void {
  const display = report.activeMemoryDisplay;
  lines.push("Memory content review candidates");
  if (report.reviewQuestions.memoryContent.length > 0) {
    lines.push("  Standard review questions (applicable to all active memories below):");
    for (const question of report.reviewQuestions.memoryContent) lines.push(`    ${bullet} ${question}`);
  }
  if (display.total === 0) {
    lines.push("  Active memories (none)");
    return;
  }
  if (display.total <= display.threshold) {
    lines.push(`  Active memories (showing all ${display.total} because <= ${display.threshold})`);
  } else if (display.mode === "all" || options.verbose) {
    lines.push(`  Active memories (showing all ${display.total} because --verbose)`);
  } else {
    lines.push(`  Active memories (showing ${display.shown} of ${display.total})`);
    lines.push(`  Showing ${display.shown} of ${display.total} active memories. Use --verbose or --json for all active memory text.`);
  }
  display.items.forEach((item, index) => pushActiveMemory(lines, item, index + 1, bullet, report.reviewQuestions.memoryContent));
}

function pushActiveMemory(lines: string[], item: ReviewBoardActiveMemory, index: number, bullet: string, standardQuestions: string[]): void {
  const strength = typeof item.strength === "number" ? item.strength.toFixed(3) : "unknown";
  lines.push(`  [${index}] id=${item.id} type=${item.type} source=${item.source} status=${item.status} strength=${strength}`);
  lines.push("      text: " + indentContinuation(item.text, "      "));
  const rawReasonCodes = item.evidence.rawReasonCodes.length > 0 ? item.evidence.rawReasonCodes.join(", ") : "none";
  lines.push(`      evidence: events=${item.evidence.eventCount} raw reason codes=${rawReasonCodes}`);
  if (item.provenance) lines.push(`      provenance: ${formatProvenance(item.provenance)}`);
  pushHeuristicFlags(lines, item.heuristicFlags, "      ", bullet);
  if (questionsEqual(item.reviewQuestions, standardQuestions)) return;
  const additionalQuestions = item.reviewQuestions.filter(question => !standardQuestions.includes(question));
  if (additionalQuestions.length > 0 && additionalQuestions.length < item.reviewQuestions.length) {
    lines.push("      additional review questions:");
    for (const question of additionalQuestions) lines.push(`        ${bullet} ${question}`);
    return;
  }
  lines.push("      review questions:");
  for (const question of item.reviewQuestions) lines.push(`        ${bullet} ${question}`);
}

function pushHeuristicFlags(lines: string[], flags: HeuristicFlag[], indent: string, bullet: string): void {
  if (flags.length === 0) return;
  lines.push(`${indent}heuristic flags:`);
  for (const flag of flags) {
    const caveat = flag.caveat || REVIEW_FLAG_CAVEAT;
    lines.push(`${indent}  ${bullet} ${flag.label}: ${flag.evidence}. ${caveat}`);
  }
}

function pushReviewQuestions(lines: string[], report: ReviewBoardReport, bullet: string): void {
  lines.push("Review questions");
  lines.push("  SYSTEM MECHANISM");
  for (const question of report.reviewQuestions.systemMechanism) lines.push(`    ${bullet} ${question}`);
  lines.push("  MEMORY CONTENT");
  for (const question of report.reviewQuestions.memoryContent) lines.push(`    ${bullet} ${question}`);
}

function pushNextCommands(lines: string[], report: ReviewBoardReport, bullet: string): void {
  lines.push("Next commands");
  for (const command of report.nextCommands) lines.push(`  ${bullet} ${command}`);
}

function candidatesFor(report: ReviewBoardReport, sources: ReviewBoardCandidate["source"][]): ReviewBoardCandidate[] {
  const sourceSet = new Set(sources);
  return report.reviewCandidates.filter(candidate => candidate.concernKind === "system_mechanism" && sourceSet.has(candidate.source));
}

function sharedProvenance(candidates: ReviewBoardCandidate[]): CandidateProvenance | undefined {
  if (candidates.length <= 1) return undefined;
  const first = candidates[0]?.provenance;
  if (!first) return undefined;
  const key = formatProvenance(first);
  return candidates.every(candidate => candidate.provenance && formatProvenance(candidate.provenance) === key) ? first : undefined;
}

function formatConcern(concern: ReviewBoardCandidate["concernKind"]): string {
  return concern === "system_mechanism" ? "SYSTEM MECHANISM" : "MEMORY CONTENT";
}

function formatMigrationTimeline(timeline: ReviewBoardReport["provenanceContext"]["migrationTimeline"]): string {
  if (timeline.length === 0) return "(none)";
  return timeline.map(row => `${row.migrationId}=${row.presentInStore ? "present" : "absent"}${row.firstEvidenceAt ? ` firstEvidenceAt=${row.firstEvidenceAt}` : ""}`).join(", ");
}

function formatProvenanceCounts(counts: Record<ProvenanceClassification, number>): string {
  return PROVENANCE_ORDER.map(classification => `${classification}=${counts[classification] ?? 0}`).join(", ");
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length === 0 ? "(none)" : entries.map(([key, count]) => `${key}=${count}`).join(", ");
}

function formatTypeCountsWithCaps(counts: Record<string, number>, caps: Record<string, number>): string {
  const keys = uniqueSorted([...Object.keys(caps), ...Object.keys(counts)]);
  return keys.length === 0 ? "(none)" : keys.map(key => `${key} ${counts[key] ?? 0}/${caps[key] ?? "?"}`).join(", ");
}

function formatFullCaps(fullCaps: string[], typeCounts: Record<string, number>, typeCaps: Record<string, number>, active: number, maxEntries: number): string {
  if (fullCaps.length === 0) return "(none)";
  return fullCaps.map(cap => cap === "global" ? `global ${active}/${maxEntries}` : `${cap} ${typeCounts[cap] ?? 0}/${typeCaps[cap] ?? "?"}`).join(", ");
}

function formatRepeatedBlocks(blocks: ReviewBoardReport["facts"]["systemMechanisms"]["reinforcementRules"]["repeatedBlocksByMemory"]): string {
  if (blocks.length === 0) return "(none)";
  return blocks.map(block => `${block.memoryId} count=${block.count} refs=${block.refs.join("|") || "none"} raw reason codes=${block.rawReasonCodes.join("|") || "none"}`).join(", ");
}

function formatMemoryPreviews(items: ReviewBoardReport["facts"]["memoryContent"]["weakestActiveMemories"]): string {
  if (items.length === 0) return "(none)";
  return items.map(item => `${item.id} type=${item.type} strength=${typeof item.strength === "number" ? item.strength.toFixed(3) : "unknown"} text=${JSON.stringify(item.textPreview)}`).join(" | ");
}

function formatPercent(value: number): string {
  return `${(Number.isFinite(value) ? value * 100 : 0).toFixed(1)}%`;
}

function formatProvenance(provenance: CandidateProvenance): string {
  return `${provenance.classification} confidence=${provenance.confidence}; basis=${provenance.basis.join("; ") || "unavailable"}; caveat=${provenance.interpretationCaveat}`;
}

function formatCandidateFacts(facts: Record<string, unknown>): string {
  if (Object.keys(facts).length === 0) return "(none)";
  return formatDetails(Object.fromEntries(
    Object.entries(facts).map(([key, value]) => [key, formatFactValue(value)]),
  ));
}

function formatFactValue(value: unknown): string | number | boolean | string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map(item => typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null ? String(item) : stringifyUnknown(item));
  return stringifyUnknown(value);
}

function stringifyUnknown(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function questionsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function indentContinuation(text: string, indent: string): string {
  return text.split("\n").map((line, index) => index === 0 ? line : `${indent}${line}`).join("\n");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return cleanText(value, false);
  if (Array.isArray(value)) return value.map(item => redactUnknown(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactUnknown(item)]));
}
