/**
 * esbuild.config.advanced.js
 *
 * Builds ALL scripts into self-contained bundles under dist/:
 *
 *   dist/index.bundle.js    — icon/duotone/illustration export pipeline
 *   dist/workflow.bundle.js — full lifecycle orchestrator (clone→audit→export→git)
 *
 * index.bundle.js entry: scripts/bundle-entry.js
 * Dispatches at runtime via --script flag:
 *   node dist/index.bundle.js                             # interactive menu
 *   node dist/index.bundle.js --script export-icon        # icon font pipeline
 *   node dist/index.bundle.js --script export-duotone     # duotone sprites
 *   node dist/index.bundle.js --script export-illustration
 *   node dist/index.bundle.js --script nucleo-export <projectDir> <outputDir>
 *   node dist/index.bundle.js --script nucleo-sprite  <projectDir> <outputDir>
 *
 * workflow.bundle.js entry: scripts/workflow.js
 *   node dist/workflow.bundle.js --pipeline icon --name "Lock Shield" --theme-path /path
 *
 * Usage:
 *   node esbuild.config.advanced.js
 *   NODE_ENV=dev node esbuild.config.advanced.js   # with source maps, not minified
 */

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');
const dotenv = require('dotenv');

const isDev = process.env.NODE_ENV === 'dev';

// Read .env at build time and inline all vars via esbuild's define.
// No .env file is needed at runtime in the bundle.
// PROJECT_ROOT must stay dynamic so --project-root can override it at runtime.
const DYNAMIC_VARS = new Set(['DEBUG', 'NODE_ENV', 'PROJECT_ROOT']);

function buildEnvDefines() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    console.warn('⚠️  No .env file found — env vars will not be inlined.');
    return {};
  }
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  const defines = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (DYNAMIC_VARS.has(key)) continue;
    defines[`process.env.${key}`] = JSON.stringify(value);
  }
  console.log(`✓ Inlining ${Object.keys(defines).length} env vars from .env`);
  return defines;
}

/** Shared esbuild options for both bundles. */
function sharedOptions(envDefines) {
  return {
    bundle: true,
    platform: 'node',
    target: 'node18',
    minify: !isDev,
    sourcemap: isDev ? 'inline' : false,
    logLevel: 'info',
    external: ['@resvg/resvg-js'], // Native module — cannot be bundled
    define: {
      'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
      ...envDefines,
    },
  };
}

async function build() {
  try {
    const envDefines = buildEnvDefines();

    console.log('🔨 Building bundles...\n');

    // ── Bundle 1: index.bundle.js — export pipeline ───────────────────────
    const indexOutfile = 'dist/index.bundle.js';
    await esbuild.build({
      entryPoints: ['scripts/bundle-entry.js'],
      outfile: indexOutfile,
      ...sharedOptions(envDefines),
    });
    try { fs.chmodSync(indexOutfile, 0o755); } catch (_) {}
    const indexSize = (fs.statSync(indexOutfile).size / 1024).toFixed(2);
    console.log(`✓ ${indexOutfile} (${indexSize} KB)`);

    // ── Bundle 2: workflow.bundle.js — full lifecycle orchestrator ────────
    const workflowOutfile = 'dist/workflow.bundle.js';
    await esbuild.build({
      entryPoints: ['scripts/workflow.js'],
      outfile: workflowOutfile,
      ...sharedOptions(envDefines),
    });
    try { fs.chmodSync(workflowOutfile, 0o755); } catch (_) {}
    const workflowSize = (fs.statSync(workflowOutfile).size / 1024).toFixed(2);
    console.log(`✓ ${workflowOutfile} (${workflowSize} KB)`);

    // ── Copy @resvg/resvg-js native module into dist/node_modules ─────────
    // Both bundles mark it external; the copied module is found via NODE_PATH.
    const srcResvg  = path.join(process.cwd(), 'node_modules', '@resvg');
    const destResvg = path.join(process.cwd(), 'dist', 'node_modules', '@resvg');
    fse.copySync(srcResvg, destResvg, { overwrite: true });
    console.log('✓ Copied @resvg/resvg-js to dist/node_modules/');

    console.log('\n🚀 Usage:');
    console.log(`   node ${indexOutfile}                              # interactive menu`);
    console.log(`   node ${indexOutfile} --script export-icon`);
    console.log(`   node ${workflowOutfile} --pipeline icon --name "Lock Shield" --theme-path /path`);
  } catch (error) {
    console.error('✗ Build failed:', error);
    process.exit(1);
  }
}

build();


