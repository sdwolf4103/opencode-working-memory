import test from "node:test";
import assert from "node:assert/strict";
import {
  formatPackageVersionMismatch,
  packageLockReadErrorMessage,
  packageVersionMismatches,
} from "../scripts/dev/check-package-integrity.ts";

test("package integrity accepts matching package and lockfile versions", () => {
  const mismatches = packageVersionMismatches(
    { version: "1.6.4" },
    { version: "1.6.4", packages: { "": { version: "1.6.4" } } },
  );

  assert.deepEqual(mismatches, []);
});

test("package integrity reports both lockfile version mismatches", () => {
  const mismatches = packageVersionMismatches(
    { version: "1.6.4" },
    { version: "1.6.3", packages: { "": { version: "1.6.2" } } },
  );

  assert.deepEqual(
    mismatches.map(formatPackageVersionMismatch),
    [
      "package-lock.json version (1.6.3) does not match package.json version (1.6.4)",
      "package-lock.json packages[\"\"].version (1.6.2) does not match package.json version (1.6.4)",
    ],
  );
});

test("package integrity explains missing package-lock.json", () => {
  assert.equal(
    packageLockReadErrorMessage(Object.assign(new Error("missing"), { code: "ENOENT" })),
    "package-lock.json not found; run npm install first",
  );
});
