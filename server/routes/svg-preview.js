'use strict';

const express = require('express');
const fs      = require('fs');
const { getPipeline } = require('../lib/pipelineRegistry');
const { getProjectRoot } = require('../lib/context');

const MAX_PREVIEW_BYTES = 1024 * 1024; // 1 MB

const router = express.Router();

router.get('/', (req, res) => {
  const { pipeline: pipelineName, name, sourceLabel } = req.query;
  if (!pipelineName || !name) {
    res.status(400).json({ error: 'pipeline and name are required' });
    return;
  }

  try {
    const projectRoot = getProjectRoot();
    const pipeline = getPipeline(String(pipelineName));
    const paths = pipeline.resolvePaths(projectRoot);
    const filePath = pipeline.preview(paths, String(name), sourceLabel ? String(sourceLabel) : undefined);

    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: `No preview available for "${name}"` });
      return;
    }

    const stat = fs.statSync(filePath);
    if (stat.size > MAX_PREVIEW_BYTES) {
      res.status(413).json({ error: `Preview file too large (${Math.round(stat.size / 1024)} KB)` });
      return;
    }

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
