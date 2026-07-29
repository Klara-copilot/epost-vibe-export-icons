'use strict';

const express = require('express');
const { expandHome } = require('../../scripts/lib/common');
const { pickFolder } = require('../lib/nativeDialog');

const router = express.Router();

router.post('/', async (req, res) => {
  const { defaultPath } = req.body || {};
  try {
    const result = await pickFolder(expandHome(defaultPath || ''));
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: 'unavailable', reason: err.message });
  }
});

module.exports = router;
