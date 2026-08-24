# Trend Radar 数据 provenance

本文定义“热度”在项目中的真实含义。项目不会把不同平台的数字直接相加，也不会把派生趋势指数当成平台热度。

## 字段约定

| 字段 | 含义 |
| --- | --- |
| `rank` | 本次来源榜单中的名次，只在同一来源内可比较 |
| `heat` | 来源原生的热度、阅读量、播放量或平台排序信号；具体映射见下表 |
| `engagement` | 来源原生的互动计数或互动计数之和 |
| `captured_at` | Worker/Bridge 实际采集时间，不是文章发布时间 |
| `raw_json.trendRadarUpstream` | 实际使用的请求地址或外部 Bridge 标识 |
| `raw_json.trendRadarMetrics` | 实际选用的 heat/engagement 字段路径；通用聚合源只选一个候选字段，不合并别名 |
| `raw_signals.peak_evidence` | 24 小时 heat/engagement 峰值各自对应的采集时间和 upstream；峰值不默认等于最新值 |
| `raw_signals.source_kind` | 根据该主题最新一条 raw item 的 upstream 推导；不直接套用来源当前状态，避免官方/fallback 混采时误标 |
| `raw_signals.observed_upstreams` | 24 小时窗口内该主题/来源实际出现过的全部 upstream；用于识别官方与 fallback 的切换 |
| `NULL` | 上游没有提供该指标；不会用 0 填充 |
| `current_score` / `trend_score` | 项目派生趋势指数，不是任何平台的原始热度 |

## 来源类型

`sources[].kind` 描述本次成功采集实际走过的链路，不代表不同平台的数字可以互相比较：

- `official-api`：平台官方 API
- `official-rss`：平台官方 RSS/Feed 页面，可能没有平台原生计数字段
- `mirror-fallback`：第三方镜像或公开热榜接口
- `aggregator-fallback`：共享聚合服务的回退结果
- `external-bridge`：外部登录态或浏览器 Bridge 推送

如果一次采集失败，`latest_upstream` 保持为空；不能根据来源名称推断本次拿到的是官方数据。

## 当前实时来源

| 来源 | 当前 upstream / fallback | `heat` | `engagement` | 可比性边界 |
| --- | --- | --- | --- | --- |
| 微博 | `weibo.com/ajax/side/hotSearch`；失败时可能使用 DailyHot mirror | `data.realtime[].num` | 未提供（`NULL`） | 只在微博榜内解释 |
| 知乎 | `api.zhihu.com/topstory/hot-lists/total`；失败时可能使用 DailyHot mirror | `detail_text` 解析出的官方展示热度 | 未提供（`NULL`） | 只在知乎榜内解释 |
| 抖音 | 官方接口失败后按顺序尝试 AA1、Luochen、Fanyia | 依据实际响应选择 `word_list[]`、`data.list[]` 或 `data[]` 中的热榜字段；每条记录的 `metric_paths.heat` 保留实际命中字段 | 未提供（`NULL`） | 必须同时查看 `kind=mirror-fallback` 和实际 upstream |
| 少数派 | `sspai.com/feed` 官方 RSS | 无（`NULL`） | 无（`NULL`） | RSS 只提供文章发布信息，不代表平台热度 |
| 36 氪 | `gateway.36kr.com/api/mis/nav/home/nav/rank/hot`；RSS fallback 可能无计数 | `templateMaterial.statRead` | `statCollect + statComment + statPraise` | RSS 无字段时对应值为 `NULL` |
| 掘金 | `api.juejin.cn/recommend_api/v1/article/recommend_all_feed` | `article_info.view_count` | `digg_count + comment_count + collect_count + share_count` | 只在掘金推荐流内解释 |
| V2EX | `www.v2ex.com/api/topics/hot.json` | 无独立热度字段（`NULL`） | `topics[].replies` | 回复数不是热度 |
| Hacker News | `hacker-news.firebaseio.com/v0/item/{id}.json` | `item.score` | `item.descendants` | score、评论数是 HN 原生计数 |
| GitHub 新仓库 | `api.github.com/search/repositories?q=created:>=<UTC date>&sort=stars&order=desc&per_page=30` | `repository.stargazers_count` | `repository.forks_count` | 按近 36 小时 UTC 日期边界筛选并按 Star 排序；这不是 GitHub Trending，Star、Fork 也不是跨平台热度单位 |
| 小红书 | 外部 `xiaohongshu-mcp` Bridge | `noteCard.interactInfo.likedCount` | 点赞 + 收藏 + 评论 | 需要外部登录态；Bridge 标识会保留 |
| IT之家 | 官方 RSS | 无（`NULL`） | 无（`NULL`） | RSS 只提供文章发布信息，不代表平台热度 |
| Solidot | 官方 RSS | 无（`NULL`） | 无（`NULL`） | RSS 只提供文章发布信息，不代表平台热度 |

## 派生趋势指数

实时 Worker 的 `current_score` 先计算：

`rank_score × 0.72 + heat_percentile × 24 + engagement_percentile × 18`

其中 `rank_score` 是当前来源榜单跨度内的 30–100 分，百分位只在同一来源内计算，缺失指标不参与百分位。随后再计算：

`base × 0.82 × source_weight + cross_source_bonus + persistence_bonus`

其中 `cross_source_bonus = min(log2(source_count) × 10, 25)`，`persistence_bonus = min(log2(mentions) × 3, 12)`，最终限制在 0–100。`Breakout` 另外使用上一轮分数变化、新来源数变化、mentions 变化和 novelty；它们都是项目派生值，不是平台热度。

原始 heat/engagement 不跨平台直接比较。缺失指标不会获得正向加分；来源停用后，其历史 raw item 不再参与当前评分、页面证据或 AI 证据。

## 读取方式

- 实时 Worker：`https://radar.wiki-power.com` 或 `https://internet-trend-radar.linyuxuanlin.workers.dev`；两个入口读取同一套 D1 数据和质量门禁。
- `/api/dashboard`：返回 `data_contract`、每个来源的 `metric_definition`，以及主题级 `raw_signals`。
- `/api/topic/:id`：返回主题的原始热度峰值、互动峰值、最近采集时间、upstream 链接和实际字段路径。
- `/api/debug`：返回 provenance 缺失计数、指标缺失计数和来源健康状态。
- Dashboard 的 `sources[]`：成功或 stale 时返回最近一次成功采集的 `latest_upstream` 和采集时间；当前 source 为 error 时这两个字段为 NULL，避免把上一轮地址误读成本轮成功。主题 `raw_signals` 仍保留对应历史证据。

如果 upstream 不可用，系统会显示来源异常/停用或 fallback 类型；不会用演示数据填充实时 Dashboard。
