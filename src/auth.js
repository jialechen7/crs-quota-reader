// API key extraction + hashing — must match CRS apiKeyService._hashApiKey
// exactly: sha256(apiKey + ENCRYPTION_KEY).digest('hex'). Drift here = 401 for
// every caller.

const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
  // eslint-disable-next-line no-console
  console.warn(
    '[auth] ENCRYPTION_KEY is empty. Hashing will not match CRS; all lookups will fail.',
  );
}

function hashApiKey(apiKey) {
  return crypto
    .createHash('sha256')
    .update(apiKey + (ENCRYPTION_KEY || ''))
    .digest('hex');
}

// Accept either `Authorization: Bearer <key>` or `x-api-key: <key>`, like CRS does.
function extractApiKey(req) {
  const authz = req.headers.authorization || '';
  if (authz.toLowerCase().startsWith('bearer ')) {
    return authz.slice(7).trim();
  }
  const xKey = req.headers['x-api-key'];
  if (typeof xKey === 'string' && xKey.trim()) {
    return xKey.trim();
  }
  return null;
}

module.exports = { hashApiKey, extractApiKey };
