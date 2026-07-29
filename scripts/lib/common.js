'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { spawn }        = require('child_process');
const { writeFileSync, mkdtempSync } = require('fs');
const { tmpdir, homedir } = require('os');

// ─── Home-directory expansion ─────────────────────────────────────────────────
/** Expand a leading `~` to the user's home directory (mirrors export-cli.mjs). */
function expandHome(p) {
  return p && p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p;
}

// ─── ANSI color helpers ───────────────────────────────────────────────────────
const c = {
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  gray:   s => `\x1b[90m${s}\x1b[0m`,
  white:  s => s,
};

// ─── UUID ─────────────────────────────────────────────────────────────────────
/** Generate a 22-char lowercase hex string matching Nucleo's UUID format. */
function generateUuid() {
  return crypto.randomBytes(11).toString('hex');
}

// ─── Recursive SVG search ─────────────────────────────────────────────────────
/**
 * Recursively find .svg files whose basename contains nameFragment
 * (case-insensitive).
 * Returns array of { fullPath, basename }.
 */
function findSvgs(dir, nameFragment) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSvgs(fullPath, nameFragment));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.svg')) {
      const basename = path.basename(entry.name, '.svg');
      if (basename.toLowerCase().includes(nameFragment.toLowerCase())) {
        results.push({ fullPath, basename });
      }
    }
  }
  return results;
}

// ─── project.nucleo helpers ───────────────────────────────────────────────────

/**
 * Read a project.nucleo file.
 * Returns { rawJson, obj, existingNames: Map<name,uuid>, maxPlace }.
 */
function readProjectNucleo(nucleoPath) {
  const rawJson = fs.readFileSync(nucleoPath, 'utf8');
  const obj     = JSON.parse(rawJson);
  const existingNames = new Map();
  let maxPlace = 0;
  for (const icon of (obj.icons || [])) {
    existingNames.set(icon.name, icon.uuid);
    if (icon.place > maxPlace) maxPlace = icon.place;
  }
  return { rawJson, obj, existingNames, maxPlace };
}

/**
 * Build a new icon JSON fragment string for project.nucleo.
 * opts: { uuid, name, filename?, width, height, klass, grid, place, fillAll }
 * filename defaults to `${uuid}.svg` if omitted.
 */
function buildIconJson(opts) {
  const { uuid, name, width, height, klass, grid, place, fillAll } = opts;
  const filename = opts.filename || uuid + '.svg';
  const esc = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return (
    `{"uuid":"${uuid}","local":1,"remote_id":null,"tags":"","nucleo_tags":"",` +
    `"width":${width},"height":${height},"filename":"${esc(filename)}",` +
    `"fill_all":${fillAll},"klass":"${klass}","name":"${esc(name)}",` +
    `"grid":${grid},"place":${place}}`
  );
}

/**
 * Splice one or more icon JSON fragments into a raw project.nucleo JSON string.
 * initialExistingCount: the number of icons already present before this run
 * (determines whether to prepend a comma).
 */
function spliceIconsIntoRawJson(rawJson, fragments, initialExistingCount) {
  const timestamp  = Math.floor(Date.now() / 1000);
  const joinedNew  = fragments.join(',');
  const insertJson = initialExistingCount > 0 ? ',' + joinedNew : joinedNew;

  const match = rawJson.match(/\]\s*,\s*"timestamp"/);
  if (!match) throw new Error('Could not locate icons array end in project.nucleo');

  let updated = rawJson.substring(0, match.index) + insertJson + rawJson.substring(match.index);
  updated = updated.replace(/"timestamp":\d+/, `"timestamp":${timestamp}`);
  return updated;
}

/**
 * Validate that a raw JSON string parses correctly.
 * Returns the parsed object. Throws on invalid JSON.
 */
function validateJson(rawJson, context) {
  try {
    return JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`Invalid JSON in ${context}: ${e.message}`);
  }
}

/**
 * Backup a file OUTSIDE any git repo (to the OS temp dir), so the copy can
 * never be picked up by `git add .` and leak into a PR. Returns the backup
 * path. Used instead of writing a sibling `<file>.bak`, which previously ended
 * up staged/committed alongside the real change (e.g. _icons-map.scss.bak,
 * project.nucleo.bak).
 */
function backupOutsideRepo(filePath) {
  const hash = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 8);
  const backupPath = path.join(
    tmpdir(),
    `vibe-backup-${path.basename(filePath)}-${hash}-${Date.now()}.bak`,
  );
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * Backup + write project.nucleo (UTF-8 no-BOM). The backup goes to the OS temp
 * dir (not a sibling `.bak`) so it never leaks into the theme_icons commit.
 */
function writeProjectNucleo(nucleoPath, rawJson) {
  backupOutsideRepo(nucleoPath);
  fs.writeFileSync(nucleoPath, rawJson, 'utf8');
}

// ─── CLI arg parsing ──────────────────────────────────────────────────────────
/**
 * Parse CLI flags shared across all export scripts.
 *
 *   --name / -n <v>   Repeatable — provide multiple to skip Phase 1 prompts.
 *                     result.name is always result.names[0] for backward-compat.
 *   --theme-path / -t Target klara-theme directory (Phase 3)
 *   --pipeline <v>    'icon' | 'duotone' | 'illustration'  (index.js only)
 *   --skip-export     Skip Phase 2 font/sprite export      (export-icon.js)
 *   --skip-copy       Skip Phase 3 copy to klara-theme     (all export scripts)
 *
 * A bare first positional arg (no leading --) is treated as --name.
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    names:       [],
    name:        null,   // = names[0], kept for backward-compat
    themePath:   null,
    pipeline:    null,
    projectRoot: null,   // overrides process.env.PROJECT_ROOT
    skipExport:  false,
    skipCopy:    false,
    autoExport:  false,
    autoCopy:    false,
  };
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--name' || args[i] === '-n') && args[i + 1]) {
      result.names.push(args[++i]);
    } else if ((args[i] === '--theme-path' || args[i] === '-t') && args[i + 1]) {
      result.themePath = args[++i];
    } else if (args[i] === '--pipeline' && args[i + 1]) {
      result.pipeline = args[++i];
    } else if ((args[i] === '--project-root' || args[i] === '-r') && args[i + 1]) {
      result.projectRoot = args[++i];
    } else if (args[i] === '--skip-export') {
      result.skipExport = true;
    } else if (args[i] === '--skip-copy') {
      result.skipCopy = true;
    } else if (args[i] === '--auto-export') {
      result.autoExport = true;
    } else if (args[i] === '--auto-copy') {
      result.autoCopy = true;
    } else if (!args[i].startsWith('-') && !result.names.length) {
      result.names.push(args[i]);
    }
  }
  result.name = result.names[0] || null;
  return result;
}

// ─── Path helpers ─────────────────────────────────────────────────────────────
/** Strip a leading `/` so path.join() doesn't misinterpret env var values. */
function stripLeadingSlash(s) {
  return s ? s.replace(/^\//, '') : s;
}

// ─── Export runner ────────────────────────────────────────────────────────────

/** Write exportConfig to a temp file and build the spawn args for scriptPath. */
function prepareExportSpawn(scriptPath, projectDir, outputDir, exportConfig) {
  const tmpDir  = mkdtempSync(path.join(tmpdir(), 'nucleo-cli-'));
  const cfgPath = path.join(tmpDir, 'export-config.json');
  writeFileSync(cfgPath, JSON.stringify(exportConfig, null, 2), 'utf8');

  // Bundle mode: all scripts are inside the single bundle file. Re-invoke it
  // with --script <name> instead of spawning a separate .js file on disk.
  const isBundle = path.basename(process.argv[1]).endsWith('.bundle.js');
  const scriptName = path.basename(scriptPath, '.js'); // e.g. 'nucleo-export'
  const args = isBundle
    ? [process.argv[1], '--script', scriptName, projectDir, outputDir]
    : [scriptPath, projectDir, outputDir];

  return { args, cfgPath };
}

/**
 * Spawn nucleo-export.js or nucleo-sprite.js with the given config, inheriting
 * this process's stdio (CLI usage — output goes straight to the terminal).
 * Returns a Promise that resolves when the child exits 0, rejects otherwise.
 */
function spawnExport(scriptPath, projectDir, outputDir, exportConfig) {
  return new Promise((resolve, reject) => {
    const { args, cfgPath } = prepareExportSpawn(scriptPath, projectDir, outputDir, exportConfig);
    const child = spawn(
      process.execPath,
      args,
      { env: { ...process.env, EXPORT_CONFIG: cfgPath }, stdio: 'inherit' },
    );
    child.on('close', code => {
      if (code !== 0) reject(new Error(`Export script exited with code ${code}`));
      else resolve();
    });
    child.on('error', reject);
  });
}

/**
 * Same as spawnExport, but captures stdout/stderr instead of inheriting the
 * parent's stdio — used by the bridge server to stream export output to a
 * browser client instead of printing to the server's own terminal.
 * onData(text) is called for each chunk of stdout/stderr as it arrives.
 */
function spawnExportCaptured(scriptPath, projectDir, outputDir, exportConfig, onData) {
  return new Promise((resolve, reject) => {
    const { args, cfgPath } = prepareExportSpawn(scriptPath, projectDir, outputDir, exportConfig);
    const child = spawn(
      process.execPath,
      args,
      { env: { ...process.env, EXPORT_CONFIG: cfgPath }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', chunk => onData(chunk.toString('utf8')));
    child.stderr.on('data', chunk => onData(chunk.toString('utf8')));
    child.on('close', code => {
      if (code !== 0) reject(new Error(`Export script exited with code ${code}`));
      else resolve();
    });
    child.on('error', reject);
  });
}

module.exports = {
  c,
  expandHome,
  generateUuid,
  findSvgs,
  readProjectNucleo,
  buildIconJson,
  spliceIconsIntoRawJson,
  validateJson,
  writeProjectNucleo,
  backupOutsideRepo,
  parseArgs,
  stripLeadingSlash,
  spawnExport,
  spawnExportCaptured,
};
