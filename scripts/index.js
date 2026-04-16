#!/usr/bin/env node
/**
 * scripts/index.js  — Main entry point for `npm start`
 *
 * Asks the user which pipeline they want to run, then delegates to the
 * appropriate script, inheriting stdio so all interactive prompts work.
 *
 * Usage:
 *   npm start
 *   npm start -- --theme-path /path/to/klara-theme
 *   npm start -- --name "Lock Shield"    # forwarded to export-icon
 */
'use strict';

require('dotenv').config();

const path    = require('path');
const { spawn } = require('child_process');
const { select } = require('@inquirer/prompts');

// Colour helpers (no extra dependency)
const c = {
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
};

// In bundle mode (dist/vibe-icon.bundle.js) all scripts are co-located inside the
// same file. Spawn the bundle itself with --script <name> instead of a sibling file.
const isBundle = path.basename(process.argv[1]).endsWith('.bundle.js');

const SCRIPTS = {
  icon:         path.join(__dirname, 'export-icon.js'),
  duotone:      path.join(__dirname, 'export-duotone.js'),
  illustration: path.join(__dirname, 'export-illustration.js'),
};

async function main() {
  console.log(c.bold(c.cyan('\n=== Streamline Icon Export Pipeline ===')));
  console.log(c.yellow('Select what you want to export:\n'));

  const choice = await select({
    message: 'Export pipeline',
    choices: [
      {
        value: 'icon',
        name:  'Icon fonts       — Light / Regular / Bold / Glyph (generates .woff2, .ttf, SCSS map)',
      },
      {
        value: 'duotone',
        name:  'Duotone sprites  — SVG symbol sprite with CSS variable color replacement',
      },
      {
        value: 'illustration',
        name:  'Illustrations    — SVG symbol sprite (Steamline Filled + UX Line)',
      },
    ],
  });

  // Forward any extra args passed after `npm start --`
  const extraArgs = process.argv.slice(2);
  // Bundle mode: re-invoke this bundle with --script <name>; source mode: spawn sibling .js file
  const spawnArgs = isBundle
    ? [process.argv[1], '--script', choice, ...extraArgs]
    : [SCRIPTS[choice], ...extraArgs];

  const child = spawn(process.execPath, spawnArgs, {
    stdio: 'inherit',
    env:   process.env,
  });

  child.on('exit', code => process.exit(code ?? 0));
  child.on('error', err => {
    console.error(`Failed to start script: ${err.message}`);
    process.exit(1);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
