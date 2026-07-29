'use strict';

const express = require('express');
const { getPipeline } = require('../lib/pipelineRegistry');
const { getProjectRoot } = require('../lib/context');

const router = express.Router();

router.get('/', (req, res) => {
  const { pipeline: pipelineName, term } = req.query;
  try {
    const projectRoot = getProjectRoot();
    const pipeline = getPipeline(String(pipelineName));
    const paths = pipeline.resolvePaths(projectRoot);
    // Strip internal `_icon`/`_file` fields (raw findSvgs results) before
    // sending to the client — only the display-relevant fields are needed.
    const results = pipeline.search(paths, String(term || '')).map(
      ({ _icon, _file, ...rest }) => rest,
    );
    res.json({ pipeline: pipelineName, term, results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
