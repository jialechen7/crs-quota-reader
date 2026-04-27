// Read-only ioredis client + schema helpers cloned from claude-relay-service.
// We deliberately mirror CRS's key naming and timezone math so the data we read
// matches what CRS writes; any drift here = silent wrong numbers.

const Redis = require('ioredis');

const TIMEZONE_OFFSET = parseInt(process.env.TIMEZONE_OFFSET, 10) || 8;

function buildClient() {
  const tlsRaw = (process.env.REDIS_ENABLE_TLS || '').toLowerCase();
  const useTLS = tlsRaw === 'true' || tlsRaw === '1' || tlsRaw === 'yes';
  return new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB, 10) || 0,
    tls: useTLS ? {} : undefined,
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });
}

const client = buildClient();
client.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[redis] error:', err.message);
});

// ── timezone helpers (mirror CRS src/models/redis.js getDateInTimezone et al) ─
function getDateInTimezone(date = new Date()) {
  const offsetMs = TIMEZONE_OFFSET * 3600000;
  return new Date(date.getTime() + offsetMs);
}

function getDateStringInTimezone(date = new Date()) {
  const tzDate = getDateInTimezone(date);
  const y = tzDate.getUTCFullYear();
  const m = String(tzDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(tzDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getHourInTimezone(date = new Date()) {
  return getDateInTimezone(date).getUTCHours();
}

// ── primitives ──────────────────────────────────────────────────────────────
async function findKeyIdByHash(hashedKey) {
  // Primary: new index `apikey:hash_map` (hash) — apikey:hash_map[hashedKey] = keyId.
  let keyId = await client.hget('apikey:hash_map', hashedKey);
  if (keyId) return keyId;

  // Fallback: legacy `apikey_hash:<hashedKey>` hash with `id` field.
  const legacy = await client.hgetall(`apikey_hash:${hashedKey}`);
  if (legacy && legacy.id) return legacy.id;

  return null;
}

async function getApiKey(keyId) {
  const data = await client.hgetall(`apikey:${keyId}`);
  if (!data || Object.keys(data).length === 0) return null;
  return { id: keyId, ...data };
}

async function getClaudeAccount(accountId) {
  const data = await client.hgetall(`claude:account:${accountId}`);
  if (!data || Object.keys(data).length === 0) return null;
  return { id: accountId, ...data };
}

// Aggregate `account_usage:hourly:<accountId>:<YYYY-MM-DD>:<HH>` between
// [windowStart, windowEnd] (Date or ISO string), matching CRS aggregation.
async function aggregateAccountHourlyUsage(accountId, windowStart, windowEnd) {
  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  if (isNaN(start) || isNaN(end) || start >= end) {
    return emptyUsage();
  }

  const cursor = new Date(start);
  cursor.setMinutes(0, 0, 0);
  const hourlyKeys = [];
  while (cursor <= end) {
    const dateStr = getDateStringInTimezone(cursor);
    const hourStr = String(getHourInTimezone(cursor)).padStart(2, '0');
    hourlyKeys.push(`account_usage:hourly:${accountId}:${dateStr}:${hourStr}`);
    cursor.setHours(cursor.getHours() + 1);
  }
  if (hourlyKeys.length === 0) return emptyUsage();

  const pipeline = client.pipeline();
  hourlyKeys.forEach((k) => pipeline.hgetall(k));
  const results = await pipeline.exec();

  const acc = emptyUsage();
  for (const [err, data] of results) {
    if (err || !data || Object.keys(data).length === 0) continue;
    acc.inputTokens += parseInt(data.inputTokens || 0, 10);
    acc.outputTokens += parseInt(data.outputTokens || 0, 10);
    acc.cacheCreateTokens += parseInt(data.cacheCreateTokens || 0, 10);
    acc.cacheReadTokens += parseInt(data.cacheReadTokens || 0, 10);
    acc.allTokens += parseInt(data.allTokens || 0, 10);
    acc.requests += parseInt(data.requests || 0, 10);

    for (const [field, value] of Object.entries(data)) {
      if (!field.startsWith('model:')) continue;
      const parts = field.split(':');
      if (parts.length < 3) continue;
      const modelName = parts[1];
      const metric = parts.slice(2).join(':');
      const bucket =
        acc.modelUsage[modelName] ||
        (acc.modelUsage[modelName] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreateTokens: 0,
          cacheReadTokens: 0,
          allTokens: 0,
          requests: 0,
        });
      if (metric in bucket) {
        bucket[metric] += parseInt(value || 0, 10);
      }
    }
  }
  return acc;
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    allTokens: 0,
    requests: 0,
    modelUsage: {},
  };
}

// Sum allTokens across model entries whose name contains "opus" (case-insensitive).
// Used to surface the 7d Opus subtotal that Anthropic enforces separately.
function sumOpusTokens(modelUsage) {
  let n = 0;
  for (const [name, bucket] of Object.entries(modelUsage || {})) {
    if (name.toLowerCase().includes('opus')) {
      n += parseInt(bucket.allTokens || 0, 10);
    }
  }
  return n;
}

module.exports = {
  client,
  findKeyIdByHash,
  getApiKey,
  getClaudeAccount,
  aggregateAccountHourlyUsage,
  sumOpusTokens,
};
