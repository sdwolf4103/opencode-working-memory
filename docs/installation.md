# Installation Guide

## Prerequisites

- **OpenCode** 1.0.0 or higher
- **Node.js** 18+ with npm

## Quick Install

### Option 1: Install from npm (Recommended)

```bash
npm install -g opencode-working-memory
```

Then add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-working-memory"]
}
```

Restart OpenCode. Done.

### Option 2: Install from GitHub

```bash
npm install -g github:sdwolf4103/opencode-working-memory
```

Then add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-working-memory"]
}
```

### Option 3: Local Development Install

Clone the repository:

```bash
git clone https://github.com/sdwolf4103/opencode-working-memory.git
cd opencode-working-memory
npm install
npm link
```

Then reference it in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-working-memory"]
}
```

## Verification

After installation, start an OpenCode session and run:

```
core_memory_update goal "Test installation"
```

You should see a success message. Check `.opencode/memory-core/` in your project directory for the session file.

## Configuration

The plugin works out-of-the-box with sensible defaults. For advanced configuration, see [configuration.md](./configuration.md).

## Troubleshooting

### Plugin Not Loading

**Symptom**: No `core_memory_update` tool available

**Solution**: 
1. Check `~/.config/opencode/opencode.json` includes `"opencode-working-memory"` in `"plugin": []` array
2. Verify `npm install -g opencode-working-memory` completed successfully
3. Restart OpenCode session

### Memory Files Not Created

**Symptom**: No `.opencode/memory-core/` or `.opencode/memory-working/` directories

**Solution**:
1. Ensure OpenCode has write permissions in project directory
2. Check plugin hooks are registered (look for "Working Memory Plugin" in session logs)
3. Trigger memory operations (e.g., use `core_memory_update` tool)

### Type Errors During Development

**Symptom**: TypeScript errors when modifying plugin

**Solution**:
1. Ensure `@opencode-ai/plugin` is installed: `npm install @opencode-ai/plugin`
2. Run type checking: `npm run typecheck`
3. See [AGENTS.md](../AGENTS.md) for code style guidelines

## Uninstallation

```bash
npm uninstall -g opencode-working-memory
```

Remove `"opencode-working-memory"` from `~/.config/opencode/opencode.json`. Memory files in `.opencode/memory-*` will persist unless manually deleted.

## Next Steps

- Read [Architecture Documentation](./architecture.md) to understand how memory tiers work
- See [Configuration Guide](./configuration.md) for customization options
- Check [AGENTS.md](../AGENTS.md) for development guidelines
