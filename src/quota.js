// Build the account-quota response for one API key. We treat the account as the
// scoping unit (5h session window + rolling 7d) because that's how Anthropic's
// upstream rate limits are enforced. Per-key (tokenLimit/dailyCostLimit) info is
// already exposed by CRS's own /api/v1/key-info endpoint, so we don't duplicate.

const {
  findKeyIdByHash,
  getApiKey,
  getClaudeAccount,
  aggregateAccountHourlyUsage,
  sumOpusTokens,
} = require('./redis');
const { hashApiKey } = require('./auth');

async function buildAccountQuota(apiKey) {
  const hashed = hashApiKey(apiKey);
  const keyId = await findKeyIdByHash(hashed);
  if (!keyId) {
    return { found: false, reason: 'unknown_api_key' };
  }

  const keyData = await getApiKey(keyId);
  if (!keyData) {
    return { found: false, reason: 'api_key_record_missing' };
  }

  const accountId = keyData.claudeAccountId || '';
  if (!accountId) {
    // CRS allows binding a key to no fixed account: traffic is dispatched at
    // request time across the pool, so a single account-level quota doesn't apply.
    return {
      found: true,
      keyId,
      keyName: keyData.name || null,
      scheduledPool: true,
      message: 'Key uses scheduling pool, no fixed upstream account.',
    };
  }

  const account = await getClaudeAccount(accountId);
  if (!account) {
    return {
      found: true,
      keyId,
      keyName: keyData.name || null,
      accountId,
      reason: 'bound_account_missing',
    };
  }

  const now = new Date();

  // 5-hour session window, sourced from claude:account:<id>.{sessionWindowStart,
  // sessionWindowEnd}. CRS recomputes these on every upstream request; an
  // expired window means no traffic in the last 5h, in which case usage is 0.
  const swStart = account.sessionWindowStart || null;
  const swEnd = account.sessionWindowEnd || null;
  let sessionWindow = null;
  if (swStart && swEnd) {
    const start = new Date(swStart);
    const end = new Date(swEnd);
    const active = now < end;
    let usage = active
      ? await aggregateAccountHourlyUsage(accountId, start, end)
      : null;
    sessionWindow = {
      hasActiveWindow: active,
      windowStart: swStart,
      windowEnd: swEnd,
      remainingMinutes: active
        ? Math.max(0, Math.round((end.getTime() - now.getTime()) / 60000))
        : 0,
      progressPct: active
        ? Math.min(100, Math.round(((now - start) / (end - start)) * 100))
        : 100,
      usage,
    };
  } else {
    sessionWindow = { hasActiveWindow: false, reason: 'no_window_recorded' };
  }

  // Rolling 7d total + Opus subtotal.
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const last7 = await aggregateAccountHourlyUsage(accountId, sevenDaysAgo, now);
  const opus7dTokens = sumOpusTokens(last7.modelUsage);

  return {
    found: true,
    keyId,
    keyName: keyData.name || null,
    accountId,
    accountName: account.name || null,
    accountStatus: account.status || null,
    sessionWindowStatus: account.sessionWindowStatus || null,
    lastRequestTime: account.lastRequestTime || null,
    sessionWindow,
    last7days: {
      inputTokens: last7.inputTokens,
      outputTokens: last7.outputTokens,
      cacheCreateTokens: last7.cacheCreateTokens,
      cacheReadTokens: last7.cacheReadTokens,
      allTokens: last7.allTokens,
      requests: last7.requests,
    },
    last7daysOpus: {
      allTokens: opus7dTokens,
    },
  };
}

module.exports = { buildAccountQuota };
