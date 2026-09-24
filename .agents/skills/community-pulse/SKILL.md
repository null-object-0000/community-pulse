---
name: community-pulse
description: "聚合各社区/平台「大家都在做什么」动态：Show HN / V2EX 分享创造 发布流、GitHub Trending 新仓库、社区新帖。数据源注册表驱动，统一 item 结构。触发词：大家都在做什么、热榜、社区动态、今日热点、HN、Show HN、V2EX、GitHub trending、新产品、信息收集、聚合。"
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
| showhn | Show HN | Algolia 搜索 API 按北京日区间取全量（`created_at_i` 范围） | ✅ 可按北京日回溯到 2025-01 |
| v2ex | V2EX · 分享创造 | 官方公开 API（`/api/topics/show.json?node_name=create`）当前 10 条 | ⚪ 只有实际观察日，无历史接口 |

所有来源中只要能从结构化字段、产品详情或正文识别出 `github.com/owner/repo`，就由 `capture_github_repositories_raw.js` 统一请求 GitHub Repository API，将原始仓库对象落在 `source-raw/github-repositories/YYYY-MM-DD.json`。`collect.js` 只离线合并 star、fork、语言、许可证、创建/更新时间等字段。

**「按报告日读」与「按观察日读」的区别**（加新源时最容易踩的坑）：`source_raw_items.js` 的 `OBSERVED_SOURCES` 决定该源的文件名用哪个日期。GitHub Trending 与 V2EX 没有历史接口，文件只能记「哪一天观察到的」，所以按**观察日**读；其余来源（含 Show HN）都能按报告日寻址，按**报告日**读。Show HN 虽然也是 Algolia 实时接口，但它的 `created_at_i` 区间查询可以精确重建任意历史北京日，因此属于报告日一类，**不要**把它加进 `OBSERVED_SOURCES`。

**Show HN 不接受未结束的当天**：`capture_showhn_raw.js` 默认拒绝抓「今天」（`--allow-partial-day` 可显式放行）。原因是文件不可变，当天抓一半就会把缺失的那半天永久冻结——第二天重跑只会看到「已存在」而跳过。workflow 传的是昨日（`TARGET`），所以正常路径不受影响。

**历史日快照缺失时**：`source-raw/github-repositories/` 只从 2026-09-07 开始有快照。更早的日期（如 09-05/09-06）识别出的仓库没有指标行——此时用 `capture_github_repositories_raw.js --date <历史日> --observed-date <今天>` 补一份「当前值」快照（记录抓取时间=今天，观察日=今天，不伪装成历史当日值），之后重跑 collect 即可显示指标。快照文件按 `targetDate`（报告日）落盘，`observed-date` 仅记录观察日。

```bash
node scripts/capture_github_repositories_raw.js --date 2026-09-07 --observed-date 2026-09-08
node scripts/validate_github_repositories_raw.js --date 2026-09-07
```

**vibecafe 抓取要点**（`scripts/sources/vibecafe.js`）：
- 读它的前端数据接口（Next.js RSC flight 流），产品数据在 `initialProducts` 数组里（**干净 JSON**）。请求头与路径随站点改版会变，按当时的实现适配即可。
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
- 投稿正文中的纯文本链接必须在中英文括号、句号、冒号等正文标点处终止。例如 `https://example.com/）。它是` 只能标准化为 `https://example.com/`；否则浏览器会把后续中文编码进路径，同一产品的重复投稿也无法按 URL 合并。规则与回归测试见 `source_raw_items.js` 的 `extractExternalUrls()` / `tests/issue-url.test.js`。
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
- `daily` 是滚动热度窗口，同一个仓库连续多日出现是源站事实。原始快照始终完整保留；`collect.js` 只在发布层按规范化 `owner/repo` 与过去 3 份已发布 `raw/*.json` 比较，主列表不重复展示冷却期内已发仓库。全球榜与中文榜同日重合时全球榜优先，先对完整榜单排重再执行 `max_items` 截断；未展示的低排名项目以后升榜仍可进入日报。
- 被冷却的项目不进入日报/今日发现的普通卡片；按 `stars today` 取最多 3 个写进顶层 `trendingPolicy.continuedItems`，Markdown 与网站以折叠的「持续热门」摘要展示。报告历史不足 3 天时只使用实际存在的历史文件，来源层不受影响。

## GitHub 开源项目信息补全（已移出主链路）

采集阶段对**URL 是 `github.com/owner/repo`** 的条目，调 GitHub API 补仓库基础信息（star/fork/语言/license/描述/创建时间/更新时间/archived），存进 item 的 `github` 字段；md 渲染时在描述下方加一行小字。

- `collect.js --enrich-github` 现在会直接报错，因为它会在原始层之后再请求 GitHub API，破坏可复现性。
- 如果以后需要 star/fork/license 等信息，应先建立独立的按日原始快照和校验器，再由后续处理读取，不得在报告生成时即时联网。
`enrich_github.js` 仅保留为旧实验工具，不得接入 `collect.js`、日报或回溯 workflow。

## 网络/代理（仅来源采集层）

来源采集层按需走本地代理：地址由 `COMMUNITY_PULSE_PROXY` 指定（未设置时代码里有一个本机默认值，见 `capture_*_raw.js`）。
代理只由 `capture_*_raw.js` 系列来源采集脚本使用。`collect.js` 是纯本地读取，不设置代理，不执行 `curl`/`gh`。

## 新增数据源

1. 建立不做标准化和截断的 `capture_xxx_raw.js`，按日写入 `source-raw/xxx/YYYY-MM-DD.json`。
2. 建立不联网的 `validate_xxx_raw.js`，校验完整性、日归属、数量和内容哈希。
3. 在 `scripts/source_raw_items.js` 注册纯函数转换器，只把原始文件转成统一 item。
4. 在 `config/sources.json` 注册来源，并把采集+校验加入日报 workflow。
5. 跑 `node scripts/collect.js --strict --source xxx --date YYYY-MM-DD` 验证纯本地处理。

## 手动重跑/重发前必查

用户要求"重新触发 Actions/重发日报"时，先核对两件事再动手：① cron 列表里日报任务今天的 last run 是否 ok（成功则今早已自动发送过一次）；② final/<日期>.md 的 mtime 是否今天生成。若当天已发送，必须先告知用户并确认再重发，否则会重复发消息。

## 关键坑（务必看）

- **网络/代理**：来源采集脚本按需走 `COMMUNITY_PULSE_PROXY` 指定的本地代理（未设置时代码里有一个本机默认值）。
  - 只有来源采集脚本使用 `COMMUNITY_PULSE_PROXY`；Actions 将它设为空字符串直连。
  - `collect.js` 完全不联网，不应包含任何代理、`curl`或 `gh` 逻辑。
- **gh 字段名**：`gh search repos --json` 的字段是 `language`（不是 `primaryLanguage`），否则报 "Unknown JSON field"。
- 交互查看时单个源失败会写入 `error`；生产 workflow 必须使用 `--strict`，任一输入失败就停止。
- **日报 workflow 的步骤顺序：必需产物必须先落盘，非必需附件排后面**（2026-09-24 两天两次整期缺失换来的）。
  - 两天两次「整期日报消失」机制不同、后果一样：**都不是数据坏，而是某个非必需环节有权让日报不存在**。① 身份核对（一个可能出错的检查）排在「提交并推送」之前 —— 它自己算出的假漂移让当期 raw / final / 站点全没了；② 站点快照（只是分类页的窗口刷新，缺一天不致命、能事后补）与日报产物挤在同一次提交 —— 它拉数据撞上一次 502，日报也进不了仓库。
  - 现在的顺序：`提交日报并推送`（raw + source-raw + 图片 + 评论数）→ `站点快照` + 单独提交 → 最后才是 `核对日报行与产品库的身份一致`。**改 workflow 步骤顺序时先问：这一步失败了，当天的日报还在吗？**
  - 快照失败只损失一次窗口刷新，用 `catalog-refresh.yml` 补即可；身份核对失败是**报告**，不是闸门。
- **判断「永久失败 vs 暂时重试」只能看状态码，不能看 content-type**：Cloudflare 验证页是 `403, text/html`，而源站错误页 `502/503/504` **也是 `text/html`** —— 拿 `/html/i.test(contentType)` 判永久，就会让一个重试就好的 5xx 让整批数据被丢弃（2026-09-24 实测：快照因此整批失败）。判据：403 与 4xx（429 除外）永久，5xx 与 429 一律重试；网络异常（fetch 直接抛）也重试。
- **两条链核对同一份数据时，取输入的口径必须共用同一个函数**：日报链与导入链都按日期取 GitHub 仓库快照，但一个「找不到就回退最近一份」、另一个「找不到就当没有」。两条链分叉后，**核对方报出的「漂移」其实是它自己换了输入** —— 门禁假警报拦住的不是坏数据，是它自己造成的差异。改这类「离线重建 + 逐行比对」的校验时，先问：**核对方和被核对方，读的是同一份输入吗？**

## 渲染

`collect.js` 可从同一批本地输入一次生成 JSON 和 Markdown。后续如需 HTML 报纸/LLM 分组，只读取这些已生成产物，不动抓取层。

`enhance.js` 为每条内容生成中文摘要与英文摘要，并为含中文的标题生成英文标题。它还必须从 `web/shared.js` 的固定分类中选择一个 `primaryCategory`；分类与翻译在同一次 LLM 请求中完成。中文 final Markdown 保持可直接发送，同时用隐藏的 `devtrends-i18n` 元数据保存 `productId`、`titleEn`、`summaryZh`、`summaryEn`、`primaryCategory`，供网站构建中英文页面与分类筛选；构建阶段不得再调用 LLM。旧 final 缺少分类时由 `web/shared.js` 的本地规则回退，不修改历史文件。

**`productId` 靠 `--json` 显式指路，别依赖「同目录同名」推断**：`enhance.js` 默认按 `inFile.replace(/\.md$/, '.json')` 找原始 JSON（`raw/<date>.md` → `raw/<date>.json`）。**只要输入 md 是从别处拷来的**（例如 `enhance-report.js` 会先写到 `.scratch/enhancement/<date>.md`），同目录就没有 json，脚本只打一行警告就继续跑 —— 结果是这一期 final 的每条记录都不带 `productId`，`presentation.matchedByProductId=0`、全部退回 `matchedByHeading`。增强本身看着「成功」（`summarySource=llm-final`），只有查 `matchedByProductId` 才发现匹配口径退化了。所以：**凡是不在 `raw/` 目录里跑的增强，必须显式传 `--json <raw>/<date>.json`**，并确认日志里那行「产品身份: N/N 条对齐到 productId」。事后补救不用重跑 LLM —— 带 `--json` 重跑，`normalizeRecords` 会从 `.work` 断点恢复已有结果并按对齐结果补上 `productId`（前提是 `.work` 文件还在；被 `--dry-run` 消耗掉就只能全量重生成）。

**一条垃圾投稿不该让整期日报没有中文**（2026-09-24 实测，形状已出现三次）：`enhance.js` 的批处理原来是「任一条失败 → 整期中止」（`if (failures.length) throw failures[0]`），而**永久性失败确实存在且来自条目本身** —— 阮一峰周刊 Issue 11874 标题字面是 `lost`、正文只有 `good`，模型读这段描述无论如何给不出受控业务场景，校验层拒绝（拒绝是对的），重试 5 次也不会变好。于是 71 条的整期增强在最后一条上全挂、final 一个字节都没产出。**现在分两种失败**：① **条目级**（校验层拒绝，`error.itemLevel = true`）→ 只试一次、跳过这一条（日报里保留原文）、**显式列出跳过了谁**，完整性检查改成 `localized + skipped === items`；② **系统性**（LLM 网关 HTTP/网络、限流打满）→ 仍然整批停下来 —— 绝不能静默产出一期只有零星中文的残缺日报。改这里时留意**标记要转递**：`localize()` 在重试循环结束后另抛新 Error，早先就把 `itemLevel` 丢掉了，结果调用方仍按系统性故障处理。

**定时任务的失败点会连带吞掉增强**：`~/.hermes/scripts/community_pulse_send.sh` 的第一步是 `git pull --ff-only`，失败即 `exit 1`。这本身是对的（避免发过期日报），但**增强是同一个脚本的第 3 步**，于是网络一断（公司网络到 `github.com` 的 TLS 握手被中断是常态）这一期的 final 就永远不会生成，站点静默回落到 raw 文案（`summarySource=raw`）。补跑办法：网络恢复后 `git checkout FETCH_HEAD -- 知识/大家都在做什么/raw/<date>.{json,md}` 取回 raw，再跑 `node scripts/enhance-report.js --date <date>`；**别直接跑 `enhance.js`**，`enhance-report.js` 才会做投稿准入与去重队列的重写，否则 final 与站点的列表口径不一致。判断某期是否掉队就看线上 `presentation.summarySource`：`llm-final` 正常、`raw` 即未增强。**本机已在正确的提交上时，pull 那步可以跳过**（`git log -1` 确认 HEAD 已含当日 raw，就直接跑 `enhance.js --md raw/<date>.md --out final/<date>.md`）。

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
| `backfill_issue_media.js` | 投稿旧日报补正文插图 | 用 `issue-media.js` 离线从 `content` 现算 `images`/`image`, 并删掉简介里的图片残骸; 只改这三个字段与对应 md, 不重算历史简介 |

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

**校验器的两条宽松规则**（否则回填历史时会误报）：① 一整天没有任何候选行时**不要求日文件存在**——2026-03-08 / 03-09 / 05-02 这类日期本身就没有日报；② 服务器没返回 `image/*` 的 `content-type` **只记告警**，因为图标是靠字节嗅探（`iconKind`）确认的，有些站点的 apple-touch-icon 就回 `application/octet-stream` 或干脆没有该头。

**下游**：`source_raw_items.js` 的 `loadItems` 离线把 `siteLogo` 挂到「无 `logo`/`icon`」的行上
（按 sourceId+externalId 匹配，退化时按页面 URL），`collect.js` 不联网；站点把 `siteLogo` 与 `logo`/`icon`
一起镜像（`npm run images:sync`）并按 `logo → icon → siteLogo → 文字` 渲染 48px 头像。图标下载失败时
清单里记 `null`，该行自动回到文字，不会出现破图。

## 投稿正文插图（issue-media，2026-09-17 建成）

投稿人自己在 Issue 正文里贴的图（`<img src>` 与 markdown `![]()`）是这个产品最真实的展示图，
以前整段丢掉（只有 VibeCafé / Product Hunt 这类平台自带媒体的来源才有插图集）。
现在 `issue-media.js` 的 `issueImages(body)` 按正文顺序取出来，由 `issueItems()` 挂成
`images` + `image`（首张），与平台配图同为「原始配图」层，优先级高于官网截图与 OG 图。
同一批正文以前还会把 `<img …>` 标签漏进简介（旧清洗只删 URL，留下 `src=" />` 残骸，
全量 1223/11494 行），现在 `issue-description.js` 的 `stripInlineMarkup` 会按 HTML 标签白名单删掉标签。

- **只收渲染得出来的地址**：白名单唯一口径是 `web/shared.js` 的 `D.hotlinkable`。GitHub 的三种
  图片地址按「host + 路径形状」放行（`github.com/user-attachments/assets/<uuid>`、
  `github.com/<owner>/<repo>/blob/<ref>/…<ext>?raw=true`、`raw.githubusercontent.com/…`），
  长尾图床（imgur、各类对象存储）这一版不收 —— 收进来又渲染不了的图会让构建直接报错。
  改白名单要同时看 `web/shared.js` 与 `worker/project-page.mjs`（后者现在直接复用 `D.localImage`）。
- **徽章不是插图**：`img.shields.io` / `badgen` 这类 host 与 `badge.svg`、GitHub Actions 徽章路径被剔除。
- 上限 9 张、按地址去重；`data:image/...`、相对路径、`data-src` 懒加载占位图都不收。

历史回填（离线，不联网、不重跑 collect）：

```bash
cd .agents/skills/community-pulse
node scripts/backfill_issue_media.js --dry-run
node scripts/backfill_issue_media.js --start 2026-01-01 --end 2026-09-16
cd ../../.. && npm run build
```

它只改三处：`raw/<date>.json` 的 `images`/`image` 与简介残骸、`raw/<date>.md` 的 `>` 摘要行、
`final/<date>.md`（含隐藏 `devtrends-i18n` 元数据里的 `summaryZh`）。**历史简介只删图片残骸、
不重算** —— 历史行是当时解析规则的结果，用今天的规则重算会顺带改写大量与图片无关的行
（实测约一半的行会变）。MySQL / 站点快照里的历史行要另跑 `catalog:build --start --end` +
`catalog:upload:mysql` 才会刷新。

## 产品库（MySQL）：分类页 / 详情页的正文来自哪张表

**站点有两条互不相通的内容链**，这是最容易误判的地方：

| 页面 | 数据来源 | 有中文吗 |
|------|----------|----------|
| 日报 `/reports/<date>/` | `final/<date>.md`（LLM 增强） | ✅ `titleZh` / `summaryZh` |
| 分类页 `/trends/...`、详情页 `/products/prd_*` | MySQL `product_details.item_json` | 取决于 `product_content` |

`item_json` 是 **`source-raw` 的投影，从不包含 LLM 增强结果**（`scripts/catalog/build-mysql-import.js` 的 `DEFAULT_RAW_ROOT` 就是 `source-raw/`，全仓没有 `enhanced-report` 的引用）。所以「日报有中文、分类页没有」不是 bug，是两条链本来就分开。

**中文正文在 `product_content`，由读取端合并进 item**：`worker/catalog-api.mjs` 的 `attachProductContent` / `mergeContent` 按 `product_id` 取 `is_current=1` 的中英两行，写成 `titleZh`/`summaryZh`/`titleEn`/`summaryEn` —— 这四个键是 `D.displayTitle` / `D.summary` / 详情页 `summaryOf` 唯一认的名字，**改名等于静默不显示**。三条纪律：

- **一次取中英两行，不按请求语言取一行**：Worker 同一份数据要渲染 `/` 与 `/en/`，而产品页缓存键只含 pathname —— 按语言取会让英文页拿到中文标题。
- **列表在 `productRows` 的 map 之外批量取**（一页 60~300 行，N+1 会打穿 Hyperdrive）。
- **读取端只认 `is_current=1`**：不自己发明「读 shadow」的第二套语义。**新加工的内容必须先上架才可见**，否则页面看起来毫无变化 —— 那是静默失效，不是「暂时没数据」。

**上架（激活）默认自动做，不再是「要人记得的第二步」**（2026-09-23 改）：

```bash
# 常规：写库那一跳顺手把这一批上架 —— 版本从 SQL 里认，不需要调用方传
node scripts/catalog/apply-sql.js --file <sql> --channel
# 只在「想先看数据再上架」时才 hold（写 shadow 后停住）
node scripts/catalog/apply-sql.js --file <sql> --channel --hold
```

**为什么改成自动**：原来的纪律是「所有输出 shadow，激活是单独的受审操作」，理由是「曾经自动激活导致线上短暂出现半成品描述」。但这条纪律在 2026-09-23 被证明**只在纸面上成立** —— 一批 2,000 条没人会逐条看，那道「人工关卡」实际什么都没拦，只拦住了忘记敲命令的人。代价是静默失效：`catalog-localize-v1` 的 **35,893 条标签跑完 7 天从没激活过**，网站一直用规则推断（用户发现的 `Lingua Playlist` 被算成旅行产品就是这么来的）。现在由**自动上架 + 回滚稿 + 显式日志**取代「靠人记得」。

- **版本从 SQL 里认**（`detectVersions`）：只认 `enrich-products.js` 的 `resultBatchSql` 产出的两种 INSERT 形状，认不出的一律不碰。**不让调用方传版本** —— 传就等于「又要记得」，而那正是这次事故的形状。
- **上架顺序从高优先级到低优先级**：低优先级那步的「让位」判断依赖高优先级行已经是 current。
- **回滚稿与上架同时产出**（`<sql>.rollback.sql`），workflow 会把它提交回仓库 —— 改线上数据却没有退路，等于把「能不能回头」寄托在记性上。
- **`--hold` 仍在**：需要先看数据再上架时用它。人工补激活稿仍可走 `activate-enrichment.js` + `--allow-activation`（那条路没变）。

**手工激活入口**（`scripts/catalog/activate-enrichment.js`；`apply-sql.js` 的 `--allow-activation` 只用于放行文件里带的激活语句，`--hold` 之后手工补跑时用）：

```bash
# 标签：提 LLM 行 + 撤同产品的规则行（languages facet 保留 —— LLM 不产出它）
node scripts/catalog/activate-enrichment.js --processor-version travel-localize-v1 --out .scratch/a.sql
# 正文：同产品同 locale 只能有一行 current（否则「取最新一条」取决于 created_at 的偶然顺序）
node scripts/catalog/activate-enrichment.js --content --versions travel-localize-v1,catalog-localize-v1 --out .scratch/c.sql
```

**标签与正文是两次独立的激活**：自动上架两条都做，但手工补跑时容易只做一边 —— 只做正文的症状是**分类归属不对**（标签仍是规则推断的）。**改完数据要问一句「标签和正文分别上架了吗」。**

- **两批 LLM 标签在同 facet 上不能同时 current**：读端只按 `is_current=1` 过滤、不看 `assignment_source`，所以同时成立会让**分面计数翻倍**（同一产品在一个分面里算两次）。`buildStatements` 因此有第三个语句：低优先级版本把自己的行让给高优先级版本。
- **优先级保护是自动推导的**（`higherPriorityVersions` + `VERSION_PRIORITY`），不需要调用方记得传全 —— 此前做成「调用方自己传 `--versions`」，实测忘了传就整闸失效（travel 那批 8,214 行正文被误撤）。`VERSION_PRIORITY = ['travel-localize-v1', 'catalog-localize-v1']`，**标签与正文共用一份**。
- **多批同时激活要按优先级从高到低执行**：低优先级那步的「让位」判断依赖高优先级行**已经是 current**。顺序反了会让低优先级先提为 current、再被高优先级挤掉，白跑一轮（结果对，但多一次无谓写）。
- **激活稿必须与回滚稿同时提交**：改线上数据却没有退路，等于把「能不能回头」寄托在记性上（`--out` 会自动生成同名 `.rollback.sql`）。

**判断「某期/某产品为什么没中文」的排查顺序**：

1. 分类页是**构建期快照**（`data/catalog/site-snapshot/categories/**`，由 `catalog-refresh.yml` 的 `catalog:snapshot` 重建），详情页与列表 API 是**实时读库**。改完数据必须重建快照才反映到分类页。
2. 分类页列表按**首见日期倒序**，所以**最上面几条恰好是当天新收录、还没跑增强的产品** —— 别用「前 3 条有没有中文」判断成没成，要看比例。
   - **产品名是专有名词时本来就该是英文**：`Paralight` / `Lingua Playlist` / `Hostelcare` 这些品牌名，模型按设计**不翻译**（zh-CN 行的 `title` 就等于原名），所以「标题还是英文」不等于没生效 —— 看 `summaryZh`（实测这几条的中文摘要 55~60 字都在）。`D.displayTitle` 的取值链是 `titleZh` → `title`，标题相同时自然显示原名。**判据是「有没有中文摘要」，不是「标题变没变中文」。**
   - **比例也别只看单个分类**：`travel-mobility` 因为整批补跑过是 **95%**，而同期其他分类（`capability-extension`、`business-growth`、`data-operations` 等）只有 **8~17%** —— 全站分类快照去重 **30,652 个产品里 3,815 个有中文（12%）**。分类之间的差距来自「有没有专门跑过那一批」，不是读取端坏了。
   - 全库口径（2026-09-23 补跑 09-21/09-22 并激活后实测）：`products` **322,393**、`product_content` current **25,370 行 / 12,685 个产品**（`catalog-localize-v1` 8,679 + `travel-localize-v1` 4,107，两批无重叠；另有 **202 行刻意保持 shadow** —— 那是被 travel 优先级保护挡下的同 (产品, locale) 行）。**仍是少数**：激活只是让已入库的可见，覆盖率要靠继续按天/按标签跑增强才涨。
3. 按 `first_seen_date` 分组看哪一天整批没中文 —— 日更链按天跑 `enrich-products.js --date <日期>`，**某天没跑就是整批缺**。队列口径是 `products.first_seen_date = target_date`（全局首次出现，互斥、恰好一次）。
   - **日更链不是自动的**：`enrich-products.js` 需要 `--channel`（临时 Worker 通道）或 `--mysql-url`，而**本机没有 Cloudflare 凭据**（`wrangler whoami` 报 token 过期）；仓库里也没有任何定时 workflow 跑它（`.github/workflows/` 里只有 `apply-catalog-sql.yml` 引用到它，且是 `workflow_dispatch`）。目前跑过的批次都是手工的：`catalog-localize-v1` 只覆盖 **09-14..09-20 七天**，`travel-localize-v1` 是 09-22 按标签全历史那一批。**所以「某天之后整批没中文」是常态，不是故障。**
   - 只读 API **不能**当队列源：`/api/v1/products` 强制 `term`（`queryProducts` 第 344 行的 `^[a-z0-9-]+$` 校验），传日期区间不传 term 会得到 `invalid taxonomy term`。`enrich-travel.js --pull` 能按标签拉，是因为它传了 `term`。
4. 补跑走**三跳**（见下一节）—— 不能直接跑 `enrich-products.js`，它需要 `--channel`（本机无 CF 凭据）。

### 补跑某一天：三跳（因为队列与模型分处两地）

`enrich-products.js` 自己取队列也自己写库，而这两件事的可用环境**互斥** —— 队列在 RDS（本机到 3306 的 TLS 握手被出口重置），模型网关 `127.0.0.1:18640` 是本机自建（Actions 到不了）。所以补跑拆三跳：

```bash
# ① Actions：导出队列 + 该 run 的既有状态（只读 SELECT）
gh workflow run catalog-queue-export.yml --ref main -f date=2026-09-22
gh run download <run-id> -D .scratch/qexp

# ② 本机：跑模型，出回放 SQL（--dry-run 收集语句，不碰库）
node scripts/catalog/enrich-queue.js \
  --in .scratch/qexp/enrich-queue-<date>/queue-<date>.json \
  --status .scratch/qexp/enrich-queue-<date>/status-<date>.json \
  --date <date> --concurrency 6 \
  --out .scratch/sql-<date>.sql --summary .scratch/summary-<date>.json

# ③ Actions：写库 —— **顺手上架**（版本从 SQL 里认，不用再手工激活）
gh workflow run apply-catalog-sql.yml --ref main -f sql_path=.scratch/sql-<date>.sql
# 只有「想先看数据再上架」时才加 -f hold=true，然后手工补：
node scripts/catalog/activate-enrichment.js --content --versions travel-localize-v1,catalog-localize-v1 --out .scratch/act.sql
```

**这条链为什么不能自己拼 SQL**：`enrich-queue.js` 把导出的**原始行**喂给一个假 db，调 `runEnrichment()` 走**与日更链逐字相同**的代码路径（`localizationInput` → `inputHashFor` → `planQueue` → `resultBatchSql`）。所以输入哈希、批次形状、`content_source` 命名天然同源。导出器若把行压成 `{title, desc}`，那条路径上任何未来改动都不会反映到补跑 —— 哈希分叉 → 同一批被反复重付。

**三个会静默烧钱的坑**（都已在代码里设成硬失败）：

- **`MODE` 必须从 `enrich-products.js` 导出**：`stableRunId` 把它算进 run id，漏了（`mode: undefined`）就得到与日更链**不同**的 run id，续跑判定读不到该 run 的状态行 → 整批当新的重付。实测漏掉时 `enr_5b38f526…` vs 正确 `enr_0de7c26d…`。
- **假 db 不许对不认识的查询静默返回空数组**：那会把「查不到状态」伪装成「全新一批」。
- **`--status` 必需**：本机查不到库，没有状态文件就无从判定续跑。
- 导出 workflow **一次只跑一天**：两个并发会部署同名临时 Worker 互相踩（实测 09-21/09-22 同时派发，后一个 `waitForRoute` 十次全失败）。

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

**注意成本**：刷新精选子集会重写该日精选 records（PH 的 `/r/...` 跳转 token 每次请求都会变），因此每次刷新都会连带重跑这些精选链接的 `linkResolution`——校验器要求链接覆盖与 records 完全一致，不能跳过。实测 CI 出口访问 PH 跳转页返回 403（平台对数据中心出口的限制），这些解析会全部记成 `ok:false` 的失败快照（快速失败，不阻断落盘）。按 253 天估算约 1.5 小时。

GitHub Actions 侧用 `producthunt-backfill.yml` 的 `refresh_featured=true` 输入执行同一件事（默认 false，行为不变）：

```bash
gh workflow run producthunt-backfill.yml --ref main \
  -f start=2026-01-01 -f end=2026-09-10 -f refresh_featured=true
```

刷新只改来源层；raw 日报里的 logo/配图用离线脚本补（只改 media 字段，不重跑 collect，避免顺带改写其他来源）：

```bash
node scripts/backfill_producthunt_media.js --start 2026-01-01 --end 2026-09-10 [--dry-run]
npm run images:sync   # 只镜像小标志；PH 标志按下面的规则回源，不落盘
npm run check
```

**PH 标志不镜像，走回源**：`ph-files.imgix.net` 已在 `web/shared.js` 的 `hotlinkOrigins` 白名单里（PH 图集一直就是这么做的），而 PH 的 `thumbnail` 常是发布原图（实测最大 9 MB，含动态 GIF），最终只渲染成 48px 头像。因此 `scripts/image-store.js` 的 `itemUrls()` 用 `isMirroredMark()` 跳过这个 host：`images:sync` 不下载、manifest 不保留，下次同步会把已有的这类标志一并 prune（实测 476 个文件 / 30 MB）。`IMAGES_RETENTION_DAYS>0` 的「整期镜像」模式不受影响。

**浅色标志换深色底板**：列表 / 宫格 / 卡片 / 详情页的标志框都是白底，官网图标里那些透明底的浅色图形（pacifio/atlas 的 `#FFFFEE`）画上去等于消失。`images:sync` 顺便用 `scripts/mark-tone.js` 逐个判定标志（PNG/ICO/SVG 自己解，判据是「合成到白底上还剩多少像素看得清」），把浅色的写进 `assets/images/tones.json`（和 manifest 一起提交、按内容寻址）；构建时 `localizeReport` 按 `logo → icon → siteLogo` 取值链给行挂 `item.markTone = 'light'`，渲染时加 `is-light` 换 `#101a30` 底板。想单独核对某张图：`node scripts/mark-tone.js <文件>`；WebP/AVIF 解不了，已知的浅色项在 `mark-tone.js` 的 `MANUAL_LIGHT_MARKS` 里手工兜底。

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

产品页完整 HTML 快照改为默认关闭的可选增强：新日采集设置 `PRODUCT_HUNT_PAGE_CAPTURE=1` 才抓取，已有日期仅 `--refresh-pages` 显式重抓（该参数同时启用抓页）。关闭时不新建 `productPages`，历史快照保持可读。原因：API 已覆盖所需介绍与外链，当前 CI 出口访问页面会被 PH 拒绝（403），页面 description 多数与 API 相同或只是更泛的品牌介绍，没有稳定增量价值。单个链接或页面失败均降级记录，不阻止当日 API 数据落盘。

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
