# Internet Trend Radar MVP

跨平台趋势追踪器 MVP：采集中文互联网与全球开发者/科技数据源，每 30 分钟保存一次真实原始快照，网页展示来源原生指标、派生趋势指数、Breakout 和来源健康，并在质量门禁通过时用 Workers AI 生成「为什么火」和可行动机会；支持每日邮件。

## MVP 已包含

- 当前 Worker/D1 声明范围：微博、知乎、抖音、36氪、掘金、V2EX，加 Hacker News、GitHub；小红书由外部 Bridge 提供。只有来源 enabled、未过期且有当前 raw evidence 时才进入当前评分；Worker 的 `coverage.active_*`、`sources[].enabled` 和 freshness 状态是权威依据。
- GitHub Pages 静态快照范围更大：静态适配器还会采集少数派、B站、百度、今日头条、虎扑、IT之家、Solidot 等；这批来源只代表该 Pages 快照，不等于当前 Worker/D1 已启用。静态快照的 `data_contract.source_scope` 与 `coverage.active_*` 是该快照的权威依据。
- 全球源：Hacker News 官方 Firebase API、GitHub Search API（按近 36 小时 UTC 日期边界筛选新仓库并按 Star 排序；不是 GitHub Trending）
- 小红书：External Collector Bridge，供需要登录态/浏览器环境的 `xiaohongshu-mcp` 独立运行后推送数据
- D1：raw snapshots / topics / topic snapshots / evidence / subscribers / digests
- 原始字段：平台原生 heat/engagement、榜单 rank、采集时间和 `raw.trendRadarUpstream`；未提供的指标保存为 NULL，不填充为 0
- Trend Score：`rank_score×0.72 + heat_percentile×24 + engagement_percentile×18`，再加入 source weight、跨来源覆盖奖励和 persistence，并限制在 0–100；所有百分位只在来源内计算，它是派生趋势指数，不是任何平台的原始热度
- Breakout Score：上一轮分数变化 + 新来源增长 + mentions 增长 + novelty
- AI：Workers AI，当前模型为 `@cf/meta/llama-3.1-8b-instruct-fast`；只有通过输出质量门禁的结果才进入页面、机会接口和邮件
- Web：实时榜单、24h 曲线、类别分布、Breakout、新兴趋势、源健康、来源级最近 upstream、主题证据详情、邮件订阅
- 入口语义：`https://radar.wiki-power.com` 和 `https://internet-trend-radar.linyuxuanlin.workers.dev` 都是实时 Worker/D1 入口；GitHub Pages 是静态发布入口，优先尝试实时 Worker，静态快照超过 3 小时会拒绝展示，避免把旧热度当成当前数据
- Cron：每 30 分钟采集；每天 01:00 UTC（北京时间 09:00）发送摘要

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
      "engagement": 18000,
      "raw": {
        "trendRadarUpstream": "xiaohongshu-mcp:/api/v1/feeds/search"
      }
    }
  ]
}
```

参考 `scripts/xhs_bridge_example.py`。它支持把已登录的 `xiaohongshu-mcp` 搜索/Feed 结果以 JSON 数组从 stdin 或 `XHS_ITEMS_FILE` 传入，也支持通过 `XHS_MCP_URL` 直接调用本机 MCP HTTP API，再推送到正式域名：

```bash
export TREND_RADAR_URL=https://radar.wiki-power.com
export INGEST_TOKEN=...
python3 scripts/xhs_bridge_example.py < xhs-items.json
```

直接调用本机 MCP 搜索多个关键词：

```bash
export XHS_MCP_URL=http://127.0.0.1:18060
export XHS_KEYWORDS=AI,科技,消费
python3 scripts/xhs_bridge_example.py
```

`raw.trendRadarUpstream` 是所有数据入库前的强制 provenance 字段；缺失时 Worker 会拒绝该条目。MCP 工具连接和登录态必须运行在外部浏览器/Bridge 环境中，Cloudflare Worker 不保存小红书登录态。同一种 Bridge 也可以接微信指数、淘宝/京东榜单以及其他需要登录、浏览器或独立运行时的数据源。

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
curl -X POST https://internet-trend-radar.linyuxuanlin.workers.dev/api/admin/collect \
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

完整的来源、字段映射、fallback 和 Worker/Pages 范围差异说明见 [`docs/data-provenance.md`](docs/data-provenance.md)。

MVP 允许先借助第三方聚合项目快速获得覆盖面，但长期不会把单一聚合 API 当作唯一数据源。每个平台都应逐步升级为独立 Source Adapter，并保留：

- 原始快照
- 采集时间
- 原始榜单排名 / engagement
- Source Health
- 错误与恢复状态
- 平台独立归一化逻辑

这样微博、小红书、Hacker News、GitHub 等彼此完全不同的原始信号不会被直接相加。接口会同时保留每个来源的 `raw_heat_max`、`raw_engagement_max`、`best_rank`、最近采集时间和 upstream；这些数值只在各自平台单位内可解释，NULL 明确表示来源没有提供该指标。

## 下一阶段

1. 语义/实体聚类：把不同平台对同一事件的不同标题真正归成一个 Topic
2. 继续扩展 source-specific normalization 的历史校准，但保持原始热度不跨平台直接比较
3. 为小红书 Bridge 增加可靠的定时推送和失败告警
4. 扩展微信指数、淘宝、京东、App Store、Steam、Google Trends、YouTube、Reddit、Product Hunt、Hugging Face 等源
5. Opportunity Score：需求强度 × 增速 × 竞争程度 × 开发成本 × 变现路径
6. 用户 Watchlist、专题订阅和突发提醒
7. 邮件分组、退订与发送统计

## 注意

趋势是需求信号，不等于商业机会，更不等于收益保证。AI 的职责是解释证据、提出待验证假设，而不是凭空判断“这个一定能赚钱”。

## CI

GitHub Actions 只做轻量语法检查。生产部署建议交给 Cloudflare Workers Builds；这样不会依赖私有仓库的 GitHub-hosted Actions 分钟额度。
