'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const TOKEN_PATH = path.join(__dirname, '..', '.token');

/**
 * Load the bridge server's auth token, generating and persisting a new one
 * on first run. Kept stable across restarts so the user doesn't have to
 * re-paste it into the UI every time they start the server.
 */
function loadOrCreateToken() {
  if (fs.existsSync(TOKEN_PATH)) {
    const existing = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (existing) return existing;
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_PATH, token, 'utf8');
  return token;
}

/**
 * Is this request Origin one we trust? Any page served from localhost /
 * 127.0.0.1 (the user's own machine) is trusted — a malicious website is
 * served from its own domain, so its Origin can never be localhost, and the
 * browser sets Origin itself (JS cannot forge it cross-origin). Extra origins
 * (e.g. a hosted UI) can be added via the ALLOWED_ORIGINS env.
 */
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

function isAllowedOrigin(origin, allowedOrigins = new Set()) {
  if (!origin) return false;
  if (allowedOrigins.has(origin)) return true;
  return LOCALHOST_ORIGIN.test(origin);
}

/**
 * Express middleware gating access to the bridge. A request is allowed if it
 * comes from a trusted local Origin (zero-config for the local UI) OR presents
 * the correct Bearer token (for a remote/hosted UI or non-browser clients).
 *
 * This lets the local flow work with NO token at all while still blocking
 * arbitrary websites you have open in your browser from driving the bridge.
 */
function requireAuth(token, allowedOrigins = new Set()) {
  return (req, res, next) => {
    if (isAllowedOrigin(req.headers['origin'], allowedOrigins)) {
      next();
      return;
    }
    const header = req.headers['authorization'] || '';
    const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    if (provided && provided === token) {
      next();
      return;
    }
    res.status(401).json({
      error: 'Request blocked: not from an allowed local origin and no valid token.',
    });
  };
}

module.exports = { loadOrCreateToken, requireAuth, isAllowedOrigin, TOKEN_PATH };
