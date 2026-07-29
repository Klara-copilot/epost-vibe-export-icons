'use strict';

const express = require('express');
const { getPipeline } = require('../lib/pipelineRegistry');
const { getProjectRoot } = require('../lib/context');

const router = express.Router();

router.post('/', async (req, res) => {
  const { pipeline: pipelineName } = req.body || {};

  let pipeline, paths;
  try {
    const projectRoot = getProjectRoot();
    pipeline = getPipeline(pipelineName);
    paths = pipeline.resolvePaths(projectRoot);
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }

  // Streamed plain-text log, mirroring the CLI's live console output.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.write(`Starting ${pipelineName} export...\n`);

  try {
    await pipeline.runExport(paths, chunk => res.write(chunk));
    res.write('\n=== EXPORT COMPLETE ===\n');
  } catch (err) {
    res.write(`\n=== EXPORT FAILED: ${err.message} ===\n`);
  } finally {
    res.end();
  }
});

module.exports = router;
