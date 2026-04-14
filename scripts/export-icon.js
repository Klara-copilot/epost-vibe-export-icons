#!/usr/bin/env node
/**
 * export-icon.js
 *
 * Phase 1 & 3 of the Streamline icon-font pipeline for all 4 styles
 * (Light / Regular / Bold / Glyph).
 *
 * Phase 1 — Search & Register:
 *   Interactively searches source SVG dirs (Light/Regular/Bold) as you type.
 *   Prompts to pick from matching icons, registers in all 4 nc-projects with a
 *   shared `place` value (keeping font codepoints in sync across all 4 sets).
 *   Loops until you confirm you're done adding icons.
 *
 * Phase 2 — Export (run separately):
 *   Run `node export-cli.mjs` (or `node nucleo-export.js`) to generate font files.
 *   This script pauses and waits for you to confirm that export is complete.
 *
 * Phase 3 — Deploy to klara-theme:
 *   Copies generated font files to <klara-theme>/public/assets/fonts/ and merges
 *   the icon SCSS map from the Regular set into _icons-map.scss.
 *   Requires --theme-path to be set.
 *
 * Usage:
 *   node export-icon.js
 *   node export-icon.js --theme-path /path/to/klara-theme
 *   node export-icon.js --name "Lock Shield"   # pre-fills first search
 */
'use strict';

const path = require('path');
const fs   = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { search, select, confirm } = require('@inquirer/prompts');
const {
  c, generateUuid, findSvgs,
  readProjectNucleo, buildIconJson, spliceIconsIntoRawJson,
  validateJson, writeProjectNucleo, parseArgs, stripLeadingSlash, spawnExport,
} = require('./lib/common');

// ─── Configuration ────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.env.PROJECT_ROOT;
if (!PROJECT_ROOT) {
  console.error(c.red('ERROR: PROJECT_ROOT not set. Check your .env file.'));
  process.exit(1);
}

const ASSETS_MY_SETS = process.env.ASSETS_MY_SETS
  || path.join(PROJECT_ROOT, '_Assets', 'my-sets');

const ICONSET_ROOT = path.join(
  ASSETS_MY_SETS, 'Streamline Iconsets', 'Streamline Iconset 5.0',
);

const SOURCE_DIRS = {
  Light:   process.env.SOURCE_DIR_LIGHT   || path.join(ICONSET_ROOT, 'Ultimate Light'),
  Regular: process.env.SOURCE_DIR_REGULAR || path.join(ICONSET_ROOT, 'Ultimate Regular'),
  Bold:    process.env.SOURCE_DIR_BOLD    || path.join(ICONSET_ROOT, 'Ultimate Bold'),
};

const NC_PROJECTS = {
  Light:   { dir: path.join(PROJECT_ROOT, 'nc-projects', process.env.NUCLEO_UUID_LIGHT   || ''), title: 'App / Icons / Light'   },
  Regular: { dir: path.join(PROJECT_ROOT, 'nc-projects', process.env.NUCLEO_UUID_REGULAR || ''), title: 'App / Icons / Regular' },
  Bold:    { dir: path.join(PROJECT_ROOT, 'nc-projects', process.env.NUCLEO_UUID_BOLD    || ''), title: 'App / Icons / Bold'    },
  Glyph:   { dir: path.join(PROJECT_ROOT, 'nc-projects', process.env.NUCLEO_UUID_GLYPH   || ''), title: 'App / Icons / Glyph'   },
};
for (const k of Object.keys(NC_PROJECTS)) {
  NC_PROJECTS[k].nucleo = path.join(NC_PROJECTS[k].dir, 'project.nucleo');
}

const EXPORT_DIRS = {
  Light:   path.join(PROJECT_ROOT, stripLeadingSlash(process.env.OUTPUT_SUBDIR_LIGHT   || '_Assets/StreamlineIcons/sets/Icons Font Light')),
  Regular: path.join(PROJECT_ROOT, stripLeadingSlash(process.env.OUTPUT_SUBDIR_REGULAR || '_Assets/StreamlineIcons/sets/Icons Font Regular')),
  Bold:    path.join(PROJECT_ROOT, stripLeadingSlash(process.env.OUTPUT_SUBDIR_BOLD    || '_Assets/StreamlineIcons/sets/Icons Font Bold')),
  Glyph:   path.join(PROJECT_ROOT, stripLeadingSlash(process.env.OUTPUT_SUBDIR_GLYPH   || '_Assets/StreamlineIcons/sets/Icons Font Glyph')),
};

const STYLE_ORDER = ['Light', 'Regular', 'Bold', 'Glyph'];

// Path to the font-generation script (project root)
const NUCLEO_EXPORT_SCRIPT = path.join(__dirname, '..', 'nucleo-export.js');

// Per-style export config (improveOutline: true for stroke-based sets)
const SHARED_META = { author: 'Klara Design', description: 'Built on Streamline 3.0', copyright: 'Klara Design', license: '', url: '' };
const FONT_EXPORT_CONFIGS = {
  Light: {
    iconfont: {
      fontname: 'streamline-icons-light', classprefix: 'st-', classnamebase: 'stl',
      encode: false, ligatures: false, improveOutline: true,
      metrics: { enable: false, ascent: '256', descent: '0' },
      metadataEnable: true, metadata: { ...SHARED_META, version: '0.55' },
    },
  },
  Regular: {
    iconfont: {
      fontname: 'streamline-icons-regular', classprefix: 'st-', classnamebase: 'str',
      encode: false, ligatures: false, improveOutline: true,
      metrics: { enable: false, ascent: '256', descent: '0' },
      metadataEnable: true, metadata: { ...SHARED_META, version: '0.1' },
    },
  },
  Bold: {
    iconfont: {
      fontname: 'streamline-icons-bold', classprefix: 'st-', classnamebase: 'stb',
      encode: false, ligatures: false, improveOutline: false,
      metrics: { enable: false, ascent: '256', descent: '0' },
      metadataEnable: true, metadata: { ...SHARED_META, version: '0.1' },
    },
  },
  Glyph: {
    iconfont: {
      fontname: 'streamline-icons-glyph', classprefix: 'st-', classnamebase: 'stg',
      encode: false, ligatures: false, improveOutline: false,
      metrics: { enable: false, ascent: '256', descent: '0' },
      metadataEnable: true, metadata: { ...SHARED_META, version: '0.1' },
    },
  },
};

// ─── Search helpers ───────────────────────────────────────────────────────────

/**
 * Search all 3 source dirs for `term` and return icon names that exist in all 3.
 * Returns array of { name, files: { Light, Regular, Bold } }.
 */
function searchCommonIcons(term) {
  if (!term || !term.trim()) return [];

  const foundByStyle  = {};
  const nameToStyles  = {};

  for (const style of ['Light', 'Regular', 'Bold']) {
    const found = findSvgs(SOURCE_DIRS[style], term.trim());
    foundByStyle[style] = found;
    for (const f of found) {
      if (!nameToStyles[f.basename]) nameToStyles[f.basename] = [];
      nameToStyles[f.basename].push(style);
    }
  }

  return Object.keys(nameToStyles)
    .filter(n => nameToStyles[n].length === 3)
    .sort()
    .map(name => ({
      name,
      files: {
        Light:   foundByStyle['Light'].find(f => f.basename === name),
        Regular: foundByStyle['Regular'].find(f => f.basename === name),
        Bold:    foundByStyle['Bold'].find(f => f.basename === name),
      },
    }));
}

// ─── Register one icon into all 4 nc-projects ─────────────────────────────────

async function registerIcon(iconName, iconFiles) {
  console.log(c.yellow('\nComputing shared place value...'));
  let maxPlace = 0;
  for (const style of STYLE_ORDER) {
    const { maxPlace: mp } = readProjectNucleo(NC_PROJECTS[style].nucleo);
    if (mp > maxPlace) maxPlace = mp;
  }
  const nextPlace = maxPlace + 1;
  console.log(c.yellow(`  Shared place: ${nextPlace} (previous max: ${maxPlace})`));

  console.log(c.yellow('\nRegistering in all 4 projects...'));
  let registeredCount = 0;

  const styleFiles = { ...iconFiles, Glyph: iconFiles['Bold'] };
  if (registeredCount === 0) {
    console.log(c.yellow(`  [GLYPH] Reusing Bold source: ${iconName}`));
  }

  for (const style of STYLE_ORDER) {
    const nc      = NC_PROJECTS[style];
    const srcFile = styleFiles[style];

    console.log(c.cyan(`\n  [${style}] ${nc.title}`));

    const { rawJson, obj, existingNames } = readProjectNucleo(nc.nucleo);

    if (existingNames.has(iconName)) {
      const existing = (obj.icons || []).find(i => i.name === iconName);
      console.log(c.yellow(`    [SKIP] '${iconName}' already exists (place: ${existing ? existing.place : '?'})`));
      continue;
    }

    const newUuid  = generateUuid();
    const destPath = path.join(nc.dir, newUuid + '.svg');
    fs.copyFileSync(srcFile.fullPath, destPath);
    console.log(c.green(`    [COPY] ${path.basename(srcFile.fullPath)} -> ${newUuid}.svg`));

    const iconKlass = (style === 'Light' || style === 'Regular') ? 'outline' : 'glyph';
    const iconJson  = buildIconJson({
      uuid: newUuid, name: iconName,
      width: 24, height: 24, klass: iconKlass,
      grid: 24, place: nextPlace, fillAll: 1,
    });

    const initialCount = (obj.icons || []).length;
    const updatedRaw   = spliceIconsIntoRawJson(rawJson, [iconJson], initialCount);
    const validated    = validateJson(updatedRaw, nc.title);
    console.log(c.green(`    [VALID] ${validated.icons.length} icons total (was ${initialCount})`));

    writeProjectNucleo(nc.nucleo, updatedRaw);
    console.log(c.green('    [SAVE] project.nucleo updated (backup: .bak)'));
    registeredCount++;
  }

  return registeredCount;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { name: prefillName, themePath } = parseArgs();

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 1: Search & Register (loop)
  // ══════════════════════════════════════════════════════════════════════════
  console.log(c.cyan('\n=== Phase 1: Search & Register Icons ==='));

  const addedIcons = [];
  let isFirstSearch = true;

  while (true) {
    console.log('');

    // ── Search ──────────────────────────────────────────────────────────────
    let selectedIcon; // { name, files }

    // `search` prompt: fires source() on each keystroke, shows filtered choices
    const searchResult = await search({
      message: isFirstSearch && prefillName
        ? `Search icon name: (pre-filled: ${prefillName})`
        : 'Search icon name:',
      // source is called with the current input value; must return choice array
      source: async (input) => {
        const term = (isFirstSearch && prefillName && !input) ? prefillName : (input || '');
        if (!term.trim()) {
          return [{ name: c.gray('  Type to search…'), value: null, disabled: true }];
        }

        const results = searchCommonIcons(term);

        if (results.length === 0) {
          return [{ name: c.yellow(`  No icons matching "${term}" found in all 3 sources`), value: null, disabled: true }];
        }

        // Mark already-added icons in this session
        return results.map(r => ({
          name: addedIcons.includes(r.name)
            ? c.gray(`${r.name}  [already added this session]`)
            : r.name,
          value: r,
          disabled: addedIcons.includes(r.name),
        }));
      },
    });

    isFirstSearch = false;

    // User may have selected a disabled/null entry (shouldn't happen with inquirer, but guard)
    if (!searchResult || !searchResult.name) {
      console.log(c.yellow('No icon selected. Try a different search term.'));
      const retry = await confirm({ message: 'Search again?', default: true });
      if (!retry) break;
      continue;
    }

    selectedIcon = searchResult;

    // Show which files will be used for each style
    console.log('');
    for (const style of ['Light', 'Regular', 'Bold']) {
      const rel = selectedIcon.files[style].fullPath.replace(SOURCE_DIRS[style] + path.sep, '');
      console.log(c.green(`  [${style}] ${rel}`));
    }
    console.log(c.yellow(`  [GLYPH] Reusing Bold source: ${selectedIcon.name}`));

    // ── Register ─────────────────────────────────────────────────────────────
    const registeredCount = await registerIcon(selectedIcon.name, selectedIcon.files);

    if (registeredCount > 0) {
      addedIcons.push(selectedIcon.name);
      console.log(c.green(`\n✓ '${selectedIcon.name}' registered in ${registeredCount} project(s).`));
    } else {
      console.log(c.yellow(`\n'${selectedIcon.name}' was already present in all 4 projects — nothing added.`));
    }

    // ── Place-sync summary (after each addition) ──────────────────────────────
    console.log(c.cyan('\nPlace-sync summary:'));
    console.log(`  ${'Style'.padEnd(10)} ${'Icons'.padStart(6)} ${'MaxPlace'.padStart(10)}`);
    console.log(`  ${'-----'.padEnd(10)} ${'-----'.padStart(6)} ${'--------'.padStart(10)}`);
    for (const style of STYLE_ORDER) {
      const { obj } = readProjectNucleo(NC_PROJECTS[style].nucleo);
      const icons   = obj.icons || [];
      const mp      = icons.reduce((m, i) => Math.max(m, i.place), 0);
      console.log(`  ${style.padEnd(10)} ${String(icons.length).padStart(6)} ${String(mp).padStart(10)}`);
    }

    // ── Loop prompt ───────────────────────────────────────────────────────────
    const addMore = await confirm({ message: '\nAdd another icon?', default: true });
    if (!addMore) break;
  }

  if (addedIcons.length === 0) {
    console.log(c.yellow('\nNo icons were added. Exiting.'));
    process.exit(0);
  }

  console.log(c.cyan(`\n${addedIcons.length} icon(s) registered: ${addedIcons.join(', ')}`));

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 2: Export Fonts
  // ══════════════════════════════════════════════════════════════════════════
  console.log(c.cyan('\n=== Phase 2: Export Fonts ==='));
  console.log(`Exporting all 4 sets: ${STYLE_ORDER.join(', ')}\n`);

  const proceedExport = await confirm({ message: 'Run font export now?', default: true });
  if (!proceedExport) {
    console.log(c.yellow('Skipped. Re-run the script or run export-cli.mjs manually.'));
    process.exit(0);
  }

  for (const style of STYLE_ORDER) {
    console.log(c.cyan(`\n  ━━━ ${FONT_EXPORT_CONFIGS[style].iconfont.fontname} ━━━`));
    await spawnExport(
      NUCLEO_EXPORT_SCRIPT,
      NC_PROJECTS[style].dir,
      EXPORT_DIRS[style],
      FONT_EXPORT_CONFIGS[style],
    );
    console.log(c.green(`  ✓ ${style} done`));
  }

  console.log(c.green('\nAll 4 font sets exported successfully.'));

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 3: Copy to klara-theme
  // ══════════════════════════════════════════════════════════════════════════
  console.log(c.cyan('\n=== Phase 3: Copy to klara-theme ==='));

  if (!themePath) {
    console.log(c.yellow('No --theme-path provided. Manual copy required:'));
    for (const style of STYLE_ORDER) {
      const fontsDir = path.join(EXPORT_DIRS[style], 'fonts');
      console.log(`  ${style} fonts: ${fontsDir}`);
      console.log('    -> <klara-theme>/public/assets/fonts/');
    }
    const regularScss = path.join(EXPORT_DIRS['Regular'], 'scss', 'icons.scss');
    console.log('');
    console.log(`  SCSS map: ${regularScss}`);
    console.log('    -> <klara-theme>/src/lib/styles/core/icons/_icons-map.scss');
    console.log(c.cyan('\n=== Done! ==='));
    process.exit(0);
  }

  // 3a. Copy font files from all 4 sets
  const fontsTargetDir = path.join(themePath, 'public', 'assets', 'fonts');
  if (!fs.existsSync(fontsTargetDir)) {
    console.error(c.red(`ERROR: Fonts target dir not found: ${fontsTargetDir}`));
    process.exit(1);
  }

  console.log(c.yellow(`Copying font files to: ${fontsTargetDir}`));
  for (const style of STYLE_ORDER) {
    const fontsSourceDir = path.join(EXPORT_DIRS[style], 'fonts');
    for (const fname of fs.readdirSync(fontsSourceDir)) {
      const src = path.join(fontsSourceDir, fname);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(fontsTargetDir, fname));
        console.log(c.green(`  [COPY] ${fname}`));
      }
    }
  }

  // 3b. Update SCSS icon map
  //     Extract the $icons: (...) map from Regular set's generated icons.scss
  //     and replace $streamline-icons: (...) in the theme's _icons-map.scss.
  const scssSourcePath = path.join(EXPORT_DIRS['Regular'], 'scss', 'icons.scss');
  const scssTargetPath = path.join(
    themePath, 'src', 'lib', 'styles', 'core', 'icons', '_icons-map.scss',
  );

  if (!fs.existsSync(scssSourcePath)) {
    console.error(c.red(`ERROR: Generated SCSS not found: ${scssSourcePath}`));
    process.exit(1);
  }
  if (!fs.existsSync(scssTargetPath)) {
    console.error(c.red(`ERROR: SCSS target file not found: ${scssTargetPath}`));
    process.exit(1);
  }

  const generatedScss = fs.readFileSync(scssSourcePath, 'utf8');
  const mapMatch = generatedScss.match(/\$icons:\s*\(\s*([\s\S]*?)\s*\)/);
  if (!mapMatch) {
    console.error(c.red('ERROR: Could not extract map from generated icons.scss'));
    console.error(c.gray(`Expected '$icons: (...)' block in: ${scssSourcePath}`));
    process.exit(1);
  }

  const extractedMapContent = mapMatch[1].trim().replace(/,\s*$/, '');
  const existingScss        = fs.readFileSync(scssTargetPath, 'utf8');

  fs.copyFileSync(scssTargetPath, scssTargetPath + '.bak');
  console.log(c.gray(`SCSS map backup: ${scssTargetPath}.bak`));

  const updatedScss = existingScss.replace(
    /\$streamline-icons:\s*\(\s*[\s\S]*?\s*\)/,
    `$streamline-icons: (\n\t${extractedMapContent}\n)`,
  );
  fs.writeFileSync(scssTargetPath, updatedScss, 'utf8');
  console.log(c.green('[UPDATE] Icon map entries merged into _icons-map.scss'));

  console.log(c.cyan('\n=== Done! ==='));
  console.log(c.yellow('Next steps:'));
  console.log('  1. Verify icon renders in klara-theme / storybook');
  console.log('  2. Commit changes to the theme_icons repo');
}

main().catch(err => {
  console.error(c.red('\nFATAL: ' + (err.message || err)));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
