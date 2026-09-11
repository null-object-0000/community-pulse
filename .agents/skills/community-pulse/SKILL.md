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
| chinese-indie-dev | 中国独立开发者主版面每日项目 | README 完整日分节落盘 | ✅ 按分节日期归档 |
| chinese-indie-dev-programmer | 中国独立开发者·程序员版 | `.github/pages/README-Programmer-Edition.md` 完整日分节落盘 | ✅ 按分节日期归档 |
| chinese-indie-dev-game | 中国独立开发者·游戏版 | `.github/pages/README-Game.md` 完整日分节落盘 | ✅ 按分节日期归档 |
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
- **图片分两类，不要混用**：`logoUrl` 是产品标志（列表 48px 头像用它，标准化为 `logo`）；`imageUrls` 是软件配图/截图，1~9 张且有顺序，标准化为 `images`（全部保留，不截断），`image` 仍等于首张配图。站点把配图渲染成缩略图条 + 灯箱查看器；只有 logo 会经 `npm run images:sync` 镜像落盘，配图不落盘、页面直接回源（域名白名单见站点侧 `hotlinkOrigins`）。
- 老日报若缺少 `logo` / `images`，用离线脚本补齐（只改这两个字段，不重跑 collect，避免顺带改写其他来源）：
  `node scripts/backfill_vibecafe_media.js [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--dry-run]`
- 分页：流末尾有 `initialNextCursor` 游标（当前只用首页，约30条覆盖昨日足够）。
- 有 `createdAt` 所以能按昨日精确过滤——这是与 HN/V2EX 热榜源的本质区别。
- 列表接口不包含完整的外链。来源采集阶段必须同时保存每个产品详情页的 RSC 原始响应；下游再离线提取 `websiteUrl` 和 GitHub 仓库地址。历史无详情响应的 schema v1 文件仍可读取。

**中国独立开发者三个版面**（`scripts/capture_chinese_indie_raw.js` + `scripts/chinese_indie_boards.js`）：
- 上游仓库 `1c7/chinese-independent-developer` 有 **3 个版面**，格式完全一样但内容不同：主版面 `README.md`（打开即用的网站/App）、程序员版 `.github/pages/README-Programmer-Edition.md`（命令行/开源/开发工具）、游戏版 `.github/pages/README-Game.md`。三个版面各自独立成源，各自写 `source-raw/<source-id>/YYYY-MM-DD.json`。
- 版面注册表在 `scripts/chinese_indie_boards.js`（`main` / `programmer` / `game` → sourceId、sourceName、文档路径、tag）。采集与校验都用 `--board main|programmer|game` 选版面，默认 `main`；`--board` 决定输出目录，不要再用 `--out-root` 手工指向别的源。
- 主版面走 `gh api repos/1c7/chinese-independent-developer/readme`，子版面走 `gh api repos/.../contents/<path>`；两者都是 base64 内容 + `sha`，抓取函数同一套（`fetchDocument`）。
- 文档结构：`### YYYY 年 M 月 D 号添加` 分节 → 作者行 `#### 名称 - [Github](url)` → 项目行 `* :white_check_mark: [名称](url)：介绍`。
- 状态：`:white_check_mark:`=已上线 `:clock8:`=开发中 `:x:`=已关闭（进 tags；子版面额外带 `程序员版` / `游戏版` tag）。
- 日期在节标题里（北京时间），直接按节过滤；没有当日节 = `status: "empty"` 的真空白日，不是漏抓（子版面发帖频率低，空日很多：2026 年程序员版 58 个活跃日、游戏版 40 个活跃日）。
- `capture` 里主版面保留历史字段 `readmePath/readmeSha/readmeSize`（2026 年 1 月起的存量文件只有这些），新文件统一另写 `documentPath/documentSha/documentSize`；校验器两者都认（`documentSha || readmeSha`）。
- 注意：注册表 `id` 必须与 source-raw 目录名一致；三个版面靠 `source_raw_items.js` 里的同一个 `chineseIndieItems` 转换器标准化，版面差异只由 `src.id` 决定。
- **`--resume` 只补最早缺失日、不覆盖已存在文件**：如果某天在当天结束前被抓过一次（例如回溯命令的 `--end` 写到了今天），那个文件会永久停在当时的空内容上，正式日报也不会再修它。补历史时 `--end` 只能用**已经结束的北京日**；发现这类脏文件要用 `--replace --date <日期>` 重抓。

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

`enhance.js` 为每条内容生成中文摘要与英文摘要，并为含中文的标题生成英文标题。它还必须从 `web/shared.js` 的固定分类中选择一个 `primaryCategory`；分类与翻译在同一次 LLM 请求中完成。中文 final Markdown 保持可直接发送，同时用隐藏的 `devtrends-i18n` 元数据保存 `titleEn`、`summaryZh`、`summaryEn`、`primaryCategory`，供网站构建中英文页面与分类筛选；构建阶段不得再调用 LLM。旧 final 缺少分类时由 `web/shared.js` 的本地规则回退，不修改历史文件。

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
| `backfill_vibecafe_media.js` | vibecafe 旧日报补 `logo`/`images` | 只改这两个字段, 不重跑 collect |
| `backfill_producthunt_media.js` | Product Hunt 旧日报补 `logo`/`images` | 从 `officialFeatured.records` 的 `thumbnail`/`media` 映射, 映射规则与 `source_raw_items.js` 一致, 只改 media 字段 |
| `capture_producthunt_post_media.js` | 旧混合层 PH 行补媒体 | 按 日报 引用的 Post ID 调 `post(id:)`, 写入来源层新增 `recordMedia` 段(不动 `records`/`officialFeatured`); 只抓同日 `records` 里可归属的 ID, 限流停跑可续 |
| `ph_backfill.js` | Product Hunt 旧混合层回溯（已废弃） | 只取首屏且写入标准化 item，不能作为来源层全量数据 |
| `capture_site_logos_raw.js` | 官网 Logo 兜底抓取 | 没有平台产品标志的行改读官网声明的图标, 按来源层日期落 `source-raw/site-logos/<date>.json`; 见下节 |
| `validate_site_logos_raw.js` | 离线校验官网 Logo 层 | 用 source-raw 重算候选行, 校验计数/哈希/ok 记录的证据与覆盖率, 不联网 |
| `backfill_site_logos.js` | 旧日报回填 `siteLogo` | 只把已抓到的图标 URL 写进缺标志的行, 不重跑 collect |

## 官网 Logo 兜底层（site-logos）

平台没给产品标志的行（阮一峰/HelloGitHub 投稿与正刊、中国独立开发者、GitHub Trending）以前只能显示文字首字母。
这一层让它们改读**项目官网自己声明的 logo**，作为最终兜底；官网也拿不到时才回到文字。

```text
知识/大家都在做什么/source-raw/site-logos/<date>.json
```

这一层是**辅助证据层**，不是某个来源的日快照：每条记录按 `sourceId + externalId` 指向日报里的一行，
只保存证据字段（`pageUrl` / `iconUrl` / `iconKind` / `contentType` / `byteLength` / `contentSha256` /
`attempts[]` / `status` / `error`），不保存标题、摘要或标签，因此不违反「来源层不做标准化」的约定。

`<date>` 用「消费该行的那份 source-raw 日文件」的日期：普通来源是报告日，GitHub Trending 是观察日
（与 `source_raw_items.js` 里 `OBSERVED_SOURCES` 的判定一致），所以一次日报抓取会写两个文件（TARGET 与 OBSERVED）。

**同一个日文件会被两次运行写入**：前一天的报告把 Trending 行按观察日存进来，当天自己的报告再把普通来源行
写到同一文件。记录里带 `reportDate`，脚本只重写自己那次运行的行并保留另一次运行的结果，因此重跑同一天是
幂等的；`validate_site_logos_raw.js` 也按两天窗口核对覆盖率（当天报告 + 前一天报告的 Trending 行）。

```bash
cd .agents/skills/community-pulse

# 日报：TARGET=昨天、OBSERVED=今天
node scripts/capture_site_logos_raw.js --date 2026-09-10 --observed-date 2026-09-11 --strict
node scripts/validate_site_logos_raw.js --date 2026-09-10

# 试跑 / 预览（不联网写盘）
node scripts/capture_site_logos_raw.js --date 2026-09-10 --dry-run
node scripts/capture_site_logos_raw.js --date 2026-09-10 --limit 5 --out-root /tmp/logos

# 历史回填：抓取区间内每一天，再把结果写进旧日报
node scripts/capture_site_logos_raw.js --start 2026-08-01 --end 2026-09-10
node scripts/validate_site_logos_raw.js --start 2026-08-01 --end 2026-09-10
node scripts/backfill_site_logos.js --start 2026-08-01 --end 2026-09-10 --dry-run
node scripts/backfill_site_logos.js --start 2026-08-01 --end 2026-09-10
cd ../../.. && npm run images:sync && npm run check
```

**规则（`scripts/site_logo.js`，纯函数，站点测试也用它）**

- 候选官网：`websiteUrl` → 仓库 `homepage` → 行自身 `url`。仓库 `homepage` 只存在于 GitHub 仓库快照里，
  所以抓取必须晚于 `capture_github_repositories_raw.js`（脚本会像 collect.js 一样离线合并快照）。
- 跳过平台页：GitHub/GitLab/Gitee 等代码站、应用商店（App Store / Google Play / Chrome 应用店）、
  微信知乎 B 站 X Medium 等内容平台、搜索引擎、README 徽章等文件链接。这些站的图标在几十行里反复出现，
  还会把项目认成平台，反而不如项目自己的首字母；`github.io` 这类项目页不算平台。
- 图标优先级：apple-touch-icon → `rel=icon` 且 sizes ≥ 96 → SVG icon → 其他 `rel=icon` →
  schema.org `logo`（`image` 是截图，不取）→ `/favicon.ico`。声明里的 `data:` 图标不能镜像，直接跳过。
- 选中的图标必须下载成功并按字节嗅探确认是图片（HTML 报错页不算），失败就试下一个候选。
- **单图上限 256KiB**（`SITE_LOGO_MAX_KB` 可调）：1MB 的「品牌大图」很常见，而镜像的图标会永久留在 Git 里，
  超预算就跳到下一个候选（通常是 favicon），全部超预算则该行回到文字。
- 断点续跑：同一天重跑不会重复抓取已成功的行；`--refresh-failures` 只重试上次 failed/missing 的行，
  `--replace` 重抓本次运行负责的全部行。同一次运行内按页面和图标 URL 去重，回填多天时重复站点只抓一次；
  命中缓存的页面/图标在记录里标 `cached: true`。

**下游**：`source_raw_items.js` 的 `loadItems` 离线把 `siteLogo` 挂到「无 `logo`/`icon`」的行上
（按 sourceId+externalId 匹配，退化时按页面 URL），`collect.js` 不联网；站点把 `siteLogo` 与 `logo`/`icon`
一起镜像（`npm run images:sync`）并按 `logo → icon → siteLogo → 文字` 渲染 48px 头像。图标下载失败时
清单里记 `null`，该行自动回到文字，不会出现破图。

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

中国独立开发者已实现（三个版面各自独立按日落盘）：

```bash
# 主版面：README 每日原始 Markdown 分节；不把标准化 item 当作原始数据
node scripts/capture_chinese_indie_raw.js --start 2026-01-01 --end 2026-09-10

# 子版面：程序员版 / 游戏版，同一脚本用 --board 选择
node scripts/capture_chinese_indie_raw.js --board programmer --start 2026-01-01 --end 2026-09-10
node scripts/capture_chinese_indie_raw.js --board game --start 2026-01-01 --end 2026-09-10

# 每日可恢复增量与离线校验（每个版面各跑一次）
node scripts/capture_chinese_indie_raw.js --resume --end 2026-09-10
node scripts/validate_chinese_indie_raw.js --start 2026-01-01 --end 2026-09-10
node scripts/capture_chinese_indie_raw.js --board programmer --resume --end 2026-09-10
node scripts/validate_chinese_indie_raw.js --board programmer --start 2026-01-01 --end 2026-09-10
node scripts/capture_chinese_indie_raw.js --board game --resume --end 2026-09-10
node scripts/validate_chinese_indie_raw.js --board game --start 2026-01-01 --end 2026-09-10
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

**产品图**：官方精选子集多投影两个字段——`thumbnail { type url }`（产品标志，标准化为 `logo`）与 `media { type url videoUrl }`（发布会图集，标准化为 `images`；视频条目的 `url` 是自动生成的封面，所以图集始终只有图片）。全量 sweep 不投影这两个字段：它每天 800+ 条，投影后只会让日文件与复杂度无谓膨胀。旧日文件（`officialFeatured.capture.sourceFields` 里没有 `media`）在标准化时自然没有 logo/配图，用 `--refresh-featured` 按范围补回：

```bash
# 只重抓官方精选子集（每天约 1~2 个请求），不重抓全量
node scripts/capture_producthunt_raw.js --refresh-featured --start 2026-08-01 --end 2026-09-10
node scripts/validate_producthunt_raw.js --start 2026-08-01 --end 2026-09-10
```

`--refresh-featured` 是**增量**的：`officialFeatured.capture.sourceFields` 已含 `thumbnail` 的日期直接跳过，所以限流中断后重跑只补剩余日期，不会反复重刷已升级的日期（这一条对 Actions 的 `while` 重试循环是必需的）。

**注意成本**：刷新精选子集会重写该日精选 records（PH 的 `/r/...` 跳转 token 每次请求都会变），因此每次刷新都会连带重跑这些精选链接的 `linkResolution`——校验器要求链接覆盖与 records 完全一致，不能跳过。实测 Actions 出口访问 PH 跳转页返回 403，这些解析会全部记成 `ok:false` 的失败快照（快速失败，不阻断落盘）。按 253 天估算约 1.5 小时。

GitHub Actions 侧用 `producthunt-backfill.yml` 的 `refresh_featured=true` 输入执行同一件事（默认 false，行为不变）：

```bash
gh workflow run producthunt-backfill.yml --ref main \
  -f start=2026-01-01 -f end=2026-09-10 -f refresh_featured=true
```

刷新只改来源层；raw 日报里的 logo/配图用离线脚本补（只改 media 字段，不重跑 collect，避免顺带改写其他来源）：

```bash
node scripts/backfill_producthunt_media.js --start 2026-01-01 --end 2026-09-10 [--dry-run]
npm run images:sync   # 把 ph-files.imgix.net 的产品标志镜像到 assets/images
npm run check
```

**旧混合层日报的 PH 行拿不到精选投影**：2026-01-01~2026-08 的日报（216 天）是已废弃的旧混合层生成的，每天是「当日热门 20 条」而不是 `featured: true`，与 `officialFeatured` 只有 10% 能对上（4433 行里 482 行），所以 `--refresh-featured` 补不到它们的 logo。这类行要按 Post ID 定向补抓（`post(id: ID!)` 支持 `thumbnail { url }` / `media { url }`，见 `capture_producthunt_post_media.js`）：

```bash
# 计划：只取 raw 日报真正引用、且在同一天 records 里可归属的 ID（其余跳过并报告）
node scripts/capture_producthunt_post_media.js --start 2026-01-01 --end 2026-09-10 --dry-run

# 抓取：媒体写入同日文件的新增段 recordMedia（records / officialFeatured 原样不动，
# 因此各自的 contentSha256 仍成立）；限流时停下并置退出码 2，重跑只补缺失 ID
node scripts/capture_producthunt_post_media.js --start 2026-01-01 --end 2026-09-10
node scripts/validate_producthunt_raw.js --start 2026-01-01 --end 2026-09-10
```

`recordMedia` 的每条都必须在同日 `records`（全量 sweep）里存在，校验器会强制这一归属关系；`backfill_producthunt_media.js` 优先用精选投影、缺失时回退 `recordMedia`。Actions 入口：`producthunt-post-media.yml`（`--limit-ids` 可小批试跑）。

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
