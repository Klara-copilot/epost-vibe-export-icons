#!/usr/bin/env node
/**
 * scripts/workflow.js  — Full-lifecycle icon export orchestrator
 *
 * Wraps the entire icon export workflow into a single command supporting multiple
 * pipelines in a single invocation. Allows mixing icons, duotones, and illustrations.
 * The script handles:
 *
 *   1. Fresh git clone of the theme_icons repo into an isolated temp directory (or use --red-bull)
 *   2. Physical audit — check which icons already exist in project.nucleo files
 *   3. Export via the existing pipeline (scripts/index.js or dist/index.bundle.js)
 *   4. Git: checkout branch → commit (conventional) → push (consolidates all pipelines)
 *   5. Print a machine-readable JSON result to stdout and cleanup
 *
 * Usage:
 *   node scripts/workflow.js --icon "Lock Shield" --theme-path /path/to/klara-theme
 *   node scripts/workflow.js --icon "Lock Shield" --duotone "Love Swan" --illustration "Armed Jeep" --theme-path /path
 *   node scripts/workflow.js --duotone "Heart" --duotone "Star" --theme-path /path
 *
 * Flags:
 *   --icon "Icon Name"                        Repeatable, optional (at least one pipeline required)
 *   --duotone "Duotone Name"                  Repeatable, optional
 *   --illustration "Illustration Name"        Repeatable, optional
 *   --theme-path <path>                       Required (target klara-theme directory)
 *   --branch-id <id>                          Optional; defaults to current timestamp
 *   --skip-git                                Skip git operations (useful for dry-runs)
 *   --skip-cleanup                            Keep TEMP_ROOT after run; silently ignored with --red-bull
 *   --git-name <name>                         Override git author name
 *   --git-email <email>                       Override git author email
 *   --red-bull                                Operate directly on real repos (no temp dirs).
 *                                             Requires PROJECT_ROOT (.env) to be set.
 *                                             Repos must be on 'master' with a clean tree.
 *   --klara-theme-root <path>                 Pre-cloned klara_theme directory (skips fresh clone).
 *
 * Exit codes:
 *   0  — success (some icons may be in alreadyDone, that is not a failure)
 *   1  — fatal error (clone failed, validation failed, export failed, etc.)
 *
 * Output:
 *   Final JSON is written to stdout as a single line after all log output.
 *   All progress messages go to stderr so stdout stays machine-readable.
 *
 *   {
 *     "status": "success" | "partial" | "failed",
 *     "prUrl": "https://bitbucket.org/...",
 *     "branchName": "feature/export-icons-{ID}",
 *     "luzNextPrUrl": "...",
 *     "luzNextBranchName": "...",
 *     "klaraThemePrUrl": "...",
 *     "klaraThemeBranchName": "...",
 *     "pipelines": {
 *       "icon":         { "exported": ["Icon Name"], "alreadyDone": ["Other Icon"], "failed": [] },
 *       "duotone":      { "exported": [], "alreadyDone": [], "failed": [] },
 *       "illustration": { "exported": [], "alreadyDone": [], "failed": [] }
 *     },
 *     "diff": "--- a/icons-map.scss\n+++ b/icons-map.scss\n...",
 *     "error": null
 *   }
 */
'use strict';

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { spawn } = require('child_process');

// dotenv — resolve relative to project root (works in both source and bundle mode)
const isBundle = path.basename(process.argv[1]).endsWith('.bundle.js');
const projectRoot = isBundle
  ? path.join(path.dirname(process.argv[1]), '..')   // dist/../ = repo root
  : path.join(__dirname, '..');                       // scripts/../ = repo root
require('dotenv').config({ path: path.join(projectRoot, '.env') });

const simpleGit = require('simple-git');
const fg        = require('fast-glob');
const { createTwoFilesPatch } = require('diff');
const { getRemoteUrl, buildPrUrlFromRemote, gitCommitAndPush: sharedGitCommitAndPush } = require('./lib/git-deploy');

// ─── ANSI helpers (stderr only, never bleed into JSON stdout) ────────────────
const log = {
  info:    msg => process.stderr.write(`\x1b[36m[workflow]\x1b[0m ${msg}\n`),
  ok:      msg => process.stderr.write(`\x1b[32m[workflow]\x1b[0m ${msg}\n`),
  warn:    msg => process.stderr.write(`\x1b[33m[workflow]\x1b[0m ${msg}\n`),
  error:   msg => process.stderr.write(`\x1b[31m[workflow]\x1b[0m ${msg}\n`),
  section: msg => process.stderr.write(`\n\x1b[1m\x1b[36m══ ${msg} ══\x1b[0m\n`),
};

// ─── Constants ───────────────────────────────────────────────────────────────

// Some machines don't have the `bitbucket-nhut` SSH host alias configured
// (see ~/.ssh/config) and instead use the plain `bitbucket.org` host with a
// default/named identity key. Set USE_DIRECT_GIT_HOST=true in .env to switch
// to that direct-host form; leave unset/false to keep the original alias
// (normal machine config, matches SKILL.md).
const USE_DIRECT_GIT_HOST = process.env.USE_DIRECT_GIT_HOST === 'true';

const GIT_REPO_URL      = USE_DIRECT_GIT_HOST
  ? 'git@bitbucket.org:axonivy-prod/theme_icons.git'
  : 'git@bitbucket-nhut:axonivy-prod/theme_icons.git';
const PR_BASE_URL       = 'https://bitbucket.org/axonivy-prod/theme_icons/pull-requests/new';
// Remote for luz_next (target design-system repo) — cloned fresh each automated run.
const LUZ_NEXT_REPO_URL = USE_DIRECT_GIT_HOST
  ? 'git@bitbucket.org:axonivy-prod/luz_next.git'
  : 'git@bitbucket-nhut:axonivy-prod/luz_next.git';
// Relative path from luz_next root to the klara-theme package inside it.
const THEME_SUBPATH     = path.join('libs', 'klara-theme');

// Remote URL and local path for the legacy klara_theme Java EE project.
// KLARA_THEME_REPO_URL defaults to the known URL; set to empty in .env to skip.
const KLARA_THEME_REPO_URL = process.env.KLARA_THEME_REPO_URL !== undefined
  ? process.env.KLARA_THEME_REPO_URL
  : (USE_DIRECT_GIT_HOST
    ? 'git@bitbucket.org:axonivy-prod/klara_theme.git'
    : 'git@bitbucket-nhut:axonivy-prod/klara_theme.git');
// Path to the real klara_theme on disk — required only for --red-bull mode.
const KLARA_THEME_ROOT  = process.env.KLARA_THEME_ROOT || '';

// nc-projects folder UUIDs (Nucleo 22-char hex format) per pipeline type.
// These must exist as subdirectories in ${TEMP_ROOT}/nc-projects/.
const SET_UUIDS = {
  // icon pipeline: icon must be present in ALL 4
  icon: {
    required: [
      process.env.NUCLEO_UUID_GLYPH   || '0fb05cef24426bce2d2320',
      process.env.NUCLEO_UUID_REGULAR || 'c5edc7b0c2248ad45629e8',
      process.env.NUCLEO_UUID_BOLD    || 'f61d90dbcb9a7b09a5158d',
      process.env.NUCLEO_UUID_LIGHT   || '598ac87f28a1e4f80be691',
    ],
    matchAll: true,
  },
  // illustration pipeline: must be present in ANY of the illustration projects
  illustration: {
    required: [
      process.env.NUCLEO_UUID_ILLUSTRATIONS       || '56bdad0faf1a268721a5f4',
      process.env.NUCLEO_UUID_ILLUSTRATIONS_PART3 || 'b8eee6355fe83a71ddffaa',
    ],
    matchAll: false,
  },
  // duotone pipeline: must be present in the duotone project
  duotone: {
    required: [
      process.env.NUCLEO_UUID_ILLUSTRATIONS_DUOTONE || '44766eec0950b051163a46',
    ],
    matchAll: true,
  },
};

const VALID_PIPELINES = ['icon', 'duotone', 'illustration'];
const MAX_CLONE_RETRIES = 5;

// ─── NDJSON event emitter (--json-events mode) ────────────────────────────────
// `_jsonEvents` is set to true in parseArgs when --json-events flag is present.
// emit() writes to stdout; all log.* still go to stderr so they don't interfere.
let _jsonEvents = false;

function emit(obj) {
  if (_jsonEvents) process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitStage(id, status, label, detail) {
  emit({ type: 'stage', id, status, label, ...(detail !== undefined ? { detail } : {}) });
}

function emitLog(stage, line) {
  emit({ type: 'log', stage, line });
}

const PRIMARY_REPO = process.env.PROJECT_ROOT || '';   // fallback source for _Assets/my-sets/
const MY_SETS_SUBPATH = '_Assets/my-sets';

// ─── CLI Argument Parsing ─────────────────────────────────────────────────────

function parseArgs() {
  const argv  = process.argv.slice(2);
  const result = {
    icons:      [],
    duotones:   [],
    illustrations: [],
    themePath:  null,
    branchId:   String(Date.now()),
    skipGit:    false,
    skipCleanup: false,
    gitName:    null,
    gitEmail:   null,
    redBull:    false,
    jsonEvents: false,
    workRoot:       null,
    luzNextRoot:    null,
    klaraThemeRoot: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--icon': result.icons.push(next); i++; break;
      case '--duotone': result.duotones.push(next); i++; break;
      case '--illustration': result.illustrations.push(next); i++; break;
      case '--theme-path': case '-t': result.themePath = next; i++; break;
      case '--branch-id':  result.branchId  = next; i++; break;
      case '--skip-git':   result.skipGit   = true; break;
      case '--skip-cleanup': result.skipCleanup = true; break;
      case '--git-name':   result.gitName   = next; i++; break;
      case '--git-email':  result.gitEmail  = next; i++; break;
      case '--red-bull':   result.redBull   = true; break;
      case '--json-events': result.jsonEvents = true; break;
      // Pre-cloned mode: repos are already on disk (e.g. cloned by the bridge
      // server's /api/workflow/prepare session). workflow.js then skips its
      // own clone step and operates directly on these paths.
      case '--work-root':        result.workRoot       = next; i++; break;
      case '--luz-next-root':    result.luzNextRoot    = next; i++; break;
      case '--klara-theme-root': result.klaraThemeRoot = next; i++; break;
      default:
        // ignore unknown flags
        break;
    }
  }

  return result;
}

function validateArgs(args) {
  const errors = [];
  
  // At least one pipeline must have at least one icon name
  if (args.icons.length === 0 && args.duotones.length === 0 && args.illustrations.length === 0) {
    errors.push(
      'At least one --icon, --duotone, or --illustration is required'
    );
  }
  
  // --theme-path is required unless --json-events (auto-clones luz_next) or
  // --luz-next-root (pre-cloned mode; themePath is derived from it) is set.
  if (!args.themePath && !args.jsonEvents && !args.luzNextRoot) {
    errors.push('--theme-path is required (or use --json-events / --luz-next-root for automated mode)');
  }

  if (args.workRoot && !fs.existsSync(args.workRoot)) {
    errors.push(`--work-root path does not exist: ${args.workRoot}`);
  }

  if (args.luzNextRoot && !fs.existsSync(args.luzNextRoot)) {
    errors.push(`--luz-next-root path does not exist: ${args.luzNextRoot}`);
  }

  if (args.klaraThemeRoot && !fs.existsSync(args.klaraThemeRoot)) {
    errors.push(`--klara-theme-root path does not exist: ${args.klaraThemeRoot}`);
  }

  if (args.redBull && !PRIMARY_REPO) {
    errors.push(
      '--red-bull requires PROJECT_ROOT to be set in .env ' +
      '(points to the real theme_icons repo on disk)'
    );
  }
  
  return errors;
}

// ─── Slug normalisation (mirrors SKILL.md convention) ────────────────────────

function toSlug(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

// ─── Name matching for project.nucleo ────────────────────────────────────────
// project.nucleo stores names like "lock-shield" (slug). We check both the
// original name and the slug variant.

function nameExistsInNucleo(nucleoPath, candidateName) {
  if (!fs.existsSync(nucleoPath)) return false;
  const raw  = fs.readFileSync(nucleoPath, 'utf8');
  const slug = toSlug(candidateName);
  const lc   = candidateName.toLowerCase();
  // Fast string-search before full JSON parse (avoids parse cost for large files).
  // We look for the slug or lowercased name inside the "name" field values.
  const slugPattern = `"name":"${slug}"`;
  const namePattern = `"name":"${lc}"`;
  if (raw.includes(slugPattern) || raw.includes(namePattern)) return true;
  // Full parse for exact match (handles mixed-case stored names).
  try {
    const obj = JSON.parse(raw);
    return (obj.icons || []).some(icon => {
      const stored = (icon.name || '').toLowerCase();
      return stored === lc || stored === slug;
    });
  } catch {
    return false;
  }
}

// ─── Physical Audit ───────────────────────────────────────────────────────────
/**
 * For each icon name in a pipeline, check whether it already exists in the
 * relevant project.nucleo files inside the work root.
 *
 * Returns { alreadyDone: string[], toExport: string[] }
 */
function auditPipeline(names, pipeline, workRoot) {
  const { required, matchAll } = SET_UUIDS[pipeline];
  const alreadyDone = [];
  const toExport    = [];

  for (const name of names) {
    const results = required.map(uuid => {
      const nucleoPath = path.join(workRoot, 'nc-projects', uuid, 'project.nucleo');
      return nameExistsInNucleo(nucleoPath, name);
    });

    const done = matchAll
      ? results.every(Boolean)        // icon: must be in ALL 4
      : results.some(Boolean);        // illustration: ANY of N

    if (done) {
      log.ok(`  ✓ "${name}" — already exported (SKIP)`);
      alreadyDone.push(name);
    } else {
      log.info(`  ✗ "${name}" — not found, will export`);
      toExport.push(name);
    }
  }

  log.info(`Audit complete: ${toExport.length} to export, ${alreadyDone.length} already done`);
  return { alreadyDone, toExport };
}

// ─── Clone ────────────────────────────────────────────────────────────────────

async function cloneRepo(tempRoot) {
  log.section('Phase 1 — Cleanroom Clone');
  log.info(`Target: ${tempRoot}`);

  for (let attempt = 1; attempt <= MAX_CLONE_RETRIES + 1; attempt++) {
    if (attempt > 1) log.warn(`Retrying clone (attempt ${attempt}/${MAX_CLONE_RETRIES + 1})...`);
    try {
      const git = simpleGit();
      await git.clone(GIT_REPO_URL, tempRoot, ['--quiet']);
      log.ok(`Clone successful on attempt ${attempt}`);
      return;
    } catch (err) {
      log.error(`Clone attempt ${attempt} failed: ${err.message}`);
      if (attempt > MAX_CLONE_RETRIES) {
        throw new Error(
          `Git clone failed after ${MAX_CLONE_RETRIES + 1} attempts. ` +
          'Check SSH key / network and retry.'
        );
      }
      // Remove partial clone directory before retrying
      if (fs.existsSync(tempRoot)) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

// ─── _Assets/my-sets/ verification & fallback copy ──────────────────────────

function verifyMySetsFallback(tempRoot) {
  const mySetsInClone = path.join(tempRoot, MY_SETS_SUBPATH);
  if (fs.existsSync(mySetsInClone)) {
    log.ok(`_Assets/my-sets/ found in clone`);
    return;
  }

  log.warn(`_Assets/my-sets/ missing in clone — attempting fallback copy from primary repo`);
  if (!PRIMARY_REPO) {
    throw new Error(
      '_Assets/my-sets/ is missing from the clone and PROJECT_ROOT is not set in .env. ' +
      'Cannot proceed without the source icon library.'
    );
  }
  const mySetsInPrimary = path.join(PRIMARY_REPO, MY_SETS_SUBPATH);
  if (!fs.existsSync(mySetsInPrimary)) {
    throw new Error(
      `_Assets/my-sets/ not found in clone (${mySetsInClone}) or primary repo ` +
      `(${mySetsInPrimary}). Please place the asset library at one of these locations.`
    );
  }
  fs.mkdirSync(path.dirname(mySetsInClone), { recursive: true });
  fs.cpSync(mySetsInPrimary, mySetsInClone, { recursive: true });
  log.ok(`Copied _Assets/my-sets/ from primary repo`);
}

// ─── Red-bull: direct-repo helpers ───────────────────────────────────────────

/**
 * Throw if the working tree in `repoRoot` has uncommitted changes.
 * `label` is used in the error message (e.g. 'theme_icons', 'luz_next').
 */
async function guardCleanTree(repoRoot, label) {
  const git    = simpleGit(repoRoot);
  const status = await git.status();
  if (status.files.length > 0) {
    const files = status.files.map(f => `  ${f.index}${f.working_dir} ${f.path}`).join('\n');
    throw new Error(
      `${label} has uncommitted changes. Stash or commit them before using --red-bull.\n${files}`
    );
  }
}

/**
 * Fetch origin and reset to origin/master in `repoRoot`.
 * Throws if the current branch is not 'master'.
 */
async function pullLatestMaster(repoRoot) {
  const git    = simpleGit(repoRoot);
  const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  if (branch !== 'master') {
    throw new Error(
      `${repoRoot} is on branch '${branch}', not 'master'. ` +
      'Please checkout master before using --red-bull.'
    );
  }
  log.info(`Fetching origin/master for ${path.basename(repoRoot)}…`);
  await git.fetch('origin');
  await git.reset(['--hard', 'origin/master']);
  log.ok(`Reset to origin/master`);
}

// ─── luz_next helpers ─────────────────────────────────────────────────────────

/**
 * Find the git root for any path (walks up via git rev-parse).
 * Returns null if the path is not inside a git repo.
 */
async function findGitRoot(dirPath) {
  try {
    return (await simpleGit(dirPath).revparse(['--show-toplevel'])).trim();
  } catch {
    return null;
  }
}

/**
 * Clone luz_next at latest master into a sibling directory.
 * Returns the path to the sibling clone root.
 */
async function cloneSiblingLuzNext(luzNextRoot, branchId) {
  log.section('Phase 1b — Clone sibling luz_next');

  const remoteUrl = await getRemoteUrl(luzNextRoot);
  if (!remoteUrl) {
    throw new Error(`Could not determine remote URL for ${luzNextRoot}`);
  }

  const siblingRoot = path.join(path.dirname(luzNextRoot), `temp_luz_next_${branchId}`);
  log.info(`Cloning ${remoteUrl} → ${siblingRoot}`);

  if (fs.existsSync(siblingRoot)) {
    fs.rmSync(siblingRoot, { recursive: true, force: true });
  }
  await simpleGit().clone(remoteUrl, siblingRoot, ['--quiet']);
  log.ok(`Sibling clone ready: ${siblingRoot}`);
  return siblingRoot;
}

/**
 * Mirror exported klara-theme files (fonts + SCSS map) from srcThemePath into
 * dstThemePath.
 */
function mirrorThemeFiles(srcThemePath, dstThemePath) {
  log.info(`Mirroring theme files → ${path.basename(dstThemePath)}`);

  // public/assets/fonts/
  const srcFonts = path.join(srcThemePath, 'public', 'assets', 'fonts');
  const dstFonts = path.join(dstThemePath, 'public', 'assets', 'fonts');
  if (fs.existsSync(srcFonts)) {
    fs.mkdirSync(dstFonts, { recursive: true });
    fs.cpSync(srcFonts, dstFonts, { recursive: true });
    log.ok('  public/assets/fonts/ mirrored');
  } else {
    log.warn(`  fonts source not found: ${srcFonts}`);
  }

  // src/lib/assets/fonts/ (second location written by export-icon.js)
  const srcLibFonts = path.join(srcThemePath, 'src', 'lib', 'assets', 'fonts');
  const dstLibFonts = path.join(dstThemePath, 'src', 'lib', 'assets', 'fonts');
  if (fs.existsSync(srcLibFonts)) {
    fs.mkdirSync(dstLibFonts, { recursive: true });
    fs.cpSync(srcLibFonts, dstLibFonts, { recursive: true });
    log.ok('  src/lib/assets/fonts/ mirrored');
  }

  // src/lib/assets/icons/*.svg (SVG sprites — duotone + illustration)
  const srcIconSvgs = path.join(srcThemePath, 'src', 'lib', 'assets', 'icons');
  const dstIconSvgs = path.join(dstThemePath, 'src', 'lib', 'assets', 'icons');
  if (fs.existsSync(srcIconSvgs)) {
    fs.mkdirSync(dstIconSvgs, { recursive: true });
    const svgFiles = fs.readdirSync(srcIconSvgs).filter(f => f.endsWith('.svg'));
    for (const fname of svgFiles) {
      fs.copyFileSync(path.join(srcIconSvgs, fname), path.join(dstIconSvgs, fname));
    }
    if (svgFiles.length > 0) log.ok(`  src/lib/assets/icons/ mirrored (${svgFiles.length} SVG(s))`);
  }

  // src/lib/styles/core/icons/_icons-map.scss
  const scssRelPaths = [
    path.join('src', 'lib', 'styles', 'core', 'icons', '_icons-map.scss'),
    path.join('src', 'styles', 'core', 'icons', '_icons-map.scss'),
  ];
  for (const rel of scssRelPaths) {
    const src = path.join(srcThemePath, rel);
    const dst = path.join(dstThemePath, rel);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      log.ok('  _icons-map.scss mirrored');
      break;
    }
  }
}

// ─── klara_theme mirror ───────────────────────────────────────────────────────

/**
 * Extract all icon name→code pairs from a SCSS map (any variable name).
 * @returns {Map<string, string>}
 */
function extractScssIconEntries(content) {
  const entries = new Map();
  const re = /'([^']+)':\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    entries.set(m[1], m[2]);
  }
  return entries;
}

/**
 * Additive merge: copy new icon entries from srcPath ($streamline-icons in
 * luz_next) into dstPath ($icons in klara_theme). Existing entries in dst are
 * preserved; new ones are appended before the closing ); using the 4-space
 * indent style used in klara_theme's _icons.scss.
 */
function mergeIconsToKlaraTheme(srcPath, dstPath) {
  if (!fs.existsSync(srcPath)) { log.warn(`  SCSS source not found: ${srcPath}`); return; }
  if (!fs.existsSync(dstPath)) { log.warn(`  SCSS target not found: ${dstPath}`); return; }

  const srcContent = fs.readFileSync(srcPath, 'utf8');
  const dstContent = fs.readFileSync(dstPath, 'utf8');

  const srcEntries = extractScssIconEntries(srcContent);
  const dstEntries = extractScssIconEntries(dstContent);

  const newLines = [];
  for (const [name, code] of srcEntries) {
    if (!dstEntries.has(name)) {
      newLines.push(`    '${name}': '${code}',`);
    }
  }

  if (newLines.length === 0) {
    log.ok('  _icons.scss: no new icons to merge');
    return;
  }

  const closingIdx = dstContent.lastIndexOf(');');
  if (closingIdx === -1) {
    log.warn('  _icons.scss: could not find closing ); — skipping merge');
    return;
  }

  const updated = dstContent.slice(0, closingIdx) + newLines.join('\n') + '\n' + dstContent.slice(closingIdx);
  fs.writeFileSync(dstPath, updated, 'utf8');
  log.ok(`  _icons.scss: ${newLines.length} new icon(s) merged`);
}

/**
 * Mirror exported icon assets from a luz_next/libs/klara-theme source into the
 * legacy klara_theme Java EE project:
 *   - Streamline font files  → webContent/layouts/klara-theme/fonts/
 *   - SVG sprites            → webContent/layouts/klara-theme/icons/
 *   - SCSS icons map (merge) → .../layout/icons-font/_icons.scss
 */
function mirrorToKlaraTheme(srcThemePath, klaraThemeRoot) {
  log.info(`Mirroring to klara_theme: ${path.basename(klaraThemeRoot)}`);

  // Font files — streamline-icons-* only (leaves Roboto etc. untouched)
  const srcFonts = path.join(srcThemePath, 'public', 'assets', 'fonts');
  const dstFonts = path.join(klaraThemeRoot, 'webContent', 'layouts', 'klara-theme', 'fonts');
  if (fs.existsSync(srcFonts) && fs.existsSync(dstFonts)) {
    const fontFiles = fs.readdirSync(srcFonts).filter(f => f.startsWith('streamline-icons-'));
    for (const fname of fontFiles) {
      fs.copyFileSync(path.join(srcFonts, fname), path.join(dstFonts, fname));
    }
    log.ok(`  fonts: ${fontFiles.length} streamline font file(s) copied`);
  } else {
    if (!fs.existsSync(srcFonts)) log.warn(`  font source not found: ${srcFonts}`);
    if (!fs.existsSync(dstFonts)) log.warn(`  font target not found: ${dstFonts}`);
  }

  // SCSS icons map — additive merge ($streamline-icons in luz_next → $icons in klara_theme)
  const srcIconsMap = path.join(
    srcThemePath, 'src', 'lib', 'styles', 'core', 'icons', '_icons-map.scss'
  );
  const dstIconsScss = path.join(
    klaraThemeRoot, 'webContent', 'layouts', 'klara-theme',
    'styles', 'sass', 'layout', 'icons-font', '_icons.scss'
  );
  mergeIconsToKlaraTheme(srcIconsMap, dstIconsScss);

  // SVG sprites — streamline-*.svg only
  const srcIconSvgs = path.join(srcThemePath, 'src', 'lib', 'assets', 'icons');
  const dstIconSvgs = path.join(klaraThemeRoot, 'webContent', 'layouts', 'klara-theme', 'icons');
  if (fs.existsSync(srcIconSvgs) && fs.existsSync(dstIconSvgs)) {
    const svgFiles = fs.readdirSync(srcIconSvgs)
      .filter(f => f.startsWith('streamline-') && f.endsWith('.svg'));
    for (const fname of svgFiles) {
      fs.copyFileSync(path.join(srcIconSvgs, fname), path.join(dstIconSvgs, fname));
    }
    log.ok(`  icons: ${svgFiles.length} SVG sprite(s) copied`);
  } else {
    if (!fs.existsSync(srcIconSvgs)) log.warn(`  SVG source not found: ${srcIconSvgs}`);
    if (!fs.existsSync(dstIconSvgs)) log.warn(`  SVG target not found: ${dstIconSvgs}`);
  }
}

// ─── Shared git commit+push ───────────────────────────────────────────────────

/**
 * Thin wrapper over lib/git-deploy.js's shared gitCommitAndPush: resolves git
 * author, checks out a fresh branch, commits all staged changes, pushes, and
 * returns { branchName, prUrl }. Returns null if there is nothing to commit.
 *
 * @param {string}   repoRoot
 * @param {string}   branchId
 * @param {string[]} names        – icon names for commit message
 * @param {string}   pipeline     – 'icon' | 'duotone' | 'illustration'
 * @param {string|null} gitName
 * @param {string|null} gitEmail
 */
async function gitCommitAndPush(repoRoot, branchId, names, pipeline, gitName, gitEmail) {
  return sharedGitCommitAndPush(
    repoRoot, branchId, names, pipeline, gitName, gitEmail,
    PRIMARY_REPO || repoRoot,
    msg => log.info(msg),
  );
}

// ─── Export pipeline ──────────────────────────────────────────────────────────
/**
 * Resolves the entry point to spawn. In bundle mode we call the sibling
 * index.bundle.js with --script; in source mode we call scripts/index.js with
 * --pipeline.
 */
function resolveEntryPoint() {
  if (isBundle) {
    const bundleDir  = path.dirname(process.argv[1]);
    const indexBundle = path.join(bundleDir, 'index.bundle.js');
    if (!fs.existsSync(indexBundle)) {
      throw new Error(`Expected ${indexBundle} alongside workflow.bundle.js but it was not found.`);
    }
    return { script: indexBundle, isBundle: true };
  }
  return { script: path.join(projectRoot, 'scripts', 'index.js'), isBundle: false };
}

async function runExport(pipeline, names, themePath, tempRoot) {
  log.section('Phase 3 — Export');

  const { script, isBundle: bundleMode } = resolveEntryPoint();

  // Build argv
  const args = bundleMode
    ? ['--script', `export-${pipeline}`]   // bundle: --script export-icon
    : ['--pipeline', pipeline];             // source: --pipeline icon

  for (const n of names) {
    args.push('--name', n);
  }
  args.push(
    '--auto-export',
    '--auto-copy',
    '--theme-path', themePath,
    '--project-root', tempRoot,
  );

  log.info(`Spawning: node ${path.basename(script)} ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    // In --json-events mode capture stdout+stderr so we can relay them as
    // NDJSON log events rather than letting them bleed into the machine-readable
    // stdout stream.
    const stdioMode = _jsonEvents
      ? ['inherit', 'pipe', 'pipe']
      : ['inherit', 'inherit', 'inherit'];
    const child = spawn(process.execPath, [script, ...args], {
      stdio: stdioMode,
      env: { ...process.env, PROJECT_ROOT: tempRoot },
    });
    if (_jsonEvents) {
      const stageId = `export-${pipeline}`;
      if (child.stdout) child.stdout.on('data', chunk => emitLog(stageId, chunk.toString()));
      if (child.stderr) child.stderr.on('data', chunk => emitLog(stageId, chunk.toString()));
    }
    child.on('close', code => {
      if (code === 0) {
        log.ok('Export pipeline finished successfully');
        resolve();
      } else {
        reject(new Error(`Export pipeline exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

// ─── Read SCSS map for diff ───────────────────────────────────────────────────

function readIconsMapScss(themePath) {
  const candidates = [
    path.join(themePath, 'src', 'lib', 'styles', 'core', 'icons', '_icons-map.scss'),
    path.join(themePath, 'src', 'styles', 'core', 'icons', '_icons-map.scss'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return { filePath: p, content: fs.readFileSync(p, 'utf8') };
  }
  return null;
}

// ─── Git operations ───────────────────────────────────────────────────────────

/** Thin wrapper for the theme_icons temp-clone path. */
async function gitSync(tempRoot, branchId, names, pipeline, gitName, gitEmail) {
  log.section('Phase 4 — Git Sync (theme_icons)');
  return gitCommitAndPush(tempRoot, branchId, names, pipeline, gitName, gitEmail);
}

/**
 * luz_next sibling-clone path: clone → mirror → commit+push.
 * Returns { branchName, prUrl } or null if nothing changed.
 */
async function gitSyncLuzNext(luzNextRoot, branchId, themePath, names, pipeline, gitName, gitEmail) {
  log.section('Phase 4b — Git Sync (luz_next sibling)');

  const siblingRoot = await cloneSiblingLuzNext(luzNextRoot, branchId);

  const relThemePath    = path.relative(luzNextRoot, themePath);
  const siblingThemePath = path.join(siblingRoot, relThemePath);
  mirrorThemeFiles(themePath, siblingThemePath);

  const result = await gitCommitAndPush(siblingRoot, branchId, names, pipeline, gitName, gitEmail);
  return { siblingRoot, result };
}



// ─── Build export task list ───────────────────────────────────────────────────

/**
 * Convert parsed args (with icons/duotones/illustrations arrays) into a list
 * of export tasks. Each task represents one pipeline + its icon names.
 *
 * Filters out empty pipelines.
 *
 * @returns {Array<{pipeline: string, names: string[]}>}
 */
function buildExportTasks(args) {
  const tasks = [];
  if (args.icons.length > 0) {
    tasks.push({ pipeline: 'icon', names: args.icons });
  }
  if (args.duotones.length > 0) {
    tasks.push({ pipeline: 'duotone', names: args.duotones });
  }
  if (args.illustrations.length > 0) {
    tasks.push({ pipeline: 'illustration', names: args.illustrations });
  }
  return tasks;
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

function cleanup(tempRoot) {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    log.ok(`Cleaned up temp directory: ${tempRoot}`);
  } catch (err) {
    log.warn(`Could not remove temp directory: ${err.message}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args   = parseArgs();
  // Enable NDJSON events on stdout when --json-events is set.
  _jsonEvents = args.jsonEvents;
  const errors = validateArgs(args);

  if (errors.length) {
    for (const e of errors) log.error(e);
    log.error('\nUsage: node workflow.js --icon "Name" --duotone "Name" --illustration "Name" --theme-path /path');
    process.exit(1);
  }

  // Result scaffold — mutated as we progress
  const result = {
    status:            'failed',
    prUrl:             null,
    branchName:        null,
    luzNextPrUrl:       null,
    luzNextBranchName:  null,
    klaraThemePrUrl:    null,
    klaraThemeBranchName: null,
    pipelines: {
      icon:         { exported: [], alreadyDone: [], failed: [] },
      duotone:      { exported: [], alreadyDone: [], failed: [] },
      illustration: { exported: [], alreadyDone: [], failed: [] },
    },
    diff:              null,
    error:             null,
  };

  // In red-bull mode we operate on the real repos in-place (no temp dirs).
  // In pre-cloned mode (--work-root) the caller already cloned theme_icons —
  // typically the bridge server's /api/workflow/prepare session — so we skip
  // our own clone step entirely and operate on that path directly.
  // Otherwise (normal mode) we clone theme_icons to a temp dir ourselves.
  const preCloned = Boolean(args.workRoot);
  const tempRoot  = path.join(os.tmpdir(), `theme_icons_${args.branchId}`);
  const workRoot  = args.redBull ? PRIMARY_REPO : (args.workRoot || tempRoot);
  let siblingLuzNext    = null;  // sibling clone path (normal mode only), for cleanup
  let luzNextTempRoot   = null;  // set when --json-events auto-clones luz_next fresh
  let siblingKlaraTheme = null;  // sibling clone path (normal mode only), for cleanup
  let scssBeforeInfo    = null;

  // Resolve luz_next root + themePath, in priority order:
  //   1. --luz-next-root (pre-cloned mode; themePath derived from it)
  //   2. --json-events with no --theme-path (clone luz_next fresh ourselves)
  //   3. --theme-path (find its git root for Phase 4b)
  let luzNextRoot;
  if (args.luzNextRoot) {
    luzNextRoot = args.luzNextRoot;
    if (!args.themePath) args.themePath = path.join(luzNextRoot, THEME_SUBPATH);
    log.info(`luz_next root (pre-cloned): ${luzNextRoot}`);
  } else if (args.jsonEvents && !args.themePath) {
    luzNextTempRoot = path.join(os.tmpdir(), `luz_next_${args.branchId}`);
    emitStage('clone-luz-next', 'start', 'Cloning luz_next');
    try {
      log.section('Phase 1b — Clone luz_next');
      log.info(`Cloning ${LUZ_NEXT_REPO_URL} → ${luzNextTempRoot}`);
      if (fs.existsSync(luzNextTempRoot)) fs.rmSync(luzNextTempRoot, { recursive: true, force: true });
      await simpleGit().clone(LUZ_NEXT_REPO_URL, luzNextTempRoot, ['--quiet']);
      args.themePath = path.join(luzNextTempRoot, THEME_SUBPATH);
      luzNextRoot = luzNextTempRoot;
      log.ok(`luz_next ready: ${luzNextTempRoot}`);
      emitStage('clone-luz-next', 'ok', 'Cloning luz_next');
    } catch (err) {
      emitStage('clone-luz-next', 'error', 'Cloning luz_next', err.message);
      throw err;
    }
  } else {
    // Resolve the luz_next repo root from --theme-path for Phase 4b.
    luzNextRoot = await findGitRoot(args.themePath);
    if (!luzNextRoot) {
      log.warn(`--theme-path (${args.themePath}) is not inside a git repo — luz_next PR will be skipped`);
    } else {
      log.info(`luz_next root: ${luzNextRoot}`);
    }
  }

  // ── klara_theme resolution ─────────────────────────────────────────────────
  // Priority: --klara-theme-root (pre-cloned) → KLARA_THEME_ROOT + --red-bull → clone fresh.
  let klaraThemeRoot = null;
  if (args.klaraThemeRoot) {
    klaraThemeRoot = args.klaraThemeRoot;
    log.info(`klara_theme root (pre-cloned): ${klaraThemeRoot}`);
  } else if (args.redBull) {
    if (KLARA_THEME_ROOT) {
      klaraThemeRoot = KLARA_THEME_ROOT;
      log.info(`klara_theme root (red-bull): ${klaraThemeRoot}`);
    } else {
      log.warn('KLARA_THEME_ROOT not set in .env — klara_theme deploy skipped for --red-bull');
    }
  }
  // Normal mode: klaraThemeRoot stays null; Phase 4c clones from KLARA_THEME_REPO_URL.

  // Build list of export tasks (filters out empty pipelines)
  const exportTasks = buildExportTasks(args);
  const allExportedNames = [];  // accumulate all exported names across all pipelines

  try {
    // ── Phase 1 ───────────────────────────────────────────────────────────
    if (preCloned) {
      log.section(`Phase 1 — Using pre-cloned workspace (${path.basename(workRoot)})`);
      verifyMySetsFallback(workRoot);
    } else if (args.redBull) {
      log.section(`Phase 1 — Pull Latest (--red-bull | ${path.basename(workRoot)})`);
      await guardCleanTree(workRoot, 'theme_icons');
      await pullLatestMaster(workRoot);
      verifyMySetsFallback(workRoot);

      // Also pull luz_next BEFORE the export writes files into it, so the
      // reset --hard doesn't wipe our changes.
      if (!args.skipGit && luzNextRoot) {
        log.section(`Phase 1b — Pull Latest (--red-bull | ${path.basename(luzNextRoot)})`);
        await guardCleanTree(luzNextRoot, 'luz_next');
        await pullLatestMaster(luzNextRoot);
      }
      if (!args.skipGit && klaraThemeRoot) {
        log.section(`Phase 1c — Pull Latest (--red-bull | ${path.basename(klaraThemeRoot)})`);
        await guardCleanTree(klaraThemeRoot, 'klara_theme');
        await pullLatestMaster(klaraThemeRoot);
      }
    } else {
      emitStage('clone-theme-icons', 'start', 'Cloning theme_icons');
      try {
        await cloneRepo(tempRoot);
        verifyMySetsFallback(tempRoot);
        emitStage('clone-theme-icons', 'ok', 'Cloning theme_icons');
      } catch (err) {
        emitStage('clone-theme-icons', 'error', 'Cloning theme_icons', err.message);
        throw err;
      }
    }

    // ── Pre-export: snapshot SCSS map for diff ────────────────────────────
    scssBeforeInfo = readIconsMapScss(args.themePath);

    // ── Loop: Audit + Export for each pipeline ────────────────────────────
    for (const task of exportTasks) {
      log.section(`Pipeline: ${task.pipeline}`);

      // Phase 2: Physical Audit
      log.section(`Phase 2 — Physical Audit (${task.pipeline})`);
      emitStage(`audit-${task.pipeline}`, 'start', `Auditing ${task.pipeline}`);
      const { alreadyDone, toExport } = auditPipeline(task.names, task.pipeline, workRoot);
      result.pipelines[task.pipeline].alreadyDone = alreadyDone;
      emitStage(`audit-${task.pipeline}`, 'ok', `Auditing ${task.pipeline}`,
        `${toExport.length} to export, ${alreadyDone.length} already done`);

      if (toExport.length === 0) {
        log.ok(`All ${task.pipeline} icons already exported — skip`);
        continue;
      }

      // Phase 3: Export
      emitStage(`export-${task.pipeline}`, 'start', `Exporting ${task.pipeline}`);
      try {
        await runExport(task.pipeline, toExport, args.themePath, workRoot);
        result.pipelines[task.pipeline].exported = toExport;
        allExportedNames.push(...toExport);
        emitStage(`export-${task.pipeline}`, 'ok', `Exporting ${task.pipeline}`);
      } catch (err) {
        log.error(`Export failed: ${err.message}`);
        result.pipelines[task.pipeline].failed = toExport;
        if (!result.error) result.error = err.message;
        emitStage(`export-${task.pipeline}`, 'error', `Exporting ${task.pipeline}`, err.message);
        // Continue to next pipeline — don't abort everything
      }
    }

    // ── Post-export: compute SCSS diff ────────────────────────────────────
    if (scssBeforeInfo) {
      const after = fs.existsSync(scssBeforeInfo.filePath)
        ? fs.readFileSync(scssBeforeInfo.filePath, 'utf8')
        : '';
      if (after !== scssBeforeInfo.content) {
        result.diff = createTwoFilesPatch(
          '_icons-map.scss (before)',
          '_icons-map.scss (after)',
          scssBeforeInfo.content,
          after
        );
      }
    }

    // Check if we have anything to commit
    if (allExportedNames.length === 0) {
      log.ok('All icons already exported — nothing to do.');
      result.status = 'success';
      if (args.jsonEvents) {
        emit({ type: 'result', result });
      } else {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      }
      if (!args.skipCleanup && !args.redBull) {
        cleanup(tempRoot);
        if (luzNextTempRoot) cleanup(luzNextTempRoot);
      }
      return;
    }

    // ── Phase 4: Git (theme_icons) ────────────────────────────────────────
    if (!args.skipGit) {
      log.section('Phase 4 — Git Sync (theme_icons)');
      emitStage('commit-theme-icons', 'start', 'Committing theme_icons');
      // For commit message, we need to summarize all exported items
      // We'll use allExportedNames which is the concatenation of all pipelines
      const syncResult = await gitCommitAndPush(
        workRoot,
        args.branchId,
        allExportedNames,
        'icon',  // Use 'icon' as the category for commit message purposes
        args.gitName,
        args.gitEmail,
      );
      if (syncResult) {
        result.branchName = syncResult.branchName;
        result.prUrl      = syncResult.prUrl;
        emitStage('commit-theme-icons', 'ok', 'Committing theme_icons', syncResult.branchName);
      } else {
        emitStage('commit-theme-icons', 'ok', 'Committing theme_icons', 'Nothing to commit');
      }
    }

    // ── Phase 4b: Git (luz_next) ──────────────────────────────────────────
    if (!args.skipGit && luzNextRoot) {
      if (luzNextTempRoot || args.luzNextRoot) {
        // Direct-commit mode: luz_next was already cloned (either freshly by
        // --json-events Phase 1b, or pre-cloned via --luz-next-root). The
        // export pipeline deployed files directly there — just commit+push.
        log.section('Phase 4b — Git Sync (luz_next direct)');
        emitStage('commit-luz-next', 'start', 'Committing luz_next');
        const lnResult = await gitCommitAndPush(
          luzNextTempRoot || luzNextRoot,
          args.branchId,
          allExportedNames,
          'icon',
          args.gitName,
          args.gitEmail,
        );
        if (lnResult) {
          result.luzNextBranchName = lnResult.branchName;
          result.luzNextPrUrl      = lnResult.prUrl;
          emitStage('commit-luz-next', 'ok', 'Committing luz_next', lnResult.branchName);
        } else {
          emitStage('commit-luz-next', 'ok', 'Committing luz_next', 'Nothing to commit');
        }
      } else if (args.redBull) {
        // The real luz_next was already pulled in Phase 1b (before the export
        // ran), so our changes are already on disk. Just commit+push.
        log.section(`Phase 4b — Commit (--red-bull | ${path.basename(luzNextRoot)})`);
        emitStage('commit-luz-next', 'start', 'Committing luz_next');
        const lnResult = await gitCommitAndPush(
          luzNextRoot,
          args.branchId,
          allExportedNames,
          'icon',  // Use 'icon' for commit message purposes
          args.gitName,
          args.gitEmail,
        );
        if (lnResult) {
          result.luzNextBranchName = lnResult.branchName;
          result.luzNextPrUrl      = lnResult.prUrl;
          emitStage('commit-luz-next', 'ok', 'Committing luz_next', lnResult.branchName);
        } else {
          emitStage('commit-luz-next', 'ok', 'Committing luz_next', 'Nothing to commit');
        }
      } else {
        // Clone a sibling temp repo, mirror files, commit+push there.
        log.section('Phase 4b — Git Sync (luz_next sibling)');
        emitStage('commit-luz-next', 'start', 'Committing luz_next');
        const siblingRoot = await cloneSiblingLuzNext(luzNextRoot, args.branchId);

        const relThemePath    = path.relative(luzNextRoot, args.themePath);
        const siblingThemePath = path.join(siblingRoot, relThemePath);
        mirrorThemeFiles(args.themePath, siblingThemePath);

        const lnResult = await gitCommitAndPush(
          siblingRoot,
          args.branchId,
          allExportedNames,
          'icon',  // Use 'icon' for commit message purposes
          args.gitName,
          args.gitEmail,
        );
        siblingLuzNext = siblingRoot;
        if (lnResult) {
          result.luzNextBranchName = lnResult.branchName;
          result.luzNextPrUrl      = lnResult.prUrl;
          emitStage('commit-luz-next', 'ok', 'Committing luz_next', lnResult.branchName);
        } else {
          emitStage('commit-luz-next', 'ok', 'Committing luz_next', 'Nothing to commit');
        }
      }
    }

    result.status = Object.values(result.pipelines).some(p => p.failed.length > 0) ? 'partial' : 'success';

    // ── Phase 4c: Git (klara_theme) ───────────────────────────────────────────
    // Red-bull without KLARA_THEME_ROOT: already warned during resolution — skip.
    if (!args.skipGit && !(args.redBull && !klaraThemeRoot)) {
      let ktRoot = klaraThemeRoot;  // null in normal mode
      log.section('Phase 4c — Git Sync (klara_theme)');
      emitStage('commit-klara-theme', 'start', 'Committing klara_theme');

      // Normal mode: clone klara_theme fresh, then mirror into it.
      if (!ktRoot) {
        const cloneDir = path.join(os.tmpdir(), `klara_theme_${args.branchId}`);
        if (fs.existsSync(cloneDir)) fs.rmSync(cloneDir, { recursive: true, force: true });
        log.info(`Cloning ${KLARA_THEME_REPO_URL} → ${cloneDir}`);
        await simpleGit().clone(KLARA_THEME_REPO_URL, cloneDir, ['--quiet']);
        log.ok(`klara_theme clone ready: ${cloneDir}`);
        ktRoot = cloneDir;
        siblingKlaraTheme = cloneDir;
      }

      mirrorToKlaraTheme(args.themePath, ktRoot);
      const ktResult = await gitCommitAndPush(
        ktRoot, args.branchId, allExportedNames, 'icon', args.gitName, args.gitEmail,
      );
      if (ktResult) {
        result.klaraThemeBranchName = ktResult.branchName;
        result.klaraThemePrUrl      = ktResult.prUrl;
        emitStage('commit-klara-theme', 'ok', 'Committing klara_theme', ktResult.branchName);
      } else {
        emitStage('commit-klara-theme', 'ok', 'Committing klara_theme', 'Nothing to commit');
      }
    }

    // ── Red-bull cleanup: checkout master on both repos ───────────────────
    if (args.redBull && !args.skipGit) {
      log.section('Phase 5 — Checkout master (--red-bull cleanup)');
      try {
        await simpleGit(workRoot).checkout('master');
        log.ok(`${path.basename(workRoot)} → master`);
      } catch (err) {
        log.warn(`Could not checkout master in ${path.basename(workRoot)}: ${err.message}`);
      }
      if (luzNextRoot) {
        try {
          await simpleGit(luzNextRoot).checkout('master');
          log.ok(`${path.basename(luzNextRoot)} → master`);
        } catch (err) {
          log.warn(`Could not checkout master in ${path.basename(luzNextRoot)}: ${err.message}`);
        }
      }
      if (klaraThemeRoot) {
        try {
          await simpleGit(klaraThemeRoot).checkout('master');
          log.ok(`${path.basename(klaraThemeRoot)} → master`);
        } catch (err) {
          log.warn(`Could not checkout master in ${path.basename(klaraThemeRoot)}: ${err.message}`);
        }
      }
    }

  } catch (err) {
    log.error(`Fatal: ${err.message}`);
    result.error  = err.message;
    result.status = 'failed';
  } finally {
    // Emit final result (NDJSON event or legacy plain JSON)
    if (args.jsonEvents) {
      emitStage('cleanup', 'start', 'Cleaning up');
      if (!args.skipCleanup && !args.redBull) {
        cleanup(tempRoot);
        if (siblingLuzNext) cleanup(siblingLuzNext);
        if (luzNextTempRoot) cleanup(luzNextTempRoot);
        if (siblingKlaraTheme) cleanup(siblingKlaraTheme);
      }
      emitStage('cleanup', 'ok', 'Cleaning up');
      emit({ type: 'result', result });
    } else {
      // Always emit JSON to stdout — agent parses this
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (!args.skipCleanup && !args.redBull) {
        cleanup(tempRoot);
        if (siblingLuzNext) cleanup(siblingLuzNext);
        if (siblingKlaraTheme) cleanup(siblingKlaraTheme);
      }
    }
  }
}

main().catch(err => {
  process.stderr.write(`\x1b[31m[workflow] Unhandled error: ${err.message}\x1b[0m\n`);
  process.exit(1);
});

