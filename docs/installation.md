# Installation Guide

## Quick Install

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-working-memory"]
}
```

Restart OpenCode. The plugin is downloaded and installed automatically — no `npm install` needed.

> **Note**: The correct key is `plugin` (singular), not `plugins`.

## For LLM Agents

1. Edit `~/.config/opencode/opencode.json`
2. Add `"opencode-working-memory"` to the `plugin` array
3. Verify the config file was saved correctly

## Verification

After restarting OpenCode, ask your agent:

```
Use core_memory_read to show me what you remember
```

If the tool responds, the plugin is active.

## Troubleshooting

### Plugin Not Loading

**Symptom**: No `core_memory_update` tool available

**Solution**:
1. Check `~/.config/opencode/opencode.json` uses `"plugin"` (not `"plugins"`)
2. Restart OpenCode to trigger automatic installation
3. Check OpenCode logs for any download errors

### Memory Files Not Created

**Symptom**: No `.opencode/memory-core/` or `.opencode/memory-working/` directories

**Solution**:
1. Ensure OpenCode has write permissions in project directory
2. Trigger memory operations (e.g., use `core_memory_update` tool)

### Type Errors During Development

**Symptom**: TypeScript errors when modifying the plugin source

**Solution**:
1. Run `npm install` to install dev dependencies
2. Run `npm run typecheck` to check for errors
3. See [AGENTS.md](../AGENTS.md) for code style guidelines

## Uninstallation

Remove `"opencode-working-memory"` from the `plugin` array in `~/.config/opencode/opencode.json`.

Memory files in `.opencode/memory-*` will persist unless manually deleted.

## Next Steps

- Read [Architecture Documentation](./architecture.md) to understand how memory tiers work
- See [Configuration Guide](./configuration.md) for customization options
- Check [AGENTS.md](../AGENTS.md) for development guidelines
