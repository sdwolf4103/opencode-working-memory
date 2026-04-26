import { createHash } from "crypto";
import type { ActiveFile, LongTermMemoryEntry, LongTermType, OpenError } from "./types.ts";
import { LONG_TERM_LIMITS } from "./types.ts";

function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function hash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

export function extractExplicitMemories(text: string): LongTermMemoryEntry[] {
  const patterns = [
    // 注意：所有pattern必須有 g flag，因為使用 matchAll()
    /(?:请记住|記住|记住这一点|remember this|commit to memory)[:：]?\s*(.+)$/gim,
    /(?:从现在开始|從現在開始|从今以后|從今以後|from now on|going forward)[:：,，]?\s*(.+)$/gim,
  ];

  const now = new Date().toISOString();
  const entries: LongTermMemoryEntry[] = [];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const body = match[1]?.trim();
      if (!body || body.length < 8) continue;
      if (/^(再说|再說|later|next time)$/i.test(body)) continue;

      const type = classifyExplicitMemory(body);
      entries.push({
        id: id("mem"),
        type,
        text: body.slice(0, LONG_TERM_LIMITS.maxEntryTextChars),
        source: "explicit",
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
        staleAfterDays: staleAfterDaysFor(type),
      });
    }
  }

  return entries;
}

function classifyExplicitMemory(text: string): LongTermType {
  const lower = text.toLowerCase();
  if (/https?:\/\/|linear|slack|notion|dashboard|grafana/.test(lower)) return "reference";
  if (/decide|decision|choose|chosen|决定|決定|选择|選擇/.test(lower)) return "decision";
  if (/project|repo|项目|專案/.test(lower)) return "project";
  return "feedback";
}

export function staleAfterDaysFor(type: LongTermType): number | undefined {
  if (type === "feedback") return undefined;
  if (type === "decision") return 45;
  if (type === "project") return 60;
  return 90;
}

export function extractActiveFiles(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
): Array<{ path: string; action: ActiveFile["action"] }> {
  if (toolName === "read" && typeof args.filePath === "string") return [{ path: args.filePath, action: "read" }];
  if (toolName === "edit" && typeof args.filePath === "string") return [{ path: args.filePath, action: "edit" }];
  if (toolName === "write" && typeof args.filePath === "string") return [{ path: args.filePath, action: "write" }];
  if (toolName === "grep") return extractGrepPaths(output).map(path => ({ path, action: "grep" as const }));
  return [];
}

function extractGrepPaths(output: string): string[] {
  const matches = output.match(/^(\/[^\n]+\.(ts|tsx|js|jsx|json|md|py|go|rs|toml|yml|yaml)):/gm) ?? [];
  return [...new Set(matches.map(match => match.replace(/:$/, "")))].slice(0, 10);
}

function isErrorLine(line: string, knownValidationCommand: boolean): boolean {
  // 無條件捕捉的強訊號
  if (/TS\d{4}|ERR!|Traceback \(most recent call last\):|panic:/i.test(line)) return true;

  // Error 類型前綴（獨立行）
  if (/^\s*(Error|TypeError|ReferenceError|SyntaxError|Exception):/i.test(line)) {
    return true;
  }

  // 已知 validation command 才用寬鬆匹配
  if (knownValidationCommand) {
    return /\b(error|failed|failure|exception)\b/i.test(line);
  }

  return false;
}

export function extractErrorsFromBash(command: string, output: string): OpenError[] {
  const classifiedCategory = classifyCommand(command);
  const knownValidationCommand = classifiedCategory !== null;

  const lines = output
    .split("\n")
    .filter(line => isErrorLine(line, knownValidationCommand))
    .slice(0, 5);
  if (lines.length === 0) return [];

  const category = classifiedCategory ?? "runtime";
  const summary = lines.join(" ").slice(0, 280);
  const fingerprint = hash(`${category}:${summary.toLowerCase().replace(/\s+/g, " ")}`);
  const now = Date.now();

  return [
    {
      id: `err_${fingerprint}`,
      category,
      summary,
      command,
      file: extractFirstPath(summary),
      fingerprint,
      status: "open",
      firstSeen: now,
      lastSeen: now,
      seenCount: 1,
    },
  ];
}

export function classifyCommand(command: string): OpenError["category"] | null {
  const c = command.toLowerCase();
  if (/\b(tsc|typecheck)\b/.test(c)) return "typecheck";
  if (/\b(test|vitest|jest|mocha|pytest|go test|cargo test)\b/.test(c)) return "test";
  if (/\b(lint|eslint|biome)\b/.test(c)) return "lint";
  if (/\b(build|vite build|webpack|tsup)\b/.test(c)) return "build";
  return null;
}

function extractFirstPath(text: string): string | undefined {
  return text.match(/[\w./-]+\.(ts|tsx|js|jsx|json|md|py|go|rs)/)?.[0];
}

export function parseWorkspaceMemoryCandidates(summary: string): LongTermMemoryEntry[] {
  const match = summary.match(/<workspace_memory_candidates>([\s\S]*?)<\/workspace_memory_candidates>/i);
  if (!match) return [];

  const now = new Date().toISOString();
  const entries: LongTermMemoryEntry[] = [];

  for (const line of match[1].split("\n")) {
    const item = line.trim().match(/^-\s*\[(feedback|project|decision|reference)\]\s*(.+)$/i);
    if (!item) continue;
    const type = item[1].toLowerCase() as LongTermType;
    const body = item[2].trim();
    if (body.length < 12) continue;
    entries.push({
      id: id("mem"),
      type,
      text: body.slice(0, LONG_TERM_LIMITS.maxEntryTextChars),
      source: "compaction",
      confidence: 0.75,
      status: "active",
      createdAt: now,
      updatedAt: now,
      staleAfterDays: staleAfterDaysFor(type),
    });
  }

  return entries;
}
