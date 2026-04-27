# Installation Guide

## Quick Install

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-working-memory"]
}
```

Restart OpenCode. OpenCode Working Memory activates automatically — no manual setup needed.

> **Note**: The correct key is `plugin` (singular), not `plugins`.

## For LLM Agents

1. Edit `~/.config/opencode/opencode.json`
2. Add `"opencode-working-memory"` to the `plugin` array
3. Verify the config file was saved correctly

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

**Symptom**: No memory context in system prompt

**Solution**:
1. Check `~/.config/opencode/opencode.json` uses `"plugin"` (not `"plugins"`)
2. Restart OpenCode to trigger automatic installation
3. Check OpenCode logs for any download errors

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

Remove `"opencode-working-memory"` from the `plugin` array in `~/.config/opencode/opencode.json`.

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
