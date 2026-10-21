# Installation Guide

## OpenCode V2

Add to your `~/.config/opencode/opencode.json` (or project `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-working-memory"]
}
```

For a local checkout, use the plugin directory:

```json
{
  "plugins": ["/home/mirro/coding/opencode-working-memory"]
}
```

V2 requires a directory, not an `index.ts` file. The package's `./tui` export is
loaded automatically, so no separate `tui.json` is needed.

Restart OpenCode. OpenCode Working Memory activates automatically — no manual setup needed.

## OpenCode V1

Add to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-working-memory"]
}
```

For the `/memory` TUI menu, also add the package to `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-working-memory"]
}
```

> **Note**: V1 uses `plugin` (singular); V2 uses `plugins` (plural).

## For LLM Agents

1. Edit `~/.config/opencode/opencode.json`
2. On V2, add the package or local directory to the `plugins` array; on V1, add it to `plugin`
3. Verify the config file was saved correctly
4. Restart OpenCode (V2 requires a server restart after adding a local plugin)

## Verification

After restarting OpenCode, memory context appears automatically in system prompts. You'll see:

```
Workspace memory (cross-session, verify if stale):
decision:
- ... (if any long-term memories exist)

---
Memory candidates:
- [project] ... (candidates for long-term memory)

Hot session state (current session):
active_files:
- path/to/file.ts (action, count)

open_errors: (none, or listed)
```

**No tools to call**. OpenCode Working Memory works automatically via hooks.

## How Memory Works

### Workspace Memory (Long-term)

Persists across sessions. Automatically extracted during compaction when you say "remember this" or when important decisions are made.

### Hot Session State (Short-term)

Tracks current session:
- Active files (what you're working on)
- Open errors (unresolved issues)
- Recent decisions (for compaction candidate promotion)

## Troubleshooting

### Plugin Not Loading

**Symptom**: No memory context in system prompt, or `1 plugin failed`

**Solution**:
1. Check the config key for your host: V2 uses `"plugins"` with a directory path; V1 uses `"plugin"` with the package name
2. Restart OpenCode to trigger automatic installation
3. Check OpenCode logs for plugin load errors (`~/.local/share/opencode/log/opencode.log`)
4. V2: confirm the plugin appears as `working-memory` with `state.status: active` in `opencode api get /api/plugin`

### Memory Files Not Created

**Symptom**: No `~/.local/share/opencode-working-memory/` directory

**Solution**:
1. Ensure OpenCode has write permissions in home directory
2. Trigger memory operations by working normally (memory files are created on-demand)
3. Check that `opencode-working-memory` is listed in config

### Memory Not Persisting

**Symptom**: Workspace memory empty after restart

**Solution**:
1. Verify you're in the same workspace (different workspace = different memory)
2. Ensure `Memory candidates:` were captured during compaction
3. Check `workspace-memory.json` exists

### Type Errors During Development

**Symptom**: TypeScript errors when modifying the plugin source

**Solution**:
1. Run `npm install` to install dev dependencies
2. Run `npm run typecheck` to check for errors
3. Run `npm test` to verify functionality

## Uninstallation

V2: remove `"opencode-working-memory"` (or the local directory) from the `plugins` array in `~/.config/opencode/opencode.json`.

V1: remove `"opencode-working-memory"` from the `plugin` arrays in `opencode.json` and `tui.json`.

Memory files in `~/.local/share/opencode-working-memory/` persist unless manually deleted.

## Manual Memory Management

### View Workspace Memory

```bash
cat ~/.local/share/opencode-working-memory/workspaces/*/workspace-memory.json | jq
```

### View Session State

```bash
cat ~/.local/share/opencode-working-memory/workspaces/*/sessions/*.json | jq
```

### Clear Workspace Memory

```bash
rm ~/.local/share/opencode-working-memory/workspaces/*/workspace-memory.json
```

### Clear All Session States

```bash
rm -rf ~/.local/share/opencode-working-memory/workspaces/*/sessions/*.json
```

## Next Steps

- Read [Architecture Documentation](./architecture.md) to understand how the three layers work
- See [Configuration Guide](./configuration.md) for customization options

---

**Last Updated**: April 2026
