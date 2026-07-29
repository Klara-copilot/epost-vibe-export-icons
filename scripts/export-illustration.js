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

// --project-root overrides PROJECT_ROOT from .env (must run before config block)
{ const i = process.argv.indexOf('--project-root'); if (i !== -1 && process.argv[i+1]) process.env.PROJECT_ROOT = process.argv[i+1]; }

const { search, confirm, input } = require('@inquirer/prompts');
const {
  c, expandHome, readProjectNucleo, parseArgs, spawnExport,
} = require('./lib/common');
const {
  resolveIllustrationPaths, searchIllustrationPipeline, registerIllustrationPipeline, deployIllustrationPipeline,
} = require('./lib/pipelines');

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

const paths = resolveIllustrationPaths(PROJECT_ROOT);
const { NC_PROJECT_DIR, NUCLEO_PATH, EXPORT_DIR, SPRITE_CONFIG, NUCLEO_SPRITE_SCRIPT } = paths;

// ─── Search / register wrappers (shared logic lives in lib/pipelines.js) ──────

function searchIllustrations(term) {
  return searchIllustrationPipeline(paths, term);
}

function registerIllustration(selectedFile, existingNames) {
  return registerIllustrationPipeline(paths, selectedFile, existingNames, msg => {
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
  // Phase 1: Search & Register (loop)
  // ══════════════════════════════════════════════════════════════════════════
  console.log(c.cyan('\n=== Phase 1: Search & Register Illustrations ==='));

  // Load existing names once; kept in-sync after each registration
  const { existingNames } = readProjectNucleo(NUCLEO_PATH);
  const addedIcons = [];

  if (args.names.length > 0) {
    // ── Non-interactive: auto-register all --name values ──────────────────────
    for (const name of args.names) {
      console.log('');
      const results = searchIllustrations(name);
      const matchEntry = results.find(r => r.file.basename.toLowerCase() === name.trim().toLowerCase())
        || (results.length === 1 ? results[0] : null);
      if (!matchEntry) {
        const closest = results.slice(0, 5).map(r => `  • ${r.file.basename}  [${r.sourceLabel}]`).join('\n');
        console.error(c.red(`ERROR: Illustration "${name}" not found in source dirs.`));
        if (closest) console.error(c.yellow('Closest matches:\n' + closest));
        process.exit(1);
      }
      const added = registerIllustration(matchEntry.file, existingNames);
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
  } // end interactive

  if (addedIcons.length === 0) {
    console.log(c.yellow('\nNo illustrations were added. Exiting.'));
    process.exit(0);
  }

  console.log(c.cyan(`\n${addedIcons.length} illustration(s) registered: ${addedIcons.join(', ')}`));

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 2: Export Sprite
  // ══════════════════════════════════════════════════════════════════════════
  console.log(c.cyan('\n=== Phase 2: Export Sprite ==='));
  console.log(c.yellow('Generating SVG sprite...'));

  await spawnExport(NUCLEO_SPRITE_SCRIPT, NC_PROJECT_DIR, paths.OUTPUT_DIR, SPRITE_CONFIG);
  console.log(c.green('Sprite export complete.'));

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

  if (args.skipCopy) {
    console.log(c.yellow('\nPhase 3 skipped (--skip-copy).'));
    console.log(c.cyan('\n=== Done! ==='));
    process.exit(0);
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
      message: `Copy illustration sprite(s) to:\n  ${path.join(themePath, 'src', 'lib', 'assets', 'icons')}`,
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
    deployResult = deployIllustrationPipeline(paths, themePath);
  } catch (err) {
    console.error(c.red(`ERROR: ${err.message}`));
    process.exit(1);
  }

  console.log(c.yellow(`Copying to: ${path.join(themePath, 'src', 'lib', 'assets', 'icons')}`));
  for (const fname of deployResult.copiedFiles) {
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
