#!/usr/bin/env node
/**
 * scripts/workflow.js  — Full-lifecycle icon export orchestrator
 *
 * Wraps the entire icon export workflow into a single command so an AI agent
 * (or developer) only needs to supply icon names. The script handles:
 *
 *   1. Fresh git clone of the theme_icons repo into an isolated temp directory
 *   2. Physical audit — check which icons already exist in project.nucleo files
 *   3. Export via the existing pipeline (scripts/index.js or dist/index.bundle.js)
 *   4. Git: checkout branch → commit (conventional) → push
 *   5. Print a machine-readable JSON result to stdout and cleanup
 *
 * Usage:
 *   node scripts/workflow.js --pipeline icon --name "Lock Shield" --theme-path /path/to/klara-theme
 *   node scripts/workflow.js --pipeline duotone --name "Love Swan" --name "Kiwi Bird" --theme-path /path
 *   node scripts/workflow.js --pipeline illustration --name "Armed Jeep" --theme-path /path
 *
 * Flags:
 *   --pipeline <icon|duotone|illustration>   Required
 *   --name "Icon Name"                        Repeatable, required (at least one)
 *   --theme-path <path>                       Required (target klara-theme directory)
 *   --branch-id <id>                          Optional; defaults to current timestamp
 *   --skip-git                                Skip git operations (useful for dry-runs)
 *   --skip-cleanup                            Keep TEMP_ROOT after run (for debugging)
 *   --git-name <name>                         Override git author name
 *   --git-email <email>                       Override git author email
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
 *     "icons": {
 *       "exported": ["Icon Name"],
 *       "alreadyDone": ["Other Icon"],
 *       "failed": []
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

const GIT_REPO_URL = 'git@bitbucket.org:axonivy-prod/theme_icons.git';
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
    pipeline:   null,
    names:      [],
    themePath:  null,
    branchId:   String(Date.now()),
    skipGit:    false,
    skipCleanup: false,
    gitName:    null,
    gitEmail:   null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--pipeline':   result.pipeline  = next; i++; break;
      case '--name': case '-n': result.names.push(next); i++; break;
      case '--theme-path': case '-t': result.themePath = next; i++; break;
      case '--branch-id':  result.branchId  = next; i++; break;
      case '--skip-git':   result.skipGit   = true; break;
      case '--skip-cleanup': result.skipCleanup = true; break;
      case '--git-name':   result.gitName   = next; i++; break;
      case '--git-email':  result.gitEmail  = next; i++; break;
      default:
        if (!a.startsWith('-')) {
          // bare positional = icon name
          result.names.push(a);
        }
    }
  }

  return result;
}

function validateArgs(args) {
  const errors = [];
  if (!args.pipeline || !VALID_PIPELINES.includes(args.pipeline)) {
    errors.push(`--pipeline must be one of: ${VALID_PIPELINES.join(', ')}`);
  }
  if (args.names.length === 0) {
    errors.push('At least one --name is required');
  }
  if (!args.themePath) {
    errors.push('--theme-path is required');
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
 * For each icon name, check whether it already exists in the relevant
 * project.nucleo files inside the cloned TEMP_ROOT.
 *
 * Returns { alreadyDone: string[], toExport: string[] }
 */
function auditIcons(names, pipeline, tempRoot) {
  log.section('Phase 2 — Physical Audit');

  const { required, matchAll } = SET_UUIDS[pipeline];
  const alreadyDone = [];
  const toExport    = [];

  for (const name of names) {
    const results = required.map(uuid => {
      const nucleoPath = path.join(tempRoot, 'nc-projects', uuid, 'project.nucleo');
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

async function gitSync(tempRoot, branchId, names, pipeline, gitName, gitEmail) {
  log.section('Phase 4 — Git Sync');

  const git = simpleGit(tempRoot);

  // Author identity: flag → local config → global config → error
  let name  = gitName;
  let email = gitEmail;

  if (!name || !email) {
    try {
      const cfg = await git.listConfig();
      const get = key =>
        cfg.all[key] || cfg.all[`local.${key}`] || cfg.all[`global.${key}`] || null;
      name  = name  || get('user.name');
      email = email || get('user.email');
    } catch { /* ignore */ }
  }

  if (!name || !email) {
    // Fall back to git config --global (via system call)
    try {
      name  = name  || (await simpleGit().raw(['config', '--global', 'user.name'])).trim();
      email = email || (await simpleGit().raw(['config', '--global', 'user.email'])).trim();
    } catch { /* ignore */ }
  }

  if (!name || !email) {
    // Last resort: read from PRIMARY_REPO local config
    try {
      const primaryGit = simpleGit(PRIMARY_REPO);
      name  = name  || (await primaryGit.raw(['config', 'user.name'])).trim();
      email = email || (await primaryGit.raw(['config', 'user.email'])).trim();
    } catch { /* ignore */ }
  }

  if (!name || !email) {
    throw new Error(
      'Git author identity not found. Pass --git-name and --git-email flags, ' +
      'or set global git config (git config --global user.name / user.email).'
    );
  }

  log.info(`Git author: ${name} <${email}>`);

  // Apply local config to the temp clone
  await git.addConfig('user.name', name, false, 'local');
  await git.addConfig('user.email', email, false, 'local');

  // Branch
  const branchName = `feature/export-icons-${branchId}`;
  await git.checkoutLocalBranch(branchName);
  const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
  log.ok(`On branch: ${currentBranch.trim()}`);

  // Commit
  const count      = names.length;
  const namesList  = names.join(', ');
  const pipelineLabel = pipeline === 'icon' ? 'Streamline Icon Fonts'
    : pipeline === 'duotone' ? 'Streamline Duotone'
    : 'Streamline Illustrations';

  await git.add('.');
  await git.commit([
    `feat(icons): export ${count} icon${count > 1 ? 's' : ''}`,
    `Icons: ${namesList}`,
    `Set: ${pipelineLabel}`,
    'Automated batch export.',
  ]);

  const lastLog = await git.log({ maxCount: 1 });
  log.ok(`Commit: ${lastLog.latest.hash.slice(0, 8)} — ${lastLog.latest.message.split('\n')[0]}`);

  // Push
  await git.push('origin', branchName, ['--set-upstream']);
  log.ok(`Pushed ${branchName} to origin`);

  const prUrl = `${PR_BASE_URL}?source=${encodeURIComponent(branchName)}&t=1`;
  return { branchName, prUrl };
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
    log.error('\nUsage: node workflow.js --pipeline <icon|duotone|illustration> --name "Name" --theme-path /path');
    process.exit(1);
  }

  // Result scaffold — mutated as we progress
  const result = {
    status:     'failed',
    prUrl:      null,
    branchName: null,
    icons:      { exported: [], alreadyDone: [], failed: [] },
    diff:       null,
    error:      null,
  };

  const tempRoot = path.join(os.tmpdir(), `theme_icons_${args.branchId}`);
  let scssBeforeInfo = null;

  try {
    // ── Phase 1: Clone ────────────────────────────────────────────────────
    await cloneRepo(tempRoot);
    verifyMySetsFallback(tempRoot);

    // ── Phase 2: Physical Audit ───────────────────────────────────────────
    const { alreadyDone, toExport } = auditIcons(args.names, args.pipeline, tempRoot);
    result.icons.alreadyDone = alreadyDone;

    if (toExport.length === 0) {
      log.ok('All icons already exported — nothing to do.');
      result.status = 'success';
      result.icons.exported = [];
      // Still print result, no git needed
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (!args.skipCleanup) cleanup(tempRoot);
      return;
    }

    // ── Pre-export: snapshot SCSS map for diff ────────────────────────────
    scssBeforeInfo = readIconsMapScss(args.themePath);

    // ── Phase 3: Export ───────────────────────────────────────────────────
    try {
      await runExport(args.pipeline, toExport, args.themePath, tempRoot);
      result.icons.exported = toExport;
    } catch (err) {
      log.error(`Export failed: ${err.message}`);
      result.icons.failed = toExport;
      result.error = err.message;
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (!args.skipCleanup) cleanup(tempRoot);
      process.exit(1);
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

    // ── Phase 4: Git ──────────────────────────────────────────────────────
    if (!args.skipGit) {
      const { branchName, prUrl } = await gitSync(
        tempRoot,
        args.branchId,
        toExport,
        args.pipeline,
        args.gitName,
        args.gitEmail,
      );
      result.branchName = branchName;
      result.prUrl      = prUrl;
    }

    result.status = result.icons.failed.length > 0 ? 'partial' : 'success';

  } catch (err) {
    log.error(`Fatal: ${err.message}`);
    result.error = err.message;
    result.status = 'failed';
  } finally {
    // Always emit JSON to stdout — agent parses this
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!args.skipCleanup) cleanup(tempRoot);
  }
}

main().catch(err => {
  process.stderr.write(`\x1b[31m[workflow] Unhandled error: ${err.message}\x1b[0m\n`);
  process.exit(1);
});
