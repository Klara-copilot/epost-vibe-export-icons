/**
 * esbuild.config.js
 *
 * Build configuration to bundle scripts/index.js and all dependencies
 * into a single executable file with minimal node_modules coupling.
 *
 * Usage:
 *   node esbuild.config.js         # build in production mode
 *   NODE_ENV=dev node esbuild.config.js  # build with source maps
 */

const esbuild = require('esbuild');
const path = require('path');

const isDev = process.env.NODE_ENV === 'dev';

const config = {
  // Entry point
  entryPoints: ['scripts/index.js'],

  // Output
  outfile: 'dist/index.bundle.js',
  bundle: true,
  platform: 'node',
  target: 'node18',

  // Include all dependencies (not external)
  external: [
    // Native modules that can't be bundled
    '@resvg/resvg-js',
  ],

  // Configuration
  minify: !isDev,
  sourcemap: isDev ? 'inline' : false,
  define: {
    'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
  },

  // Logging
  logLevel: 'info',
};

esbuild
  .build(config)
  .then(() => {
    console.log('✓ Bundle created: dist/index.bundle.js');
    console.log(`  Size: ${require('fs').statSync('dist/index.bundle.js').size} bytes`);
  })
  .catch(err => {
    console.error('✗ Build failed:', err);
    process.exit(1);
  });
