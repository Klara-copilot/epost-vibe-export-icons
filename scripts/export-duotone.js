#!/usr/bin/env node
/**
 * export-duotone.js
 *
 * Phase 1 & 3 of the Streamline duotone illustration pipeline.
 *
 * Phase 1 — Search & Register:
 *   Interactively searches UX Duotone source assets as you type.
 *   Pick an illustration, register it, then loop to add more.
 *
 * Phase 2 — Export (automatic):
 *   Generates the SVG symbol sprite via nucleo-sprite.js, then automatically
 *   applies the Streamline duotone color → CSS-variable replacements
 *   (ported from ReplaceColorsInDuotone.bat). Output goes to output/ subdir.
 *
 * Phase 3 — Deploy to klara-theme:
 *   Copies the exported SVG sprite to klara-theme.
 *   Requires --theme-path to be set.
 *
 * Usage:
 *   node export-duotone.js
 *   node export-duotone.js --theme-path /path/to/klara-theme
 *   node export-duotone.js --name "Dove"   # pre-fills first search
 */
'use strict';

const path = require('path');
const fs   = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { search, confirm } = require('@inquirer/prompts');
const {
  c, generateUuid, findSvgs,
  readProjectNucleo, buildIconJson, spliceIconsIntoRawJson,
  validateJson, writeProjectNucleo, parseArgs, stripLeadingSlash, spawnExport,
} = require('./lib/common');
const { replaceColorsDuotone } = require('./lib/replace-colors-duotone');

// ─── Configuration ────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.env.PROJECT_ROOT;
if (!PROJECT_ROOT) {
  console.error(c.red('ERROR: PROJECT_ROOT not set. Check your .env file.'));
  process.exit(1);
}

const ASSETS_MY_SETS     = process.env.ASSETS_MY_SETS
  || path.join(PROJECT_ROOT, '_Assets', 'my-sets');
const UX_ILLUST_ROOT     = path.join(ASSETS_MY_SETS, 'Streamline UX Illustrations');

const DUOTONE_SOURCE_DIR = process.env.SOURCE_DIR_DUOTONE
  || path.join(UX_ILLUST_ROOT, 'UX Duotone');

const NC_PROJECT_UUID    = process.env.NUCLEO_UUID_ILLUSTRATIONS_DUOTONE || '';
const NC_PROJECT_DIR     = path.join(PROJECT_ROOT, 'nc-projects', NC_PROJECT_UUID);
const NUCLEO_PATH        = path.join(NC_PROJECT_DIR, 'project.nucleo');

const OUTPUT_SUBDIR      = stripLeadingSlash(process.env.OUTPUT_SUBDIR_ILLUSTRATIONS_DUOTONE || '_Assets/StreamlineDuotoneIcons');
const OUTPUT_DIR         = path.join(PROJECT_ROOT, OUTPUT_SUBDIR);
const SPRITE_INPUT_SVG   = path.join(OUTPUT_DIR, 'img',    'streamline-icon-duotone.svg');
const EXPORT_SVG         = path.join(OUTPUT_DIR, 'output', 'streamline-icon-duotone.svg');

// Path to the sprite-generation script (project root)
const NUCLEO_SPRITE_SCRIPT = path.join(__dirname, '..', 'nucleo-sprite.js');

const SPRITE_CONFIG = {
  svgsprite: {
    baseClass:      'streamline-icon-duotone',
    idPrefix:       'streamline-icon-duotone-',
    assetsPath:     'img',
    fileName:       'streamline-icon-duotone.svg',
    metadataEnable: true,
    metadata: {
      author: 'Klara Design', description: 'Built on Streamline', version: '0.1',
      copyright: 'Klara Design', license: '', url: '',
    },
  },
};

// ─── Search helper ───────────────────────────────────────────────────────────

function searchDuotone(term) {
  if (!term || !term.trim()) return [];
  return findSvgs(DUOTONE_SOURCE_DIR, term.trim()).sort((a, b) => a.basename.localeCompare(b.basename));
}

// ─── Register one illustration ────────────────────────────────────────────────

function registerIllustration(selectedFile, existingNames) {
  const svgBaseName = selectedFile.basename;
  const rel         = selectedFile.fullPath.replace(UX_ILLUST_ROOT + path.sep, '');

  if (existingNames.has(svgBaseName)) {
    console.log(c.yellow(
      `  [SKIP] '${svgBaseName}' already exists in project.nucleo (uuid: ${existingNames.get(svgBaseName)})`,
    ));
    return null;
  }

  const { rawJson, obj } = readProjectNucleo(NUCLEO_PATH);
  const initialCount     = (obj.icons || []).length;
  const currentMax       = (obj.icons || []).reduce((m, i) => Math.max(m, i.place), 0);
  const nextPlace        = currentMax + 1;

  const newUuid  = generateUuid();
  const destPath = path.join(NC_PROJECT_DIR, newUuid + '.svg');
  fs.copyFileSync(selectedFile.fullPath, destPath);
  console.log(c.green(`  [COPY] ${rel} -> ${newUuid}.svg`));

  const iconJson = buildIconJson({
    uuid:     newUuid,
    name:     svgBaseName,
    filename: svgBaseName + '.svg',
    width:    100,
    height:   100,
    klass:    'colored',
    grid:     128,
    place:    nextPlace,
    fillAll:  0,
  });

  const updatedRaw = spliceIconsIntoRawJson(rawJson, [iconJson], initialCount);
  const validated  = validateJson(updatedRaw, 'project.nucleo');
  console.log(c.yellow(`  Validation: ${validated.icons.length} icon(s) total (was ${initialCount}).`));

  writeProjectNucleo(NUCLEO_PATH, updatedRaw);
  existingNames.set(svgBaseName, newUuid);
  console.log(c.green(`  [ADD]  Registered '${svgBaseName}' (uuid: ${newUuid}, place: ${nextPlace})`));
  return svgBaseName;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { name: prefillName, themePath } = parseArgs();

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 1: Search & Add (loop)
  // ══════════════════════════════════════════════════════════════════════════
  console.log(c.cyan('\n=== Phase 1: Search & Add Illustrations ==='));

  // Load existing names once; kept in-sync after each registration
  const { existingNames } = readProjectNucleo(NUCLEO_PATH);
  const addedIcons = [];
  let isFirstSearch = true;

  while (true) {
    console.log('');

    const searchResult = await search({
      message: isFirstSearch && prefillName
        ? `Search illustration name: (pre-filled: ${prefillName})`
        : 'Search illustration name:',
      source: async (input) => {
        const term = (isFirstSearch && prefillName && !input) ? prefillName : (input || '');
        if (!term.trim()) {
          return [{ name: c.gray('  Type to search…'), value: null, disabled: true }];
        }
        const results = searchDuotone(term);
        if (results.length === 0) {
          return [{ name: c.yellow(`  No duotone illustrations matching "${term}"`), value: null, disabled: true }];
        }
        return results.map(r => ({
          name: addedIcons.includes(r.basename)
            ? c.gray(`${r.basename}  [already added this session]`)
            : r.basename,
          value: r,
          disabled: addedIcons.includes(r.basename),
        }));
      },
    });

    isFirstSearch = false;

    if (!searchResult || !searchResult.basename) {
      console.log(c.yellow('No illustration selected. Try a different search term.'));
      const retry = await confirm({ message: 'Search again?', default: true });
      if (!retry) break;
      continue;
    }

    const added = registerIllustration(searchResult, existingNames);
    if (added) {
      addedIcons.push(added);
      console.log(c.green(`\n✓ '${added}' registered.`));
    } else {
      console.log(c.yellow(`\n'${searchResult.basename}' already exists — nothing added.`));
    }

    const addMore = await confirm({ message: '\nAdd another illustration?', default: true });
    if (!addMore) break;
  }

  if (addedIcons.length === 0) {
    console.log(c.yellow('\nNo illustrations were added. Exiting.'));
    process.exit(0);
  }

  console.log(c.cyan(`\n${addedIcons.length} illustration(s) registered: ${addedIcons.join(', ')}`))

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 2: Export Sprite
  // ══════════════════════════════════════════════════════════════════════════
  console.log(c.cyan('\n=== Phase 2: Export Sprite ==='));

  console.log(c.yellow('\nGenerating SVG sprite...'));
  await spawnExport(NUCLEO_SPRITE_SCRIPT, NC_PROJECT_DIR, OUTPUT_DIR, SPRITE_CONFIG);
  console.log(c.green('Sprite export complete.'));

  console.log(c.yellow('Applying color replacements...'));
  replaceColorsDuotone(SPRITE_INPUT_SVG, EXPORT_SVG);
  console.log(c.green(`Color-replaced sprite written to: ${EXPORT_SVG}`));

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 3: Copy to klara-theme
  // ══════════════════════════════════════════════════════════════════════════
  console.log(c.cyan('\n=== Phase 3: Copy to klara-theme ==='));

  if (!fs.existsSync(EXPORT_SVG)) {
    console.error(c.red(`ERROR: Exported file not found at '${EXPORT_SVG}'.`));
    console.error(c.yellow('Ensure the export completed and the file was saved to the correct location.'));
    process.exit(1);
  }

  if (!themePath) {
    console.log(c.yellow('No --theme-path provided. Manual copy required:'));
    console.log(`  Source: ${EXPORT_SVG}`);
    console.log('    -> <klara-theme>/libs/klara-theme/src/lib/assets/icons/streamline-icon-duotone.svg');
    console.log(c.cyan('\n=== Done! ==='));
    process.exit(0);
  }

  const klaraTarget = path.join(themePath, 'streamline-icon-duotone.svg');
  fs.copyFileSync(EXPORT_SVG, klaraTarget);
  console.log(c.green(`Copied to klara-theme: ${klaraTarget}`));

  console.log(c.cyan('\n=== Done! ==='));
  console.log(c.yellow('Next steps:'));
  console.log('  1. Verify the illustration renders correctly in klara-theme');
  console.log('  2. Commit changes to the theme_icons repo');
}

main().catch(err => {
  console.error(c.red('\nFATAL: ' + (err.message || err)));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
