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

// --project-root overrides PROJECT_ROOT from .env (must run before config block)
{ const i = process.argv.indexOf('--project-root'); if (i !== -1 && process.argv[i+1]) process.env.PROJECT_ROOT = process.argv[i+1]; }

const { search, confirm, input } = require('@inquirer/prompts');
const {
  c, expandHome, readProjectNucleo, parseArgs, spawnExport,
} = require('./lib/common');
const {
  resolveDuotonePaths, searchDuotonePipeline, registerDuotonePipeline, deployDuotonePipeline,
} = require('./lib/pipelines');
const { replaceColorsDuotone } = require('./lib/replace-colors-duotone');

// ─── Configuration ────────────────────────────────────────────────────────────

const PROJECT_ROOT = expandHome(process.env.PROJECT_ROOT);
if (!PROJECT_ROOT) {
  console.error(c.red('ERROR: PROJECT_ROOT not set. Check your .env file.'));
  process.exit(1);
}
if (!fs.existsSync(PROJECT_ROOT)) {
  console.error(c.red(`ERROR: PROJECT_ROOT does not exist: ${PROJECT_ROOT}`));
  process.exit(1);
}

const paths = resolveDuotonePaths(PROJECT_ROOT);
const { NC_PROJECT_DIR, NUCLEO_PATH, OUTPUT_DIR, SPRITE_INPUT_SVG, EXPORT_SVG, SPRITE_CONFIG, NUCLEO_SPRITE_SCRIPT } = paths;

// ─── Search / register wrappers (shared logic lives in lib/pipelines.js) ──────

function searchDuotone(term) {
  return searchDuotonePipeline(paths, term);
}

function registerIllustration(selectedFile, existingNames) {
  return registerDuotonePipeline(paths, selectedFile, existingNames, msg => {
    const color = msg.startsWith('[SKIP]') ? c.yellow : c.green;
    console.log(color(`  ${msg}`));
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const prefillName = args.name;
  let themePath = args.themePath;

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 1: Search & Add (loop)
  // ══════════════════════════════════════════════════════════════════════════
  console.log(c.cyan('\n=== Phase 1: Search & Add Illustrations ==='));

  // Load existing names once; kept in-sync after each registration
  const { existingNames } = readProjectNucleo(NUCLEO_PATH);
  const addedIcons = [];

  if (args.names.length > 0) {
    // ── Non-interactive: auto-register all --name values ──────────────────────
    for (const name of args.names) {
      console.log('');
      const results = searchDuotone(name);
      const match = results.find(r => r.basename.toLowerCase() === name.trim().toLowerCase())
        || (results.length === 1 ? results[0] : null);
      if (!match) {
        const closest = results.slice(0, 5).map(r => `  • ${r.basename}`).join('\n');
        console.error(c.red(`ERROR: Illustration "${name}" not found in duotone source.`));
        if (closest) console.error(c.yellow('Closest matches:\n' + closest));
        process.exit(1);
      }
      const added = registerIllustration(match, existingNames);
      if (added) {
        addedIcons.push(added);
        console.log(c.green(`✓ '${added}' registered.`));
      } else {
        console.log(c.yellow(`'${name}' already exists — nothing added.`));
      }
    }
  } else {
  // ── Interactive loop ──────────────────────────────────────────────────────
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
  } // end interactive

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

  if (args.skipCopy) {
    console.log(c.yellow('\nPhase 3 skipped (--skip-copy).'));
    console.log(c.cyan('\n=== Done! ==='));
    process.exit(0);
  }

  if (!fs.existsSync(EXPORT_SVG)) {
    console.error(c.red(`ERROR: Exported file not found at '${EXPORT_SVG}'.`));
    console.error(c.yellow('Ensure the export completed and the file was saved to the correct location.'));
    process.exit(1);
  }

  if (!themePath) {
    console.log(c.yellow('No --theme-path provided.'));
    themePath = await input({
      message: 'Enter klara-theme path (absolute):',
      validate: v => v.trim() ? true : 'Path cannot be empty',
    });
    themePath = themePath.trim();
  }

  if (!args.autoCopy) {
    const proceedCopy = await confirm({
      message: `Copy duotone sprite to:\n  ${path.join(themePath, 'src', 'lib', 'assets', 'icons', 'streamline-icon-duotone.svg')}`,
      default: true,
    });
    if (!proceedCopy) {
      console.log(c.yellow('Copy skipped. Re-run with --theme-path to copy manually.'));
      console.log(c.cyan('\n=== Done! ==='));
      process.exit(0);
    }
  } else {
    console.log(c.yellow(`Auto-copying to klara-theme (--auto-copy): ${themePath}`));
  }

  let deployResult;
  try {
    deployResult = deployDuotonePipeline(paths, themePath);
  } catch (err) {
    console.error(c.red(`ERROR: ${err.message}`));
    process.exit(1);
  }
  console.log(c.green(`Copied to klara-theme: ${deployResult.target}`));

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
