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

  const scriptPath = SCRIPTS[choice];
  // Forward any extra args passed after `npm start --`
  const extraArgs = process.argv.slice(2);

  const child = spawn(process.execPath, [scriptPath, ...extraArgs], {
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
