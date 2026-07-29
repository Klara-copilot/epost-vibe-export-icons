'use strict';

const { expandHome } = require('../../scripts/lib/common');

/** Resolve the current PROJECT_ROOT (with ~ expansion), throwing if unset. */
function getProjectRoot() {
  const root = expandHome(process.env.PROJECT_ROOT || '');
  if (!root) {
    throw new Error('PROJECT_ROOT not configured. Set it on the Settings page first.');
  }
  return root;
}

module.exports = { getProjectRoot };
