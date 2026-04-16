#!/usr/bin/env node
/**
 * scripts/bundle-entry.js  — Single esbuild entry point for the all-in-one bundle
 *
 * All scripts are bundled into dist/index.bundle.js via this file.
 * At runtime it dispatches to the right script based on the --script flag:
 *
 *   node dist/index.bundle.js                            # interactive menu (index.js)
 *   node dist/index.bundle.js --script export-icon       # export-icon.js
 *   node dist/index.bundle.js --script export-duotone    # export-duotone.js
 *   node dist/index.bundle.js --script export-illustration
 *   node dist/index.bundle.js --script nucleo-export <projectDir> <outputDir>
 *   node dist/index.bundle.js --script nucleo-sprite  <projectDir> <outputDir>
 *
 * The --script flag and its value are stripped from process.argv before the
 * target script runs, so each script sees the same argv it would normally see.
 */
'use strict';

// ── Native module resolution fix ─────────────────────────────────────────────
// @resvg/resvg-js is a native (.node) module that esbuild cannot bundle.
// At build time it is copied into dist/node_modules/ so the bundle is fully
// self-contained wherever it is deployed. We prepend that local node_modules
// to NODE_PATH before any require() calls so it is always found first.
(function ensureNativeModulePaths() {
  const path   = require('path');
  const Module = require('module');
  const isBundle = path.basename(process.argv[1]).endsWith('.bundle.js');
  if (!isBundle) return;
  // Candidates in priority order:
  //   1. dist/node_modules/  — copied at build time, travels with the bundle
  //   2. <bundle-parent>/node_modules/ — fallback if bundle is already in root
  const bundleDir = path.dirname(process.argv[1]);
  const candidates = [
    path.join(bundleDir, 'node_modules'),
    path.join(bundleDir, '..', 'node_modules'),
  ];
  const currentPaths = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
  const toAdd = candidates.filter(p => !currentPaths.includes(p));
  if (toAdd.length) {
    process.env.NODE_PATH = [...toAdd, ...currentPaths].join(path.delimiter);
    Module._initPaths(); // reinitialise resolution cache with updated NODE_PATH
  }
}());

// ── Script dispatch ───────────────────────────────────────────────────────────
const scriptIdx = process.argv.indexOf('--script');

if (scriptIdx === -1) {
  // No --script flag: run the interactive menu
  require('./index');
} else {
  const scriptName = process.argv[scriptIdx + 1];
  // Remove "--script <name>" so delegated scripts see clean argv
  process.argv.splice(scriptIdx, 2);

  switch (scriptName) {
    case 'export-icon':         require('./export-icon');        break;
    case 'export-duotone':      require('./export-duotone');     break;
    case 'export-illustration': require('./export-illustration'); break;
    case 'nucleo-export':       require('../nucleo-export');     break;
    case 'nucleo-sprite':       require('../nucleo-sprite');     break;
    default:
      console.error(`\nFATAL: Unknown --script "${scriptName}"`);
      console.error('Valid values: export-icon, export-duotone, export-illustration, nucleo-export, nucleo-sprite');
      process.exit(1);
  }
}
