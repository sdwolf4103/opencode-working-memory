# Plan: Package JS Entry for OpenCode Node Loader

## Goal

Fix GitHub issue #6 by making the published `opencode-working-memory` package loadable through OpenCode's Node-based plugin loader. The package must not expose TypeScript source files as runtime entry points under `node_modules`.

## Background

`opencode-working-memory@1.6.6` currently publishes:

- `main: "index.ts"`
- `exports["."]: "./index.ts"`
- `exports["./server"]: "./index.ts"`
- `exports["./tui"]: "./src/tui-plugin.ts"`

Node can import the local repo `index.ts`, but refuses to strip TypeScript types for files under `node_modules`. This means local path testing passes while npm/opencode package-cache loading fails.

## Proposed Changes

1. Expand the existing dist build config into a full package build.
   - Update `tsconfig.memory-diag.json` to include `index.ts`, `src/**/*.ts`, `scripts/memory-diag.ts`, and `scripts/memory-diag/**/*.ts`.
   - Remove the current exclusions for runtime plugin dependencies: `src/plugin.ts`, `src/tui-plugin.ts`, `src/opencode.ts`, `src/session-state.ts`, `src/extractors.ts`, `src/pending-journal.ts`, `src/promotion-accounting.ts`, and `src/memory-visibility.ts`.
   - Keep `rootDir: "."` and `outDir: "dist"` so `index.ts` emits to `dist/index.js` and `src/tui-plugin.ts` emits to `dist/src/tui-plugin.js`.
   - Keep `rewriteRelativeImportExtensions: true` so emitted ESM imports point at `.js`.

2. Update `package.json` runtime entry points.
   - `main` should point to `dist/index.js`.
   - `exports["."]` and `exports["./server"]` should point to `./dist/index.js`.
   - `exports["./tui"]` should point to `./dist/src/tui-plugin.js`.

3. Update build scripts.
   - Keep one clean build path that emits both plugin runtime JS and `memory-diag` JS.
   - Preserve the existing `memory-diag` binary wrapper behavior.
   - Rename or alias the script so the unified dist build is not hidden behind a memory-diag-only name.

4. Update packaging tests.
   - Add a smoke test that builds/packs/installs the tarball into a temporary prefix and imports `opencode-working-memory` from `node_modules`.
   - Assert the default export id is `working-memory`.
   - Assert `opencode-working-memory/server` imports and exposes the same default plugin id.
   - Assert `opencode-working-memory/tui` imports and exposes the TUI plugin id.
   - Assert package manifest entry points do not point at `.ts`.
   - Use an isolated npm cache under `/private/tmp` or the test temp root so local `~/.npm` permissions do not affect the smoke test.

5. Update package file allowlist if needed.
   - Ensure `dist/`, `scripts/memory-diag-bin.cjs`, `README.md`, and `LICENSE` are included.
   - Keeping TypeScript source files in the tarball is acceptable only if runtime entry points resolve to JS.

## Affected Files

- `package.json`
- `tsconfig.memory-diag.json` or a new build tsconfig
- `tests/smoke/memory-diag-packaging.test.ts` or a new smoke test under `tests/smoke/`
- `CHANGELOG.md`
- Possibly `package-lock.json` if package metadata changes require npm to refresh it

## Verification

Run:

```bash
npm run build
test -f dist/index.js
test -f dist/src/tui-plugin.js
node -e "import('./dist/index.js').then(m => console.log(m.default.id))"
node -e "import('./dist/src/tui-plugin.js').then(m => console.log(m.default.id))"
rg 'from\s+\".*\\.ts\"|import\s*\\(.*\\.ts' dist
npm run typecheck
npm test
npm run check:package-integrity
```

Package-path smoke:

```bash
rm -rf /private/tmp/owm-pack /private/tmp/owm-install /private/tmp/npm-cache
mkdir -p /private/tmp/owm-pack /private/tmp/owm-install /private/tmp/npm-cache
npm pack --cache /private/tmp/npm-cache --pack-destination /private/tmp/owm-pack
npm install --cache /private/tmp/npm-cache --prefix /private/tmp/owm-install /private/tmp/owm-pack/opencode-working-memory-*.tgz
node -e "import('/private/tmp/owm-install/node_modules/opencode-working-memory').then(m => console.log(m.default.id))"
node -e "import('/private/tmp/owm-install/node_modules/opencode-working-memory/server').then(m => console.log(m.default.id))"
node -e "import('/private/tmp/owm-install/node_modules/opencode-working-memory/tui').then(m => console.log(m.default.id))"
```

Expected output for both import checks:

```text
working-memory
```

For the TUI import, expected output is:

```text
working-memory-tui
```

Also inspect the installed package manifest and assert `main`, `exports["."]`, `exports["./server"]`, and `exports["./tui"]` all point to `.js` files.

## Release Preparation

After implementation and verification:

1. Inspect `git diff`.
2. Confirm the working tree contains only this release fix plus the pre-existing unrelated untracked plan.
3. Add a `CHANGELOG.md` entry for `1.6.7` describing the Node loader/package entry fix.
4. Run `npm version patch` or otherwise bump `package.json` and `package-lock.json` to `1.6.7` consistently.
5. If publishing from `main`, prepare the verified package for publish after the final git diff review.

## Risks

- Build config may expose TypeScript type-check errors in files that were previously excluded from `tsconfig.memory-diag.json`.
- Package smoke tests that call `npm pack` can fail on the developer machine if `~/.npm` has permission problems; tests should use an isolated cache under `/private/tmp`.
- OpenCode may resolve `./server` or `./tui` differently from bare package import, so both exports should be checked.
- `npm run check:package-integrity` currently checks package-lock version alignment only; entry-point assertions must live in packaging tests or a new entry-point check.
- Publishing both `src/` and `dist/` increases tarball size, but runtime correctness depends on the JS entry points rather than removing sources.

## Rollback

Revert the package entry/build changes and publish a corrected package if the JS entry causes a runtime regression. Existing local-path development remains unaffected by reverting because it can still import TypeScript from outside `node_modules`.
