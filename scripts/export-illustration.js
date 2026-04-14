#!/usr/bin/env node
/**
 * export-illustration.js
 *
 * Phase 1 & 3 of the Streamline illustration pipeline (Part 3 project).
 *
 * Phase 1 — Search & Register:
 *   Interactively searches Streamline Filled and UX Line source assets as you type.
 *   Results from both sources are merged; each result shows its source label.
 *   Pick an illustration, register it, then loop to add more.
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
 *   node export-illustration.js
 *   node export-illustration.js --theme-path /path/to/klara-theme
 *   node export-illustration.js --name "User Smiling"   # pre-fills first search
 */
'use strict';

const path = require('path');
const fs   = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { search, confirm } = require('@inquirer/prompts');
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

// ─── Source labels for display ─────────────────────────────────────────────────────

const SOURCE_LABELS = [
  'Steamline Filled',
  'UX Line',
];

// ─── Search helper ───────────────────────────────────────────────────────────

/**
 * Search both source dirs. Returns array of { file, sourceLabel } sorted by basename.
 * Duplicates (same name in both sources) are kept as separate entries so the user
 * can pick the preferred variant.
 */
function searchIllustrations(term) {
  if (!term || !term.trim()) return [];
  const results = [];
  for (let i = 0; i < SOURCE_DIRS.length; i++) {
    if (!fs.existsSync(SOURCE_DIRS[i])) continue;
    for (const f of findSvgs(SOURCE_DIRS[i], term.trim())) {
      results.push({ file: f, sourceLabel: SOURCE_LABELS[i] });
    }
  }
  return results.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
}

// ─── Register one illustration ────────────────────────────────────────────────

function registerIllustration(selectedFile, existingNames) {
  const svgBaseName = selectedFile.basename;

  if (existingNames.has(svgBaseName)) {
    console.log(c.yellow(`  [SKIP] '${svgBaseName}' already exists (uuid: ${existingNames.get(svgBaseName)})`))
    return null;
  }

  const { rawJson, obj } = readProjectNucleo(NUCLEO_PATH);
  const initialCount     = (obj.icons || []).length;
  const currentMax       = (obj.icons || []).reduce((m, i) => Math.max(m, i.place), 0);
  const nextPlace        = currentMax + 1;

  const newUuid  = generateUuid();
  const destPath = path.join(NC_PROJECT_DIR, newUuid + '.svg');
  fs.copyFileSync(selectedFile.fullPath, destPath);
  console.log(c.green(`  [COPY] ${svgBaseName}.svg -> ${newUuid}.svg`));

  const iconJson = buildIconJson({
    uuid:    newUuid,
    name:    svgBaseName,
    width:   100,
    height:  100,
    klass:   'outline',
    grid:    128,
    place:   nextPlace,
    fillAll: 1,
  });

  const updatedRaw = spliceIconsIntoRawJson(rawJson, [iconJson], initialCount);
  const validated  = validateJson(updatedRaw, 'project.nucleo');
  console.log(c.green(`  [VALID] ${validated.icons.length} icons total (was ${initialCount})`));

  fs.copyFileSync(NUCLEO_PATH, NUCLEO_PATH + '.bak');
  fs.writeFileSync(NUCLEO_PATH, updatedRaw, 'utf8');
  existingNames.set(svgBaseName, newUuid);
  console.log(c.green(`  [ADD]  '${svgBaseName}' (uuid: ${newUuid}, place: ${nextPlace})`));
  return svgBaseName;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { name: prefillName, themePath } = parseArgs();

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 1: Search & Register (loop)
  // ══════════════════════════════════════════════════════════════════════════
  console.log(c.cyan('\n=== Phase 1: Search & Register Illustrations ==='));

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
        const results = searchIllustrations(term);
        if (results.length === 0) {
          return [{ name: c.yellow(`  No illustrations matching "${term}"`), value: null, disabled: true }];
        }
        return results.map(({ file, sourceLabel }) => {
          const alreadyAdded = addedIcons.includes(file.basename);
          const label        = `${file.basename}  ${c.gray(`[${sourceLabel}]`)}`;
          return {
            name: alreadyAdded ? c.gray(`${file.basename}  [already added this session]`) : label,
            value: file,
            disabled: alreadyAdded,
          };
        });
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

  console.log(c.cyan(`\n${addedIcons.length} illustration(s) registered: ${addedIcons.join(', ')}`));

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 2: Export sprite (using nucleo-sprite.js / export-cli.mjs)
  // ══════════════════════════════════════════════════════════════════════════
  console.log(c.cyan('\n=== Phase 2: Export Sprite ==='));
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
