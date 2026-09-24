#!/usr/bin/env node
/**
 * scripts/setup-web-ui.js
 *
 * One-command bootstrap for the web UI on a fresh clone, so users don't have to
 * remember to `npm install` in two places and hand-create a .env.
 *
 * It:
 *   1. installs the root dependencies (bridge server + pipelines)
 *   2. installs the web/ dependencies (React + Vite UI)
 *   3. creates .env from .env.example if it's missing
 *   4. prints the next step
 *
 * Run with:  npm run setup-web-ui
 */
'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const npm  = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const c = {
  bold:   s => `\x1b[1m${s}\x1b[22m`,
  cyan:   s => `\x1b[36m${s}\x1b[39m`,
  green:  s => `\x1b[32m${s}\x1b[39m`,
  yellow: s => `\x1b[33m${s}\x1b[39m`,
  red:    s => `\x1b[31m${s}\x1b[39m`,
  dim:    s => `\x1b[2m${s}\x1b[22m`,
};

function step(msg) {
  console.log(`\n${c.cyan('\u25B8')} ${c.bold(msg)}`);
}

/** Run a command, inheriting stdio; exit the whole script on failure. */
function run(cmd, args, cwd) {
  const where = path.relative(ROOT, cwd) || '.';
  console.log(c.dim(`  $ ${cmd} ${args.join(' ')}  (in ${where})`));
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  if (res.error) {
    console.error(c.red(`\n\u2717 Failed to run ${cmd}: ${res.error.message}`));
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(c.red(`\n\u2717 ${cmd} ${args.join(' ')} exited with code ${res.status}`));
    process.exit(res.status || 1);
  }
}

function main() {
  console.log(c.bold('\nSetting up the Icon Export web UI...'));

  // 1. Root dependencies (bridge server + pipelines).
  step('Installing root dependencies');
  run(npm, ['install'], ROOT);

  // 2. Web UI dependencies.
  step('Installing web UI dependencies');
  run(npm, ['install'], path.join(ROOT, 'web'));

  // 3. Bootstrap .env from the example if it doesn't exist yet.
  step('Checking environment file');
  const envPath    = path.join(ROOT, '.env');
  const envExample = path.join(ROOT, '.env.example');
  if (fs.existsSync(envPath)) {
    console.log(c.green('  \u2713 .env already exists - leaving it untouched'));
  } else if (fs.existsSync(envExample)) {
    fs.copyFileSync(envExample, envPath);
    console.log(c.green('  \u2713 Created .env from .env.example'));
    console.log(c.yellow('  ! Edit .env and set PROJECT_ROOT (and the NUCLEO_UUID_* values) before running.'));
  } else {
    console.log(c.yellow('  ! No .env or .env.example found - you may need to create .env manually.'));
  }

  // Done.
  console.log(c.green('\n\u2713 Setup complete!'));
  console.log(`\n${c.bold('Next:')} start the bridge server and the web UI together with:`);
  console.log(c.cyan('    npm run dev'));
  console.log(c.dim('    then open http://localhost:5173\n'));
}

main();
