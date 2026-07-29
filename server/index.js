#!/usr/bin/env node
/**
 * server/index.js — Local bridge server for the web UI.
 *
 * The web UI is a static SPA hosted on Netlify; it cannot read arbitrary
 * local folders or spawn processes. This server runs on the user's own
 * machine, exposes the existing scripts/lib/pipelines.js logic over HTTP on
 * 127.0.0.1, and is the only thing with real filesystem/git access.
 *
 * Usage:
 *   npm run server
 *   PORT=5177 npm run server
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors    = require('cors');

const { loadOrCreateToken, requireAuth, isAllowedOrigin } = require('./lib/auth');

const PORT = Number(process.env.BRIDGE_SERVER_PORT) || 5177;
const token = loadOrCreateToken();

// Extra trusted origins beyond localhost (e.g. a hosted UI), comma-separated.
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
);

const app = express();
app.use(express.json());

// Only reflect CORS for trusted origins (localhost/127.0.0.1 on any port, plus
// ALLOWED_ORIGINS). This is the browser-side half of the defense; the
// requireAuth middleware below is the server-side half. Requests with no Origin
// (curl, server-to-server) are allowed through CORS but still gated by token.
app.use(cors({
  origin(origin, cb) {
    if (!origin || isAllowedOrigin(origin, allowedOrigins)) {
      cb(null, true);
      return;
    }
    cb(null, false);
  },
}));

app.get('/api/status', (req, res) => {
  res.json({ ok: true });
});

app.use(requireAuth(token, allowedOrigins));

app.use('/api/config', require('./routes/config'));
app.use('/api/browse', require('./routes/browse'));
app.use('/api/pick-folder', require('./routes/pick-folder'));
app.use('/api/search', require('./routes/search'));
app.use('/api/svg-preview', require('./routes/svg-preview'));
app.use('/api/register', require('./routes/register'));
app.use('/api/export', require('./routes/export'));
app.use('/api/deploy', require('./routes/deploy'));
app.use('/api/workflow', require('./routes/workflow'));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\nIcon export bridge server running at http://127.0.0.1:${PORT}`);
  console.log('Local web UI (localhost) is trusted automatically — no token needed.');
  console.log(`Token (only needed for a remote/hosted UI): ${token}\n`);
});
