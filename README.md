# Internet Trend Radar MVP

跨平台趋势追踪器 MVP：中文互联网 + 全球开发者/科技数据源，30 分钟采集一次，D1 保存时间序列，网页实时展示热度 / Breakout / 来源健康，并用 Workers AI 生成「为什么火」和可行动机会；支持每日邮件。

## MVP 已包含

- 中文聚合源：微博、知乎、B站、百度、抖音、今日头条、36氪、掘金、虎扑、V2EX（通过 DailyHotApi 适配器快速覆盖）
- 全球源：Hacker News 官方 Firebase API、GitHub Search API
- 小红书：External Collector Bridge，给需要登录态/浏览器的 `xiaohongshu-mcp` 独立部署
- D1：raw snapshots / topics / topic snapshots / evidence / subscribers / digests
- 热度：Rank + Heat + Engagement + Cross-source + Persistence
- Breakout：上一轮分数变化 + 新来源增长 + mentions 增长 + novelty
- AI：Workers AI（默认 GLM-4.7-Flash），输出 summary / why now / opportunities / risks
- Web：实时榜单、24h 曲线、类别分布、Breakout、新兴趋势、源健康、主题证据详情、邮件订阅
- Cron：每 30 分钟采集；每天 08:05（北京时间）生成并发送摘要

## 为什么小红书做 Bridge

小红书 MCP 需要登录态和浏览器环境，不适合和普通 REST API 采集器共用 Cloudflare Worker 生命周期。Trend Radar 只定义统一 ingest 契约：

```http
POST /api/ingest/xiaohongshu
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json
```

```json
{
  "items": [
    {
      "externalId": "note-id",
      "title": "标题",
      "url": "https://...",
      "author": "作者",
      "rank": 1,
      "heat": 12000,
      "engagement": 18000
    }
  ]
}
```

参考 `scripts/xhs_bridge_example.py`。

## Cloudflare 部署

### 1. 创建 D1

```bash
npm install
npx wrangler login
npx wrangler d1 create trend-radar
```

把输出的 database_id 填进 `wrangler.jsonc`。

### 2. 初始化数据库

```bash
npm run db:migrate:remote
```

### 3. 设置 secrets

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put INGEST_TOKEN
# 可选：提高 GitHub API 配额
npx wrangler secret put GITHUB_TOKEN
# 邮件启用时
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_FROM
```

### 4. 发布

```bash
npm run deploy
```

### 5. 立即触发第一次采集

```bash
curl -X POST https://YOUR_WORKER.workers.dev/api/admin/collect \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

之后页面每分钟刷新展示，后台每 30 分钟继续采集。

## API

- `GET /api/health`
- `GET /api/dashboard?category=AI`
- `GET /api/topic/:id`
- `POST /api/subscribe`
- `POST /api/ingest/:source`（Bearer `INGEST_TOKEN`）
- `POST /api/admin/collect`（Bearer `ADMIN_TOKEN`）

## 下一阶段

1. 近似语义聚类：不同平台不同标题归并成同一事件
2. source-specific normalization：不同平台热度单位做历史 percentile / z-score 归一化
3. 小红书 MCP 真正接入与定时任务
4. 微信指数 / 淘宝 / 京东 / App Store / Steam / Google Trends / YouTube / Reddit 等插件
5. 机会验证：搜索需求、竞品数量、变现路径、开发周期联合打分
6. 用户自定义 Watchlist 与突发提醒
7. Resend Broadcast/Segments + 双重确认退订流程

## 注意

第三方聚合 API 适合作为 MVP 快速验证，不应当作为长期唯一数据源。平台接口和抓取规则可能变化；生产版需要 source health、速率限制、重试、失败隔离以及合规审查。

## CI

GitHub Actions 会在 push / pull request 时执行 Worker 与前端脚本语法检查。Cloudflare 生产部署仍需要先创建 D1，并把 `database_id` 写入 `wrangler.jsonc`。
