'use strict';

const express = require('express');
const { getPipeline } = require('../lib/pipelineRegistry');
const { getProjectRoot } = require('../lib/context');

const router = express.Router();

router.post('/', (req, res) => {
  const { pipeline: pipelineName, name } = req.body || {};
  if (!pipelineName || !name) {
    res.status(400).json({ error: 'pipeline and name are required' });
    return;
  }
  try {
    const projectRoot = getProjectRoot();
    const pipeline = getPipeline(pipelineName);
    const paths = pipeline.resolvePaths(projectRoot);
    const result = pipeline.register(paths, name, () => {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
