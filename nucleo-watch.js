#!/usr/bin/env node
/**
 * nucleo-watch.js
 *
 * File watcher that re-runs the export pipeline whenever:
 *   - project.nucleo is changed (icon added/removed/renamed)
 *   - Any {uuid}.svg in the project folder changes
 *
 * Usage:
 *   node nucleo-watch.js [project_dir] [output_dir]
 */

'use strict';

const path     = require('path');
const { spawn } = require('child_process');
const chokidar = require('chokidar');

const PROJECT_DIR = process.argv[2] || process.env.PROJECT_DIR
  || path.join(__dirname, '../theme_icons/nc-projects/0fb05cef24426bce2d2320');

const OUTPUT_DIR = process.argv[3] || process.env.OUTPUT_DIR
  || path.join(__dirname, 'dist/glyph');

const EXPORT_SCRIPT = path.join(__dirname, 'nucleo-export.js');

let debounce = null;
let running  = false;

function runExport() {
  if (running) return;
  running = true;
  console.log(`\n[watch] Change detected — running export…`);

  const child = spawn(process.execPath, [EXPORT_SCRIPT, PROJECT_DIR, OUTPUT_DIR], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', code => {
    running = false;
    if (code === 0) {
      console.log('[watch] Export complete.\n');
    } else {
      console.error(`[watch] Export failed (exit code ${code}).\n`);
    }
  });
}

function scheduleExport() {
  clearTimeout(debounce);
  debounce = setTimeout(runExport, 300); // 300 ms debounce
}

const watcher = chokidar.watch([
  path.join(PROJECT_DIR, 'project.nucleo'),
  path.join(PROJECT_DIR, '*.svg'),
], {
  ignoreInitial: false,
  persistent:    true,
});

watcher
  .on('add',    f => { console.log(`[watch] add    ${path.basename(f)}`); scheduleExport(); })
  .on('change', f => { console.log(`[watch] change ${path.basename(f)}`); scheduleExport(); })
  .on('unlink', f => { console.log(`[watch] remove ${path.basename(f)}`); scheduleExport(); });

console.log(`[watch] Watching ${PROJECT_DIR}`);
console.log(`[watch] Output  → ${OUTPUT_DIR}`);
console.log('[watch] Press Ctrl+C to stop.\n');
