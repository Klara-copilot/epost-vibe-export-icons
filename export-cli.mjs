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

import { config } from 'dotenv';
config();

import { input, select, confirm } from '@inquirer/prompts';
import { writeFileSync, mkdtempSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir, homedir } from 'os';
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
  'streamline-illustrations': {
    fontname:      'streamline-illustrations',
    classnamebase: 'sti',
    classprefix:   'st-',
    version:       '0.1',
    pipeline:      'sprite',
    baseClass:     'streamline-icons',
    idPrefix:      'streamline-icon-',
    assetsPath:    'img',
    fileName:      'streamline-icons.svg',
  },
  'streamline-illustrations-duotone': {
    fontname:      'streamline-illustrations-duotone',
    classnamebase: 'stid',
    classprefix:   'st-',
    version:       '0.1',
    pipeline:      'sprite',
    baseClass:     'streamline-icons',
    idPrefix:      'streamline-icon-',
    assetsPath:    'img',
    fileName:      'streamline-icons.svg',
  },
};

const SHARED_METADATA = {
  author:      'Klara Design',
  description: 'Built on Streamline',
  copyright:   'Klara Design',
};

// ─── Environment-driven path helpers ─────────────────────────────────────────

const expandHome = p => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

const PROJECT_ROOT = expandHome(
  process.env.PROJECT_ROOT || '~/Work/Projects/theme_icons',
);

// Nucleo project UUIDs per style
const STYLE_UUIDS = {
  'streamline-icons-glyph':              process.env.NUCLEO_UUID_GLYPH,
  'streamline-icons-regular':            process.env.NUCLEO_UUID_REGULAR,
  'streamline-icons-bold':               process.env.NUCLEO_UUID_BOLD,
  'streamline-icons-light':              process.env.NUCLEO_UUID_LIGHT,
  'streamline-illustrations':            process.env.NUCLEO_UUID_ILLUSTRATIONS,
  'streamline-illustrations-duotone':    process.env.NUCLEO_UUID_ILLUSTRATIONS_DUOTONE,
};

// Output subdirectories (relative to PROJECT_ROOT) per style
const STYLE_OUTPUT_SUBDIRS = {
  'streamline-icons-glyph':              process.env.OUTPUT_SUBDIR_GLYPH,
  'streamline-icons-regular':            process.env.OUTPUT_SUBDIR_REGULAR,
  'streamline-icons-bold':               process.env.OUTPUT_SUBDIR_BOLD,
  'streamline-icons-light':              process.env.OUTPUT_SUBDIR_LIGHT,
  'streamline-illustrations':            process.env.OUTPUT_SUBDIR_ILLUSTRATIONS,
  'streamline-illustrations-duotone':    process.env.OUTPUT_SUBDIR_ILLUSTRATIONS_DUOTONE,
};

const defaultProjectDir = style =>
  join(PROJECT_ROOT, 'nc-projects', STYLE_UUIDS[style] || style);

const defaultOutputDir = style =>
  STYLE_OUTPUT_SUBDIRS[style]
    ? join(PROJECT_ROOT, STYLE_OUTPUT_SUBDIRS[style])
    : resolve(__dirname, `dist/${style}`);

// ─── Prompts ──────────────────────────────────────────────────────────────────

async function promptExportConfig() {
  console.log('\n=== Nucleo Export — Configuration ===\n');

  // 1. Style selection
  const style = await select({
    message: 'Which icon style would you like to export?',
    choices: Object.keys(STYLE_PRESETS).map(s => ({ name: s, value: s })),
  });

  const preset   = STYLE_PRESETS[style];
  const isSprite = preset.pipeline === 'sprite';

  console.log(`\nConfigure export for: ${style}`);
  console.log(`Pipeline: ${isSprite ? 'SVG sprite (<symbol>)' : 'Icon font'}`);
  console.log('(Press Enter to accept each default)\n');

  // 2. Common metadata prompts
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

  let exportConfig;

  if (isSprite) {
    // ── SVG sprite pipeline ──────────────────────────────────────────────────
    const baseClass  = await input({
      message: 'Base CSS class:',
      default: preset.baseClass || 'streamline-icons',
    });

    const idPrefix = await input({
      message: 'Icon ID prefix:',
      default: preset.idPrefix || 'streamline-icon-',
    });

    const assetsPath = await input({
      message: 'Assets path (subdirectory for sprite file):',
      default: preset.assetsPath || 'img',
    });

    const fileName = await input({
      message: 'File name:',
      default: preset.fileName || 'streamline-icons.svg',
    });

    exportConfig = {
      svgsprite: {
        baseClass,
        idPrefix,
        assetsPath,
        fileName,
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
  } else {
    // ── Icon font pipeline ───────────────────────────────────────────────────
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

    exportConfig = {
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
  }

  // 3. Paths
  console.log('\n--- Export Paths ---\n');

  const projectDir = await input({
    message: 'Project directory (nc-projects/{uuid}):',
    default: defaultProjectDir(style),
  });

  const outputDir = await input({
    message: 'Output directory:',
    default: defaultOutputDir(style),
  });

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

  const isSprite    = !!exportConfig.svgsprite;
  const scriptName  = isSprite ? 'nucleo-sprite.js' : 'nucleo-export.js';
  const exportScript = resolve(__dirname, scriptName);

  console.log(`\nLaunching: node ${scriptName} ${projectDir} ${outputDir}\n`);

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
