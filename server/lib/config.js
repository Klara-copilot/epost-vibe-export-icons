'use strict';

const fs   = require('fs');
const path = require('path');
const { expandHome } = require('../../scripts/lib/common');

const ENV_PATH = path.join(__dirname, '..', '..', '.env');

const UUID_KEYS = {
  light:                'NUCLEO_UUID_LIGHT',
  regular:               'NUCLEO_UUID_REGULAR',
  bold:                  'NUCLEO_UUID_BOLD',
  glyph:                 'NUCLEO_UUID_GLYPH',
  illustrations:         'NUCLEO_UUID_ILLUSTRATIONS',
  illustrationsPart3:    'NUCLEO_UUID_ILLUSTRATIONS_PART3',
  illustrationsDuotone:  'NUCLEO_UUID_ILLUSTRATIONS_DUOTONE',
};

function getConfig() {
  const pipelineUuids = {};
  for (const [label, envKey] of Object.entries(UUID_KEYS)) {
    pipelineUuids[label] = process.env[envKey] || '';
  }
  return {
    projectRoot: expandHome(process.env.PROJECT_ROOT || ''),
    themePath: expandHome(process.env.THEME_PATH || ''),
    pipelineUuids,
  };
}

/**
 * Persist projectRoot/themePath into .env (creating the keys if absent) and
 * update process.env immediately so subsequent requests in this process see
 * the new value without a restart.
 */
function updateConfig(partial) {
  const updates = {};
  if (typeof partial.projectRoot === 'string') updates.PROJECT_ROOT = partial.projectRoot;
  if (typeof partial.themePath === 'string') updates.THEME_PATH = partial.themePath;

  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }

  if (Object.keys(updates).length > 0) {
    writeEnvUpdates(updates);
  }

  return getConfig();
}

function writeEnvUpdates(updates) {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(content)) {
      content = content.replace(pattern, line);
    } else {
      content = content.replace(/\n?$/, '') + `\n${line}\n`;
    }
  }
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

module.exports = { getConfig, updateConfig };
