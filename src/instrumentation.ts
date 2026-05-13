import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
let cachedVersion: string | undefined;

const MEMORY_PRODUCER_NAME = "opencode-working-memory";
const MEMORY_INSTRUMENTATION_VERSION = 2;

function producerVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const candidates = [
      join(__dirname, "..", "package.json"),
      join(__dirname, "..", "..", "package.json"),
      // resolve from compiled dist/src/ -> repo root
    ];
    for (const path of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(path, "utf8"));
        cachedVersion = pkg.version as string;
        break;
      } catch {
        // try next
      }
    }
    if (!cachedVersion) cachedVersion = "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

export function producerFields(): { producerName: string; producerVersion: string; instrumentationVersion: number } {
  return {
    producerName: MEMORY_PRODUCER_NAME,
    producerVersion: producerVersion(),
    instrumentationVersion: MEMORY_INSTRUMENTATION_VERSION,
  };
}
