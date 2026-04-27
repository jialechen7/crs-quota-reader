// Entry point. Single read-only HTTP service in front of CRS's Redis.
// Endpoints:
//   GET /v1/health           — liveness + redis ping
//   GET /v1/account-quota    — bound upstream account 5h/7d usage for the
//                              caller's API key (Authorization: Bearer ...
//                              or x-api-key)

require('node:fs');
// dotenv is intentionally optional: in container deployments env is injected
// directly, locally we load .env if present.
try {
  require('dotenv').config();
} catch (_) {
  // dotenv not installed — fine, env must come from the runtime.
}

const express = require('express');

const { client: redis } = require('./redis');
const { extractApiKey } = require('./auth');
const { buildAccountQuota } = require('./quota');

const PORT = parseInt(process.env.PORT, 10) || 8788;
const ACCESS_LOG = (process.env.ACCESS_LOG || 'true').toLowerCase() !== 'false';

const app = express();
app.disable('x-powered-by');

if (ACCESS_LOG) {
  app.use((req, _res, next) => {
    // eslint-disable-next-line no-console
    console.log(`[access] ${req.method} ${req.path}`);
    next();
  });
}

app.get('/v1/health', async (_req, res) => {
  try {
    const pong = await redis.ping();
    res.json({ ok: true, redis: pong === 'PONG' ? 'connected' : pong });
  } catch (err) {
    res.status(503).json({ ok: false, redis: 'unreachable', error: err.message });
  }
});

app.get('/v1/account-quota', async (req, res) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) {
    res.status(401).json({
      error: 'missing_api_key',
      message: 'Provide Authorization: Bearer <key> or x-api-key header.',
    });
    return;
  }

  try {
    const result = await buildAccountQuota(apiKey);
    if (!result.found) {
      res.status(401).json({ error: 'unknown_api_key', detail: result });
      return;
    }
    res.json(result);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[account-quota] failure:', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[crs-quota-reader] listening on :${PORT}`);
});

function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`[shutdown] received ${signal}, closing`);
  server.close(() => {
    redis.quit().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
