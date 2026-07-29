'use strict';

const express = require('express');
const { getConfig, updateConfig } = require('../lib/config');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(getConfig());
});

router.post('/', (req, res) => {
  res.json(updateConfig(req.body || {}));
});

module.exports = router;
