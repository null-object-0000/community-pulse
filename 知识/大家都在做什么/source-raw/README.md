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

- `vibecafe/`：VibeCafé 作品，数据范围从平台上线日 `2026-06-02` 开始。
- `chinese-indie-dev/`：中国独立开发者 README 每日项目，年度数据从 `2026-01-01` 开始。
- `weekly-issues/`：`ruanyf/weekly` 的投稿 Issue，年度数据从 `2026-01-01` 开始。
- `hellogithub-issues/`：`521xueweihan/HelloGitHub` 的投稿 Issue，年度数据从 `2026-01-01` 开始。
- `weekly-issue/`：阮一峰《科技爱好者周刊》正式刊物，年度数据从 `2026-01-01` 开始。
- `hellogithub-issue/`：《HelloGitHub》月刊正式刊物，年度数据从 `2026-01-01` 开始。
- `producthunt/`：Product Hunt GraphQL `Post` 节点，年度数据从 `2026-01-01` 开始。
- `github-trending/`：GitHub Trending `daily` 全球榜完整 HTML 观察快照，从 `2026-09-08` 开始。
- `github-trending-cn/`：GitHub Trending `daily` 中文口语筛选榜完整 HTML 观察快照，从 `2026-09-08` 开始。

GitHub Issues 来源的 `records` 保留 API 返回的 Issue 对象原貌。GitHub 的 Issues API 同时返回 Pull Request；PR 不属于投稿 Issue，因此在分日之前排除，并在每日文件的 `capture.excludedPullRequestCount` 中记录数量。

Issue 会在创建后发生关闭、评论等状态变化。历史文件标记为 `historical-reconstruction`，表示这是回溯抓取时观察到的源站状态；每日文件则在次日抓取，写入后默认不可变。历史重建还会与仓库内早先保存的源站原对象合并，当前 API 对象优先；已经删除、当前返回 404 但曾被抓到的 Issue 会保留，并由 `capture.supplementedFromPriorCaptureCount` 明示。

中国独立开发者来源的源站真值是一份按日期分节的 README。每日文件的 `sectionMarkdown` 原样保存对应的完整 Markdown 分节；`itemCount` 只用于完整性核对，解析、字段转换和状态中文化留给下游处理。没有对应分节的日期写成 `status: empty`，与抓取失败明确区分。

正式刊物来源的 `records` 保存 GitHub Contents API 返回的整期 Markdown 文件原对象（包含原始 base64 内容），而不是提前截取“推荐”条目。发布日期来自明确的 release commit，并按 `Asia/Shanghai` 归日；不能仅靠“周五”或“每月 28 日”推测。每个非空日都保留 release commit、文档路径和 Git blob SHA 证据。

Product Hunt 是 GraphQL API，不存在 REST 意义上的“返回整个对象”；每日文件的 `records` 原样保存查询所选择的全部 `Post`，`officialFeatured.records` 则原样保存同日 `featured: true` 的官方精选子集。两边都必须翻到 `hasNextPage=false` 且累计边数等于 API `totalCount`。新采集还会保存下游使用的 `featuredAt`/`votesCount`/`commentsCount`，避免生成报告时再查 API；早期已落盘文件没有这三个字段，下游按缺省值处理。日常报告只消费官方精选，全量底账不丢。日界线按 `Asia/Shanghai` 二次归属，邻日边界记录会排除并计数。

GitHub Trending 是随时变化的榜单，`since=daily` 表示趋势统计窗口，不是可查询的历史日期。因此文件日期是北京时间的实际观察日，`capture.mode` 固定为 `observed-snapshot`；抓取器会拒绝用当前页面回填过去日期。`response.body` 对完整 HTML 做无损 gzip 后以 base64 保存，可按 SHA-256 复核解压后原始字节，不只保留榜单前 15 条；仓库路径只作完整性校验证据。

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
