import { assessMemoryQuality } from "../../../src/memory-quality.ts";
import {
  DORMANT_DECAY_MULTIPLIER,
  RETENTION_TYPE_MAX,
  WORKSPACE_DORMANT_AFTER_DAYS,
} from "../../../src/retention.ts";
import { renderWorkspaceMemory } from "../../../src/workspace-memory.ts";
import type { LongTermSource, PendingMemoryJournalStore, WorkspaceMemoryStore } from "../../../src/types.ts";
import { LONG_TERM_LIMITS } from "../../../src/types.ts";
import { SUSPICIOUS_REASONS, TYPES } from "../constants.ts";
import {
  ageDays,
  daysSinceIso,
  formatStrength,
  isSafetyCriticalForDiag,
  promotionLimit,
  retentionCandidatesForDiag,
} from "../retention-model.ts";
import {
  canonicalMemoryText,
  cleanPath,
  cleanText,
  countBy,
  formatPercent,
  formatWorkspaceIdentity,
  truncate,
} from "../text.ts";
import { normalizedJournal, normalizedStore } from "../workspace-snapshot.ts";

export type WorkspaceHealthInput = {
  root?: string;
  key: string;
  memoryPath: string;
  pendingPath: string;
  raw: boolean;
  now: number;
  includeTitle?: boolean;
};

export type WorkspaceHealthLoadedData = {
  rawStore: WorkspaceMemoryStore | null;
  rawJournal: PendingMemoryJournalStore | null;
  pendingExists: boolean;
};

export function formatWorkspaceHealth(input: WorkspaceHealthInput, loadedData: WorkspaceHealthLoadedData): string {
  const lines: string[] = [];
  if (input.includeTitle) {
    lines.push("Workspace memory health");
    lines.push("");
  }

  const rawStore = loadedData.rawStore;
  const storeRoot = rawStore?.workspace?.root ?? input.root ?? "";
  const storeKey = rawStore?.workspace?.key ?? input.key;
  const store = normalizedStore(rawStore, storeRoot, storeKey);
  const journal = normalizedJournal(loadedData.rawJournal);

  const identity = formatWorkspaceIdentity(storeKey, storeRoot || undefined, input.raw);
  if (identity) lines.push(identity);
  lines.push(`memoryPath=${cleanPath(input.memoryPath, input.raw)}`);
  lines.push(`pendingPath=${cleanPath(input.pendingPath, input.raw)}`);
  if (!rawStore) lines.push("memory store: missing or unreadable (treated as empty)");
  if (!loadedData.pendingExists) lines.push("pending journal: missing (treated as empty)");
  lines.push("");

  const active = store.entries.filter(entry => entry.status !== "superseded");
  const superseded = store.entries.filter(entry => entry.status === "superseded");
  const retention = retentionCandidatesForDiag(store, input.now);
  const renderedEntries = retention.rendered.map(item => item.entry);
  const renderedEstimate = renderWorkspaceMemory(store).length;

  lines.push(`Stored active memories: ${active.length}`);
  lines.push(`Superseded memories: ${superseded.length}`);
  lines.push(`Rendered candidates: ${renderedEntries.length}`);
  lines.push(`Rendered estimate: ${renderedEstimate.toLocaleString()} chars`);
  lines.push("");

  const pendingEntries = journal.entries;
  const retryable = pendingEntries.filter(entry => (entry.promotionAttempts ?? 0) < promotionLimit(entry.source)).length;
  const nearRetryLimit = pendingEntries.filter(entry => (entry.promotionAttempts ?? 0) >= promotionLimit(entry.source) - 1).length;
  const pendingBySource = countBy(pendingEntries.map(entry => entry.source));
  lines.push("Pending journal:");
  lines.push(`  total: ${pendingEntries.length}`);
  lines.push(`  retryable: ${retryable}`);
  lines.push(`  near retry limit: ${nearRetryLimit}`);
  lines.push("  by source:");
  for (const source of ["explicit", "manual", "compaction"] as LongTermSource[]) {
    lines.push(`    ${source}: ${pendingBySource.get(source) ?? 0}`);
  }
  lines.push("");

  lines.push("By type:");
  for (const type of TYPES) {
    const storedCount = active.filter(entry => entry.type === type).length;
    const renderedCount = renderedEntries.filter(entry => entry.type === type).length;
    const supersededCount = superseded.filter(entry => entry.type === type).length;
    lines.push(`  ${type.padEnd(9)} stored=${String(storedCount).padEnd(3)} rendered=${String(renderedCount).padEnd(3)} typeCap=${RETENTION_TYPE_MAX[type]} superseded=${supersededCount}`);
  }
  lines.push("");

  lines.push("Retention caps:");
  lines.push(`  type-capped entries: ${retention.typeCapped.length}`);
  lines.push(`  global-cap overflow: ${retention.globalCapped.length}`);
  lines.push("");

  const olderThan30 = active.filter(entry => (ageDays(entry, input.now) ?? 0) > 30).length;
  const olderThan90 = active.filter(entry => (ageDays(entry, input.now) ?? 0) > 90).length;
  const staleMarked = active.filter(entry => {
    const days = ageDays(entry, input.now);
    return Boolean(entry.staleAfterDays && days !== null && days > entry.staleAfterDays);
  }).length;
  lines.push("Age:");
  lines.push(`  stale-marked: ${staleMarked}`);
  lines.push(`  older than 30d: ${olderThan30}`);
  lines.push(`  older than 90d: ${olderThan90}`);
  lines.push("");

  const wallDaysSinceActivity = daysSinceIso(store.lastActivityAt, input.now);
  const dormantDiscountActive = wallDaysSinceActivity !== null && wallDaysSinceActivity > WORKSPACE_DORMANT_AFTER_DAYS;
  const dormantDaysPastGrace = wallDaysSinceActivity === null
    ? 0
    : Math.max(0, wallDaysSinceActivity - WORKSPACE_DORMANT_AFTER_DAYS);
  lines.push("Dormancy:");
  lines.push(`  lastActivityAt: ${store.lastActivityAt ?? "(missing)"}`);
  lines.push(`  wall days since activity: ${wallDaysSinceActivity === null ? "unknown" : wallDaysSinceActivity.toFixed(1)}`);
  lines.push(`  dormant discount active: ${dormantDiscountActive ? "yes" : "no"}`);
  lines.push(`  dormant days past grace: ${dormantDaysPastGrace.toFixed(1)}`);
  lines.push(`  dormant multiplier: ${DORMANT_DECAY_MULTIPLIER}`);
  lines.push("");

  const highImportanceCount = active.filter(entry => entry.userImportance === "high").length;
  const safetyCriticalCount = active.filter(isSafetyCriticalForDiag).length;
  const maxReinforcedCount = active.filter(entry => (entry.reinforcementCount ?? 0) >= 6).length;
  const highImportanceRatio = active.length === 0 ? 0 : highImportanceCount / active.length;
  const maxReinforcedRatio = active.length === 0 ? 0 : maxReinforcedCount / active.length;
  const highImportanceAlert = highImportanceRatio > 0.3;
  const safetyCriticalWarning = safetyCriticalCount > 0;
  const maxReinforcedAlert = maxReinforcedRatio > 0.1;
  lines.push("Retention monitoring:");
  lines.push(`  high_importance_ratio: ${formatPercent(highImportanceRatio)} (alert > 30%)${highImportanceAlert ? " ALERT" : ""}`);
  lines.push(`  safety_critical_count: ${safetyCriticalCount} (deprecated field)${safetyCriticalWarning ? " WARNING" : ""}`);
  lines.push(`  max_reinforced_count: ${maxReinforcedAlert ? `${maxReinforcedCount} (${formatPercent(maxReinforcedRatio)}, alert > 10%) ALERT` : `${maxReinforcedCount} (alert > 10% active)`}`);
  lines.push("");

  const qualityByEntry = active.map(entry => ({ entry, quality: assessMemoryQuality(entry) }));
  const duplicateCounts = countBy(active.map(entry => `${entry.type}:${canonicalMemoryText(entry.text)}`));
  const duplicateExtras = [...duplicateCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  lines.push("Quality warnings:");
  lines.push(`  progress-like active memories: ${qualityByEntry.filter(item => item.quality.reasons.includes("progress_snapshot")).length}`);
  lines.push(`  path-heavy active memories: ${qualityByEntry.filter(item => item.quality.reasons.includes("path_heavy")).length}`);
  lines.push(`  duplicate-ish exact canonical text: ${duplicateExtras}`);
  lines.push(`  very long entries: ${active.filter(entry => entry.text.length > LONG_TERM_LIMITS.maxEntryTextChars).length}`);
  lines.push("");

  lines.push("Suspicious active memories:");
  for (const reason of SUSPICIOUS_REASONS) {
    lines.push(`  ${reason}-like: ${qualityByEntry.filter(item => item.quality.reasons.includes(reason)).length}`);
  }

  const failingQuality = qualityByEntry.filter(item => !item.quality.accepted);
  if (failingQuality.length > 0) {
    lines.push("");
    lines.push("Active memories failing offline quality checks:");
    for (const item of failingQuality.slice(0, 8)) {
      lines.push(`  - [${item.entry.type}] reasons=${item.quality.reasons.join(",")} ${JSON.stringify(truncate(cleanText(item.entry.text, input.raw)))}`);
    }
  }

  lines.push("");
  lines.push("Top rendered candidates:");
  const top = retention.rendered.slice(0, 5);
  if (top.length === 0) {
    lines.push("  (none)");
  } else {
    for (const item of top) {
      lines.push(`  - strength=${formatStrength(item.strength)} [${item.entry.type}] ${truncate(cleanText(item.entry.text, input.raw))}`);
    }
  }

  lines.push("");
  lines.push("Weakest active memories:");
  const weakest = retention.sorted.slice(-5).reverse();
  if (weakest.length === 0) {
    lines.push("  (none)");
  } else {
    for (const item of weakest) {
      lines.push(`  - strength=${formatStrength(item.strength)} [${item.entry.type}] ${truncate(cleanText(item.entry.text, input.raw))}`);
    }
  }

  return lines.join("\n");
}
