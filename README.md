# Internet Trend Radar MVP

跨平台趋势追踪器 MVP：覆盖中文互联网与全球开发者/科技数据源，每 30 分钟采集一次，D1 保存时间序列，网页实时展示热度、Breakout、类别和来源健康，并用 Workers AI 生成「为什么火」和可行动机会；支持每日邮件。

## MVP 已包含

- 中文源：微博、知乎、B站、百度、抖音、今日头条、36氪、掘金、虎扑、V2EX（MVP 通过 DailyHotApi 快速覆盖）
- 全球源：Hacker News 官方 Firebase API、GitHub Search API
- 小红书：External Collector Bridge，供需要登录态/浏览器环境的 `xiaohongshu-mcp` 独立运行后推送数据
- D1：raw snapshots / topics / topic snapshots / evidence / subscribers / digests
- Trend Score：榜单位置 + 原始热度 + engagement + cross-source + persistence
- Breakout Score：上一轮分数变化 + 新来源增长 + mentions 增长 + novelty
- AI：Workers AI，默认 `@cf/zai-org/glm-4.7-flash`，输出 summary / why now / opportunities / risks
- Web：实时榜单、24h 曲线、类别分布、Breakout、新兴趋势、源健康、主题证据详情、邮件订阅
- Cron：每 30 分钟采集；每天 00:05 UTC（北京时间 08:05）发送摘要

## 小红书为什么使用 Bridge

小红书 MCP 需要登录态和浏览器环境，不适合与普通 REST API 采集器共用 Cloudflare Worker 生命周期。Trend Radar 只定义稳定的 ingest 契约：

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

参考 `scripts/xhs_bridge_example.py`。同一种 Bridge 以后也可以接微信指数、淘宝/京东榜单以及其他需要登录、浏览器或独立运行时的数据源。

## Cloudflare 部署

当前 `wrangler.jsonc` 使用 Cloudflare 的自动资源 provisioning：只声明 `DB` binding，不写死 `database_id`。首次部署时 Wrangler 可以为项目创建并绑定 D1，不需要先手工复制数据库 ID。

### 方式 A：Cloudflare Workers Builds（推荐）

在 Cloudflare Dashboard 创建 Worker / Workers Builds，并连接 GitHub 仓库 `linyuxuanlin/internet-trend-radar`：

- Production branch：`main`
- Deploy command：`npx wrangler deploy`

部署完成后，在 Cloudflare 的构建环境或本地对该项目执行：

```bash
npm install
npx wrangler d1 migrations apply DB --remote
```

然后设置生产 secrets：

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put INGEST_TOKEN
# 可选：提高 GitHub API 配额
npx wrangler secret put GITHUB_TOKEN
# 启用邮件时
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_FROM
```

### 方式 B：本地 Wrangler

```bash
npm install
npx wrangler login
npm run deploy
npm run db:migrate:remote
```

### 第一次真实采集

```bash
curl -X POST https://YOUR_WORKER.workers.dev/api/admin/collect \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

之后页面自动读取 D1，后台 Cron 每 30 分钟继续采集。

### 临时预览

Wrangler 4.102+ 支持无账号临时预览：

```bash
npx wrangler deploy --temporary
```

临时账号能力与正式 Cloudflare 账户并不完全相同；正式版建议仍部署到自己的 Cloudflare 账户，并保留 Workers AI binding。

## API

- `GET /api/health`
- `GET /api/dashboard?category=AI`
- `GET /api/topic/:id`
- `POST /api/subscribe`
- `POST /api/ingest/:source`（Bearer `INGEST_TOKEN`）
- `POST /api/admin/collect`（Bearer `ADMIN_TOKEN`）

## 数据层原则

MVP 允许先借助第三方聚合项目快速获得覆盖面，但长期不会把单一聚合 API 当作唯一数据源。每个平台都应逐步升级为独立 Source Adapter，并保留：

- 原始快照
- 采集时间
- 原始榜单排名 / engagement
- Source Health
- 错误与恢复状态
- 平台独立归一化逻辑

这样微博、小红书、Google、GitHub 等彼此完全不同的“热度”不会被简单粗暴地直接相加。

## 下一阶段

1. 语义/实体聚类：把不同平台对同一事件的不同标题真正归成一个 Topic
2. source-specific normalization：按平台历史 percentile / z-score 归一化热度
3. 真正接入小红书 MCP 并定时推送快照
4. 扩展微信指数、淘宝、京东、App Store、Steam、Google Trends、YouTube、Reddit、Product Hunt、Hugging Face 等源
5. Opportunity Score：需求强度 × 增速 × 竞争程度 × 开发成本 × 变现路径
6. 用户 Watchlist、专题订阅和突发提醒
7. 邮件分组、退订与发送统计

## 注意

趋势是需求信号，不等于商业机会，更不等于收益保证。AI 的职责是解释证据、提出待验证假设，而不是凭空判断“这个一定能赚钱”。

## CI

GitHub Actions 只做轻量语法检查。生产部署建议交给 Cloudflare Workers Builds；这样不会依赖私有仓库的 GitHub-hosted Actions 分钟额度。
