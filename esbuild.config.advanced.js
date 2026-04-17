/**
 * esbuild.config.advanced.js
 *
 * Builds ALL scripts (index, export-icon, export-duotone, export-illustration,
 * nucleo-export, nucleo-sprite) into a SINGLE self-contained bundle:
 *   dist/index.bundle.js
 *
 * The bundle entry point is scripts/bundle-entry.js which dispatches at runtime
 * based on the --script flag:
 *
 *   node dist/index.bundle.js                             # interactive menu
 *   node dist/index.bundle.js --script export-icon        # icon font pipeline
 *   node dist/index.bundle.js --script export-duotone     # duotone sprites
 *   node dist/index.bundle.js --script export-illustration
 *   node dist/index.bundle.js --script nucleo-export <projectDir> <outputDir>
 *   node dist/index.bundle.js --script nucleo-sprite  <projectDir> <outputDir>
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

async function build() {
  try {
    const envDefines = buildEnvDefines();
    const outfile = 'dist/index.bundle.js';

    console.log('🔨 Building single bundle...\n');

    await esbuild.build({
      entryPoints: ['scripts/bundle-entry.js'],
      outfile,
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
    });

    // Copy @resvg/resvg-js (native module) into dist/node_modules so the bundle
    // is self-contained and works from any location without a local node_modules.
    const srcResvg  = path.join(process.cwd(), 'node_modules', '@resvg');
    const destResvg = path.join(process.cwd(), 'dist', 'node_modules', '@resvg');
    fse.copySync(srcResvg, destResvg, { overwrite: true });
    console.log('✓ Copied @resvg/resvg-js to dist/node_modules/');

    // Make executable
    try { fs.chmodSync(outfile, 0o755); } catch (_) {}

    const size = (fs.statSync(outfile).size / 1024).toFixed(2);
    console.log(`\n✓ Bundle created: ${outfile} (${size} KB)`);
    console.log('\n🚀 Usage:');
    console.log(`   node ${outfile}                              # interactive menu`);
    console.log(`   node ${outfile} --script export-icon`);
    console.log(`   node ${outfile} --script export-duotone`);
    console.log(`   node ${outfile} --script export-illustration`);
  } catch (error) {
    console.error('✗ Build failed:', error);
    process.exit(1);
  }
}

build();

