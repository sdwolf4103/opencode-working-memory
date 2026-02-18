# Installation Guide

## Prerequisites

- **OpenCode** 1.0.0 or higher
- **Node.js** 18+ (for development only)

## Quick Install (For Users)

### Option 1: Install from npm (Recommended)

```bash
npm install opencode-working-memory
```

Then add to your `.opencode/package.json`:

```json
{
  "plugins": [
    "opencode-working-memory"
  ]
}
```

### Option 2: Install from GitHub

Add to your `.opencode/package.json`:

```json
{
  "dependencies": {
    "opencode-working-memory": "github:sdwolf4103/opencode-working-memory"
  },
  "plugins": [
    "opencode-working-memory"
  ]
}
```

Then run:

```bash
cd .opencode
npm install
```

### Option 3: Local Development Install

Clone the repository:

```bash
git clone https://github.com/sdwolf4103/opencode-working-memory.git
cd opencode-working-memory
npm install
```

Link to your OpenCode project:

```bash
cd /path/to/your/project/.opencode
npm link /path/to/opencode-working-memory
```

Add to `.opencode/package.json`:

```json
{
  "plugins": [
    "opencode-working-memory"
  ]
}
```

## Verification

After installation, start an OpenCode session and run:

```
core_memory_update goal "Test installation"
```

You should see a success message. Check `.opencode/memory-core/` for the session file.

## Configuration

The plugin works out-of-the-box with sensible defaults. For advanced configuration, see [configuration.md](./configuration.md).

## Troubleshooting

### Plugin Not Loading

**Symptom**: No `core_memory_update` tool available

**Solution**: 
1. Check `.opencode/package.json` includes plugin in `"plugins": []` array
2. Verify `npm install` completed successfully
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
2. Run type checking: `npx tsc --noEmit`
3. See [AGENTS.md](../AGENTS.md) for code style guidelines

## Uninstallation

```bash
cd .opencode
npm uninstall opencode-working-memory
```

Remove from `.opencode/package.json` plugins array. Memory files in `.opencode/memory-*` will persist unless manually deleted.

## Next Steps

- Read [Architecture Documentation](./architecture.md) to understand how memory tiers work
- See [Configuration Guide](./configuration.md) for customization options
- Check [AGENTS.md](../AGENTS.md) for development guidelines
