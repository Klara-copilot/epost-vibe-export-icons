'use strict';

const simpleGit = require('simple-git');

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
 * Resolve git author identity: explicit args → repo-local config → global
 * config → fallbackRepoRoot's config → throw.
 */
async function resolveGitAuthor(repoRoot, gitName, gitEmail, fallbackRepoRoot) {
  let name  = gitName;
  let email = gitEmail;

  if (!name || !email) {
    try {
      const cfg = await simpleGit(repoRoot).listConfig();
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

  if ((!name || !email) && fallbackRepoRoot) {
    try {
      const pgit = simpleGit(fallbackRepoRoot);
      name  = name  || (await pgit.raw(['config', 'user.name'])).trim();
      email = email || (await pgit.raw(['config', 'user.email'])).trim();
    } catch { /* ignore */ }
  }

  if (!name || !email) {
    throw new Error(
      'Git author identity not found. Pass gitName/gitEmail explicitly, ' +
      'or set global git config (git config --global user.name / user.email).'
    );
  }

  return { name, email };
}

/**
 * Push a branch to origin with automatic retries on transient failures
 * (network blips, remote hiccups). Throws the last error if all attempts fail.
 *
 * @param {import('simple-git').SimpleGit} git
 * @param {string} branchName
 * @param {function(string):void} [log]
 * @param {number} [maxRetries]
 */
async function pushWithRetry(git, branchName, log = () => {}, maxRetries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) log(`Push retry ${attempt}/${maxRetries}...`);
      await git.push('origin', branchName, ['--set-upstream']);
      return;
    } catch (err) {
      lastErr = err;
      log(`Push attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
  }
  throw lastErr;
}

/** True if a local branch with this name exists in the repo. */
async function localHasBranch(repoRoot, branchName) {
  try {
    const branches = await simpleGit(repoRoot).branchLocal();
    return branches.all.includes(branchName);
  } catch {
    return false;
  }
}

/** True if origin already has this branch (i.e. an earlier push succeeded). */
async function remoteHasBranch(repoRoot, branchName) {
  try {
    const out = await simpleGit(repoRoot).listRemote(['--heads', 'origin', branchName]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Push an already-committed local branch to origin (retrying), without
 * re-committing. Used by the manual "retry push" flow after a network failure.
 * Returns { branchName, prUrl }.
 */
async function pushExistingBranch(repoRoot, branchName, log = () => {}, maxRetries = 3) {
  const git = simpleGit(repoRoot);
  // Make sure we're on the branch (harmless no-op if already checked out).
  try { await git.checkout(branchName); } catch { /* may already be on it */ }
  await pushWithRetry(git, branchName, log, maxRetries);
  const remoteUrl = await getRemoteUrl(repoRoot);
  const prUrl     = buildPrUrlFromRemote(remoteUrl, branchName);
  return { branchName, prUrl };
}

/**
 * Checkout a fresh branch, commit all staged changes, push, and return
 * { branchName, prUrl }. Returns null if there is nothing to commit.
 *
 * @param {string}   repoRoot
 * @param {string}   branchId
 * @param {string[]} names            – icon/illustration names for the commit message
 * @param {string}   pipeline         – 'icon' | 'duotone' | 'illustration'
 * @param {string|null} gitName
 * @param {string|null} gitEmail
 * @param {string|null} fallbackRepoRoot – repo to read git author from if
 *                                         repoRoot/global config has none
 * @param {function(string):void} [log] – progress callback
 */
async function gitCommitAndPush(repoRoot, branchId, names, pipeline, gitName, gitEmail, fallbackRepoRoot, log = () => {}) {
  const git = simpleGit(repoRoot);

  const { name, email } = await resolveGitAuthor(repoRoot, gitName, gitEmail, fallbackRepoRoot);
  log(`Git author: ${name} <${email}>`);
  await git.addConfig('user.name',  name,  false, 'local');
  await git.addConfig('user.email', email, false, 'local');

  const branchName = `feature/export-icons-${branchId}`;
  await git.checkoutLocalBranch(branchName);
  log(`On branch: ${branchName}`);

  await git.add('.');
  const status = await git.status();
  if (status.files.length === 0) {
    log('Nothing to commit — skipping push');
    return null;
  }

  const count = names.length;
  const pipelineLabel = pipeline === 'icon'    ? 'icons'
    : pipeline === 'duotone'      ? 'duotones'
    : 'illustrations';

  await git.commit([
    `feat(${pipelineLabel}): export ${count} ${pipelineLabel.slice(0, -1)}${count > 1 ? 's' : ''}`,
    `${names.join(', ')}`,
    'Automated batch export.',
  ]);

  const lastLog = await git.log({ maxCount: 1 });
  log(`Commit: ${lastLog.latest.hash.slice(0, 8)} — ${lastLog.latest.message.split('\n')[0]}`);

  await pushWithRetry(git, branchName, log);
  log(`Pushed ${branchName} to origin`);

  const remoteUrl = await getRemoteUrl(repoRoot);
  const prUrl     = buildPrUrlFromRemote(remoteUrl, branchName);
  return { branchName, commit: lastLog.latest.hash, prUrl };
}

module.exports = {
  getRemoteUrl, buildPrUrlFromRemote, resolveGitAuthor, gitCommitAndPush,
  pushWithRetry, localHasBranch, remoteHasBranch, pushExistingBranch,
};
