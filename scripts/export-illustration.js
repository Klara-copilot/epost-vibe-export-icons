#!/usr/bin/env node
/**
 * export-illustration.js
 *
 * Phase 1 & 3 of the Streamline illustration pipeline (Part 3 project).
 *
 * Phase 1 — Search & Register:
 *   Finds illustrations in the Streamline Filled and UX Line source assets,
 *   registers them in the Part 3 Nucleo project (project.nucleo), copying
 *   SVG files with UUID filenames.
 *
 * Phase 2 — Export (run separately):
 *   Run `node nucleo-sprite.js` (or `node export-cli.mjs`) to generate the
 *   SVG symbol sprite. This script pauses and waits for confirmation.
 *   If the output SVG exceeds 1 MB, consider splitting into a new part.
 *
 * Phase 3 — Deploy to klara-theme:
 *   Copies the exported SVG(s) to <klara-theme>/src/lib/assets/icons/.
 *   Requires --theme-path to be set.
 *
 * Usage:
 *   node export-illustration.js --name "User Smiling"
 *   node export-illustration.js --name "User Smiling" --theme-path /path/to/klara-theme
 */
'use strict';

const path = require('path');
const fs   = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { checkbox, confirm } = require('@inquirer/prompts');
const {
  c, generateUuid, findSvgs,
  readProjectNucleo, buildIconJson, spliceIconsIntoRawJson,
  validateJson, parseArgs, stripLeadingSlash,
} = require('./lib/common');

// ─── Configuration ────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.env.PROJECT_ROOT;
if (!PROJECT_ROOT) {
  console.error(c.red('ERROR: PROJECT_ROOT not set. Check your .env file.'));
  process.exit(1);
}

const ASSETS_MY_SETS  = process.env.ASSETS_MY_SETS
  || path.join(PROJECT_ROOT, '_Assets', 'my-sets');
const UX_ILLUST_ROOT  = path.join(ASSETS_MY_SETS, 'Streamline UX Illustrations');

// Two source dirs searched in order, results combined
const SOURCE_DIRS = [
  process.env.SOURCE_DIR_ILLUSTRATIONS_FILLED
    || path.join(UX_ILLUST_ROOT, 'Steamline Filled (Fixed with oslllo-svg-fixer)'),
  process.env.SOURCE_DIR_ILLUSTRATIONS_LINE
    || path.join(UX_ILLUST_ROOT, 'UX Line'),
];

const NC_PROJECT_UUID = process.env.NUCLEO_UUID_ILLUSTRATIONS_PART3 || 'b8eee6355fe83a71ddffaa';
const NC_PROJECT_DIR  = path.join(PROJECT_ROOT, 'nc-projects', NC_PROJECT_UUID);
const NUCLEO_PATH     = path.join(NC_PROJECT_DIR, 'project.nucleo');

const OUTPUT_SUBDIR   = stripLeadingSlash(process.env.OUTPUT_SUBDIR_ILLUSTRATIONS || '_Assets/StreamlineIllustrator');
const EXPORT_DIR      = path.join(PROJECT_ROOT, OUTPUT_SUBDIR, 'img');

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { name, themePath } = parseArgs();

  if (!name) {
    console.error(c.red(
      'Usage: node export-illustration.js --name "User Smiling" [--theme-path /path/to/klara-theme]',
    ));
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 1: Search & Register in Nucleo Project (Part 3)
  // ══════════════════════════════════════════════════════════════════════════
  console.log(c.cyan('\n=== Phase 1: Search & Register Illustration ==='));
  console.log(c.yellow(`Searching for '${name}' in illustration sources...`));

  const foundSvgs = [];
  for (const srcDir of SOURCE_DIRS) {
    if (fs.existsSync(srcDir)) {
      foundSvgs.push(...findSvgs(srcDir, name));
    }
  }

  if (foundSvgs.length === 0) {
    console.log(c.red(`No illustrations found matching '${name}'.`));
    console.log(c.yellow('Searched in:'));
    SOURCE_DIRS.forEach(d => console.log(`  - ${d}`));
    process.exit(1);
  }

  console.log(c.green(`\nFound ${foundSvgs.length} match(es):`));
  foundSvgs.forEach((f, i) => {
    const rel = f.fullPath.replace(UX_ILLUST_ROOT + path.sep, '');
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
        name: `[${i + 1}] ${f.fullPath.replace(UX_ILLUST_ROOT + path.sep, '')}`,
        value: f,
      })),
    });
    if (selectedFiles.length === 0) {
      console.log(c.yellow('No selection made. Aborting.'));
      process.exit(0);
    }
  }

  // Load project.nucleo (raw string approach)
  const { rawJson: origRaw, obj, existingNames, maxPlace: initMax } = readProjectNucleo(NUCLEO_PATH);
  const initialCount = (obj.icons || []).length;
  let maxPlace = initMax;

  const newFragments = [];

  for (const selectedFile of selectedFiles) {
    const svgBaseName = selectedFile.basename;

    if (existingNames.has(svgBaseName)) {
      console.log(c.yellow(`  [SKIP] '${svgBaseName}' already exists (uuid: ${existingNames.get(svgBaseName)})`));
      continue;
    }

    const newUuid  = generateUuid();
    const destPath = path.join(NC_PROJECT_DIR, newUuid + '.svg');
    fs.copyFileSync(selectedFile.fullPath, destPath);
    console.log(c.green(`  [COPY] ${svgBaseName}.svg -> ${newUuid}.svg`));

    maxPlace++;
    const iconJson = buildIconJson({
      uuid:    newUuid,
      name:    svgBaseName,
      width:   100,
      height:  100,
      klass:   'outline',
      grid:    128,
      place:   maxPlace,
      fillAll: 1,
    });
    newFragments.push(iconJson);
    existingNames.set(svgBaseName, newUuid);
    console.log(c.green(`  [ADD]  '${svgBaseName}' (uuid: ${newUuid}, place: ${maxPlace})`));
  }

  if (newFragments.length === 0) {
    console.error(c.red('\nERROR: All selected illustrations already exist in Part 3.'));
    console.error(c.red('No changes made. Aborting.'));
    process.exit(0);
  }

  const updatedRaw = spliceIconsIntoRawJson(origRaw, newFragments, initialCount);
  const validated  = validateJson(updatedRaw, 'project.nucleo');
  console.log(c.green(
    `\n[VALID] ${validated.icons.length} icons total (was ${validated.icons.length - newFragments.length})`,
  ));

  fs.copyFileSync(NUCLEO_PATH, NUCLEO_PATH + '.bak');
  console.log(c.gray('[BACKUP] project.nucleo.bak created'));
  fs.writeFileSync(NUCLEO_PATH, updatedRaw, 'utf8');
  console.log(c.green(`[SAVE] project.nucleo updated - ${newFragments.length} illustration(s) added.\n`));

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 2: Export sprite (using nucleo-sprite.js / export-cli.mjs)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('=== Phase 2: Export Sprite ===');
  console.log('Run the sprite export. Use one of:\n');
  console.log('  node export-cli.mjs          (interactive CLI, select streamline-illustrations)');
  console.log(`  node nucleo-sprite.js "${NC_PROJECT_DIR}" "${path.join(PROJECT_ROOT, OUTPUT_SUBDIR)}"\n`);
  console.log('Export settings:\n');
  console.log('  [Save As]');
  console.log('    Format        : SVG\n');
  console.log('  [SVG Options]');
  console.log('    SVG Type      : SVG <symbol>\n');
  console.log('  [General]');
  console.log('    Base Class    : streamline-icon');
  console.log('    Icon ID Prefix: streamline-icon-\n');
  console.log('  [Advanced Options]');
  console.log('    Use external reference for <use> : Checked');
  console.log('    Assets Path                      : img');
  console.log('    Remove inline colors             : Unchecked');
  console.log('    Remove stroke-width values       : Unchecked');
  console.log('    Remove <title> element           : Checked');
  console.log('    Use BEM naming convention        : Unchecked');
  console.log('    Use CSS custom properties        : Checked\n');
  console.log(`  Save to: ${EXPORT_DIR}\n`);

  const ready = await confirm({
    message: 'Have you completed the export?',
    default: false,
  });
  if (!ready) {
    console.log(c.yellow('Aborted. Re-run the script after completing the export.'));
    process.exit(0);
  }

  // Verify exported SVG(s) exist
  const exportedFiles = fs.existsSync(EXPORT_DIR)
    ? fs.readdirSync(EXPORT_DIR).filter(f => f.endsWith('.svg'))
    : [];

  if (exportedFiles.length === 0) {
    console.error(c.red(`ERROR: No SVG files found in ${EXPORT_DIR}`));
    console.error(c.yellow('Ensure the export ran successfully and saved to the correct folder.'));
    process.exit(1);
  }

  console.log(c.green('Found exported SVG(s):'));
  for (const fname of exportedFiles) {
    const fpath  = path.join(EXPORT_DIR, fname);
    const sizeKB = Math.round(fs.statSync(fpath).size / 1024 * 10) / 10;
    console.log(c.green(`  ${fname} (${sizeKB} KB)`));
    if (fs.statSync(fpath).size > 1024 * 1024) {
      console.log(c.yellow('  WARNING: File exceeds 1 MB - consider splitting into a new part!'));
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 3: Copy to klara-theme
  // ══════════════════════════════════════════════════════════════════════════
  console.log(c.cyan('\n=== Phase 3: Copy to klara-theme ==='));

  if (!themePath) {
    console.log(c.yellow('No --theme-path provided. Manual copy required:'));
    console.log(`  Source: ${EXPORT_DIR}`);
    exportedFiles.forEach(f => console.log(`    ${f}`));
    console.log('  Target: <klara-theme>/src/lib/assets/icons/');
    console.log(c.cyan('\n=== Done! ==='));
    process.exit(0);
  }

  const iconsTargetDir = path.join(themePath, 'src', 'lib', 'assets', 'icons');
  if (!fs.existsSync(iconsTargetDir)) {
    console.error(c.red(`ERROR: Target dir not found: ${iconsTargetDir}`));
    process.exit(1);
  }

  console.log(c.yellow(`Copying to: ${iconsTargetDir}`));
  for (const fname of exportedFiles) {
    const src  = path.join(EXPORT_DIR, fname);
    const dest = path.join(iconsTargetDir, fname);
    if (fs.existsSync(dest)) {
      fs.copyFileSync(dest, dest + '.bak');
      console.log(c.gray(`  [BACKUP] ${fname}.bak`));
    }
    fs.copyFileSync(src, dest);
    console.log(c.green(`  [COPY] ${fname}`));
  }

  console.log(c.cyan('\n=== Done! ==='));
  console.log(c.yellow('Next steps:'));
  console.log('  1. Verify illustration renders in klara-theme / storybook');
  console.log('  2. Commit changes to the theme_icons repo');
}

main().catch(err => {
  console.error(c.red('\nFATAL: ' + (err.message || err)));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
