#!/usr/bin/env node
/**
 * export-duotone.js
 *
 * Phase 1 & 3 of the Streamline duotone illustration pipeline.
 *
 * Phase 1 — Search & Register:
 *   Finds illustrations in the UX Duotone source assets and registers them in
 *   the Nucleo project (project.nucleo), copying SVG files with UUID filenames.
 *
 * Phase 2 — Export (run separately):
 *   Run `node nucleo-sprite.js` (or `node export-cli.mjs`) to generate the
 *   SVG symbol sprite. This script pauses and waits for confirmation.
 *   Note: If color replacement (ReplaceColorsInDuotone) is needed, run that
 *   bat script first before running Phase 2.
 *
 * Phase 3 — Deploy to klara-theme:
 *   Copies the exported SVG sprite to klara-theme.
 *   Requires --theme-path to be set.
 *
 * Usage:
 *   node export-duotone.js --name "Dove"
 *   node export-duotone.js --name "Dove" --theme-path /path/to/klara-theme
 */
'use strict';

const path = require('path');
const fs   = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { checkbox, confirm } = require('@inquirer/prompts');
const {
  c, generateUuid, findSvgs,
  readProjectNucleo, buildIconJson, spliceIconsIntoRawJson,
  validateJson, writeProjectNucleo, parseArgs, stripLeadingSlash,
} = require('./lib/common');

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
const EXPORT_SVG         = path.join(OUTPUT_DIR, 'img', 'streamline-icon-duotone.svg');

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { name, themePath } = parseArgs();

  if (!name) {
    console.error(c.red(
      'Usage: node export-duotone.js --name "Dove" [--theme-path /path/to/klara-theme]',
    ));
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 1: Search & Add to Nucleo Project
  // ══════════════════════════════════════════════════════════════════════════
  console.log(c.cyan('\n=== Phase 1: Search & Add Illustration ==='));
  console.log(c.yellow(`Searching for '${name}' in UX Duotone assets...`));

  const foundSvgs = findSvgs(DUOTONE_SOURCE_DIR, name);

  if (foundSvgs.length === 0) {
    console.log(c.red(`No illustrations found matching '${name}'.`));
    if (fs.existsSync(DUOTONE_SOURCE_DIR)) {
      const cats = fs.readdirSync(DUOTONE_SOURCE_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
      if (cats.length) {
        console.log(c.yellow('Available categories:'));
        cats.forEach(cat => console.log(`  - ${cat}`));
      }
    }
    process.exit(1);
  }

  console.log(c.green(`\nFound ${foundSvgs.length} match(es):`));
  foundSvgs.forEach((f, i) => {
    const rel = f.fullPath.replace(DUOTONE_SOURCE_DIR + path.sep, '');
    console.log(`  [${i + 1}] ${rel}`);
  });

  // Select one or more illustrations
  let selectedFiles;
  if (foundSvgs.length === 1) {
    selectedFiles = [foundSvgs[0]];
    console.log(c.yellow('\nAuto-selecting the only match.'));
  } else {
    selectedFiles = await checkbox({
      message: 'Select illustrations to add (space to toggle, enter to confirm):',
      choices: foundSvgs.map((f, i) => ({
        name: `[${i + 1}] ${f.fullPath.replace(DUOTONE_SOURCE_DIR + path.sep, '')}`,
        value: f,
      })),
    });
    if (selectedFiles.length === 0) {
      console.log(c.yellow('No selection made. Aborting.'));
      process.exit(0);
    }
  }

  // Load project.nucleo (raw string approach to avoid ConvertTo-Json corruption)
  const { rawJson: origRaw, obj, existingNames, maxPlace: initMax } = readProjectNucleo(NUCLEO_PATH);
  const initialCount = (obj.icons || []).length;
  let maxPlace = initMax;

  const newFragments = [];

  for (const selectedFile of selectedFiles) {
    const svgBaseName = selectedFile.basename;
    const rel         = selectedFile.fullPath.replace(UX_ILLUST_ROOT + path.sep, '');

    if (existingNames.has(svgBaseName)) {
      console.log(c.yellow(
        `  [SKIP] '${svgBaseName}' already exists in project.nucleo (uuid: ${existingNames.get(svgBaseName)})`,
      ));
      continue;
    }

    const newUuid  = generateUuid();
    const destPath = path.join(NC_PROJECT_DIR, newUuid + '.svg');
    fs.copyFileSync(selectedFile.fullPath, destPath);
    console.log(c.green(`  [COPY] ${rel} -> ${newUuid}.svg`));

    maxPlace++;
    // Duotone keeps the original filename in the JSON (matching PS1 behavior)
    const iconJson = buildIconJson({
      uuid:     newUuid,
      name:     svgBaseName,
      filename: svgBaseName + '.svg',
      width:    100,
      height:   100,
      klass:    'colored',
      grid:     128,
      place:    maxPlace,
      fillAll:  0,
    });
    newFragments.push(iconJson);
    existingNames.set(svgBaseName, newUuid);
    console.log(c.green(
      `  [ADD]  Registered '${svgBaseName}' in project.nucleo (uuid: ${newUuid}, place: ${maxPlace})`,
    ));
  }

  if (newFragments.length === 0) {
    console.log(c.yellow('\nNo new illustrations added.'));
    process.exit(0);
  }

  const updatedRaw = spliceIconsIntoRawJson(origRaw, newFragments, initialCount);
  const validated  = validateJson(updatedRaw, 'project.nucleo');
  console.log(c.yellow(
    `Validation: ${validated.icons.length} icon(s) in modified JSON (was ${initialCount}).`,
  ));

  writeProjectNucleo(NUCLEO_PATH, updatedRaw);
  console.log(c.green(`\nproject.nucleo updated - ${newFragments.length} illustration(s) added.`));

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 2: Export sprite (using nucleo-sprite.js / export-cli.mjs)
  // ══════════════════════════════════════════════════════════════════════════
  const saveDir = path.join(OUTPUT_DIR, 'img');
  console.log(c.cyan('\n=== Phase 2: Export Sprite ==='));
  console.log('Run the sprite export. Use one of:\n');
  console.log('  node export-cli.mjs          (interactive CLI, select streamline-illustrations-duotone)');
  console.log(`  node nucleo-sprite.js "${NC_PROJECT_DIR}" "${OUTPUT_DIR}"\n`);
  console.log('If color replacement is needed, run ReplaceColorsInDuotone.bat first.\n');
  console.log('Export settings:');
  console.log('  Project          : App / Illustrations / Duotone');
  console.log('  Format           : SVG symbol');
  console.log('  Base CSS Class   : streamline-icon-duotone');
  console.log('  Icon ID Prefix   : streamline-icon-duotone-');
  console.log('  File name        : streamline-icon-duotone.svg');
  console.log(`  Save to          : ${saveDir}`);

  const ready = await confirm({
    message: '\nHave you completed the export?',
    default: false,
  });
  if (!ready) {
    console.log(c.yellow('Aborted. Re-run the script after completing the export.'));
    process.exit(0);
  }

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
