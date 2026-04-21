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

// ─── ANSI helpers (stderr only, never bleed into JSON stdout) ────────────────
const log = {
  info:    msg => process.stderr.write(`\x1b[36m[workflow]\x1b[0m ${msg}\n`),
  ok:      msg => process.stderr.write(`\x1b[32m[workflow]\x1b[0m ${msg}\n`),
  warn:    msg => process.stderr.write(`\x1b[33m[workflow]\x1b[0m ${msg}\n`),
  error:   msg => process.stderr.write(`\x1b[31m[workflow]\x1b[0m ${msg}\n`),
  section: msg => process.stderr.write(`\n\x1b[1m\x1b[36m══ ${msg} ══\x1b[0m\n`),
};

// ─── Constants ───────────────────────────────────────────────────────────────

const GIT_REPO_URL = 'git@bitbucket-nhut:axonivy-prod/theme_icons.git';
const PR_BASE_URL  = 'https://bitbucket.org/axonivy-prod/theme_icons/pull-requests/new';

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
  
  if (!args.themePath) {
    errors.push('--theme-path is required');
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

/** Return the 'origin' remote URL for a local repo root, or null on failure. */
async function getRemoteUrl(repoRoot) {
  try {
    return (await simpleGit(repoRoot).remote(['get-url', 'origin'])).trim();
  } catch {
    return null;
  }
}

/**
 * Convert a git remote URL into a "create PR" link for Bitbucket or GitHub.
 * Returns null if the URL format is not recognised.
 */
function buildPrUrlFromRemote(remoteUrl, branchName) {
  if (!remoteUrl) return null;
  const enc = encodeURIComponent(branchName);

  const bb = remoteUrl.match(/bitbucket\.org[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (bb) {
    return `https://bitbucket.org/${bb[1]}/${bb[2]}/pull-requests/new?source=${enc}&t=1`;
  }
  const gh = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (gh) {
    return `https://github.com/${gh[1]}/${gh[2]}/compare/${enc}`;
  }
  return null;
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

  const srcFonts = path.join(srcThemePath, 'public', 'assets', 'fonts');
  const dstFonts = path.join(dstThemePath, 'public', 'assets', 'fonts');
  if (fs.existsSync(srcFonts)) {
    fs.mkdirSync(dstFonts, { recursive: true });
    fs.cpSync(srcFonts, dstFonts, { recursive: true });
    log.ok('  fonts/ mirrored');
  } else {
    log.warn(`  fonts source not found: ${srcFonts}`);
  }

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

// ─── Shared git commit+push ───────────────────────────────────────────────────

/**
 * Shared core: resolve git author, checkout fresh branch, commit all staged
 * changes, push, and return { branchName, prUrl }.
 * Returns null if there is nothing to commit after `git add .`.
 *
 * @param {string}   repoRoot
 * @param {string}   branchId
 * @param {string[]} names        – icon names for commit message
 * @param {string}   pipeline     – 'icon' | 'duotone' | 'illustration'
 * @param {string|null} gitName
 * @param {string|null} gitEmail
 */
async function gitCommitAndPush(repoRoot, branchId, names, pipeline, gitName, gitEmail) {
  const git = simpleGit(repoRoot);

  // Author identity: flag → repo local → global → primary repo → error
  let name  = gitName;
  let email = gitEmail;

  if (!name || !email) {
    try {
      const cfg = await git.listConfig();
      const get = key => cfg.all[key] || cfg.all[`local.${key}`] || cfg.all[`global.${key}`] || null;
      name  = name  || get('user.name');
      email = email || get('user.email');
    } catch { /* ignore */ }
  }

  if (!name || !email) {
    try {
      name  = name  || (await simpleGit().raw(['config', '--global', 'user.name'])).trim();
      email = email || (await simpleGit().raw(['config', '--global', 'user.email'])).trim();
    } catch { /* ignore */ }
  }

  if (!name || !email) {
    try {
      const pgit = simpleGit(PRIMARY_REPO || repoRoot);
      name  = name  || (await pgit.raw(['config', 'user.name'])).trim();
      email = email || (await pgit.raw(['config', 'user.email'])).trim();
    } catch { /* ignore */ }
  }

  if (!name || !email) {
    throw new Error(
      'Git author identity not found. Pass --git-name and --git-email flags, ' +
      'or set global git config (git config --global user.name / user.email).'
    );
  }

  log.info(`Git author: ${name} <${email}>`);
  await git.addConfig('user.name',  name,  false, 'local');
  await git.addConfig('user.email', email, false, 'local');

  const branchName = `feature/export-icons-${branchId}`;
  await git.checkoutLocalBranch(branchName);
  log.ok(`On branch: ${branchName}`);

  await git.add('.');
  const status = await git.status();
  if (status.files.length === 0) {
    log.warn('Nothing to commit — skipping push');
    return null;
  }

  const count = names.length;
  const pipelineLabel = pipeline === 'icon'         ? 'icons'
    : pipeline === 'duotone'      ? 'duotones'
    : 'illustrations';

  await git.commit([
    `feat(${pipelineLabel}): export ${count} ${pipelineLabel.slice(0, -1)}${count > 1 ? 's' : ''}`,
    `${names.join(', ')}`,
    'Automated batch export.',
  ]);

  const lastLog = await git.log({ maxCount: 1 });
  log.ok(`Commit: ${lastLog.latest.hash.slice(0, 8)} — ${lastLog.latest.message.split('\n')[0]}`);

  await git.push('origin', branchName, ['--set-upstream']);
  log.ok(`Pushed ${branchName} to origin`);

  const remoteUrl = await getRemoteUrl(repoRoot);
  const prUrl     = buildPrUrlFromRemote(remoteUrl, branchName);
  return { branchName, prUrl };
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
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ['inherit', 'inherit', 'inherit'],
      env: { ...process.env, PROJECT_ROOT: tempRoot },
    });
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
    luzNextPrUrl:      null,
    luzNextBranchName: null,
    pipelines: {
      icon:         { exported: [], alreadyDone: [], failed: [] },
      duotone:      { exported: [], alreadyDone: [], failed: [] },
      illustration: { exported: [], alreadyDone: [], failed: [] },
    },
    diff:              null,
    error:             null,
  };

  // In red-bull mode we operate on the real repos in-place (no temp dirs).
  // In normal mode we clone theme_icons to a temp dir.
  const tempRoot  = path.join(os.tmpdir(), `theme_icons_${args.branchId}`);
  const workRoot  = args.redBull ? PRIMARY_REPO : tempRoot;
  let siblingLuzNext = null;   // sibling clone path (normal mode only), for cleanup
  let scssBeforeInfo = null;

  // Resolve the luz_next repo root from --theme-path for Phase 4b.
  const luzNextRoot = await findGitRoot(args.themePath);
  if (!luzNextRoot) {
    log.warn(`--theme-path (${args.themePath}) is not inside a git repo — luz_next PR will be skipped`);
  } else {
    log.info(`luz_next root: ${luzNextRoot}`);
  }

  // Build list of export tasks (filters out empty pipelines)
  const exportTasks = buildExportTasks(args);
  const allExportedNames = [];  // accumulate all exported names across all pipelines

  try {
    // ── Phase 1 ───────────────────────────────────────────────────────────
    if (args.redBull) {
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
    } else {
      await cloneRepo(tempRoot);
      verifyMySetsFallback(tempRoot);
    }

    // ── Pre-export: snapshot SCSS map for diff ────────────────────────────
    scssBeforeInfo = readIconsMapScss(args.themePath);

    // ── Loop: Audit + Export for each pipeline ────────────────────────────
    for (const task of exportTasks) {
      log.section(`Pipeline: ${task.pipeline}`);

      // Phase 2: Physical Audit
      log.section(`Phase 2 — Physical Audit (${task.pipeline})`);
      const { alreadyDone, toExport } = auditPipeline(task.names, task.pipeline, workRoot);
      result.pipelines[task.pipeline].alreadyDone = alreadyDone;

      if (toExport.length === 0) {
        log.ok(`All ${task.pipeline} icons already exported — skip`);
        continue;
      }

      // Phase 3: Export
      try {
        await runExport(task.pipeline, toExport, args.themePath, workRoot);
        result.pipelines[task.pipeline].exported = toExport;
        allExportedNames.push(...toExport);
      } catch (err) {
        log.error(`Export failed: ${err.message}`);
        result.pipelines[task.pipeline].failed = toExport;
        if (!result.error) result.error = err.message;
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
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (!args.skipCleanup && !args.redBull) cleanup(tempRoot);
      return;
    }

    // ── Phase 4: Git (theme_icons) ────────────────────────────────────────
    if (!args.skipGit) {
      log.section('Phase 4 — Git Sync (theme_icons)');
      
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
      }
    }

    // ── Phase 4b: Git (luz_next) ──────────────────────────────────────────
    if (!args.skipGit && luzNextRoot) {
      if (args.redBull) {
        // The real luz_next was already pulled in Phase 1b (before the export
        // ran), so our changes are already on disk. Just commit+push.
        log.section(`Phase 4b — Commit (--red-bull | ${path.basename(luzNextRoot)})`);
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
        }
      } else {
        // Clone a sibling temp repo, mirror files, commit+push there.
        log.section('Phase 4b — Git Sync (luz_next sibling)');
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
        }
      }
    }

    result.status = Object.values(result.pipelines).some(p => p.failed.length > 0) ? 'partial' : 'success';

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
    }

  } catch (err) {
    log.error(`Fatal: ${err.message}`);
    result.error  = err.message;
    result.status = 'failed';
  } finally {
    // Always emit JSON to stdout — agent parses this
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!args.skipCleanup && !args.redBull) {
      cleanup(tempRoot);
      if (siblingLuzNext) cleanup(siblingLuzNext);
    }
  }
}

main().catch(err => {
  process.stderr.write(`\x1b[31m[workflow] Unhandled error: ${err.message}\x1b[0m\n`);
  process.exit(1);
});

