'use strict';

/**
 * /api/workflow — session-based automated workflow.
 *
 * The two repositories must be cloned FIRST — the icon source assets live
 * inside theme_icons, so search only becomes possible after the clone
 * completes. A persistent session workspace holds the cloned repos on disk
 * across the prepare -> search -> run requests.
 *
 *   POST /api/workflow/prepare      (stream) clone both repos, return session id
 *   GET  /api/workflow/search       search icons within a prepared session
 *   GET  /api/workflow/svg-preview  preview an icon within a prepared session
 *   POST /api/workflow/run          (stream) audit -> export -> commit -> push
 *   POST /api/workflow/cancel       explicitly stop a running /run process
 *   POST /api/workflow/cleanup      remove a session workspace
 *
 * Stream events (NDJSON lines):
 *   { type: 'stage',   id, status: 'start'|'ok'|'warn'|'error', label, detail? }
 *   { type: 'log',     stage, line }
 *   { type: 'session', id }                      // emitted by /prepare
 *   { type: 'result',  result: WorkflowResult }   // emitted by /run
 *
 * IMPORTANT: /run performs real git commits and pushes. The child process is
 * intentionally NOT tied to the HTTP request/response lifecycle — an
 * accidental browser disconnect (tab reload, navigation, dev-server HMR
 * reload) must never kill a workflow mid-push. The only way to stop a run is
 * the explicit POST /api/workflow/cancel endpoint.
 */

const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const crypto    = require('crypto');
const { spawn } = require('child_process');
const express   = require('express');
const simpleGit = require('simple-git');

const { expandHome, findSvgs } = require('../../scripts/lib/common');
const { localHasBranch, remoteHasBranch, pushExistingBranch } = require('../../scripts/lib/git-deploy');
const { getPipeline } = require('../lib/pipelineRegistry');

const router = express.Router();

// ─── Constants ────────────────────────────────────────────────────────────────

// Some machines don't have the `bitbucket-nhut` SSH host alias configured
// (see ~/.ssh/config) and instead use the plain `bitbucket.org` host with a
// default/named identity key. Set USE_DIRECT_GIT_HOST=true in .env to switch
// to that direct-host form; leave unset/false to keep the original alias
// (normal machine config, matches scripts/workflow.js).
const USE_DIRECT_GIT_HOST = process.env.USE_DIRECT_GIT_HOST === 'true';

const THEME_ICONS_REPO_URL = USE_DIRECT_GIT_HOST
  ? 'git@bitbucket.org:axonivy-prod/theme_icons.git'
  : 'git@bitbucket-nhut:axonivy-prod/theme_icons.git';
const LUZ_NEXT_REPO_URL    = USE_DIRECT_GIT_HOST
  ? 'git@bitbucket.org:axonivy-prod/luz_next.git'
  : 'git@bitbucket-nhut:axonivy-prod/luz_next.git';
const THEME_SUBPATH        = path.join('libs', 'klara-theme');
const MY_SETS_SUBPATH      = path.join('_Assets', 'my-sets');
const MAX_CLONE_RETRIES    = 5;

const VALID_PIPELINES = new Set(['icon', 'duotone', 'illustration']);
const MAX_NAME_LENGTH = 200;

// ─── Session workspace registry ───────────────────────────────────────────────
// Sessions are ephemeral, in-memory, and hold the cloned repos on disk. They
// exist only for the lifetime of one prepare -> search -> run cycle.

const sessions = new Map();

// ─── Running /run child process registry ──────────────────────────────────────
// Keyed by session id. Lets POST /cancel target a specific in-flight run
// without relying on the HTTP request/response lifecycle (see file header).
const runningChildren = new Map();

function sessionDirFor(id) {
  return path.join(os.tmpdir(), `vibe-workflow-${id}`);
}

/** Clone a single repo with retries, emitting log lines via onEvent. */
async function cloneWithRetry(repoUrl, targetDir, stageId, onEvent) {
  for (let attempt = 1; attempt <= MAX_CLONE_RETRIES + 1; attempt++) {
    if (attempt > 1) {
      onEvent({ type: 'log', stage: stageId, line: `Retrying clone (attempt ${attempt}/${MAX_CLONE_RETRIES + 1})...` });
    }
    try {
      if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
      await simpleGit().clone(repoUrl, targetDir, ['--quiet']);
      onEvent({ type: 'log', stage: stageId, line: `Cloned into ${targetDir}` });
      return;
    } catch (err) {
      onEvent({ type: 'log', stage: stageId, line: `Attempt ${attempt} failed: ${err.message}` });
      if (attempt > MAX_CLONE_RETRIES) {
        throw new Error(`Clone of ${repoUrl} failed after ${MAX_CLONE_RETRIES + 1} attempts: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

/**
 * Ensure `_Assets/my-sets` exists in the cloned theme_icons repo; fall back to
 * copying from PROJECT_ROOT (mirrors verifyMySetsFallback in workflow.js).
 * Search needs these source assets.
 */
function verifyMySets(themeIconsRoot, onEvent) {
  const inClone = path.join(themeIconsRoot, MY_SETS_SUBPATH);
  if (fs.existsSync(inClone)) return;

  onEvent({ type: 'log', stage: 'clone-theme-icons', line: '_Assets/my-sets missing in clone - attempting fallback copy' });
  const primaryRoot = expandHome(process.env.PROJECT_ROOT || '');
  if (!primaryRoot) {
    throw new Error('_Assets/my-sets is missing from the clone and PROJECT_ROOT is not set. Cannot search without the source icon library.');
  }
  const inPrimary = path.join(primaryRoot, MY_SETS_SUBPATH);
  if (!fs.existsSync(inPrimary)) {
    throw new Error(`_Assets/my-sets not found in clone or PROJECT_ROOT (${inPrimary}).`);
  }
  fs.mkdirSync(path.dirname(inClone), { recursive: true });
  fs.cpSync(inPrimary, inClone, { recursive: true });
  onEvent({ type: 'log', stage: 'clone-theme-icons', line: 'Copied _Assets/my-sets from PROJECT_ROOT' });
}

/**
 * Clone both repos into a fresh session workspace, streaming stage/log events.
 * Returns the session descriptor. Throws (after emitting an error stage) on
 * clone failure; the partial workspace is removed in that case.
 */
async function prepareSession(id, onEvent) {
  const root           = sessionDirFor(id);
  const themeIconsRoot = path.join(root, 'theme_icons');
  const luzNextRoot    = path.join(root, 'luz_next');
  const themePath      = path.join(luzNextRoot, THEME_SUBPATH);

  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  // Clone theme_icons first — the icon source assets live here, and search
  // cannot work until this clone (plus _Assets/my-sets) is in place.
  onEvent({ type: 'stage', id: 'clone-theme-icons', status: 'start', label: 'Cloning theme_icons' });
  try {
    await cloneWithRetry(THEME_ICONS_REPO_URL, themeIconsRoot, 'clone-theme-icons', onEvent);
    verifyMySets(themeIconsRoot, onEvent);
    onEvent({ type: 'stage', id: 'clone-theme-icons', status: 'ok', label: 'Cloning theme_icons' });
  } catch (err) {
    onEvent({ type: 'stage', id: 'clone-theme-icons', status: 'error', label: 'Cloning theme_icons', detail: err.message });
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }

  // Clone luz_next (deploy target for the exported assets).
  onEvent({ type: 'stage', id: 'clone-luz-next', status: 'start', label: 'Cloning luz_next' });
  try {
    await cloneWithRetry(LUZ_NEXT_REPO_URL, luzNextRoot, 'clone-luz-next', onEvent);
    onEvent({ type: 'stage', id: 'clone-luz-next', status: 'ok', label: 'Cloning luz_next' });
  } catch (err) {
    onEvent({ type: 'stage', id: 'clone-luz-next', status: 'error', label: 'Cloning luz_next', detail: err.message });
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }

  const session = { id, root, themeIconsRoot, luzNextRoot, themePath, createdAt: Date.now(), indexes: {} };
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  return sessions.get(id) || null;
}

function cleanupSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  try {
    fs.rmSync(session.root, { recursive: true, force: true });
  } catch { /* best-effort */ }
  sessions.delete(id);
}

/**
 * Validate a single selection entry. Returns an error string or null.
 * Names are kept as strings and never evaluated — they will be passed as
 * individual argv arguments, NOT through a shell, preventing injection.
 */
function validateSelection(sel) {
  if (!sel || typeof sel !== 'object') return 'each selection must be an object';
  if (!VALID_PIPELINES.has(sel.pipeline)) return `invalid pipeline "${sel.pipeline}"`;
  if (typeof sel.name !== 'string' || !sel.name.trim()) return 'name must be a non-empty string';
  if (sel.name.length > MAX_NAME_LENGTH) return `name too long (max ${MAX_NAME_LENGTH} chars)`;
  return null;
}

// ─── In-memory search index ───────────────────────────────────────────────────
// Building the index does one recursive filesystem walk per source directory
// (findSvgs('') matches every .svg file). This happens ONCE per pipeline per
// session (cached on session.indexes), instead of on every keystroke — the
// previous implementation called searchIconPipeline() per request, which
// re-walked ~3 x 3,600 nested SVG files (Light+Regular+Bold) EVERY search.
//
// The index also carries each entry's resolved file path(s), so /svg-preview
// can look them up directly instead of re-walking the filesystem too.

const ILLUSTRATION_SOURCE_LABELS = ['Steamline Filled', 'UX Line'];

function buildIndexForPipeline(pipelineName, paths) {
  if (pipelineName === 'icon') {
    // Mirrors searchIconPipeline's "must exist in all 3 styles" rule, but
    // computed once instead of per-request.
    const foundByStyle = {};
    for (const style of ['Light', 'Regular', 'Bold']) {
      foundByStyle[style] = findSvgs(paths.SOURCE_DIRS[style], '');
    }
    const nameToFiles = new Map();
    for (const style of ['Light', 'Regular', 'Bold']) {
      for (const f of foundByStyle[style]) {
        if (!nameToFiles.has(f.basename)) nameToFiles.set(f.basename, {});
        nameToFiles.get(f.basename)[style] = f;
      }
    }
    const entries = [];
    for (const [name, files] of nameToFiles) {
      if (files.Light && files.Regular && files.Bold) {
        entries.push({ name, files });
      }
    }
    return entries;
  }

  if (pipelineName === 'duotone') {
    return findSvgs(paths.SOURCE_DIR, '').map(f => ({ name: f.basename, fullPath: f.fullPath }));
  }

  if (pipelineName === 'illustration') {
    const entries = [];
    for (let i = 0; i < paths.SOURCE_DIRS.length; i++) {
      if (!fs.existsSync(paths.SOURCE_DIRS[i])) continue;
      for (const f of findSvgs(paths.SOURCE_DIRS[i], '')) {
        entries.push({ name: f.basename, sourceLabel: ILLUSTRATION_SOURCE_LABELS[i], fullPath: f.fullPath });
      }
    }
    return entries;
  }

  throw new Error(`No index builder for pipeline "${pipelineName}"`);
}

function getOrBuildIndex(session, pipelineName, paths) {
  if (!session.indexes[pipelineName]) {
    session.indexes[pipelineName] = buildIndexForPipeline(pipelineName, paths);
  }
  return session.indexes[pipelineName];
}

/**
 * Rank how well `name` matches `term` (case-insensitive). Lower is better;
 * returns null when there is no match at all. Priority order:
 *   0 exact match
 *   1 starts-with
 *   2 every whitespace/hyphen-separated word of term appears in name
 *   3 plain substring
 *   4 subsequence — every character of term appears in name, in order
 *     (handles typos/abbreviations, e.g. "lkshd" -> "lock-shield")
 */
function fuzzyScore(name, term) {
  const n = name.toLowerCase();
  const t = term.toLowerCase().trim();
  if (!t) return null;
  if (n === t) return 0;
  if (n.startsWith(t)) return 1;

  const words = t.split(/[\s-]+/).filter(Boolean);
  if (words.length > 1 && words.every(w => n.includes(w))) return 2;

  if (n.includes(t)) return 3;

  let ti = 0;
  for (let ni = 0; ni < n.length && ti < t.length; ni++) {
    if (n[ni] === t[ti]) ti++;
  }
  if (ti === t.length) return 4;

  return null;
}

const MAX_SEARCH_RESULTS = 40;

// ─── POST /prepare — clone both repos, stream progress ────────────────────────

router.post('/prepare', async (req, res) => {
  const id = crypto.randomBytes(8).toString('hex');

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const write = obj => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };

  try {
    await prepareSession(id, write);
    write({ type: 'session', id });
  } catch (err) {
    write({ type: 'stage', id: 'system', status: 'error', label: 'Prepare failed', detail: err.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// ─── GET /search — search within a prepared session ───────────────────────────

router.get('/search', (req, res) => {
  const { session: sessionId, pipeline: pipelineName, term } = req.query;
  const session = getSession(String(sessionId || ''));
  if (!session) {
    res.status(404).json({ error: 'Session not found or expired. Prepare the workspace first.' });
    return;
  }
  try {
    const pipeline = getPipeline(String(pipelineName));
    const paths = pipeline.resolvePaths(session.themeIconsRoot);
    const index = getOrBuildIndex(session, String(pipelineName), paths);

    const termStr = String(term || '');
    let results = [];
    if (termStr.trim()) {
      results = index
        .map(entry => ({ entry, score: fuzzyScore(entry.name, termStr) }))
        .filter(({ score }) => score !== null)
        .sort((a, b) => a.score - b.score || a.entry.name.length - b.entry.name.length || a.entry.name.localeCompare(b.entry.name))
        .slice(0, MAX_SEARCH_RESULTS)
        .map(({ entry }) => {
          if (pipelineName === 'icon') return { name: entry.name, matchedStyles: ['Light', 'Regular', 'Bold'] };
          if (pipelineName === 'illustration') return { name: entry.name, sourceLabel: entry.sourceLabel };
          return { name: entry.name };
        });
    }

    res.json({ pipeline: pipelineName, term, results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── GET /svg-preview — preview an icon within a prepared session ─────────────

router.get('/svg-preview', (req, res) => {
  const { session: sessionId, pipeline: pipelineName, name, sourceLabel } = req.query;
  if (!pipelineName || !name) {
    res.status(400).json({ error: 'pipeline and name are required' });
    return;
  }
  const session = getSession(String(sessionId || ''));
  if (!session) {
    res.status(404).json({ error: 'Session not found or expired. Prepare the workspace first.' });
    return;
  }
  try {
    const pipeline = getPipeline(String(pipelineName));
    const paths = pipeline.resolvePaths(session.themeIconsRoot);
    const index = getOrBuildIndex(session, String(pipelineName), paths);

    const nameStr = String(name).toLowerCase();
    let filePath = null;
    if (pipelineName === 'icon') {
      const entry = index.find(e => e.name.toLowerCase() === nameStr);
      filePath = entry ? entry.files.Regular.fullPath : null;
    } else if (pipelineName === 'illustration') {
      const wantLabel = sourceLabel ? String(sourceLabel) : undefined;
      const entry = index.find(e => e.name.toLowerCase() === nameStr && (!wantLabel || e.sourceLabel === wantLabel))
        || index.find(e => e.name.toLowerCase() === nameStr);
      filePath = entry ? entry.fullPath : null;
    } else {
      const entry = index.find(e => e.name.toLowerCase() === nameStr);
      filePath = entry ? entry.fullPath : null;
    }

    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: `No preview available for "${name}"` });
      return;
    }
    const stat = fs.statSync(filePath);
    if (stat.size > 1024 * 1024) {
      res.status(413).json({ error: 'Preview file too large' });
      return;
    }
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── POST /run — audit + export + commit + push against the session ──────────

router.post('/run', (req, res) => {
  const { session: sessionId, selections, branchId, skipGit } = req.body || {};

  const session = getSession(String(sessionId || ''));
  if (!session) {
    res.status(404).json({ error: 'Session not found or expired. Prepare the workspace first.' });
    return;
  }
  if (!Array.isArray(selections) || selections.length === 0) {
    res.status(400).json({ error: 'selections must be a non-empty array' });
    return;
  }
  for (const sel of selections) {
    const err = validateSelection(sel);
    if (err) {
      res.status(400).json({ error: `Invalid selection: ${err}` });
      return;
    }
  }

  const resolvedBranchId = (typeof branchId === 'string' && /^[\w.-]{1,80}$/.test(branchId))
    ? branchId
    : String(Date.now());

  // Build argv (no shell — each arg is its own array element). Pre-cloned
  // mode points workflow.js at the session's already-cloned repos so it does
  // NOT clone again — it only audits/exports/commits/pushes.
  const scriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'workflow.js');
  const argv = [
    '--branch-id', resolvedBranchId,
    '--json-events',
    '--work-root', session.themeIconsRoot,
    '--luz-next-root', session.luzNextRoot,
    '--skip-cleanup',   // the bridge server owns the session's lifecycle
  ];
  for (const sel of selections) {
    const flag = sel.pipeline === 'icon' ? '--icon'
      : sel.pipeline === 'duotone' ? '--duotone'
        : '--illustration';
    argv.push(flag, sel.name.trim());
  }
  if (skipGit) argv.push('--skip-git');

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  // Emit the resolved command up front so failures that happen immediately
  // (bad path, missing binary, arg validation inside workflow.js) are always
  // traceable in the live log, even before the child process produces output.
  res.write(JSON.stringify({
    type: 'log',
    stage: 'system',
    line: `Spawning: node ${scriptPath} ${argv.join(' ')}`,
  }) + '\n');

  const child = spawn(process.execPath, [scriptPath, ...argv], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  runningChildren.set(session.id, child);

  // The branch workflow.js will create/commit in each repo (mirrors
  // git-deploy.js's naming). Used by the push-retry detection below.
  const runBranchName = `feature/export-icons-${resolvedBranchId}`;

  child.stdout.on('data', chunk => { if (!res.writableEnded) res.write(chunk); });

  let stderrBuf = '';
  child.stderr.on('data', chunk => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (line && !res.writableEnded) {
        res.write(JSON.stringify({ type: 'log', stage: 'system', line }) + '\n');
      }
    }
  });

  child.on('close', async (code, signal) => {
    runningChildren.delete(session.id);
    if (stderrBuf && !res.writableEnded) {
      res.write(JSON.stringify({ type: 'log', stage: 'system', line: stderrBuf }) + '\n');
    }
    if (code !== 0 && !res.writableEnded) {
      const detail = signal
        ? `Process was terminated by signal ${signal} (cancelled or the bridge server was stopped)`
        : `Process exited with code ${code}`;
      res.write(JSON.stringify({
        type: 'stage', id: 'system', status: 'error',
        label: 'Workflow process', detail,
      }) + '\n');
    }

    // Detect repos where the commit succeeded locally but the push did NOT
    // reach origin (e.g. a network error). Those can be retried without
    // re-cloning/re-exporting, so we KEEP the session alive and tell the
    // client a manual "Retry push" is available.
    const pendingRepos = [];
    for (const [label, root] of [['theme_icons', session.themeIconsRoot], ['luz_next', session.luzNextRoot]]) {
      try {
        if (await localHasBranch(root, runBranchName) && !(await remoteHasBranch(root, runBranchName))) {
          pendingRepos.push({ label, root });
        }
      } catch { /* treat as not-pending */ }
    }

    if (pendingRepos.length > 0) {
      session.pendingPush = { branchName: runBranchName, repos: pendingRepos };
      if (!res.writableEnded) {
        res.write(JSON.stringify({
          type: 'push-retry',
          branchName: runBranchName,
          repos: pendingRepos.map(r => r.label),
        }) + '\n');
      }
      // Keep the session so /retry-push can operate on the committed branch.
    } else {
      // Fully done (all pushes landed, or nothing to push) — safe to clean up.
      cleanupSession(session.id);
    }
    if (!res.writableEnded) res.end();
  });

  child.on('error', err => {
    runningChildren.delete(session.id);
    if (!res.writableEnded) {
      res.write(JSON.stringify({
        type: 'stage', id: 'system', status: 'error',
        label: 'Workflow process', detail: err.message,
      }) + '\n');
      res.end();
    }
    cleanupSession(session.id);
  });

  // Deliberately do NOT kill the child on req 'close'. This endpoint performs
  // real git commits/pushes — an accidental browser disconnect (tab reload,
  // navigation, dev-server HMR full-reload) must never interrupt that. The
  // child keeps running to completion in the background; if the response
  // stream is already closed, writes above become no-ops (guarded by
  // `!res.writableEnded`) and the run still finishes and cleans up normally.
  // The only supported way to stop a run is POST /api/workflow/cancel.
});

// ─── POST /retry-push — re-attempt a failed push for a session ───────────────
// After /run, if a commit landed locally but the push to origin failed (e.g.
// a network blip), the session is kept alive with session.pendingPush set.
// This endpoint re-pushes only the still-unpushed repos, streaming progress.
// It can be called repeatedly until every repo's push finally succeeds.

router.post('/retry-push', async (req, res) => {
  const { session: sessionId } = req.body || {};
  const session = getSession(String(sessionId || ''));
  if (!session || !session.pendingPush) {
    res.status(404).json({ error: 'No pending push to retry for this session.' });
    return;
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const write = obj => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };

  const { branchName, repos } = session.pendingPush;
  const stillFailing = [];
  const prUrls = {};

  for (const { label, root } of repos) {
    const stageId = `commit-${label === 'theme_icons' ? 'theme-icons' : 'luz-next'}`;
    write({ type: 'stage', id: stageId, status: 'start', label: `Pushing ${label}` });
    try {
      const result = await pushExistingBranch(
        root, branchName,
        line => write({ type: 'log', stage: stageId, line }),
      );
      prUrls[label] = result.prUrl || null;
      write({ type: 'stage', id: stageId, status: 'ok', label: `Pushing ${label}`, detail: branchName });
    } catch (err) {
      stillFailing.push({ label, root });
      write({ type: 'stage', id: stageId, status: 'error', label: `Pushing ${label}`, detail: err.message });
    }
  }

  if (stillFailing.length === 0) {
    // Everything pushed — clear pending state and clean up the workspace.
    session.pendingPush = null;
    write({ type: 'push-complete', prUrls });
    cleanupSession(session.id);
  } else {
    // Some repos still failed — keep the session so the user can retry again.
    session.pendingPush = { branchName, repos: stillFailing };
    write({ type: 'push-retry', branchName, repos: stillFailing.map(r => r.label) });
  }

  if (!res.writableEnded) res.end();
});

// ─── POST /cancel — explicitly stop an in-flight /run process ────────────────

router.post('/cancel', (req, res) => {
  const { session: sessionId } = req.body || {};
  const child = runningChildren.get(String(sessionId || ''));
  if (!child) {
    res.status(404).json({ error: 'No running workflow found for this session.' });
    return;
  }
  child.kill('SIGTERM');
  res.json({ ok: true });
});

// ─── POST /cleanup — drop a session workspace (e.g. user resets/cancels) ──────

router.post('/cleanup', (req, res) => {
  const { session: sessionId } = req.body || {};
  cleanupSession(String(sessionId || ''));
  res.json({ ok: true });
});

module.exports = router;
