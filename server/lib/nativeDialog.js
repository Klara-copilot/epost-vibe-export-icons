'use strict';

const { spawn } = require('child_process');

const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;

/** Run a command, collecting stdout/stderr, with a bounded timeout. */
function run(cmd, args) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child) child.kill();
      resolve({ code: null, stdout, stderr, timedOut: true, spawnError: null });
    }, DIALOG_TIMEOUT_MS);

    try {
      child = spawn(cmd, args);
    } catch (err) {
      clearTimeout(timer);
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: err });
      return;
    }

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut: false, spawnError: err });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false, spawnError: null });
    });
  });
}

function isMissingBinary(result) {
  return result.spawnError && result.spawnError.code === 'ENOENT';
}

async function pickFolderWindows(defaultPath) {
  const escapedDefault = (defaultPath || '').replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
    escapedDefault ? `$f.SelectedPath = '${escapedDefault}'` : null,
    '$result = $f.ShowDialog()',
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }",
  ].filter(Boolean).join('; ');

  const result = await run('powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
  if (isMissingBinary(result)) {
    return { status: 'unavailable', reason: 'powershell.exe not found' };
  }
  const path = result.stdout.trim();
  if (!path) return { status: 'cancelled' };
  return { status: 'ok', path };
}

async function pickFolderMac(defaultPath) {
  const escapedDefault = (defaultPath || '').replace(/"/g, '\\"');
  const script = escapedDefault
    ? `POSIX path of (choose folder with prompt "Select a folder" default location (POSIX file "${escapedDefault}"))`
    : `POSIX path of (choose folder with prompt "Select a folder")`;

  const result = await run('osascript', ['-e', script]);
  if (isMissingBinary(result)) {
    return { status: 'unavailable', reason: 'osascript not found' };
  }
  if (result.code !== 0) {
    if (/user canceled/i.test(result.stderr)) return { status: 'cancelled' };
    return { status: 'unavailable', reason: result.stderr.trim() || 'osascript failed' };
  }
  const path = result.stdout.trim();
  if (!path) return { status: 'cancelled' };
  return { status: 'ok', path };
}

async function pickFolderLinux(defaultPath) {
  const zenity = await run('zenity', [
    '--file-selection', '--directory',
    ...(defaultPath ? [`--filename=${defaultPath}/`] : []),
  ]);
  if (!isMissingBinary(zenity)) {
    if (zenity.code === 0) {
      const path = zenity.stdout.trim();
      return path ? { status: 'ok', path } : { status: 'cancelled' };
    }
    return { status: 'cancelled' };
  }

  const kdialog = await run('kdialog', [
    '--getexistingdirectory', defaultPath || require('os').homedir(),
  ]);
  if (!isMissingBinary(kdialog)) {
    if (kdialog.code === 0) {
      const path = kdialog.stdout.trim();
      return path ? { status: 'ok', path } : { status: 'cancelled' };
    }
    return { status: 'cancelled' };
  }

  return { status: 'unavailable', reason: 'Neither zenity nor kdialog is installed' };
}

/**
 * Open a native OS folder-selection dialog and resolve the chosen path.
 * Returns { status: 'ok', path } | { status: 'cancelled' } | { status: 'unavailable', reason }.
 */
async function pickFolder(defaultPath) {
  switch (process.platform) {
    case 'win32': return pickFolderWindows(defaultPath);
    case 'darwin': return pickFolderMac(defaultPath);
    case 'linux': return pickFolderLinux(defaultPath);
    default: return { status: 'unavailable', reason: `Unsupported platform: ${process.platform}` };
  }
}

module.exports = { pickFolder };
