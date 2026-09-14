# 原始来源层

这里按来源、按北京时间日分区保存源站原始记录。该层只负责忠实采集和完整性证明，不做摘要、标签、GitHub 仓库补全、跨源去重或条数截断。

## 处理链路

`source-raw` 是后续处理的唯一输入：

```text
源站 → 来源原始日文件 → 离线校验 → 本地标准化/精选/去重 → raw 日报 → final
```

`scripts/collect.js` 不再请求源站，只通过 `scripts/source_raw_items.js` 读取指定日文件。输出 JSON 的 `inputMode` 固定为 `source-raw`，每个 result 都有 `sourceRaw` 字段，记录输入文件日期、路径、哈希和采集时间。日报工作流使用 `--strict`，任一来源缺失或不完整都不会写出一份看似成功的报告。

```bash
cd .agents/skills/community-pulse
node scripts/collect.js --strict --date 2026-09-07 --observed-date 2026-09-08 \
  --markdown --out /tmp/2026-09-07.md --json-out /tmp/2026-09-07.json
```

`--date` 用于可按日归属的来源；`--observed-date` 用于 GitHub Trending 全球榜和中文圈榜的实际观察日。两者分开是为了防止把当前榜单伪装成昨日历史数据。

当前来源：

- `vibecafe/`：VibeCafé 作品，数据范围从平台上线日 `2026-06-02` 开始。`records` 里每个产品同时带 `logoUrl`（产品标志）与 `imageUrls`（软件配图，1~9 张，有顺序），两者语义不同，下游标准化为 `logo` 与 `images`，不要互相替代。
- `chinese-indie-dev/`：中国独立开发者 README 每日项目，年度数据从 `2026-01-01` 开始。
- `weekly-issues/`：`ruanyf/weekly` 的投稿 Issue，年度数据从 `2026-01-01` 开始。
- `hellogithub-issues/`：`521xueweihan/HelloGitHub` 的投稿 Issue，年度数据从 `2026-01-01` 开始。
- `weekly-issue/`：阮一峰《科技爱好者周刊》正式刊物，年度数据从 `2026-01-01` 开始。
- `hellogithub-issue/`：《HelloGitHub》月刊正式刊物，年度数据从 `2026-01-01` 开始。
- `producthunt/`：Product Hunt GraphQL `Post` 节点，年度数据从 `2026-01-01` 开始。
- `github-trending/`：GitHub Trending `daily` 全球榜完整 HTML 观察快照。逐日实时采集从 `2026-09-08` 开始；`2026-06-23 → 2026-09-01` 由 Internet Archive 归档回填（见下）。
- `github-trending-cn/`：GitHub Trending `daily` 中文口语筛选榜完整 HTML 观察快照。逐日实时采集从 `2026-09-08` 开始；归档回填只覆盖窗口内 16 天（`2026-06-25 → 2026-09-01` 中的零星日期），其余日子归档里没有这一榜。

GitHub Issues 来源的 `records` 保留 API 返回的 Issue 对象原貌。GitHub 的 Issues API 同时返回 Pull Request；PR 不属于投稿 Issue，因此在分日之前排除，并在每日文件的 `capture.excludedPullRequestCount` 中记录数量。

Issue 会在创建后发生关闭、评论等状态变化。历史文件标记为 `historical-reconstruction`，表示这是回溯抓取时观察到的源站状态；每日文件则在次日抓取，写入后默认不可变。历史重建还会与仓库内早先保存的源站原对象合并，当前 API 对象优先；已经删除、当前返回 404 但曾被抓到的 Issue 会保留，并由 `capture.supplementedFromPriorCaptureCount` 明示。

中国独立开发者来源的源站真值是一份按日期分节的 README。每日文件的 `sectionMarkdown` 原样保存对应的完整 Markdown 分节；`itemCount` 只用于完整性核对，解析、字段转换和状态中文化留给下游处理。没有对应分节的日期写成 `status: empty`，与抓取失败明确区分。

正式刊物来源的 `records` 保存 GitHub Contents API 返回的整期 Markdown 文件原对象（包含原始 base64 内容），而不是提前截取“推荐”条目。发布日期来自明确的 release commit，并按 `Asia/Shanghai` 归日；不能仅靠“周五”或“每月 28 日”推测。每个非空日都保留 release commit、文档路径和 Git blob SHA 证据。

Product Hunt 是 GraphQL API，不存在 REST 意义上的“返回整个对象”；每日文件的 `records` 原样保存查询所选择的全部 `Post`，`officialFeatured.records` 则原样保存同日 `featured: true` 的官方精选子集。两边都必须翻到 `hasNextPage=false` 且累计边数等于 API `totalCount`。新采集还会保存下游使用的 `featuredAt`/`votesCount`/`commentsCount`，避免生成报告时再查 API；早期已落盘文件没有这三个字段，下游按缺省值处理。日常报告只消费官方精选，全量底账不丢。日界线按 `Asia/Shanghai` 二次归属，邻日边界记录会排除并计数。

GitHub Trending 是随时变化的榜单，`since=daily` 表示趋势统计窗口，不是可查询的历史日期。因此文件日期是北京时间的实际观察日，实时采集的 `capture.mode` 是 `observed-snapshot`；抓取器会拒绝用当前页面回填过去日期。`response.body` 对完整 HTML 做无损 gzip 后以 base64 保存，可按 SHA-256 复核解压后原始字节，不只保留榜单前 15 条；仓库路径只作完整性校验证据。

归档回填的文件用第二种 `capture.mode`：`archived-observation`。它不是「拿今天的页面冒充过去」，而是 Internet Archive 在**那一天**抓下的同一页面，观察日期由归档本身携带，所以可以描述过去。这类文件额外带 `capture.archive`：归档时间戳、CDX digest、实际抓取 URL、当天在归档里的快照数，以及相对站内采集时刻（北京 `00:07`，即报告日 `16:07Z`）的偏移秒数 —— 回填时在同一北京日内挑离该时刻最近的一张。两条榜单的归档 URL 形态不同，必须按归档里真实存在的那条取：全球榜只有不带参数的 `https://github.com/trending` 是逐日归档的（带 `?since=daily` 的变体一年只有十几次），中文榜只有 `https://github.com/trending?spoken_language_code=zh` 有归档且覆盖稀疏；两个页面都按 GitHub 默认的 `daily` 窗口渲染，`capture.since` 仍记 `daily`。`historicalBackfillSupported: false` 在两种模式下都不变：实时采集器依旧不许回填。

回填只动 source-raw 与日报的**新增部分**：`backfill_report_trending.js` 把 Trending 结果条目和 Markdown 分区插进已发布日报（位置与现行版式一致，在 Product Hunt 之前），已有条目与正文逐字节不变 —— 该脚本用原文件的切片拼装，并在拼装时断言「非新增部分与原文完全相等」。语言不来自仓库快照（这些日子的快照是从已发布日报派生的，不认识新增仓库），而是取自归档页面自身的 `programmingLanguage` 字段，写进行的 `language`；star / fork 是测量值，不作为仓库事实写入。

每日可恢复增量：

```bash
cd .agents/skills/community-pulse
node scripts/capture_chinese_indie_raw.js --resume --end "$(TZ=Asia/Shanghai date -d yesterday +%F)"
node scripts/validate_chinese_indie_raw.js --start 2026-01-01 --end "$(TZ=Asia/Shanghai date -d yesterday +%F)"
node scripts/capture_github_issues_raw.js --resume --end "$(TZ=Asia/Shanghai date -d yesterday +%F)"
node scripts/validate_github_issues_raw.js --start 2026-01-01 --end "$(TZ=Asia/Shanghai date -d yesterday +%F)"
node scripts/capture_periodicals_raw.js --resume --end "$(TZ=Asia/Shanghai date -d yesterday +%F)"
node scripts/validate_periodicals_raw.js --start 2026-01-01 --end "$(TZ=Asia/Shanghai date -d yesterday +%F)"
node scripts/capture_producthunt_raw.js --date "$(TZ=Asia/Shanghai date -d yesterday +%F)"
node scripts/validate_producthunt_raw.js --start "$(TZ=Asia/Shanghai date -d yesterday +%F)" --end "$(TZ=Asia/Shanghai date -d yesterday +%F)"
node scripts/capture_github_trending_raw.js --date "$(TZ=Asia/Shanghai date +%F)"
node scripts/validate_github_trending_raw.js --date "$(TZ=Asia/Shanghai date +%F)"
```

`--resume` 会分别检查各个来源，从各自最早的缺失日开始恢复；没有历史缺口时只补昨天。

Product Hunt 的单日数据量和 GraphQL complexity 明显更高，历史回填需使用 `--resume --wait-on-rate-limit` 单独长跑；参数会按 API 返回的重置时间等待，并且每次只在整日分页完成后写文件。日常工作流始终先抓目标日，不会为了补历史而漏掉昨天。

Product Hunt 同一发布批次的 Post 会共享完全相同的 `createdAt`，而 API cursor 实际采用偏移量；`NEWEST` 或 `RANKING` 都可能在翻页间漂移，产生重叠并漏项。来源层使用 `order: RANKING`，遇重叠时按 ID 合并并重新扫完整连接；只有唯一 ID 数最终等于 API `totalCount` 才落盘，否则整日拒绝写入。

## 辅助证据层

除按来源分区的日快照外，这里还有两个不隶属于任何单一来源、由下游行派生的辅助目录。它们只保存证据，不保存摘要/标签，也不参与「来源层不做标准化」的判断：

- `github-repositories/YYYY-MM-DD.json`：当日所有来源里出现的 `github.com/owner/repo` 的 GitHub Repository API 原对象。`collect.js` 离线合并 star、语言、license 和 `homepage`。
- `site-logos/YYYY-MM-DD.json`：没有平台产品标志的行，其**官网自己声明的图标**（apple-touch-icon / `rel=icon` / schema.org logo / 兜底 `/favicon.ico`）。每条记录按 `sourceId + externalId` 指向日报的一行，只含 `pageUrl`、`iconUrl`、`contentType`、`byteLength`、`contentSha256`、`attempts[]`、`status`（`ok` / `missing` / `failed`）。

`site-logos` 的日期是「消费该行的 source-raw 日文件」的日期：普通来源用报告日，GitHub Trending 用观察日。因此同一个日文件会被两次运行写入——前一天的报告把它的 Trending 行按观察日存在这里，当天自己的报告再把普通来源行写到同一文件。记录里带 `reportDate`，脚本据此只重写自己那次运行的行，并始终保留另一次运行的结果，所以重跑同一天是幂等的（可加 `--refresh-failures` 只重试失败行）。

```bash
cd .agents/skills/community-pulse
node scripts/capture_site_logos_raw.js --date 2026-09-10 --observed-date 2026-09-11 --strict
node scripts/validate_site_logos_raw.js --date 2026-09-10
```
