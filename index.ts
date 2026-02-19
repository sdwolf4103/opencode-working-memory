/**
 * Working Memory Plugin for OpenCode
 *
 * Four-tier memory architecture:
 * 1. Core Memory - Persistent goal/progress/context blocks (always in-context)
 * 2. Working Memory - Auto-managed session-relevant information
 * 3. Smart Pruning - Content-aware tool output compression
 * 4. Memory Pressure Monitoring - Context usage tracking with adaptive warnings
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile, readdir, stat, unlink, rm } from "fs/promises";
import { join } from "path";

// ============================================================================
// Types & Schemas
// ============================================================================

type CoreMemory = {
  sessionID: string;
  blocks: {
    goal: CoreBlock;
    progress: CoreBlock;
    context: CoreBlock;
  };
  updatedAt: string;
};

type CoreBlock = {
  value: string;
  charLimit: number;
  lastModified: string;
};

const CORE_MEMORY_LIMITS = {
  goal: 1000,      // ~250 tokens
  progress: 2000,  // ~500 tokens
  context: 1500,   // ~375 tokens
};

// ============================================================================
// Smart Pruning Types
// ============================================================================

type PruningStrategy =
  | "keep-all"
  | "keep-ends"
  | "keep-last"
  | "summarize"
  | "discard";

type PruningRule = {
  strategy: PruningStrategy;
  firstChars?: number;
  lastChars?: number;
  maxChars?: number;
};

type CachedToolOutput = {
  callID: string;
  sessionID: string;
  tool: string;
  fullOutput: string;
  timestamp: number;
};

// ============================================================================
// Working Memory Types (Slot-based Architecture)
// ============================================================================

type WorkingMemory = {
  sessionID: string;
  slots: {
    error: WorkingMemoryItem[];      // FIFO queue, max 3 items
    decision: WorkingMemoryItem[];   // FIFO queue, max 5 items
    todo: WorkingMemoryItem[];       // FIFO queue, max 3 items
    dependency: WorkingMemoryItem[]; // FIFO queue, max 3 items
  };
  pool: WorkingMemoryItem[];         // file-path, finding, other (exponential decay)
  eventCounter: number;              // Increments on every add operation
  updatedAt: string;
};

type WorkingMemoryItem = {
  id: string;
  type: WorkingMemoryItemType;
  content: string;
  source: string; // e.g., "tool:read", "tool:bash", "manual"
  timestamp: number;
  relevanceScore: number;  // Only used for pool items (decay-based scoring)
  mentions: number;        // How many times referenced
  lastEventCounter?: number; // For pool items: tracks when score was last updated
};

type WorkingMemoryItemType =
  | "file-path"      // Important file paths discovered (pool)
  | "error"          // Errors encountered (slot)
  | "decision"       // Key decisions made (slot)
  | "other";         // Misc important info (pool)

// Slot-based types: guaranteed retention (FIFO)
type SlotType = "error" | "decision";

// Pool-based types: exponential decay
type PoolType = "file-path" | "other";

const SLOT_CONFIG: Record<SlotType, number> = {
  error: 3,      // Keep last 3 errors
  decision: 3,   // Keep last 3 decisions (FIFO, no human approval needed)
};

const POOL_CONFIG = {
  maxItems: 50,           // Maximum pool items
  gamma: 0.85,            // Decay rate (15% decay per event)
  minScore: 0.01,         // Remove items below this score
};

const WORKING_MEMORY_LIMITS = {
  maxCharsPerItem: 200,   // Max chars for each item
  systemPromptBudget: 1600, // ~400 tokens for system prompt injection (doubled to show more items)
};

// ============================================================================
// Storage Governance
// ============================================================================

const STORAGE_GOVERNANCE = {
  toolOutputMaxFiles: 300,                    // Max tool-output files per session
  toolOutputMaxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days TTL
  sweepInterval: 20,                          // Sweep every N tool calls
};

// ============================================================================
// Memory Pressure Monitoring
// ============================================================================

type PressureLevel = "safe" | "moderate" | "high";

type ModelPressureInfo = {
  sessionID: string;
  modelID: string;
  providerID: string;
  limits: {
    context: number;
    input?: number;
    output: number;
  };
  calculated: {
    maxOutputTokens: number; // min(model.limit.output, 32000)
    reserved: number; // min(20000, maxOutputTokens)
    usable: number; // input - reserved OR context - maxOutputTokens
  };
  current: {
    totalTokens: number; // sum of all message tokens
    pressure: number; // totalTokens / usable (0.0 - 1.0+)
    level: PressureLevel;
  };
  thresholds: {
    moderate: number; // usable * 0.75
    high: number; // usable * 0.90
  };
  updatedAt: string;
};

type CompactionLog = {
  sessionID: string;
  compactionCount: number;
  lastCompaction: number | null; // timestamp
  preservedItems: number; // how many working memory items were preserved
  updatedAt: string;
};

// ============================================================================
// Storage Management
// ============================================================================

function getCoreMemoryPath(directory: string, sessionID: string): string {
  return join(directory, ".opencode", "memory-core", `${sessionID}.json`);
}

function getToolOutputCachePath(
  directory: string,
  sessionID: string,
  callID: string
): string {
  return join(
    directory,
    ".opencode",
    "memory-working",
    "tool-outputs",
    sessionID,
    `${callID}.json`
  );
}

async function ensureToolOutputCacheDir(
  directory: string,
  sessionID: string
): Promise<void> {
  const dir = join(
    directory,
    ".opencode",
    "memory-working",
    "tool-outputs",
    sessionID
  );
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function ensureCoreMemoryDir(directory: string): Promise<void> {
  const dir = join(directory, ".opencode", "memory-core");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

function getWorkingMemoryPath(directory: string, sessionID: string): string {
  return join(directory, ".opencode", "memory-working", `${sessionID}.json`);
}

async function ensureWorkingMemoryDir(directory: string): Promise<void> {
  const dir = join(directory, ".opencode", "memory-working");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

function getCompactionLogPath(directory: string, sessionID: string): string {
  return join(directory, ".opencode", "memory-working", `${sessionID}_compaction.json`);
}

function getModelPressurePath(directory: string, sessionID: string): string {
  return join(directory, ".opencode", "memory-working", `${sessionID}_pressure.json`);
}

async function loadCoreMemory(
  directory: string,
  sessionID: string
): Promise<CoreMemory | null> {
  const path = getCoreMemoryPath(directory, sessionID);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as CoreMemory;
  } catch {
    return null;
  }
}

async function saveCoreMemory(
  directory: string,
  memory: CoreMemory
): Promise<void> {
  await ensureCoreMemoryDir(directory);
  const path = getCoreMemoryPath(directory, memory.sessionID);
  await writeFile(path, JSON.stringify(memory, null, 2), "utf-8");
}

function createEmptyCoreMemory(sessionID: string): CoreMemory {
  const now = new Date().toISOString();
  return {
    sessionID,
    blocks: {
      goal: {
        value: "",
        charLimit: CORE_MEMORY_LIMITS.goal,
        lastModified: now,
      },
      progress: {
        value: "",
        charLimit: CORE_MEMORY_LIMITS.progress,
        lastModified: now,
      },
      context: {
        value: "",
        charLimit: CORE_MEMORY_LIMITS.context,
        lastModified: now,
      },
    },
    updatedAt: now,
  };
}

async function loadWorkingMemory(
  directory: string,
  sessionID: string
): Promise<WorkingMemory | null> {
  const path = getWorkingMemoryPath(directory, sessionID);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = await readFile(path, "utf-8");
    const data = JSON.parse(content);
    
    // Migration: Convert old format (items array) to new format (slots + pool)
    if (data.items && !data.slots) {
      console.log("[Working Memory] Migrating from old format to slot-based architecture...");
      const migrated: WorkingMemory = {
        sessionID: data.sessionID,
        slots: {
          error: [],
          decision: [],
          todo: [],
          dependency: [],
        },
        pool: [],
        eventCounter: 0,
        updatedAt: new Date().toISOString(),
      };
      
      // Route each item to slot or pool
      for (const item of data.items) {
        const slotType = item.type as SlotType;
        if (slotType in SLOT_CONFIG) {
          // Slot-based item: add to appropriate slot (FIFO will be applied later)
          migrated.slots[slotType].push(item);
        } else {
          // Pool-based item: add to pool
          migrated.pool.push(item);
        }
      }
      
      // Apply FIFO limits to slots
      for (const slotType of Object.keys(SLOT_CONFIG) as SlotType[]) {
        const limit = SLOT_CONFIG[slotType];
        if (migrated.slots[slotType].length > limit) {
          // Keep only the most recent items
          migrated.slots[slotType] = migrated.slots[slotType]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit);
        }
      }
      
      // Apply pool limits
      if (migrated.pool.length > POOL_CONFIG.maxItems) {
        migrated.pool = migrated.pool
          .sort((a, b) => b.relevanceScore - a.relevanceScore)
          .slice(0, POOL_CONFIG.maxItems);
      }
      
      console.log(`[Working Memory] Migration complete: ${data.items.length} items -> ${Object.values(migrated.slots).flat().length} slot items + ${migrated.pool.length} pool items`);
      
      // Save migrated version
      await saveWorkingMemory(directory, migrated);
      return migrated;
    }
    
    return data as WorkingMemory;
  } catch {
    return null;
  }
}

async function saveWorkingMemory(
  directory: string,
  memory: WorkingMemory
): Promise<void> {
  await ensureWorkingMemoryDir(directory);
  const path = getWorkingMemoryPath(directory, memory.sessionID);
  await writeFile(path, JSON.stringify(memory, null, 2), "utf-8");
}

function createEmptyWorkingMemory(sessionID: string): WorkingMemory {
  return {
    sessionID,
    slots: {
      error: [],
      decision: [],
      todo: [],
      dependency: [],
    },
    pool: [],
    eventCounter: 0,
    updatedAt: new Date().toISOString(),
  };
}

async function loadCompactionLog(
  directory: string,
  sessionID: string
): Promise<CompactionLog | null> {
  const path = getCompactionLogPath(directory, sessionID);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = await Bun.file(path).text();
    return JSON.parse(content) as CompactionLog;
  } catch {
    return null;
  }
}

async function saveCompactionLog(
  directory: string,
  log: CompactionLog
): Promise<void> {
  await ensureWorkingMemoryDir(directory);
  const path = getCompactionLogPath(directory, log.sessionID);
  await Bun.write(path, JSON.stringify(log, null, 2));
}

function createInitialCompactionLog(sessionID: string): CompactionLog {
  return {
    sessionID,
    compactionCount: 0,
    lastCompaction: null,
    preservedItems: 0,
    updatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Core Memory Operations
// ============================================================================

function validateBlockContent(
  block: keyof CoreMemory["blocks"],
  content: string
): { valid: boolean; error?: string; truncated?: string } {
  const limit = CORE_MEMORY_LIMITS[block];

  if (content.length === 0) {
    return { valid: true };
  }

  if (content.length <= limit) {
    return { valid: true };
  }

  // Auto-truncate with warning
  const truncated = content.slice(0, limit);
  const charsRemoved = content.length - limit;

  return {
    valid: false,
    error: `Content exceeds ${block} block limit (${limit} chars). Truncated ${charsRemoved} chars.`,
    truncated,
  };
}

async function updateCoreMemoryBlock(
  directory: string,
  sessionID: string,
  block: keyof CoreMemory["blocks"],
  operation: "replace" | "append",
  content: string
): Promise<{ success: boolean; message: string; memory?: CoreMemory }> {
  let memory = await loadCoreMemory(directory, sessionID);

  if (!memory) {
    memory = createEmptyCoreMemory(sessionID);
  }

  let newValue: string;
  if (operation === "replace") {
    newValue = content;
  } else {
    // append
    const currentValue = memory.blocks[block].value;
    newValue = currentValue
      ? `${currentValue}\n${content}`
      : content;
  }

  const validation = validateBlockContent(block, newValue);

  if (!validation.valid && validation.truncated) {
    newValue = validation.truncated;
  }

  memory.blocks[block].value = newValue;
  memory.blocks[block].lastModified = new Date().toISOString();
  memory.updatedAt = new Date().toISOString();

  await saveCoreMemory(directory, memory);

  const message = validation.error
    ? `⚠️ ${validation.error}\n\nUpdated ${block} block (${operation}): ${newValue.length}/${CORE_MEMORY_LIMITS[block]} chars used.`
    : `✅ Updated ${block} block (${operation}): ${newValue.length}/${CORE_MEMORY_LIMITS[block]} chars used.`;

  return { success: true, message, memory };
}

// ============================================================================
// Storage Governance Functions
// ============================================================================

/**
 * Clean up all artifacts for a deleted session.
 */
async function cleanupSessionArtifacts(
  directory: string,
  sessionID: string
): Promise<void> {
  try {
    const artifacts = [
      join(directory, ".opencode", "memory-core", `${sessionID}.json`),
      join(directory, ".opencode", "memory-working", `${sessionID}.json`),
      join(directory, ".opencode", "memory-working", `${sessionID}_pressure.json`),
      join(directory, ".opencode", "memory-working", `${sessionID}_compaction.json`),
      join(directory, ".opencode", "memory-working", "tool-outputs", sessionID),
    ];

    for (const path of artifacts) {
      if (existsSync(path)) {
        await rm(path, { recursive: true, force: true });
      }
    }
  } catch (error) {
    // Silent failure - cleanup errors are non-critical
  }
}

/**
 * Sweep tool-output cache for a session.
 * Removes files older than TTL and enforces max file count.
 * Returns number of files deleted.
 */
async function sweepToolOutputCache(
  directory: string,
  sessionID: string
): Promise<number> {
  const cacheDir = join(directory, ".opencode", "memory-working", "tool-outputs", sessionID);
  
  if (!existsSync(cacheDir)) {
    return 0;
  }

  try {
    const files = await readdir(cacheDir);
    const now = Date.now();
    const { toolOutputMaxFiles, toolOutputMaxAgeMs } = STORAGE_GOVERNANCE;
    
    // Collect file stats
    const fileStats: Array<{ name: string; mtime: number; path: string }> = [];
    for (const file of files) {
      const filePath = join(cacheDir, file);
      try {
        const stats = await stat(filePath);
        if (stats.isFile()) {
          fileStats.push({
            name: file,
            mtime: stats.mtimeMs,
            path: filePath,
          });
        }
      } catch (err) {
        // Skip files that can't be stat'd
      }
    }

    // Identify files to delete
    const toDelete: string[] = [];

    // 1. Delete files older than TTL
    for (const file of fileStats) {
      if (now - file.mtime > toolOutputMaxAgeMs) {
        toDelete.push(file.path);
      }
    }

    // 2. If still over limit, delete oldest files
    const remaining = fileStats.filter(f => !toDelete.includes(f.path));
    if (remaining.length > toolOutputMaxFiles) {
      // Sort by mtime ascending (oldest first)
      remaining.sort((a, b) => a.mtime - b.mtime);
      const excess = remaining.length - toolOutputMaxFiles;
      for (let i = 0; i < excess; i++) {
        toDelete.push(remaining[i].path);
      }
    }

    // Delete files
    for (const path of toDelete) {
      try {
        await unlink(path);
      } catch (err) {
        // Ignore unlink errors (file might already be gone)
      }
    }

    return toDelete.length;
  } catch (error) {
    return 0;
  }
}

// ============================================================================
// Smart Pruning System
// ============================================================================

/**
 * Get pruning rule for a specific tool
 */
function getPruningRule(toolName: string): PruningRule {
  const rules: Record<string, PruningRule> = {
    // Keep all - valuable outputs
    grep: { strategy: "keep-all" },
    glob: { strategy: "keep-all" },
    memory_toast_retrieve: { strategy: "keep-all" },
    skill: { strategy: "keep-all" },

    // Keep ends - code files
    read: { strategy: "keep-ends", firstChars: 500, lastChars: 300 },

    // Keep last - command outputs
    bash: { strategy: "keep-last", maxChars: 1000 },

    // Keep first - task summaries
    task: { strategy: "keep-last", maxChars: 1500 },

    // Discard - confirmations
    edit: { strategy: "discard" },
    write: { strategy: "discard" },
  };

  return rules[toolName] || { strategy: "keep-last", maxChars: 1000 };
}

/**
 * Apply smart pruning to tool output with pressure-aware limits
 */
function applySmartPruning(
  output: string,
  rule: PruningRule,
  pressureConfig?: { maxLines: number; maxChars: number; aggressiveTruncation: boolean }
): string {
  let result = output;

  // Apply pressure-aware hard limits FIRST (if provided)
  if (pressureConfig && pressureConfig.aggressiveTruncation) {
    const lines = result.split('\n');
    
    // HYPER-AGGRESSIVE: Enforce hard line limit
    if (lines.length > pressureConfig.maxLines) {
      const omittedLines = lines.length - pressureConfig.maxLines;
      result = lines.slice(0, pressureConfig.maxLines).join('\n');
      result += `\n\n[⚠️ MEMORY PRESSURE: ${omittedLines} lines truncated. Use Grep/Task tool instead of direct reads.]`;
    }
    
    // HYPER-AGGRESSIVE: Enforce hard char limit
    if (result.length > pressureConfig.maxChars) {
      const omittedChars = result.length - pressureConfig.maxChars;
      result = result.slice(0, pressureConfig.maxChars);
      result += `\n\n[⚠️ MEMORY PRESSURE: ${omittedChars} chars truncated]`;
    }
  }

  // Then apply normal pruning strategy
  switch (rule.strategy) {
    case "keep-all":
      return result;

    case "keep-ends":
      return keepFirstAndLast(
        result,
        rule.firstChars || 500,
        rule.lastChars || 300
      );

    case "keep-last":
      return keepLast(result, rule.maxChars || 1000);

    case "summarize":
      return extractSummary(result, rule.maxChars || 500);

    case "discard":
      return `[Tool completed successfully]`;

    default:
      return result;
  }
}

/**
 * Keep first N and last M chars, with omission notice
 */
function keepFirstAndLast(
  text: string,
  firstChars: number,
  lastChars: number
): string {
  if (text.length <= firstChars + lastChars) {
    return text;
  }

  const firstPart = text.slice(0, firstChars);
  const lastPart = text.slice(-lastChars);
  const omitted = text.length - firstChars - lastChars;

  return `${firstPart}\n\n[... ${omitted} chars omitted for brevity ...]\n\n${lastPart}`;
}

/**
 * Keep only last N chars
 */
function keepLast(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const omitted = text.length - maxChars;
  return `[... ${omitted} chars omitted ...]\n\n${text.slice(-maxChars)}`;
}

/**
 * Extract summary from output (simple implementation)
 */
function extractSummary(text: string, maxChars: number): string {
  // Simple: just take first maxChars as "summary"
  // Could be enhanced with LLM-based summarization
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n[... truncated at ${maxChars} chars ...]`;
}

/**
 * Store full tool output for later smart pruning
 */
async function cacheToolOutput(
  directory: string,
  cached: CachedToolOutput
): Promise<void> {
  await ensureToolOutputCacheDir(directory, cached.sessionID);
  const path = getToolOutputCachePath(
    directory,
    cached.sessionID,
    cached.callID
  );
  await writeFile(path, JSON.stringify(cached, null, 2), "utf-8");
}

/**
 * Retrieve cached tool output
 */
async function getCachedToolOutput(
  directory: string,
  sessionID: string,
  callID: string
): Promise<CachedToolOutput | null> {
  const path = getToolOutputCachePath(directory, sessionID, callID);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as CachedToolOutput;
  } catch (error) {
    console.error("Failed to load cached tool output:", error);
    return null;
  }
}

// ============================================================================
// Working Memory Auto-Management
// ============================================================================

/**
 * Generate unique ID for working memory item
 */
function generateItemID(): string {
  return `wm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Extract key information from tool output
 */
function extractFromToolOutput(
  toolName: string,
  output: string
): WorkingMemoryItem[] {
  const items: WorkingMemoryItem[] = [];
  const timestamp = Date.now();

  switch (toolName) {
    case "read":
    case "glob": {
      // Extract file paths
      const pathMatches = output.match(/[\w\-\/\.]+\.(ts|js|json|md|tsx|jsx|py|java|go|rs)/g);
      if (pathMatches) {
        const uniquePaths = [...new Set(pathMatches)].slice(0, 5); // Top 5 unique paths
        for (const path of uniquePaths) {
          items.push({
            id: generateItemID(),
            type: "file-path",
            content: path,
            source: `tool:${toolName}`,
            timestamp,
            relevanceScore: 0,
            mentions: 1,
          });
        }
      }
      break;
    }

    case "bash": {
      // Extract errors
      if (output.toLowerCase().includes("error") || output.toLowerCase().includes("failed")) {
        const errorLines = output
          .split("\n")
          .filter(line => 
            line.toLowerCase().includes("error") || 
            line.toLowerCase().includes("failed")
          )
          .slice(0, 3); // Top 3 error lines

        for (const line of errorLines) {
          const truncated = line.slice(0, WORKING_MEMORY_LIMITS.maxCharsPerItem);
          items.push({
            id: generateItemID(),
            type: "error",
            content: truncated,
            source: "tool:bash",
            timestamp,
            relevanceScore: 0,
            mentions: 1,
          });
        }
      }
      break;
    }

    case "grep": {
      // Extract file paths with matches (treat as file-path, not a separate "finding" type)
      // OpenCode grep format: "Found N matches\n/path/to/file:\n  Line X: ..."
      // Match file paths that end with common extensions followed by ":"
      const grepMatches = output.match(/^(\/[^\n]+\.(ts|js|md|json|tsx|jsx|py|java|go|rs|txt|yml|yaml|toml)):/gm);
      if (grepMatches) {
        const uniqueFiles = [...new Set(grepMatches.map(m => m.replace(/:$/, "")))].slice(0, 5);
        for (const file of uniqueFiles) {
          items.push({
            id: generateItemID(),
            type: "file-path",
            content: file,
            source: "tool:grep",
            timestamp,
            relevanceScore: 0,
            mentions: 1,
          });
        }
      }
      break;
    }

    case "edit":
    case "write": {
      // Extract file paths being modified
      const filePathMatch = output.match(/([\w\-\/\.]+\.(ts|js|json|md|tsx|jsx|py|java|go|rs))/);
      if (filePathMatch) {
        items.push({
          id: generateItemID(),
          type: "file-path",
          content: `Modified: ${filePathMatch[1]}`,
          source: `tool:${toolName}`,
          timestamp,
          relevanceScore: 0,
          mentions: 1,
        });
      }
      break;
    }
  }

  return items;
}

/**
 * Calculate relevance score for pool items (exponential decay)
 * 
 * Formula: S_i^(t) = S_i^(t-1) × γ^(events_elapsed) + W_i
 * Where:
 * - γ = decay rate (0.85)
 * - events_elapsed = current eventCounter - item's lastEventCounter
 * - W_i = mention boost (mentions × 1.0)
 */
function calculatePoolScore(
  item: WorkingMemoryItem,
  currentEventCounter: number
): number {
  // Calculate events elapsed since last update
  const lastEvent = item.lastEventCounter ?? 0;
  const eventsElapsed = currentEventCounter - lastEvent;
  
  // Apply exponential decay to existing score
  const decayedScore = item.relevanceScore * Math.pow(POOL_CONFIG.gamma, eventsElapsed);
  
  // Mention boost (not subject to decay)
  const mentionBoost = item.mentions * 0.5;
  
  return Math.max(0, decayedScore + mentionBoost);
}

/**
 * Helper: Check if item type is slot-based
 */
function isSlotType(type: WorkingMemoryItemType): type is SlotType {
  return type in SLOT_CONFIG;
}

/**
 * Add item to working memory (slot-based architecture with auto-cleanup)
 */
async function addToWorkingMemory(
  directory: string,
  sessionID: string,
  item: Omit<WorkingMemoryItem, "id" | "relevanceScore">
): Promise<WorkingMemory> {
  let memory = await loadWorkingMemory(directory, sessionID);
  if (!memory) {
    memory = createEmptyWorkingMemory(sessionID);
  }

  // Increment event counter for pool decay
  memory.eventCounter += 1;

  if (isSlotType(item.type)) {
    // ===== Slot-based item: FIFO queue =====
    const slotType = item.type as SlotType;
    const slot = memory.slots[slotType];
    
    // Check for duplicates (same content)
    const existing = slot.find(i => i.content === item.content);
    if (existing) {
      // Increment mentions, update timestamp (refresh item)
      existing.mentions += 1;
      existing.timestamp = item.timestamp;
    } else {
      // Add new item
      const newItem: WorkingMemoryItem = {
        ...item,
        id: generateItemID(),
        relevanceScore: 0, // Not used for slots
      };
      slot.push(newItem);
      
      // Apply FIFO limit: keep only most recent N items
      const limit = SLOT_CONFIG[slotType];
      if (slot.length > limit) {
        // Sort by timestamp descending, keep top N
        slot.sort((a, b) => b.timestamp - a.timestamp);
        memory.slots[slotType] = slot.slice(0, limit);
      }
    }
  } else {
    // ===== Pool-based item: Exponential decay =====
    // Check for duplicates (same content)
    const existing = memory.pool.find(i => i.content === item.content);
    if (existing) {
      // Recalculate score with decay first
      existing.relevanceScore = calculatePoolScore(existing, memory.eventCounter);
      
      // Then increment mentions and update timestamp
      existing.mentions += 1;
      existing.timestamp = item.timestamp;
      existing.lastEventCounter = memory.eventCounter;
      
      // Add mention boost to score
      existing.relevanceScore += 0.5;
    } else {
      // Add new item with initial score
      const newItem: WorkingMemoryItem = {
        ...item,
        id: generateItemID(),
        relevanceScore: 1.0, // Initial score
        lastEventCounter: memory.eventCounter,
      };
      memory.pool.push(newItem);
    }
    
    // Apply decay to all OTHER pool items (not the one we just added/updated)
    for (const poolItem of memory.pool) {
      if (poolItem.content !== item.content) {
        poolItem.relevanceScore = calculatePoolScore(poolItem, memory.eventCounter);
        poolItem.lastEventCounter = memory.eventCounter;
      }
    }
    
    // Remove items below min score
    memory.pool = memory.pool.filter(i => i.relevanceScore >= POOL_CONFIG.minScore);
    
    // Sort by relevance score (descending)
    memory.pool.sort((a, b) => b.relevanceScore - a.relevanceScore);
    
    // Limit to max items
    if (memory.pool.length > POOL_CONFIG.maxItems) {
      memory.pool = memory.pool.slice(0, POOL_CONFIG.maxItems);
    }
  }

  memory.updatedAt = new Date().toISOString();
  await saveWorkingMemory(directory, memory);

  return memory;
}

/**
 * Get top items for system prompt injection (slots first, then pool)
 */
function getTopItemsForPrompt(
  memory: WorkingMemory,
  maxChars: number = WORKING_MEMORY_LIMITS.systemPromptBudget
): { slotItems: WorkingMemoryItem[], poolItems: WorkingMemoryItem[] } {
  const slotItems: WorkingMemoryItem[] = [];
  const poolItems: WorkingMemoryItem[] = [];
  let usedChars = 0;

  // Priority 1: Add all slot items (they're guaranteed)
  for (const slotType of Object.keys(SLOT_CONFIG) as SlotType[]) {
    const items = memory.slots[slotType];
    // Sort by timestamp descending (most recent first)
    const sorted = [...items].sort((a, b) => b.timestamp - a.timestamp);
    for (const item of sorted) {
      const itemChars = item.content.length + 20; // +20 for formatting
      if (usedChars + itemChars > maxChars) {
        break;
      }
      slotItems.push(item);
      usedChars += itemChars;
    }
  }

  // Priority 2: Add pool items (sorted by relevance score)
  for (const item of memory.pool) {
    const itemChars = item.content.length + 20; // +20 for formatting
    if (usedChars + itemChars > maxChars) {
      break;
    }
    poolItems.push(item);
    usedChars += itemChars;
  }

  return { slotItems, poolItems };
}

/**
 * Compress file paths to save space in system prompt.
 */
function compressPath(content: string): string {
  const homeDir = process.env.HOME || '/Users/' + (process.env.USER || 'user');
  
  return content
    // Replace home directory with ~
    .replace(new RegExp(`^${homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '~')
    // Shorten common patterns
    .replace(/\/packages\//g, '/pkg/')
    .replace(/\/opencode-plugins\//g, '/oc-plugins/')
    .replace(/\/node_modules\//g, '/nm/')
    .replace(/\/typescript\//g, '/ts/')
    .replace(/\/javascript\//g, '/js/');
}

/**
 * Render working memory items for system prompt
 */
function renderWorkingMemoryPrompt(memory: WorkingMemory): string {
  const { slotItems, poolItems } = getTopItemsForPrompt(memory);
  
  if (slotItems.length === 0 && poolItems.length === 0) {
    return "";
  }

  // Group items by type
  const itemsByType = new Map<WorkingMemoryItemType, WorkingMemoryItem[]>();
  for (const item of [...slotItems, ...poolItems]) {
    if (!itemsByType.has(item.type)) {
      itemsByType.set(item.type, []);
    }
    itemsByType.get(item.type)!.push(item);
  }

  const sections: string[] = [];

  // Format each type section (ordered by importance)
  const typeLabels: Record<WorkingMemoryItemType, string> = {
    "file-path": "📁 Key Files",
    "error": "⚠️ Recent Errors",
    "decision": "💡 Decisions",
    "other": "📝 Notes",
  };

  const typeOrder: WorkingMemoryItemType[] = [
    "error", "decision",      // Slots first
    "file-path", "other"      // Pool second
  ];

  for (const type of typeOrder) {
    const items = itemsByType.get(type);
    if (!items || items.length === 0) continue;
    
    const label = typeLabels[type] || "📝 Notes";
    // Compress file paths to save space
    const itemList = items.map(item => {
      const content = (type === "file-path") 
        ? compressPath(item.content)
        : item.content;
      return `  - ${content}`;
    }).join("\n");
    sections.push(`${label}:\n${itemList}`);
  }

  const totalItems = slotItems.length + poolItems.length;
  return `
<working_memory>
Recent session context (auto-managed, sorted by relevance):

${sections.join("\n\n")}

(${totalItems} items shown)
</working_memory>
`.trim();
}

function getWorkingMemoryItemCount(memory: WorkingMemory): number {
  const slotCount = Object.values(memory.slots).reduce(
    (count, slotItems) => count + slotItems.length,
    0
  );
  return slotCount + memory.pool.length;
}

// ============================================================================
// Compaction Tracking
// ============================================================================

/**
 * Keep only the most relevant working memory items before compaction
 * Returns number of items preserved
 */
async function preserveRelevantItems(
  directory: string,
  sessionID: string,
  keepPercentage: number = 0.5 // Keep top 50% by default
): Promise<number> {
  const memory = await loadWorkingMemory(directory, sessionID);
  if (!memory) {
    return 0;
  }

  // Slots are always preserved (they're guaranteed retention)
  const slotCount = Object.values(memory.slots).flat().length;

  // For pool items, keep top N%
  const poolSize = memory.pool.length;
  if (poolSize > 0) {
    const keepCount = Math.max(1, Math.ceil(poolSize * keepPercentage));
    
    // Pool is already sorted by relevance score, just slice
    memory.pool = memory.pool.slice(0, keepCount);
  }

  memory.updatedAt = new Date().toISOString();
  await saveWorkingMemory(directory, memory);

  return slotCount + memory.pool.length;
}

/**
 * Record compaction event in log
 */
async function recordCompaction(
  directory: string,
  sessionID: string,
  preservedItems: number
): Promise<CompactionLog> {
  let log = await loadCompactionLog(directory, sessionID);
  if (!log) {
    log = createInitialCompactionLog(sessionID);
  }

  log.compactionCount += 1;
  log.lastCompaction = Date.now();
  log.preservedItems = preservedItems;
  log.updatedAt = new Date().toISOString();

  await saveCompactionLog(directory, log);
  return log;
}

// ============================================================================
// Memory Pressure Calculation & Tracking
// ============================================================================

/**
 * Calculate usable tokens using OpenCode's compaction formula.
 */
function calculateUsableTokens(model: {
  limit: { context: number; input?: number; output: number };
}): number {
  const OUTPUT_TOKEN_MAX = 32_000;
  const COMPACTION_BUFFER = 20_000;

  const maxOutputTokens = Math.min(
    model.limit.output || OUTPUT_TOKEN_MAX,
    OUTPUT_TOKEN_MAX
  );
  const reserved = Math.min(COMPACTION_BUFFER, maxOutputTokens);

  const usable = model.limit.input
    ? model.limit.input - reserved
    : model.limit.context - maxOutputTokens;

  return usable;
}

/**
 * Calculate pressure level based on current tokens and usable limit.
 */
function calculatePressureLevel(
  currentTokens: number,
  usable: number
): PressureLevel {
  const pressure = currentTokens / usable;

  if (pressure >= 0.90) return "high";
  if (pressure >= 0.75) return "moderate";
  return "safe";
}

/**
 * Calculate complete pressure information for a model
 */
function calculateModelPressure(
  sessionID: string,
  model: { id: string; providerID: string; limit: { context: number; input?: number; output: number } },
  totalTokens: number
): ModelPressureInfo {
  const OUTPUT_TOKEN_MAX = 32_000;
  const COMPACTION_BUFFER = 20_000;

  const maxOutputTokens = Math.min(
    model.limit.output || OUTPUT_TOKEN_MAX,
    OUTPUT_TOKEN_MAX
  );
  const reserved = Math.min(COMPACTION_BUFFER, maxOutputTokens);
  const usable = calculateUsableTokens(model);

  const pressure = totalTokens / usable;
  const level = calculatePressureLevel(totalTokens, usable);

  return {
    sessionID,
    modelID: model.id,
    providerID: model.providerID,
    limits: {
      context: model.limit.context,
      input: model.limit.input,
      output: model.limit.output,
    },
    calculated: {
      maxOutputTokens,
      reserved,
      usable,
    },
    current: {
      totalTokens,
      pressure,
      level,
    },
    thresholds: {
      moderate: Math.floor(usable * 0.75),
      high: Math.floor(usable * 0.90),
    },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Save model pressure info to disk
 */
async function saveModelPressureInfo(
  directory: string,
  info: ModelPressureInfo
): Promise<void> {
  await ensureWorkingMemoryDir(directory);
  const path = getModelPressurePath(directory, info.sessionID);
  try {
    await writeFile(path, JSON.stringify(info, null, 2), "utf-8");
  } catch (error) {
    console.error("[working-memory] Failed to save pressure info:", error);
  }
}

/**
 * Load model pressure info from disk
 */
async function loadModelPressureInfo(
  directory: string,
  sessionID: string
): Promise<ModelPressureInfo | null> {
  const path = getModelPressurePath(directory, sessionID);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as ModelPressureInfo;
  } catch (error) {
    console.error("[working-memory] Failed to load pressure info:", error);
    return null;
  }
}

/**
 * Calculate total tokens by querying session messages via OpenCode SDK.
 * Cross-platform compatible (no sqlite3 CLI dependency).
 */
async function calculateTotalTokensFromDB(
  client: ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>,
  sessionID: string
): Promise<number> {
  try {
    const result = await client.session.messages({
      path: { id: sessionID }
    });
    
    if (!result.data) return 0;
    
    // Find the most recent assistant message with non-zero tokens.
    // API returns messages oldest-first, so we scan backwards.
    for (let i = result.data.length - 1; i >= 0; i--) {
      const { info } = result.data[i];
      if (info.role !== "assistant") continue;
      
      // Total = input + output + reasoning + cache.read
      const total = info.tokens.input + info.tokens.output + info.tokens.reasoning + info.tokens.cache.read;
      if (total > 0) return total;
    }
    
    return 0;
  } catch (error) {
    // Silent — API call failed
    return 0;
  }
}

/**
 * Generate pressure warning text for system prompt injection.
 */
function generatePressureWarning(info: ModelPressureInfo): string {
  const { current, calculated } = info;
  const pct = (current.pressure * 100).toFixed(0);

  if (current.level === "high") {
    return `\n\n⚠️ HIGH MEMORY PRESSURE: ${pct}% (${current.totalTokens.toLocaleString()}/${calculated.usable.toLocaleString()} usable tokens). Compaction approaching. REQUIRED ACTIONS: Pause current task. Use core_memory_update to write your current progress, findings, and exact next steps. Use working_memory_clear_slot to drop resolved errors and completed todos. Then use Task tool for any remaining exploration.`;
  }

  if (current.level === "moderate") {
    return `\n\n💡 Memory pressure: ${pct}% - Prefer Task tool for exploration. Update core_memory regularly.`;
  }

  return "";
}

/**
 * Send a proactive intervention message when HIGH pressure (90%) is detected.
 * Uses promptAsync() which returns immediately (non-blocking).
 */
async function sendPressureInterventionMessage(
  client: any,
  sessionID: string,
  info: ModelPressureInfo
): Promise<void> {
  const { current, calculated } = info;
  const pct = (current.pressure * 100).toFixed(0);
  
  if (current.level !== "high") return;
  
  const systemPrompt = `⚠️ HIGH MEMORY PRESSURE DETECTED: ${pct}% (${current.totalTokens.toLocaleString()}/${calculated.usable.toLocaleString()} usable tokens)

Compaction is approaching. You must take action now to preserve your work:

REQUIRED ACTIONS:
1. Pause your current task immediately
2. Use core_memory_update to save:
   - Current progress on your task
   - Key findings and discoveries
   - Exact next steps to continue after compaction
3. Use working_memory_clear_slot to drop resolved errors and completed todos
4. Use Task tool for any remaining exploration work

After completing these actions, you may resume your current task.`;
  
  try {
    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        parts: [{
          type: "text",
          text: systemPrompt,
        }],
        noReply: false,
      },
    });
  } catch (error) {
    console.error("[working-memory] Failed to send pressure intervention:", error);
  }
}

/**
 * Get pressure-aware pruning config based on current memory pressure.
 */
function getPressureAwarePruningConfig(pressure: number): {
  maxLines: number;
  maxChars: number;
  aggressiveTruncation: boolean;
} {
  if (pressure >= 0.90) {
    return {
      maxLines: 2000,
      maxChars: 100_000,
      aggressiveTruncation: true,
    };
  }

  if (pressure >= 0.75) {
    return {
      maxLines: 5000,
      maxChars: 200_000,
      aggressiveTruncation: true,
    };
  }

  return {
    maxLines: 10_000,
    maxChars: 400_000,
    aggressiveTruncation: false,
  };
}

// ============================================================================
// System Prompt Rendering
// ============================================================================

function renderCoreMemoryPrompt(memory: CoreMemory): string {
  const { goal, progress, context } = memory.blocks;

  return `
<core_memory>
The following persistent memory blocks track your current task state:

<goal chars="${goal.value.length}/${goal.charLimit}">
${goal.value || "[Not set - ask user for goals and update this block]"}
</goal>

<progress chars="${progress.value.length}/${progress.charLimit}">
${progress.value || "[No progress tracked yet - update as you work]"}
</progress>

<context chars="${context.value.length}/${context.charLimit}">
${context.value || "[No project context set - add relevant file paths, conventions, etc.]"}
</context>

IMPORTANT: These blocks persist across conversation resets and compaction.
Update them regularly using core_memory_update tool. When blocks approach their character limits, compress or rephrase content.

To mark decisions for automatic capture into working memory, write inline: [Decision: chose X over Y because Z]
</core_memory>
`.trim();
}

// ============================================================================
// Plugin Implementation
// ============================================================================

export default async function WorkingMemoryPlugin(
  input: Parameters<Plugin>[0]
): Promise<ReturnType<Plugin>> {
  const { directory, client } = input;

  // Cache for sub-agent detection — avoids repeated API calls per session.
  // Maps sessionID → parentID (string) or null (root session).
  const sessionParentCache = new Map<string, string | null>();

  async function isSubAgent(sessionID: string): Promise<boolean> {
    if (sessionParentCache.has(sessionID)) {
      return sessionParentCache.get(sessionID) !== null;
    }
    try {
      const result = await client.session.get({ path: { id: sessionID } });
      const parentID = result.data?.parentID ?? null;
      sessionParentCache.set(sessionID, parentID);
      return parentID !== null;
    } catch {
      // If we can't determine, assume it's NOT a sub-agent (safe default).
      sessionParentCache.set(sessionID, null);
      return false;
    }
  }

  return {
    // Inject pressure warnings, core memory, and working memory into the system prompt each turn.
    // Core memory usage guidelines are in the core_memory_update tool description instead.
    "experimental.chat.system.transform": async (hookInput, output) => {
      const { sessionID, model } = hookInput;
      if (!sessionID) return;

      // Sub-agents are short-lived — skip entire memory system.
      if (await isSubAgent(sessionID)) return;

      // Check for memory pressure and inject warning into system prompt.
      // Skip if model just changed (avoids false alarms with different limits).
      const prevPressure = await loadModelPressureInfo(directory, sessionID);
      const modelChanged = model && prevPressure && prevPressure.modelID !== model.id;
      
      if (!modelChanged && prevPressure && prevPressure.current.level !== "safe") {
        const warning = generatePressureWarning(prevPressure);
        if (warning) {
          output.system.push(warning);
        }
      }

      // Calculate current token usage from DB and update pressure info.
      if (model) {
        const totalTokens = await calculateTotalTokensFromDB(client, sessionID);
        
        // Calculate pressure with current model
        const updatedPressure = calculateModelPressure(
          sessionID,
          {
            id: model.id,
            providerID: model.providerID,
            limit: model.limit,
          },
          totalTokens
        );
        
        // Save for next turn's warning injection.
        await saveModelPressureInfo(directory, updatedPressure);
        
        // Send proactive intervention if pressure just crossed into HIGH.
        if (updatedPressure.current.level === "high") {
          // Only send if pressure just escalated (avoid repeated spam).
          const shouldSend = !prevPressure || 
            prevPressure.current.level === "safe" || 
            prevPressure.current.level === "moderate";
          
          if (shouldSend) {
            await sendPressureInterventionMessage(client, sessionID, updatedPressure);
          }
        }
      }

      // Core memory
      const coreMemory = await loadCoreMemory(directory, sessionID);
      if (coreMemory) {
        const hasContent =
          coreMemory.blocks.goal.value ||
          coreMemory.blocks.progress.value ||
          coreMemory.blocks.context.value;

        if (hasContent) {
          const corePrompt = renderCoreMemoryPrompt(coreMemory);
          output.system.push(corePrompt);
        }
      }

      // Working memory
      const workingMemory = await loadWorkingMemory(directory, sessionID);
      if (workingMemory && getWorkingMemoryItemCount(workingMemory) > 0) {
        const workingPrompt = renderWorkingMemoryPrompt(workingMemory);
        if (workingPrompt) {
          output.system.push(workingPrompt);
        }
      }
    },

    // Cache tool outputs, auto-extract to working memory, and sweep cache periodically.
    "tool.execute.after": async (hookInput, hookOutput) => {
      const { sessionID, callID, tool: toolName, args } = hookInput;
      const { output: toolOutput } = hookOutput;

      // Sub-agents don't need working memory tracking.
      if (await isSubAgent(sessionID)) return;

      await cacheToolOutput(directory, {
        callID,
        sessionID,
        tool: toolName,
        fullOutput: toolOutput,
        timestamp: Date.now(),
      });

      const extractedItems = extractFromToolOutput(toolName, toolOutput);
      for (const item of extractedItems) {
        await addToWorkingMemory(directory, sessionID, item);
      }

      // Sweep tool-output cache every N tool calls.
      const memory = await loadWorkingMemory(directory, sessionID);
      if (memory && memory.eventCounter % STORAGE_GOVERNANCE.sweepInterval === 0) {
        await sweepToolOutputCache(directory, sessionID);
      }
    },

    // Apply smart pruning to compacted tool outputs (pressure-aware).
    "experimental.chat.messages.transform": async (hookInput, output) => {
      const sessionID = output.messages[0]?.info?.sessionID || "";
      
      // Sub-agents don't need smart pruning.
      if (sessionID && await isSubAgent(sessionID)) return;

      // Load current pressure info to get pressure-aware pruning config
      const currentPressure = await loadModelPressureInfo(directory, sessionID);
      const pressureLevel = currentPressure?.current?.pressure || 0;
      const pruningConfig = getPressureAwarePruningConfig(pressureLevel);

      // Apply smart pruning with pressure-aware limits
      for (const msg of output.messages) {
        for (const part of msg.parts) {
          // Check if this is a tool result that was pruned by OpenCode
          if (
            part.type === "tool" &&
            part.state?.status === "completed" &&
            part.state?.time?.compacted
          ) {
            // Retrieve cached full output
            const cached = await getCachedToolOutput(
              directory,
              msg.info.sessionID || "",
              part.callID || ""
            );

            if (cached) {
              const rule = getPruningRule(part.tool || "");
              const smartPruned = applySmartPruning(cached.fullOutput, rule, pruningConfig);

              // Replace the generic "[Old tool result content cleared]" with smart summary
              part.state.output = smartPruned;

              // Remove compacted marker to prevent double-pruning
              delete part.state.time.compacted;
            }
          }
        }
      }
    },

    // Auto-capture [Decision: ...] markers from agent responses.
    "experimental.text.complete": async (hookInput, output) => {
      const { sessionID } = hookInput;
      if (!sessionID) return;

      // Sub-agents are short-lived — skip decision tracking.
      if (await isSubAgent(sessionID)) return;

      // Extract all [Decision: ...] markers from the completed text.
      const matches = output.text.matchAll(/\[Decision:\s*([^\]]+)\]/gi);
      for (const match of matches) {
        const description = match[1].trim();
        if (!description) continue;

        await addToWorkingMemory(directory, sessionID, {
          type: "decision",
          content: description,
          source: "auto:text",
          timestamp: Date.now(),
          mentions: 1,
        });
      }
    },

    // Clean up all session artifacts on session deletion.
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const sessionID = event.properties?.info?.id;
        if (sessionID) {
          await cleanupSessionArtifacts(directory, sessionID);
        }
      }
    },

    // Preserve working memory state before compaction.
    "experimental.session.compacting": async (hookInput, output) => {
      const { sessionID } = hookInput;

      // Sub-agents don't need compaction support.
      if (await isSubAgent(sessionID)) return;

      // Preserve only the most relevant working memory items
      const preservedItems = await preserveRelevantItems(directory, sessionID, 0.5);

      // Record this compaction event
      const log = await recordCompaction(directory, sessionID, preservedItems);

      // Add context to compaction prompt to help preserve key info
      const coreMemory = await loadCoreMemory(directory, sessionID);
      if (coreMemory) {
        const { goal, progress, context } = coreMemory.blocks;
        
        let contextParts: string[] = [];
        
        if (goal.value) {
          contextParts.push(`Current goal: ${goal.value}`);
        }
        
        if (progress.value) {
          // Extract just the "next steps" portion if it exists
          const progressLines = progress.value.split('\n');
          const nextStepsIdx = progressLines.findIndex(line => 
            line.includes('⏭️') || line.toLowerCase().includes('next')
          );
          if (nextStepsIdx >= 0) {
            contextParts.push(`Next steps: ${progressLines[nextStepsIdx]}`);
          }
        }

        if (contextParts.length > 0) {
          output.context.push(
            `IMPORTANT: Preserve these key details:\n${contextParts.join('\n')}`
          );
        }
      }

      // Inject pending OpenCode todos into compaction context.
      try {
        const result = await client.session.todo({
          path: { id: sessionID }
        });
        
        if (result.data) {
          const todos = result.data
            .filter(todo => todo.status !== "completed")
            .map(todo => `- [${todo.status}] ${todo.content} (${todo.priority})`);
          
          if (todos.length > 0) {
            output.context.push(
              `PENDING TODOS:\n${todos.join('\n')}\nIMPORTANT: Continue working on these tasks after compaction.`
            );
          }
        }
      } catch (error) {
        // Silent — API call failed
      }

      // Inform about preserved working memory
      if (preservedItems > 0) {
        output.context.push(
          `Working memory: Preserved ${preservedItems} most relevant items (compaction #${log.compactionCount})`
        );
      }
    },

    // Tools
    tool: {
      core_memory_update: tool({
        description: `Update persistent core memory blocks that survive compaction.

Available blocks:
- goal: What the user is trying to accomplish (max 1000 chars)
- progress: What's done, in-progress, and next steps (max 2000 chars)
- context: Key project context like file paths, conventions, patterns (max 1500 chars)

Operations:
- replace: Completely replace the block content
- append: Add content to the end of the block (automatically adds newline)

These blocks are ALWAYS visible to you in every message, even after compaction.
Update them regularly to maintain continuity across long conversations.

---

## Usage Guidelines

### goal block (1000 chars)
**Purpose**: ONE specific task you're working on RIGHT NOW

✅ GOOD: "Fix pruning bug where items with relevanceScore <0.01 are incorrectly excluded"
✅ GOOD: "Add new tool: working_memory_search to query pool items by keyword"
❌ BAD: "Complete Phase 1-4 development and testing" (too broad, likely already done)
❌ BAD: "Build a working memory system for OpenCode" (project-level goal, not task-level)

### progress block (2000 chars)
**Purpose**: Checklist of done/in-progress/blocked items + key decisions

✅ GOOD: "✅ Found bug in applyDecay()\\n⏳ Testing fix with gamma=0.85\\n❓ Need to verify edge case"
✅ GOOD: "✅ Phase 1-3 complete\\n⏳ Phase 4 intervention testing\\n⚠️ BLOCKED: Need promptAsync docs"
❌ BAD: "Function foo() @ file.ts:L1286-1354" (line numbers useless after edits)
❌ BAD: "Commit 2f42f1b implemented X" (commit hash irrelevant)
❌ BAD: "API: client.session.promptAsync({ ... })" (API signatures belong in source)

### context block (1500 chars)
**Purpose**: Files you're CURRENTLY editing + key patterns/conventions

✅ GOOD: "Editing: src/plugin.ts\\nKey paths: .opencode/memory-core/ (persistent blocks)"
✅ GOOD: "Pattern: All async file ops use mkdir({recursive:true}) before writeFile"
❌ BAD: Type definitions, function signatures, API docs (read source/docs instead)

### NEVER store in core memory
- API documentation (read source/docs when needed)
- Type definitions from libraries (import them)
- Function signatures (read source code)
- Completed goals (clear them immediately)

### Update core memory immediately when
- Starting new task: clear old goal, set new specific goal
- Making progress: update progress checklist (keep concise)
- Switching files: update context with current working files
- Task completed: clear goal/progress, set next task
- Approaching char limit: compress or remove outdated info`,
        args: {
          block: tool.schema.enum(["goal", "progress", "context"]).describe(
              "Which memory block to update (goal/progress/context)"
            ),
          operation: tool.schema.enum(["replace", "append"]).describe(
              "Whether to replace the entire block or append to it"
            ),
          content: tool.schema
            .string()
            .max(5000)
            .describe(
              "Content to write. Will be auto-truncated if exceeds block limit."
            ),
        },
        execute: async (args, ctx) => {
          const { block, operation, content } = args;
          const { sessionID, directory } = ctx;

          const result = await updateCoreMemoryBlock(
            directory,
            sessionID,
            block,
            operation,
            content
          );

          return result.message;
        },
      }),

      core_memory_read: tool({
        description: `Read the current state of all core memory blocks.

Returns the current values of goal, progress, and context blocks with their usage stats.
Useful for checking what's currently stored before updating.`,
        args: {},
        execute: async (args, ctx) => {
          const { sessionID, directory } = ctx;

          let memory = await loadCoreMemory(directory, sessionID);

          if (!memory) {
            return "📭 No core memory exists for this session yet.\n\nUse core_memory_update to create memory blocks.";
          }

          const { goal, progress, context } = memory.blocks;

          const formatBlock = (
            name: string,
            block: CoreBlock
          ): string => `
## ${name.toUpperCase()}
Chars: ${block.value.length}/${block.charLimit}
Last modified: ${block.lastModified}

${block.value || "[Empty]"}
`.trim();

          return `
# Core Memory State

${formatBlock("goal", goal)}

---

${formatBlock("progress", progress)}

---

${formatBlock("context", context)}

---

Last updated: ${memory.updatedAt}
          `.trim();
        },
      }),

      working_memory_add: tool({
        description: `Manually add an important item to working memory.

Working memory auto-extracts key information from tool outputs, but you can
also manually add important decisions or notes.

Item types: file-path, error, decision, other`,
        args: {
          content: tool.schema
            .string()
            .max(200)
            .describe("The content to remember (max 200 chars)"),
          type: tool.schema
            .enum([
              "file-path",
              "error",
              "decision",
              "other",
            ])
            .describe("Type of information")
            .optional(),
        },
        execute: async (args, ctx) => {
          const { sessionID, directory } = ctx;
          const { content, type = "other" } = args;

          await addToWorkingMemory(directory, sessionID, {
            type: type as WorkingMemoryItemType,
            content,
            source: "manual",
            timestamp: Date.now(),
            mentions: 1,
          });

          return `✅ Added to working memory: ${content}`;
        },
      }),

      working_memory_clear: tool({
        description: `Clear all working memory items for this session.

Use this to reset session context when starting a completely new task.
Core memory (goal/progress/context) is NOT affected.`,
        args: {},
        execute: async (args, ctx) => {
          const { sessionID, directory } = ctx;

          const emptyMemory = createEmptyWorkingMemory(sessionID);
          await saveWorkingMemory(directory, emptyMemory);

          return "🗑️ Working memory cleared. Core memory remains intact.";
        },
      }),

      working_memory_clear_slot: tool({
        description: `Clear a specific slot in working memory (e.g., after fixing all errors).

Useful when you've resolved all items of a certain type:
- Clear "error" slot after fixing all bugs
- Clear "decision" slot after obsolete decisions

Core memory and pool items are NOT affected.`,
        args: {
          slot: tool.schema
            .enum(["error", "decision"])
            .describe("Which slot to clear"),
        },
        execute: async (args, ctx) => {
          const { sessionID, directory } = ctx;
          const { slot } = args;

          let memory = await loadWorkingMemory(directory, sessionID);
          if (!memory) {
            return "⚠️ No working memory found for this session.";
          }

          const slotType = slot as SlotType;
          const itemCount = memory.slots[slotType].length;
          memory.slots[slotType] = [];
          memory.updatedAt = new Date().toISOString();
          await saveWorkingMemory(directory, memory);

          return `✅ Cleared ${itemCount} items from "${slot}" slot.`;
        },
      }),

      working_memory_remove: tool({
        description: `Remove a specific item from working memory by content match.

Use this to remove individual items that are no longer relevant.
Provide a unique substring of the content to identify the item.`,
        args: {
          content: tool.schema
            .string()
            .describe("Content or unique substring to match and remove"),
        },
        execute: async (args, ctx) => {
          const { sessionID, directory } = ctx;
          const { content } = args;

          let memory = await loadWorkingMemory(directory, sessionID);
          if (!memory) {
            return "⚠️ No working memory found for this session.";
          }

          // Try to find and remove from slots
          let removed = false;
          for (const slotType of Object.keys(SLOT_CONFIG) as SlotType[]) {
            const slot = memory.slots[slotType];
            const index = slot.findIndex(item => item.content.includes(content));
            if (index !== -1) {
              const removedItem = slot.splice(index, 1)[0];
              memory.updatedAt = new Date().toISOString();
              await saveWorkingMemory(directory, memory);
              return `✅ Removed from "${slotType}" slot: ${removedItem.content}`;
            }
          }

          // Try to find and remove from pool
          const poolIndex = memory.pool.findIndex(item => item.content.includes(content));
          if (poolIndex !== -1) {
            const removedItem = memory.pool.splice(poolIndex, 1)[0];
            memory.updatedAt = new Date().toISOString();
            await saveWorkingMemory(directory, memory);
            return `✅ Removed from pool: ${removedItem.content}`;
          }

          return `⚠️ No item found matching: "${content}"`;
        },
      }),
    },
  };
}
