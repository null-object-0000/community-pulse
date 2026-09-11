---
name: community-pulse
description: "聚合各社区/平台「大家都在做什么」动态：HN/V2EX 热榜、GitHub Trending 新仓库、社区新帖。数据源注册表驱动，统一 item 结构。触发词：大家都在做什么、热榜、社区动态、今日热点、HN、V2EX、GitHub trending、新产品、信息收集、聚合。"
---

# community-pulse（大家都在做什么）

聚合各社区/平台「大家都在做什么」的动态：热榜帖子、新仓库、新产品、新内容。
目标是回答"现在大家在关注什么、在做什么"。

## 用法

```bash
cd .agents/skills/community-pulse

# 从各来源最新的本地 source-raw 日文件输出 JSON
node scripts/collect.js

# 只处理指定源 / 输出到文件
node scripts/collect.js --source producthunt
node scripts/collect.js --out /tmp/pulse.json

# 指定报告日和 Trending 实际观察日
node scripts/collect.js --strict --date 2026-09-07 --observed-date 2026-09-08 --out /tmp/pulse.json

# 一次本地处理同时输出 md + json
node scripts/collect.js --strict --date 2026-09-07 --observed-date 2026-09-08 --markdown --out /tmp/pulse.md --json-out /tmp/pulse.json

# 日报生产模式：同时要求当日 GitHub 仓库原始快照
node scripts/collect.js --strict --require-github-repositories --date 2026-09-07 --observed-date 2026-09-08 --markdown --out /tmp/pulse.md

# 结果结构
# { inputMode: "source-raw", generatedAt, results: [ { sourceId, sourceName, sourceRaw, items: [...] } ] }
# 每个 item: { sourceId, title, url, author, authorUrl, publishedAt, summary, content, metrics, tags, externalId }
```

## 数据源

生产链路固定为“来源采集脚本 → `source-raw` 日文件 → 离线校验 → `source_raw_items.js` 标准化 → `collect.js` 去重/渲染”。`collect.js` 和后续脚本不得二次请求源站。`scripts/sources/*.js` 是旧直连采集器，仅供查阅旧解析逻辑，不在日报主链路执行。

注册表：`config/sources.json`（开关、名称和下游截断数在这里）

| id | 内容 | 抓取方式 | 昨日过滤 |
|----|------|----------|----------|
| vibecafe | VibeCafé 作品（最新产品） | `/api/products` 游标翻页 + 每个产品详情页 RSC 原始响应 | ✅ 按 createdAt 北京日归档 |
| chinese-indie-dev | 中国独立开发者每日项目 | README 完整日分节落盘 | ✅ 按分节日期归档 |
| weekly-issues | 阮一峰周刊·用户投稿 | `gh api` 列 issues 按 created_at 过滤 | ✅ 按北京时间昨日过滤 |
| weekly-issue | 阮一峰周刊·正刊推荐 | release commit + 整期 Contents 原对象 | ✅ 按 release commit 北京日归档 |
| hellogithub-issues | HelloGitHub·用户投稿 | `gh api` 列 issues 按 created_at 过滤 | ✅ 按北京时间昨日过滤 |
| hellogithub-issue | HelloGitHub·月刊推荐 | release commit + 整期 Contents 原对象 | ✅ 按 release commit 北京日归档 |
| github-trending | GitHub Trending 每日热榜 | 完整 HTML 无损压缩快照 | ⚪ 只有实际观察日 |
| github-trending-cn | GitHub Trending 中文圈 | 完整 HTML 无损压缩快照 | ⚪ 只有实际观察日 |
| producthunt | Product Hunt 新品 | GraphQL 全量分页 + 官方精选子集 | ✅ 按 createdAt 北京日归档 |

所有来源中只要能从结构化字段、产品详情或正文识别出 `github.com/owner/repo`，就由 `capture_github_repositories_raw.js` 统一请求 GitHub Repository API，将原始仓库对象落在 `source-raw/github-repositories/YYYY-MM-DD.json`。`collect.js` 只离线合并 star、fork、语言、许可证、创建/更新时间等字段。

**历史日快照缺失时**：`source-raw/github-repositories/` 只从 2026-09-07 开始有快照。更早的日期（如 09-05/09-06）识别出的仓库没有指标行——此时用 `capture_github_repositories_raw.js --date <历史日> --observed-date <今天>` 补一份「当前值」快照（记录抓取时间=今天，观察日=今天，不伪装成历史当日值），之后重跑 collect 即可显示指标。快照文件按 `targetDate`（报告日）落盘，`observed-date` 仅记录观察日。

```bash
node scripts/capture_github_repositories_raw.js --date 2026-09-07 --observed-date 2026-09-08
node scripts/validate_github_repositories_raw.js --date 2026-09-07
```

**vibecafe 抓取要点**（`scripts/sources/vibecafe.js`）：
- 用 `curl -x 代理 -H 'RSC: 1' https://vibecafe.ai/products`，响应是 Next.js RSC flight 流，产品数据在 `initialProducts` 数组里（**干净 JSON**，不是 HTML 转义，别去挖 `self.__next_f`——那个是多重转义很坑）。
- 每个产品字段：`id, name, tagline, logoUrl, imageUrls, createdAt($D前缀ISO), owner{handle,name,labels}, websiteUrl`。
- 分页：流末尾有 `initialNextCursor` 游标（当前只用首页，约30条覆盖昨日足够）。
- 有 `createdAt` 所以能按昨日精确过滤——这是与 HN/V2EX 热榜源的本质区别。
- 列表接口不包含完整的外链。来源采集阶段必须同时保存每个产品详情页的 RSC 原始响应；下游再离线提取 `websiteUrl` 和 GitHub 仓库地址。历史无详情响应的 schema v1 文件仍可读取。

**chinese-indie-dev 抓取要点**（`scripts/sources/chinese-indie-dev.js`）：
- `gh api repos/1c7/chinese-independent-developer/readme --jq '.content'` 拿 base64 → 解码。
- README 结构：`### YYYY 年 M 月 D 号添加` 分节 → 作者行 `#### 名称 - [Github](url)` → 项目行 `* :white_check_mark: [名称](url)：介绍`。
- 状态：`:white_check_mark:`=已上线 `:clock8:`=开发中 `:x:`=已关闭（进 tags）。
- 日期在节标题里（北京时间），直接按节过滤昨日，天然精确。
- 注意：注册表 `id` 必须与文件名一致（collect.js 按 `sources/<id>.js` require）。

**阮一峰周刊双源**（`scripts/sources/weekly-issues.js` + `weekly-issue.js`）：
- **weekly-issues（投稿）**：`gh api repos/ruanyf/weekly/issues?state=all&per_page=100&sort=created&direction=desc`，按 created_at（北京时间）过滤昨日。标题带前缀标签（【开源自荐】【工具自荐】〖独立工具推荐〗投稿: 等）。body 是富文本自荐，summary 需清洗 markdown 语法后取第一段。**标题含「文章自荐/文章推荐/文章投稿」标签的文章投稿一律排除**（如「【文章自荐】…」「文章投稿：…」，含全角括号变体），日报只收录工具/项目类投稿；过滤实现见 `source_raw_items.js` 的 `issueItems()`。
- **weekly-issue（正刊）**：README 顶部引用最新期号 → `docs/issue-NNN.md`。只取「推荐」小节（工具/资源/软件/AI 工具/学习资源），**排除文章/科技动态/言论/图片/文摘**。条目 `N、[名称](链接)`，**简介在下一行**（图片行前），简介末尾 `（[@作者](issue链接) 投稿）` 关联回原始 issue（`relatedIssue` 字段）。**发布日判断：正刊周五发布，`opts.date` 非周五 → 返回空**（`needs_date: true` 让 collect.js 传 date）。
- **docs 目录列文件按字母序会错**（issue-99 > issue-411），别用目录列文件找最新期，用 README 引用。

**HelloGitHub 双源**（`scripts/sources/hellogithub-issues.js` + `hellogithub-issue.js`）：
- **hellogithub-issues（投稿）**：同阮一峰 issues 逻辑，`gh api repos/521xueweihan/HelloGitHub/issues?state=all&per_page=100&sort=created&direction=desc`，标题前缀 [开源推荐]/[开源自荐]/[Open Source] 等。
- **hellogithub-issue（月刊）**：最新期号在 `content/HelloGitHubNN.md`（**按数字取最大**，目录字母序会错）。条目按语言分类节（`### C 项目`/`### Go 项目` 等），格式 `N、[名称](链接)：介绍`，链接是 `hellogithub.com/periodical/statistics/click?target=<真实URL>`（需解出 target 参数）。末尾 `来自 [@分享者](hellogithub.com/user/xxx) 的分享` = 投稿人（`relatedShare` 字段）。**发布日判断：每月 28 号发布，`opts.date` 非 28 号 → 返回空**（`needs_date: true`）。

**定期发布源统一约定**：周刊/月刊这类 `daily_filter=false` 的源，加 `needs_date: true`，collect.js 会传 `opts.date` 给模块，模块自己判断"昨日是否是发布日"，不是就返回空数组 → md 里自动隐藏（0 条不显示）。

**github-trending 要点**（`scripts/sources/github-trending.js`）：
- 抓 `https://github.com/trending?since=daily`（daily/weekly/monthly 可选，注册表 `since` 字段）。
- 新版页面无 `repo-stars-counter-star` 语义结构，数字是裸文本序列 `... 语言  <总star>  <forks>  Built by <今日star> stars today`。
- **解析数字前必须先去掉 HTML tag**（否则 class/aria 里的数字会混入导致错位）。
- 今日新增 star 是趋势核心指标；本机走代理，Actions runner 直连（GitHub 自家域名）。

## GitHub 开源项目信息补全（已移出主链路）

采集阶段对**URL 是 `github.com/owner/repo`** 的条目，调 GitHub API 补仓库基础信息（star/fork/语言/license/描述/创建时间/更新时间/archived），存进 item 的 `github` 字段；md 渲染时在描述下方加一行小字。

- `collect.js --enrich-github` 现在会直接报错，因为它会在原始层之后再请求 GitHub API，破坏可复现性。
- 如果以后需要 star/fork/license 等信息，应先建立独立的按日原始快照和校验器，再由后续处理读取，不得在报告生成时即时联网。
`enrich_github.js` 仅保留为旧实验工具，不得接入 `collect.js`、日报或回溯 workflow。

## 网络/代理（仅来源采集层）

本机系统代理是 Clash `127.0.0.1:7890`（gsettings 配了手动代理但**未导出环境变量**）。
代理只由 `capture_*_raw.js` 系列来源采集脚本使用。`collect.js` 是纯本地读取，不设置代理，不执行 `curl`/`gh`。

## 新增数据源

1. 建立不做标准化和截断的 `capture_xxx_raw.js`，按日写入 `source-raw/xxx/YYYY-MM-DD.json`。
2. 建立不联网的 `validate_xxx_raw.js`，校验完整性、日归属、数量和内容哈希。
3. 在 `scripts/source_raw_items.js` 注册纯函数转换器，只把原始文件转成统一 item。
4. 在 `config/sources.json` 注册来源，并把采集+校验加入日报 workflow。
5. 跑 `node scripts/collect.js --strict --source xxx --date YYYY-MM-DD` 验证纯本地处理。

## 手动重跑/重发前必查

用户要求"重新触发 Actions/重发日报"时，先核对两件事再动手：① cron 列表里日报任务今天的 last run 是否 ok（成功则今早已自动发送过一次）；② final/<日期>.md 的 mtime 是否今天生成。若当天已发送，必须先告知用户并确认再重发，否则会重复发消息（已发生：2026-09-09 用户问"为啥发我了两遍"）。

## 关键坑（务必看）

- **网络/代理**：本机系统代理是 Clash `127.0.0.1:7890`（gsettings 配了手动代理但**未导出环境变量**）。
  - 只有来源采集脚本使用 `COMMUNITY_PULSE_PROXY`；Actions 将它设为空字符串直连。
  - `collect.js` 完全不联网，不应包含任何代理、`curl`或 `gh` 逻辑。
- **gh 字段名**：`gh search repos --json` 的字段是 `language`（不是 `primaryLanguage`），否则报 "Unknown JSON field"。
- 交互查看时单个源失败会写入 `error`；生产 workflow 必须使用 `--strict`，任一输入失败就停止。

## 渲染

`collect.js` 可从同一批本地输入一次生成 JSON 和 Markdown。后续如需 HTML 报纸/LLM 分组，只读取这些已生成产物，不动抓取层。

`enhance.js` 为每条内容生成中文摘要与英文摘要，并为含中文的标题生成英文标题。中文 final Markdown 保持可直接发送，同时用隐藏的 `devtrends-i18n` 元数据保存 `titleEn`、`summaryZh`、`summaryEn`，供网站构建中英文页面；构建阶段不得再调用 LLM。

Markdown 条目的三级标题统一使用纯文字，不在产品名称上包超链接。主链接和补充链接统一放在描述/指标下方的 `🔗` 行，按目标标注为“官网 / GitHub / VibeCafé / Product Hunt / 原文 / 投稿页”。

## 回溯 / 存量同步（2026-09 建成）

历史数据回溯的脚本都在 `scripts/`，用途如下：

| 脚本 | 用途 | 说明 |
|------|------|------|
| `sync_issues_full.js` | issues 全量拉取 (ruanyf + hellogithub) | 从最老往最新翻页, 断点续传, 存 `data/issues/<repo>.json` |
| `sync_ruanyf_cursor.js` | ruanyf cursor 补拉 | GitHub >10000 条 issue 列表强制 cursor 分页 (`after=` 参数, page 参数会 422), 与已有合并去重 |
| `backfill_sub_from_store.js` | 用 issues 存量回填 raw 的投稿源 | 存量是"事后完整真值", raw 每天 = 存量当天新增; **存量侧必须按北京时间归天**(`created_at` 是 UTC, `[:10]` 切是 UTC 日期会错位) |
| `backfill_indie_dev.js` | chinese-indie-dev 全量重建 | 该源所有日期都在同一个 README 里, 一次抓取按日期回填全部 raw; empty 天=README 无当日节(真实无数据, 非漏) |
| `backfill_vibecafe.js` | vibecafe 回溯回填 | 用 `/api/products?cursor=` **干净 JSON 分页 API**(不是 RSC 流), 翻页全量抓取按北京日期回填 |
| `fill_vibecafe_empty.js` | vibecafe 缺失源补空 | 无产品日补显式 `items: []`(collect.js 空结果也 push 源, 源缺失=当时抓取失败被跳过, 不自洽) |
| `ph_backfill.js` | Product Hunt 旧混合层回溯（已废弃） | 只取首屏且写入标准化 item，不能作为来源层全量数据 |

## 原始来源层（source-raw）

`知识/大家都在做什么/raw/` 是旧的混合日报层，已经包含标准化、去重和渲染逻辑，不能作为不可变的源站原始数据。新的来源层按来源独立建设在：

```text
知识/大家都在做什么/source-raw/<source-id>/YYYY-MM-DD.json
```

VibeCafé 已实现：

```bash
# 历史全量重建（游标翻页到库尾，源对象原样按北京时间归日）
node scripts/capture_vibecafe_raw.js --start 2026-06-02 --end 2026-09-07

# 离线完整性校验
node scripts/validate_vibecafe_raw.js --start 2026-06-02 --end 2026-09-07

# 每日抓取已完整结束的某一天
node scripts/capture_vibecafe_raw.js --date 2026-09-07

# 每日可恢复增量：从起始日找到最早缺失文件，通常只补北京时间昨天
node scripts/capture_vibecafe_raw.js --resume --end 2026-09-07
```

GitHub 投稿 Issues 已实现（`weekly-issues` 与 `hellogithub-issues` 分开落盘）：

```bash
# 2026 年度全量；records 保留 GitHub Issue API 原对象，明确排除接口混入的 PR
node scripts/capture_github_issues_raw.js --start 2026-01-01 --end 2026-09-07

# 每日可恢复增量与离线全区间校验
node scripts/capture_github_issues_raw.js --resume --end 2026-09-07
node scripts/validate_github_issues_raw.js --start 2026-01-01 --end 2026-09-07
```

中国独立开发者已实现：

```bash
# README 每日原始 Markdown 分节；不把标准化 item 当作原始数据
node scripts/capture_chinese_indie_raw.js --start 2026-01-01 --end 2026-09-07

# 每日可恢复增量与离线校验
node scripts/capture_chinese_indie_raw.js --resume --end 2026-09-07
node scripts/validate_chinese_indie_raw.js --start 2026-01-01 --end 2026-09-07
```

阮一峰周刊正刊与 HelloGitHub 月刊已实现：

```bash
# 整期 GitHub Contents API 原对象；发布日期取明确的 release commit 北京时间
node scripts/capture_periodicals_raw.js --start 2026-01-01 --end 2026-09-07

# 每日可恢复增量与离线校验
node scripts/capture_periodicals_raw.js --resume --end 2026-09-07
node scripts/validate_periodicals_raw.js --start 2026-01-01 --end 2026-09-07
```

Product Hunt 已实现：

```bash
# 需 PRODUCT_HUNT_TOKEN；GraphQL cursor 翻到 hasNextPage=false 后才落当天文件。
# 官方限额是每应用每 15 分钟 6250 complexity points，不是每日额度。
node scripts/capture_producthunt_raw.js --start 2026-01-01 --end 2026-09-07

# 每日可恢复增量与离线完整性校验
node scripts/capture_producthunt_raw.js --resume --wait-on-rate-limit --end 2026-09-07
node scripts/validate_producthunt_raw.js --start 2026-01-01 --end 2026-09-07

# 从新到旧试跑；遇到限流立即停，已完整落盘的日期保留
node scripts/capture_producthunt_raw.js --start 2013-11-22 --end 2026-09-07 --reverse --resume --stop-on-rate-limit
```

GraphQL 没有“自动返回完整对象”的语义；`records` 保存同日全部 Post，`officialFeatured.records` 保存 `featured: true` 官方精选子集，两者都保留独立的分页与 `totalCount` 证明。日报只消费官方精选，全量仅作为底账。时间窗口稍微覆盖北京日边界，再按 `createdAt` 二次归日；遇限流后可从最早缺失日恢复。

新采集的 Product Hunt Post 保留官方 `website` 与 `productLinks { type url }`，并对官方精选的这些 URL 去重后执行链接解析，存入 `linkResolution.links`。最多 3 并发、每请求 12 秒、每次最多 5 跳、最多 2 次尝试（间隔 1 秒）；优先 HEAD，无法取得跳转时 GET，收到响应头立即终止正文传输。只请求 PH 域名，一旦 Location 指向外部即停止，因此 `ok` 表示解析成功，`verified: false` 表示未验证目标可访问性。失败也记录并缓存，`complete` 表示所有链接已尝试，不代表全部成功；已有结果仅 `--refresh-links` 显式刷新，日常 `--resume` 不重试历史失败。

产品页完整 HTML 快照改为默认关闭的可选增强：新日采集设置 `PRODUCT_HUNT_PAGE_CAPTURE=1` 才抓取，已有日期仅 `--refresh-pages` 显式重抓（该参数同时启用抓页）。关闭时不新建 `productPages`，历史快照保持可读。原因：API 已覆盖所需介绍与外链，当前出口页面访问被 PH 封禁（403），页面 description 多数与 API 相同或只是更泛的品牌介绍，没有稳定增量价值。单个链接或页面失败均降级记录，不阻止当日 API 数据落盘。

日报摘要优先 API `description` / `tagline`，缺失才回退到历史页面简介；当次发布信息仍保留在 `launch`。官网优先解析结果，再回退历史页面 `websiteUrl`、API `website`；`productLinks` 也使用解析后的 URL，使 GitHub 链接进入统一仓库发现与快照链路。下游完全离线，历史无 `linkResolution`、v1/v2 `productPages` 文件继续兼容。

```bash
# 用已有 API 日文件补解析，无需 PH token；失败缓存，重跑不重复请求
node scripts/capture_producthunt_raw.js --date 2026-09-10
# 显式刷新链接（也可配合 --resume）
node scripts/capture_producthunt_raw.js --date 2026-09-10 --refresh-links
```

同一 Product Hunt 发布批次的 Post 可能共享完全相同的 `createdAt`，API cursor 又是偏移量；`NEWEST`/`RANKING` 都可能在翻页间漂移并造成跨页重叠。实测 `RANKING` 会随投票变化产生大量重叠，来源层使用相对稳定的 `order: NEWEST` 扫描，按 Post ID 合并多轮完整 sweep；只有唯一 ID 数等于 API `totalCount` 才写文件，否则整日拒绝落盘。

GitHub Trending 全球榜与中文圈榜已实现：

```bash
# 只能抓当前北京日；完整 HTML 无损 gzip+base64 保存，不做条数截断
node scripts/capture_github_trending_raw.js --date 2026-09-08
node scripts/validate_github_trending_raw.js --date 2026-09-08
```

Trending 不提供历史日期查询；`since=daily` 是统计窗口而非日期。文件日期必须是实际观察日，历史缺口不能伪回填。来源层保存完整响应体、原始响应头、请求参数、字节数和 SHA-256；解析出的仓库路径仅用来证明每个 `Box-row` 都可识别。

来源层禁止标签、LLM 增强、GitHub 补全、跨源去重和条数截断。每个文件必须记录 `status`、`complete`、`fetchedAt`、记录数、内容哈希，并依源类型保留分页终止或完整页面证据；历史重建必须标记为 `historical-reconstruction`，不能伪装成当日实时快照。

**关键发现/坑：**
- **GitHub 大数据集分页**: issues >10000 条时 page 参数返回 422, 必须用 `after=` cursor(从响应头 `Link: rel="next"` 提取)。`sync_ruanyf_cursor.js` 即此模式。
- **VibeCafé 可回溯性**: 平台 2026-06-02 上线; 页面"加载更多"走 `/api/products?cursor=` JSON API(每页50)。2026-09-08 验证时翻 9 页到底共 432 个产品（数量会持续增长），最早记录为北京时间 6/3；6/2 是经完整翻页确认的真实空日。**首页 RSC 流只有最近 50 个**, 回溯必须翻页 API。`?date=` 参数是假的(忽略)。
- **issues 存量在 gitignore 外**: `data/issues/*.json` 是历史全集, 需入库固化(之前 gitignore 整个 data/ 会挡); 现在只 ignore `data/tmp/` `data/cache/`。
- **投稿源历史真值**: GitHub `/issues` 会混入 PR，必须按 `pull_request` 字段排除。历史重建取“当前 API + 既有源站原对象”的并集，当前 API 对象优先；这样既补上旧分页缺口，也保留后来删除、当前已 404 的 Issue。每日文件仍按北京时间 `created_at` 归天并保持不可变。
- **正式刊物发布日期**: 周刊/月刊原始层必须从 release commit 取北京时间日期，不能只按规则日推算。2026 年 HelloGitHub 第 120 期在 3 月 27 日发布，第 123 期在 6 月 29 日发布，都不是 28 日。原始层保存整期 Contents API 对象，下游再选择推荐栏目。
- **Product Hunt 旧回溯不完整**: 旧 `ph_backfill.js` 使用 `first: 50` 但没有请求 `pageInfo`/cursor，现存混合层 220 个有数据日恰好都是 20 条（共 4400 条），只能证明拿到了首屏，不能证明全量。来源层必须逐日翻页到 `hasNextPage=false`，并保留分页终止证据；Token 只从 `PRODUCT_HUNT_TOKEN` 环境变量读取，不能把 GitHub Actions secret 写入仓库或日志。
- **GitHub Trending 无法回溯**: `since=daily` 只筛当前趋势窗口，页面没有指定历史日期的能力。从 `2026-09-08` 起每天保存全球榜和中文圈榜的实际观察快照；早于此日的旧混合层标准化记录不反推成原始 HTML。
