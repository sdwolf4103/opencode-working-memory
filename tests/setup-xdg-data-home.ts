import { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const previousXdgDataHome = process.env.XDG_DATA_HOME;
const previousTestFlag = process.env.OPENCODE_WORKING_MEMORY_TEST;
const testDataHome = await mkdtemp(join(tmpdir(), "opencode-working-memory-test-xdg-"));

process.env.XDG_DATA_HOME = testDataHome;
process.env.OPENCODE_WORKING_MEMORY_TEST = "1";

after(async () => {
  if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdgDataHome;

  if (previousTestFlag === undefined) delete process.env.OPENCODE_WORKING_MEMORY_TEST;
  else process.env.OPENCODE_WORKING_MEMORY_TEST = previousTestFlag;

  await rm(testDataHome, { recursive: true, force: true });
});
