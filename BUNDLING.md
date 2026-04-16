# Bundling `index.js` with esbuild

This setup uses **esbuild** to create a self-contained bundle of `scripts/index.js` and all its dependencies, eliminating the need to distribute `node_modules`.

## Quick Start

### 1. Install esbuild
```bash
npm install
```

### 2. Build the bundle
```bash
npm run build:bundle    # Production bundle (minified)
npm run build:bundle:dev  # Dev bundle (with source maps)
```

### 3. Run the bundled version
```bash
npm run start:bundle
```

Or directly:
```bash
node dist/index.bundle.js
```

## How It Works

- **esbuild.config.js** — Bundles `scripts/index.js` and resolves all imports (except native modules)
- Output is `dist/index.bundle.js` — a single executable Node.js file
- Shebang (`#!/usr/bin/env node`) preserved so it can be executed directly

## Bundle Size & Contents

The bundle includes:
- ✅ `@inquirer/prompts` — CLI prompts
- ✅ `dotenv` — Environment variable loading
- ✅ `fs-extra` — File system operations
- ✅ All other pure JS dependencies

The bundle excludes (marked as external):
- ❌ `@resvg/resvg-js` — Native module (must be in node_modules)

## Making the Bundle Standalone

If you want to eliminate **all** node_modules coupling:

### Option A: Use a bundle wrapper
Keep these in a `.bundled_modules/` directory:
1. Copy only `@resvg/resvg-js` to `.bundled_modules/`
2. Update the bundle to resolve from that directory

### Option B: Create a distribution package
```bash
# After building:
mkdir vibe_icon_dist
cp dist/index.bundle.js vibe_icon_dist/
cp node_modules/@resvg vibe_icon_dist/node_modules/@resvg/  # only native deps
zip -r vibe_icon_dist.zip vibe_icon_dist/
```

Users then unzip and run:
```bash
node vibe_icon_dist.zip/index.bundle.js
```

### Option C: Rebuild native modules during packaging
Use `nexe` or similar to create a standalone executable that includes everything.

## Development Tips

- Use `npm run build:bundle:dev` to generate source maps for debugging
- The bundle preserves `process.env.NODE_ENV` detection
- All CLI prompts (`@inquirer`) work identically in bundled form
- File I/O operations maintain same paths (relative to CWD)

## Troubleshooting

**Error: "Cannot find module '@resvg/resvg-js'"**
- `@resvg/resvg-js` is a native module and must be in `node_modules`
- Keep `node_modules/@resvg/` even when using the bundle
- Or install it with: `npm install @resvg/resvg-js --save`

**Bundle is too large**
- Use `npm run build:bundle` (production) instead of `build:bundle:dev`
- Check if all imported modules are necessary
