# crs-quota-reader

只读 sidecar:用 API key 查它绑定的**上游 Claude 账号**的 5h 窗口、7d 总用量、7d Opus 子项。

**不修改** [claude-relay-service](https://github.com/Wei-Shaw/claude-relay-service) 一行代码 —— 直接共用同一个 Redis,镜像 CRS 的 schema 与时区算法做读侧聚合。

## 它能做什么 / 不能做什么

| | 现状 |
|---|---|
| 用 API key 自查"我用的母账号还剩多少 5h 窗口" | ✅ 这个项目 |
| 用 API key 自查"我自己 key 的 quota / 已用 token / cost" | CRS 自带 `/api/v1/key-info`,本项目不重复 |
| Admin 视角看所有账号的负载/调度 | CRS web 后台,本项目不替代 |
| 任何写操作(改 quota / 取消 ticket / ...) | 本项目只读,不会暴露 |

## 端点

### `GET /v1/account-quota`

**鉴权**:`Authorization: Bearer <key>` 或 `x-api-key: <key>`(任选)。Key 必须是真实写在 CRS Redis 里的 API key。

**返回**(key 绑定到具体上游账号时):

```json
{
  "found": true,
  "keyId": "...",
  "keyName": "my-cc-key",
  "accountId": "...",
  "accountName": "claude-prod-1",
  "accountStatus": "active",
  "sessionWindowStatus": null,
  "lastRequestTime": "2026-04-28T08:11:23.000Z",
  "sessionWindow": {
    "hasActiveWindow": true,
    "windowStart": "2026-04-28T05:00:00.000Z",
    "windowEnd":   "2026-04-28T10:00:00.000Z",
    "remainingMinutes": 47,
    "progressPct": 84,
    "usage": {
      "inputTokens": 12345,
      "outputTokens": 67890,
      "cacheCreateTokens": 0,
      "cacheReadTokens": 1024,
      "allTokens": 81259,
      "requests": 42,
      "modelUsage": {
        "claude-opus-4-7": { "allTokens": 50000, "requests": 20, "...": "..." },
        "claude-sonnet-4-6": { "allTokens": 31259, "requests": 22, "...": "..." }
      }
    }
  },
  "last7days":     { "inputTokens": 0, "outputTokens": 0, "cacheCreateTokens": 0, "cacheReadTokens": 0, "allTokens": 4123456, "requests": 1234 },
  "last7daysOpus": { "allTokens": 1500000 }
}
```

**返回**(key 没绑账号、走调度池):

```json
{ "found": true, "keyId": "...", "keyName": "...", "scheduledPool": true,
  "message": "Key uses scheduling pool, no fixed upstream account." }
```

**错误**:

| HTTP | error 字段 | 含义 |
|---|---|---|
| 401 | `missing_api_key` | 没带 Bearer / x-api-key |
| 401 | `unknown_api_key` | 算出的 hash 在 `apikey:hash_map` 找不到。最常见原因:`ENCRYPTION_KEY` 与 CRS 不一致;次常见:Key 真的不存在 |
| 503 | (健康检查) | Redis 不通 |

### `GET /v1/health`

```json
{ "ok": true, "redis": "connected" }
```

## 部署

### 0. 前置条件

- 与 CRS 共享同一个 Redis(host/port/auth/db 一致)
- **拿到 CRS 的 `ENCRYPTION_KEY`**(在 `~/claude-relay-service/app/.env` 里,与 CRS 设置时生成的一致)。`sha256(apiKey + ENCRYPTION_KEY)` 是 CRS 唯一的 key 反查方式,不一致就**所有 API key 都会被判 unknown**

### 1. Docker compose(推荐)

```bash
cd /path/to/crs-quota-reader
cp .env.example .env
# 编辑 .env:把 REDIS_HOST/PORT/PASSWORD/DB/TLS、ENCRYPTION_KEY、TIMEZONE_OFFSET
# 全部对齐到 CRS 的 .env
$EDITOR .env

docker compose up -d --build
docker compose logs -f
```

如果 CRS 也是 docker compose 起的,且 redis 在 CRS 的私有网络,把 `docker-compose.yml` 末尾的 `networks` 段取消注释,把 `crs-net` 改成 CRS 所在 network 名(`docker network ls` 能看到)。

### 2. PM2

```bash
npm install
pm2 start src/server.js --name crs-quota-reader --env-file .env
pm2 save
```

### 3. Systemd / 裸 node

```bash
npm install
node src/server.js
```

## 客户端用法

### Claude Code statusline 例子

`~/.claude/statusline.sh`:

```bash
#!/usr/bin/env bash
KEY="$ANTHROPIC_AUTH_TOKEN"          # 你 cc 当前用的 API key
READER_BASE="http://127.0.0.1:8788"  # 本服务的 base url
INFO=$(curl -s --max-time 1.5 -H "Authorization: Bearer $KEY" "$READER_BASE/v1/account-quota" || echo '{}')
USED=$(printf '%s' "$INFO" | jq -r '.sessionWindow.usage.allTokens // 0')
LEFT_MIN=$(printf '%s' "$INFO" | jq -r '.sessionWindow.remainingMinutes // 0')
[ "$USED" = "null" ] && USED=0
printf "🔋 %s tok · 💤 %sm" "$USED" "$LEFT_MIN"
```

## 安全提示

- 服务持有 `ENCRYPTION_KEY` = 持有"任何 API key → keyId 的反查能力";请把它部署在与 CRS 相同的安全等级里(同主机 / 同私有网络),**不要直接暴露到公网**。建议:仅监听 127.0.0.1,通过反向代理 + 客户端鉴权再开放。
- 客户端用的是它自己的 API key 鉴权 —— 跟 CRS 一样,本服务不发新凭据。
- 整个 Redis client 只调 `hget/hgetall/pipeline.hgetall/ping`,不调 `set/hset/del`,生产 Redis 上发起 `SCRIPT FLUSH` 之类破坏操作的能力是 0(代码层保证)。

## Schema 来源

直接镜像 CRS `src/models/redis.js` 与 `src/services/account/claudeAccountService.js` 中:

- key hash:`sha256(apiKey + ENCRYPTION_KEY)`(`apiKeyService._hashApiKey`)
- 反查:`apikey:hash_map` 主索引,`apikey_hash:<h>` 旧索引兜底
- 账号:`claude:account:<id>` 的 `sessionWindowStart` / `sessionWindowEnd` / `name` / `status` / `sessionWindowStatus` / `lastRequestTime`
- 用量:`account_usage:hourly:<accountId>:<YYYY-MM-DD>:<HH>` 按 `TIMEZONE_OFFSET` 时区构建

CRS schema 升级时本服务可能跟着失配,定期对照一下两边的 `redis.js` 即可。
