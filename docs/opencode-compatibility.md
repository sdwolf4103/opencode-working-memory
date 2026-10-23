# OpenCode compatibility

## Version targets

**OpenCode v2 is distributed as `@opencode/cli`; the migration target here is `@opencode/cli@2.1.4` and `@opencode/plugin@2.1.4`.** Its executable reports `opencode v2.1.4` and provides `opencode` and `opencode2` commands.

The project's **Memory V2** name describes its three-layer memory architecture. The older `@opencode-ai/plugin/v2` API and `opencode-ai@tui-v2` preview have independent versioning. Previous checks of `opencode-ai@0.0.0-tui-v2-202606261840` establish compatibility with that named preview. The previous statement that no OpenCode host 2.x package existed was incorrect: it searched the older `opencode-ai` package family.

## Parallel local installation

This preserves an existing Homebrew `opencode` installation:

```bash
runtime="$HOME/.local/share/opencode-working-memory-compat/runtimes/v2-2.1.4"
npm install --prefix "$runtime" --no-audit --no-fund --save-exact \
  @opencode/cli@2.1.4
"$runtime/node_modules/.bin/opencode" --version
```

Launch the installed v2 explicitly:

```bash
"$HOME/.local/share/opencode-working-memory-compat/runtimes/v2-2.1.4/node_modules/.bin/opencode" --standalone
```

`--standalone` uses a private server for that terminal instance. OpenCode v2 normally uses a shared background server. The command selects the v2 binary; configuration and memory isolation require separate HOME/XDG directories when testing.

## Plugin configuration

Build the working tree with `npm run build`. For a local development checkout, add its absolute directory to **`plugins`** in both the v2 server `opencode.json` and terminal `cli.json`:

```json
{
  "plugins": ["/absolute/path/to/opencode-working-memory"]
}
```

V2 uses plural `plugins`. Its terminal configuration is `cli.json`; v1 uses `tui.json`. Plugin options use `{ "package": "...", "options": {} }` in v2. Keep existing configurations and memory stores when migrating. This work does not automatically rewrite them.

The root server definition exposes v1 `server` and v2 `setup`. The root terminal definition exposes v1 `tui` and v2 `setup`. Package exports point to the built JavaScript equivalents. The new SDK imports are type-only, so v1 consumers do not load the v2 SDK at runtime. Both host SDK peers are optional; development typechecks use the exact v2 SDK version.

## V2 adapter behavior and limits

- Server hooks are scoped to the plugin's workspace location. Session identity, parent, and canonical location are checked before memory writes. Child sessions and unverified locations are skipped.
- Native system text parts receive the existing frozen workspace and hot-state snapshots. Ordinary turns retain the current epoch; compaction starts a new epoch.
- Compaction preserves the host request and adds the memory instructions and numbered reference snapshot. The exact `session.compaction.ended` event text supplies the summary used for promotion.
- Per-session execution is serialized. Bounded in-process event deduplication reduces replay; it provides no cross-process exactly-once guarantee.
- V2 has no public native todo query in the inspected SDK. Additional todo injection is unavailable; OpenCode retains ownership of its native todo state.
- Tool failures affect tracked shell errors only when an explicit exit status is available. An unknown status preserves existing errors.
- Memory Review captures completed assistant text and keeps applying proposals behind explicit user confirmation. Forget supersedes the entry and retains its audit text.
- Cleanup stops callbacks and event consumption without treating plugin unload as session deletion.

## Verification record

### True OpenCode v2

The parallel Darwin arm64 installation reports `opencode v2.1.4`. Verification used isolated HOME/XDG directories, two temporary workspaces, and a deterministic localhost OpenAI-compatible provider, with no external inference or real credentials.

- Real v2 server: explicit memory journaling, hot-state provider injection, compaction promotion, new-session memory injection, a second compaction, two-workspace isolation, child-session exclusion, and session-deletion cleanup passed.
- Real v2 pseudo-terminal: `/memory`, Status, Current memories, Review submission, and persisted sealed proposal capture with its matching snapshot passed. This run returned an empty proposal set; update/forget confirmation was covered by the existing Review tests and earlier named-preview runtime checks.
- Adapter tests cover native context preservation, tool mapping and unknown exit status, event routing, cleanup draining, delayed terminal session metadata, workspace navigation, unavailable-location rejection, stale dialogs, and failed prompt submission.
- The dual server entry also passed real Homebrew OpenCode 1.18.18 prompt and hot-state injection checks.
- The final working tree passed 611 tests, TypeScript checking, build, package-integrity checking, and both installed-package smoke tests (diagnostic CLI and JavaScript plugin entry imports).
- Pre-push reproducibility checks used a fresh local checkout snapshot and Node 24.22.1, matching the CI Node major. A clean `npm install` with declared development SDKs (`@opencode-ai/plugin@1.2.6` and `@opencode/plugin@2.1.4`) passed all checks above. Overriding the legacy SDK with `@opencode-ai/plugin@1.19.4` also passed typechecking and all 611 tests. These are local macOS checks; GitHub's Linux jobs still require their own run.

Session deletion events omit location metadata. Cleanup is restricted to root sessions already verified by this plugin instance; unknown deleted sessions are skipped. Terminal commands resolve current session metadata when invoked because that data can arrive after plugin activation.

### Earlier named-version checks

Previous checks used isolated HOME, configuration, cache, state, workspace, and memory directories, with a deterministic localhost provider and no external inference:

- OpenCode 1.18.18: explicit memory journaling, hot-state injection, compaction promotion, new-session injection, and deletion cleanup.
- OpenCode 1.19.4: TypeScript and built JavaScript loading, read-tool state, child-session exclusion, workspace isolation, and the core lifecycle.
- Review on 1.19.4: updates and forget persisted immediately; existing sessions retained frozen prompts and new sessions reflected changes. Superseded text remained on disk.
- The named `tui-v2` preview: real pseudo-terminal `/memory`, Status, Current memories, Review submission and proposal capture, dry-run/edit, confirmation cancellation, update, and forget.
- OpenCode 1.18.18 was rechecked for the corrected legacy Review transport. Legacy Review submits `session.prompt({ sessionID, parts }, { throwOnError: true })`; v2 uses `{ sessionID, text }`.
- The pre-migration working tree passed 592 tests, TypeScript checking, and whitespace checks. Those results describe that earlier source state.

These records cover the specified versions and scenarios. External model behavior and other host versions require their own checks. Formal configuration, installed Homebrew binary, and normal memory were preserved.

## Authoritative sources

- [OpenCode v2 documentation](https://opencode.ai/v2/docs/)
- [V1 migration](https://opencode.ai/v2/docs/migrate-v1)
- [Plugin migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
- [Exact CLI package](https://registry.npmjs.org/@opencode%2fcli/2.1.4)
- [Exact SDK package](https://registry.npmjs.org/@opencode%2fplugin/2.1.4)
- [V2 module loader](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/plugin/module.ts)
- [Location-scoped hooks](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/plugin/hooks.ts)
- [Plugin host](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/plugin/host.ts)
- [Compaction assembly and events](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/session/compaction.ts)
- [V1 legacy loader](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/plugin/index.ts)
