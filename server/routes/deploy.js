'use strict';

const express = require('express');
const { getPipeline } = require('../lib/pipelineRegistry');
const { getProjectRoot } = require('../lib/context');
const { getConfig } = require('../lib/config');
const { gitCommitAndPush } = require('../../scripts/lib/git-deploy');

const router = express.Router();

router.post('/', async (req, res) => {
  const { pipeline: pipelineName, names } = req.body || {};
  try {
    const projectRoot = getProjectRoot();
    const { themePath } = getConfig();
    if (!themePath) {
      throw new Error('Theme path not configured. Set it on the Settings page first.');
    }

    const pipeline = getPipeline(pipelineName);
    const paths = pipeline.resolvePaths(projectRoot);

    // Copy exported files (+ merge SCSS map for the icon pipeline) into klara-theme.
    pipeline.deploy(paths, themePath);

    const branchId = String(Date.now());
    const commitNames = Array.isArray(names) && names.length > 0 ? names : ['icons'];
    const gitResult = await gitCommitAndPush(
      projectRoot, branchId, commitNames, pipelineName, null, null, projectRoot,
    );

    if (!gitResult) {
      res.json({
        branch: '', commit: '',
        note: 'Nothing to commit — the deployed files matched what was already committed.',
      });
      return;
    }

    res.json({ branch: gitResult.branchName, commit: gitResult.commit, prUrl: gitResult.prUrl || undefined });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
