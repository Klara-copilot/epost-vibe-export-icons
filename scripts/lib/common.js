'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { spawn }        = require('child_process');
const { writeFileSync, mkdtempSync } = require('fs');
const { tmpdir }       = require('os');

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
 * Backup + write project.nucleo (UTF-8 no-BOM).
 */
function writeProjectNucleo(nucleoPath, rawJson) {
  fs.copyFileSync(nucleoPath, nucleoPath + '.bak');
  fs.writeFileSync(nucleoPath, rawJson, 'utf8');
}

// ─── CLI arg parsing ──────────────────────────────────────────────────────────
/**
 * Parse --name / --theme-path from process.argv.
 * A bare first positional arg (no leading --) is treated as --name.
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const result = { name: null, themePath: null };
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--name' || args[i] === '-n') && args[i + 1]) {
      result.name = args[++i];
    } else if ((args[i] === '--theme-path' || args[i] === '-t') && args[i + 1]) {
      result.themePath = args[++i];
    } else if (!args[i].startsWith('-') && !result.name) {
      result.name = args[i];
    }
  }
  return result;
}

// ─── Path helpers ─────────────────────────────────────────────────────────────
/** Strip a leading `/` so path.join() doesn't misinterpret env var values. */
function stripLeadingSlash(s) {
  return s ? s.replace(/^\//, '') : s;
}

// ─── Export runner ────────────────────────────────────────────────────────────
/**
 * Spawn nucleo-export.js or nucleo-sprite.js with the given config.
 * Writes the config to a temp file and passes its path via EXPORT_CONFIG env var.
 * Returns a Promise that resolves when the child exits 0, rejects otherwise.
 */
function spawnExport(scriptPath, projectDir, outputDir, exportConfig) {
  return new Promise((resolve, reject) => {
    const tmpDir  = mkdtempSync(path.join(tmpdir(), 'nucleo-cli-'));
    const cfgPath = path.join(tmpDir, 'export-config.json');
    writeFileSync(cfgPath, JSON.stringify(exportConfig, null, 2), 'utf8');

    const child = spawn(
      process.execPath,
      [scriptPath, projectDir, outputDir],
      { env: { ...process.env, EXPORT_CONFIG: cfgPath }, stdio: 'inherit' },
    );
    child.on('close', code => {
      if (code !== 0) reject(new Error(`Export script exited with code ${code}`));
      else resolve();
    });
    child.on('error', reject);
  });
}

module.exports = {
  c,
  generateUuid,
  findSvgs,
  readProjectNucleo,
  buildIconJson,
  spliceIconsIntoRawJson,
  validateJson,
  writeProjectNucleo,
  parseArgs,
  stripLeadingSlash,
  spawnExport,
};
