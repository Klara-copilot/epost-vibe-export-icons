#!/usr/bin/env node
/**
 * export-cli.mjs
 *
 * Interactive CLI for configuring and launching the nucleo-export.js pipeline.
 * Prompts the user for icon style + per-style config, then spawns nucleo-export.js
 * with the resulting config injected via EXPORT_CONFIG (temp JSON file).
 *
 * Usage:
 *   node export-cli.mjs
 */

import { input, select, confirm } from '@inquirer/prompts';
import { writeFileSync, mkdtempSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Style Presets ────────────────────────────────────────────────────────────

const STYLE_PRESETS = {
  'streamline-icons-glyph': {
    fontname:      'streamline-icons-glyph',
    classnamebase: 'stg',
    classprefix:   'st-',
    version:       '0.1',
  },
  'streamline-icons-bold': {
    fontname:      'streamline-icons-bold',
    classnamebase: 'stb',
    classprefix:   'st-',
    version:       '0.1',
  },
  'streamline-icons-regular': {
    fontname:      'streamline-icons-regular',
    classnamebase: 'str',
    classprefix:   'st-',
    version:       '0.1',
  },
  'streamline-icons-light': {
    fontname:      'streamline-icons-light',
    classnamebase: 'stl',
    classprefix:   'st-',
    version:       '0.55',
  },
};

const SHARED_METADATA = {
  author:      'Klara Design',
  description: 'Built on Streamline',
  copyright:   'Klara Design',
};

// Default project path (mirrors nucleo-export.js default)
const DEFAULT_PROJECT_DIR = resolve(
  __dirname,
  '../theme_icons/nc-projects/0fb05cef24426bce2d2320',
);

// ─── Prompts ──────────────────────────────────────────────────────────────────

async function promptExportConfig() {
  console.log('\n=== Nucleo Icon Font — Export Configuration ===\n');

  // 1. Style selection
  const style = await select({
    message: 'Which icon style would you like to export?',
    choices: Object.keys(STYLE_PRESETS).map(s => ({ name: s, value: s })),
  });

  const preset = STYLE_PRESETS[style];

  console.log(`\nConfigure export for: ${style}\n(Press Enter to accept each default)\n`);

  // 2. Per-field prompts with style-specific defaults
  const fontname = await input({
    message: 'Font Name:',
    default: preset.fontname,
  });

  const classnamebase = await input({
    message: 'Base Class:',
    default: preset.classnamebase,
  });

  const classprefix = await input({
    message: 'Class Prefix:',
    default: preset.classprefix,
  });

  const author = await input({
    message: 'Author:',
    default: SHARED_METADATA.author,
  });

  const version = await input({
    message: 'Version:',
    default: preset.version,
  });

  const description = await input({
    message: 'Description:',
    default: SHARED_METADATA.description,
  });

  const copyright = await input({
    message: 'Copyright:',
    default: SHARED_METADATA.copyright,
  });

  // 3. Paths
  console.log('\n--- Export Paths ---\n');

  const projectDir = await input({
    message: 'Project directory (nc-projects/{uuid}):',
    default: DEFAULT_PROJECT_DIR,
  });

  const outputDir = await input({
    message: 'Output directory:',
    default: resolve(__dirname, `dist/${style}`),
  });

  // 4. Assemble config
  const exportConfig = {
    iconfont: {
      fontname,
      classprefix,
      classnamebase,
      encode:         false,
      ligatures:      false,
      improveOutline: false,
      metrics:        { enable: false, ascent: '256', descent: '0' },
      metadataEnable: true,
      metadata: {
        author,
        description,
        version,
        copyright,
        license: '',
        url:     '',
      },
    },
  };

  return { exportConfig, projectDir, outputDir };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { exportConfig, projectDir, outputDir } = await promptExportConfig();

  // Print final config
  console.log('\n--- Configuration Ready ---\n');
  console.log(JSON.stringify(exportConfig, null, 2));
  console.log('\nConfiguration Ready for Export!\n');

  // Confirm before running
  const proceed = await confirm({
    message: 'Run nucleo-export.js with this configuration?',
    default: true,
  });

  if (!proceed) {
    console.log('Export cancelled.');
    process.exit(0);
  }

  // Write config to temp file (EXPORT_CONFIG mechanism in nucleo-export.js)
  const tmpDir    = mkdtempSync(join(tmpdir(), 'nucleo-cli-'));
  const cfgPath   = join(tmpDir, 'export-config.json');
  writeFileSync(cfgPath, JSON.stringify(exportConfig, null, 2), 'utf8');

  const exportScript = resolve(__dirname, 'nucleo-export.js');

  console.log(`\nLaunching: node nucleo-export.js ${projectDir} ${outputDir}\n`);

  const child = spawn(
    process.execPath,
    [exportScript, projectDir, outputDir],
    {
      env:   { ...process.env, EXPORT_CONFIG: cfgPath },
      stdio: 'inherit',   // pipe child stdout/stderr directly to terminal
    },
  );

  child.on('close', code => {
    if (code !== 0) {
      console.error(`\nnucleo-export.js exited with code ${code}`);
      process.exit(code);
    }
  });
}

main().catch(err => {
  console.error('\nFATAL:', err.message || err);
  process.exit(1);
});
