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

import { input, select, confirm, Separator } from '@inquirer/prompts';
import { writeFileSync, mkdtempSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir, homedir } from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

// ─── Colors (ANSI) ────────────────────────────────────────────────────────────

const c = {
  reset:   s => `\x1b[0m${s}\x1b[0m`,
  bold:    s => `\x1b[1m${s}\x1b[22m`,
  dim:     s => `\x1b[2m${s}\x1b[22m`,
  cyan:    s => `\x1b[36m${s}\x1b[39m`,
  green:   s => `\x1b[32m${s}\x1b[39m`,
  yellow:  s => `\x1b[33m${s}\x1b[39m`,
  red:     s => `\x1b[31m${s}\x1b[39m`,
  magenta: s => `\x1b[35m${s}\x1b[39m`,
  blue:    s => `\x1b[34m${s}\x1b[39m`,
};

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
    baseClass:     'streamline-icon',
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
    baseClass:     'streamline-icon',
    idPrefix:      'streamline-icon-',
    assetsPath:    'img',
    fileName:      'streamline-icons.svg',
  },
  'streamline-illustrations-3': {
    fontname:      'streamline-illustrations-3',
    classnamebase: 'sti3',
    classprefix:   'st-',
    version:       '0.1',
    pipeline:      'sprite',
    baseClass:     'streamline-icon',
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

// ─── Font styles included in "export all" batch ───────────────────────────────

const ALL_FONT_STYLES = [
  'streamline-icons-glyph',
  'streamline-icons-regular',
  'streamline-icons-bold',
  'streamline-icons-light',
];

// improveOutline should be true for stroke-based sets (Regular + Light)
const IMPROVE_OUTLINE_STYLES = new Set(['streamline-icons-light', 'streamline-icons-regular']);

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
  'streamline-illustrations-3':           process.env.NUCLEO_UUID_ILLUSTRATIONS_PART3,
};

// Output subdirectories (relative to PROJECT_ROOT) per style
const STYLE_OUTPUT_SUBDIRS = {
  'streamline-icons-glyph':              process.env.OUTPUT_SUBDIR_GLYPH,
  'streamline-icons-regular':            process.env.OUTPUT_SUBDIR_REGULAR,
  'streamline-icons-bold':               process.env.OUTPUT_SUBDIR_BOLD,
  'streamline-icons-light':              process.env.OUTPUT_SUBDIR_LIGHT,
  'streamline-illustrations':            process.env.OUTPUT_SUBDIR_ILLUSTRATIONS,
  'streamline-illustrations-duotone':    process.env.OUTPUT_SUBDIR_ILLUSTRATIONS_DUOTONE,
  'streamline-illustrations-3':           process.env.OUTPUT_SUBDIR_ILLUSTRATIONS_PART3,
};

const defaultProjectDir = style =>
  join(PROJECT_ROOT, 'nc-projects', STYLE_UUIDS[style] || style);

const defaultOutputDir = style =>
  STYLE_OUTPUT_SUBDIRS[style]
    ? join(PROJECT_ROOT, STYLE_OUTPUT_SUBDIRS[style])
    : resolve(__dirname, `dist/${style}`);

// ─── Build export config from preset defaults (no prompts) ───────────────────

function buildDefaultConfig(style) {
  const preset   = STYLE_PRESETS[style];
  const isSprite = preset.pipeline === 'sprite';
  const metadata = {
    author:      SHARED_METADATA.author,
    description: SHARED_METADATA.description,
    version:     preset.version,
    copyright:   SHARED_METADATA.copyright,
    license:     '',
    url:         '',
  };

  if (isSprite) {
    return {
      svgsprite: {
        baseClass:      preset.baseClass  || 'streamline-icon',
        idPrefix:       preset.idPrefix   || 'streamline-icon-',
        assetsPath:     preset.assetsPath || 'img',
        fileName:       preset.fileName   || 'streamline-icons.svg',
        metadataEnable: true,
        metadata,
      },
    };
  }
  return {
    iconfont: {
      fontname:       preset.fontname,
      classprefix:    preset.classprefix,
      classnamebase:  preset.classnamebase,
      encode:         false,
      ligatures:      false,
        improveOutline: IMPROVE_OUTLINE_STYLES.has(style),
      metrics:        { enable: false, ascent: '256', descent: '0' },
      metadataEnable: true,
      metadata,
    },
  };
}

// ─── Interactive prompts for a single style ───────────────────────────────────

async function promptExportFields(style) {
  const preset   = STYLE_PRESETS[style];
  const isSprite = preset.pipeline === 'sprite';

  console.log(c.dim('  Press Enter to accept each default\n'));

  // Metadata
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

  const metadata = { author, description, version, copyright, license: '', url: '' };

  let exportConfig;

  if (isSprite) {
    // ── SVG sprite pipeline ──────────────────────────────────────────────────
    const baseClass  = await input({ message: 'Base CSS class:',                       default: preset.baseClass  || 'streamline-icon' });
    const idPrefix   = await input({ message: 'Icon ID prefix:',                       default: preset.idPrefix   || 'streamline-icon-' });
    const assetsPath = await input({ message: 'Assets path (subdir for sprite file):', default: preset.assetsPath || 'img' });
    const fileName   = await input({ message: 'File name:',                            default: preset.fileName   || 'streamline-icons.svg' });

    exportConfig = { svgsprite: { baseClass, idPrefix, assetsPath, fileName, metadataEnable: true, metadata } };
  } else {
    // ── Icon font pipeline ───────────────────────────────────────────────────
    const fontname      = await input({ message: 'Font name:',    default: preset.fontname });
    const classnamebase = await input({ message: 'Base class:',   default: preset.classnamebase });
    const classprefix   = await input({ message: 'Class prefix:', default: preset.classprefix });

    exportConfig = {
      iconfont: {
        fontname, classprefix, classnamebase,
        encode: false, ligatures: false, improveOutline: false,
        metrics: { enable: false, ascent: '256', descent: '0' },
        metadataEnable: true, metadata,
      },
    };
  }

  // Paths
  console.log(c.bold(c.cyan('\n  Export paths\n')));
  const projectDir = await input({ message: 'Project directory:', default: defaultProjectDir(style) });
  const outputDir  = await input({ message: 'Output directory:',  default: defaultOutputDir(style) });

  return { exportConfig, projectDir, outputDir };
}

// ─── Spawn export script (Promise-based) ─────────────────────────────────────

function spawnExport(exportConfig, projectDir, outputDir) {
  return new Promise((res, rej) => {
    const tmpDir      = mkdtempSync(join(tmpdir(), 'nucleo-cli-'));
    const cfgPath     = join(tmpDir, 'export-config.json');
    writeFileSync(cfgPath, JSON.stringify(exportConfig, null, 2), 'utf8');

    const isSprite    = !!exportConfig.svgsprite;
    const scriptName  = isSprite ? 'nucleo-sprite.js' : 'nucleo-export.js';
    const exportScript = resolve(__dirname, scriptName);

    console.log(c.dim(`  node ${scriptName}\n`));

    const child = spawn(
      process.execPath,
      [exportScript, projectDir, outputDir],
      { env: { ...process.env, EXPORT_CONFIG: cfgPath }, stdio: 'inherit' },
    );
    child.on('close', code => {
      if (code !== 0) rej(new Error(`Export exited with code ${code}`));
      else res();
    });
  });
}

// ─── Print a section header ───────────────────────────────────────────────────

function printHeader(title) {
  const line = '─'.repeat(title.length + 4);
  console.log('\n' + c.bold(c.cyan(`┌${line}┐`)));
  console.log(c.bold(c.cyan(`│  ${title}  │`)));
  console.log(c.bold(c.cyan(`└${line}┘`)) + '\n');
}

function printSummary(exportConfig, projectDir, outputDir) {
  console.log(c.bold(c.cyan('\n  Configuration summary\n')));
  console.log(c.dim(JSON.stringify(exportConfig, null, 2)));
  console.log(c.yellow(`\n  Project : ${projectDir}`));
  console.log(c.yellow(`  Output  : ${outputDir}\n`));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  printHeader('Nucleo Export');

  // 1. Style selection (includes batch option)
  const style = await select({
    message: 'Which icon style would you like to export?',
    choices: [
      ...Object.keys(STYLE_PRESETS).map(s => ({ name: s, value: s })),
      new Separator(),
      {
        name:  c.yellow('⚡ Export all icon fonts') + c.dim('  (glyph + regular + bold + light — all defaults)'),
        value: '--all-fonts',
      },
    ],
  });

  // ── Batch: export all icon fonts with defaults ─────────────────────────────
  if (style === '--all-fonts') {
    console.log(c.bold(c.yellow('\n  Batch export: glyph + regular + bold + light\n')));
    console.log(c.dim('  All styles will use default settings.\n'));

    const proceed = await confirm({ message: 'Run all 4 font exports?', default: true });
    if (!proceed) { console.log(c.red('\n  Cancelled.\n')); process.exit(0); }

    for (const s of ALL_FONT_STYLES) {
      console.log(c.bold(c.magenta(`\n  ━━━ ${s} ━━━\n`)));
      const exportConfig = buildDefaultConfig(s);
      await spawnExport(exportConfig, defaultProjectDir(s), defaultOutputDir(s));
      console.log(c.green(`  ✔  ${s} done\n`));
    }

    console.log(c.bold(c.green('  ✔  All icon fonts exported successfully!\n')));
    return;
  }

  // ── Single style ───────────────────────────────────────────────────────────
  const preset   = STYLE_PRESETS[style];
  const isSprite = preset.pipeline === 'sprite';
  const pipeline = isSprite ? 'SVG sprite (<symbol>)' : 'Icon font';

  console.log(c.dim(`\n  Pipeline: ${pipeline}\n`));

  // 2. Skip-all option
  const useDefaults = await confirm({
    message: 'Use all defaults? ' + c.dim('(skip configuration prompts)'),
    default: false,
  });

  let exportConfig, projectDir, outputDir;

  if (useDefaults) {
    exportConfig = buildDefaultConfig(style);
    projectDir   = defaultProjectDir(style);
    outputDir    = defaultOutputDir(style);
  } else {
    ({ exportConfig, projectDir, outputDir } = await promptExportFields(style));
  }

  // 3. Summary + confirm
  printSummary(exportConfig, projectDir, outputDir);

  const proceed = await confirm({ message: 'Run export with this configuration?', default: true });
  if (!proceed) { console.log(c.red('\n  Export cancelled.\n')); process.exit(0); }

  console.log(c.bold(c.cyan(`\n  Exporting ${style}...\n`)));
  await spawnExport(exportConfig, projectDir, outputDir);
  console.log(c.bold(c.green(`\n  ✔  Export complete!\n`)));
}

main().catch(err => {
  console.error(c.red(`\n  FATAL: ${err.message || err}\n`));
  process.exit(1);
});
