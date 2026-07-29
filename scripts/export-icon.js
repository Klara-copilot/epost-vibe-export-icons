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

// --project-root overrides PROJECT_ROOT from .env (must run before config block)
{ const i = process.argv.indexOf('--project-root'); if (i !== -1 && process.argv[i+1]) process.env.PROJECT_ROOT = process.argv[i+1]; }

const { search, select, confirm, input } = require('@inquirer/prompts');
const {
  c, expandHome, parseArgs, spawnExport, readProjectNucleo,
} = require('./lib/common');
const {
  resolveIconPaths, searchIconPipeline, findIconExact: findIconExactShared,
  registerIconPipeline, deployIconPipeline, applyFontVersions,
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

const paths = resolveIconPaths(PROJECT_ROOT);
const { SOURCE_DIRS, NC_PROJECTS, EXPORT_DIRS, STYLE_ORDER, FONT_EXPORT_CONFIGS, NUCLEO_EXPORT_SCRIPT } = paths;

// ─── Search / register wrappers (shared logic lives in lib/pipelines.js) ──────

function searchCommonIcons(term) {
  return searchIconPipeline(paths, term);
}

function findIconExact(name) {
  return findIconExactShared(paths, name);
}

async function registerIcon(iconName, iconFiles) {
  console.log(c.yellow('\nRegistering in all 4 projects...'));
  const registeredCount = registerIconPipeline(paths, iconName, iconFiles, msg => {
    const color = msg.startsWith('[SKIP]') ? c.yellow : c.green;
    console.log(color(`    ${msg}`));
  });
  return registeredCount;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const prefillName = args.name;
  let themePath = args.themePath;

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 1: Search & Register (loop)
  // ══════════════════════════════════════════════════════════════════════════
  console.log(c.cyan('\n=== Phase 1: Search & Register Icons ==='));

  const addedIcons = [];

  if (args.names.length > 0) {
    // ── Non-interactive: auto-register all --name values ──────────────────────
    for (const name of args.names) {
      console.log('');
      const icon = findIconExact(name);
      if (!icon) {
        const closest = searchCommonIcons(name).slice(0, 5).map(r => `  • ${r.name}`).join('\n');
        console.error(c.red(`ERROR: Icon "${name}" not found in all 3 source dirs (Light, Regular, Bold).`));
        if (closest) console.error(c.yellow('Closest matches:\n' + closest));
        process.exit(1);
      }
      for (const style of ['Light', 'Regular', 'Bold']) {
        const rel = icon.files[style].fullPath.replace(SOURCE_DIRS[style] + path.sep, '');
        console.log(c.green(`  [${style}] ${rel}`));
      }
      console.log(c.yellow(`  [GLYPH] Reusing Bold source: ${icon.name}`));
      const registeredCount = await registerIcon(icon.name, icon.files);
      if (registeredCount > 0) {
        addedIcons.push(icon.name);
        console.log(c.green(`✓ '${icon.name}' registered in ${registeredCount} project(s).`));
      } else {
        console.log(c.yellow(`'${icon.name}' already present in all 4 projects.`));
      }
    }
  } else {
  // ── Interactive loop ──────────────────────────────────────────────────────
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
  } // end interactive

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

  if (args.skipExport) {
    console.log(c.yellow('\nPhase 2 skipped (--skip-export).'));
  } else {
    if (!args.autoExport) {
      const proceedExport = await confirm({ message: 'Run font export now?', default: true });
      if (!proceedExport) {
        console.log(c.yellow('Skipped. Re-run the script or run export-cli.mjs manually.'));
        process.exit(0);
      }
    } else {
      console.log(c.yellow('Auto-running font export (--auto-export).'));
    }

    // Align embedded font versions with what is already deployed in the theme
    // (read + bump) instead of the hardcoded placeholder, so the generated
    // fonts don't regress the version (e.g. 1.39 -> 0.1). Needs themePath.
    if (themePath) {
      applyFontVersions(paths, themePath, msg => console.log(c.gray(`  ${msg}`)));
    } else {
      console.log(c.yellow('  [VERSION] No --theme-path yet; using default font versions.'));
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
      message: `Copy font files + SCSS map to:\n  ${themePath}`,
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
    deployResult = deployIconPipeline(paths, themePath);
  } catch (err) {
    console.error(c.red(`ERROR: ${err.message}`));
    process.exit(1);
  }

  console.log(c.yellow(`Copied font files to: ${path.join(themePath, 'public', 'assets', 'fonts')}`));
  console.log(c.yellow(`             and also: ${path.join(themePath, 'src', 'lib', 'assets', 'fonts')}`));
  for (const fname of deployResult.copiedFiles) {
    console.log(c.green(`  [COPY] ${fname}`));
  }
  console.log(c.green(`[UPDATE] ${deployResult.iconsAdded} new icon(s) merged into _icons-map.scss`));

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
