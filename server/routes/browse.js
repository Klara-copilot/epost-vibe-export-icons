'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { expandHome } = require('../../scripts/lib/common');

const router = express.Router();

router.get('/', (req, res) => {
  let targetPath = path.resolve(expandHome(String(req.query.path || '')) || os.homedir());

  let stat;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    res.status(400).json({ error: `Cannot access path: ${targetPath}` });
    return;
  }
  if (!stat.isDirectory()) {
    targetPath = path.dirname(targetPath);
  }

  let entries;
  try {
    entries = fs.readdirSync(targetPath, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        path: path.join(targetPath, e.name),
        isDirectory: e.isDirectory(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    res.status(400).json({ error: `Cannot read directory: ${targetPath}` });
    return;
  }

  res.json({ path: targetPath, entries });
});

module.exports = router;
