# DevTrends · 开发者趋势

**大家都在做什么** —— 每天从开发者社区、独立开发者圈子与开源生态里，找出值得关注的新项目、新产品和新趋势。

- 网站：<https://devtrends.site> ｜ English: <https://devtrends.site/en/>
- 历史日报：<https://devtrends.site/reports/> ｜ RSS：<https://devtrends.site/feed.xml>

## 这是什么

DevTrends 是一个自动运行的开发者趋势日报站。它每天采集多个公开来源（Show HN、V2EX、GitHub Trending、Product Hunt、独立开发者社区、科技周刊投稿等），把同一批发现标准化、去重、归类，生成当日日报，并构建成一份可索引的静态站点。

- **只看公开信息**：所有内容来自公开榜单、公开 API、公开仓库和公开投稿，不抓取登录后的私有内容。
- **每天一期**：北京时间 00:07 采集，产出 `知识/大家都在做什么/raw/<日期>.{json,md}`，站点随之重建。
- **中英双语**：中文与英文页面共用同一份数据，URL 决定语言。
- **可回溯**：来源层按来源、按天保存原始快照，日报的每一条都能追回当时的输入。

## 数据来源

| 来源 | 内容 | 采集方式 |
| --- | --- | --- |
| [Show HN](https://news.ycombinator.com/show) | Hacker News 的 Show HN 投稿 | Algolia 搜索 API，按北京时间日区间取全量 |
| [V2EX · 分享创造](https://www.v2ex.com/?tab=create) | 分享创造节点的最新主题 | 官方公开 API |
| [GitHub Trending](https://github.com/trending) | 每日热榜（全球榜 / 中文圈榜） | 榜单 HTML 快照 |
| [Product Hunt](https://www.producthunt.com/) | 每日新品与官方精选 | 官方 GraphQL API |
| [VibeCafé](https://vibecafe.ai/) | 社区最新作品 | 公开 API + 产品详情 |
| [中国独立开发者](https://github.com/1c7/chinese-independent-developer) | 主版面 / 程序员版 / 游戏版每日新增项目 | 仓库 README 日分节 |
| [阮一峰《科技爱好者周刊》](https://www.ruanyifeng.com/blog/) | 正刊推荐 + 用户投稿 Issue | 发布提交 + Issues |
| [HelloGitHub](https://hellogithub.com/) | 月刊推荐 + 用户投稿 Issue | 发布提交 + Issues |
| GitHub Issues 投稿 | 各周刊仓库里的自荐 / 推荐 Issue | GitHub API |

只要能从结构化字段或正文里识别出 `github.com/owner/repo`，就会通过 GitHub Repository API 补一份仓库快照（star、fork、主语言、许可证等），日报里的指标都来自那次快照。

## 网站包含什么

| 路径 | 内容 |
| --- | --- |
| `/`、`/en/` | 今日发现：当天全部项目，支持搜索、分类筛选、列表 / 宫格视图 |
| `/cards/` | 今日卡片：一张一张浏览当天的新发现 |
| `/trends/` | 趋势洞察：按业务场景、Agent 生态、编程语言比较最近 7 天与此前 28 天 |
| `/trends/<维度>/<分类>/` | 分类库：可切换本周期 / 近 4 周 / 近 12 周 / 全部历史 |
| `/reports/` | 历史日报归档（月历视图，带项目数与评论数） |
| `/reports/<日期>/` | 单期日报，可下载 Markdown |
| `/projects/<owner>/<repo>/` | 项目详情：介绍、仓库信息、收录记录、相关项目 |
| `/products/<id>/` | 产品详情：没有仓库地址的产品走产品库页面 |
| `/feed.xml`、`/sitemap.xml`、`/sitemap-baidu.xml`、`/robots.txt` | RSS、站点地图与爬虫声明 |

日报和项目页的评论由公开仓库 [null-object-0000/devtrends-comments](https://github.com/null-object-0000/devtrends-comments) 的 GitHub Discussions（giscus）承载，中英文共用同一条讨论。

## 数据链路

```text
公开来源 ──► 采集层（GitHub Actions，每天 00:07 北京时间）
              │  来源采集脚本 + 离线校验
              ▼
         source-raw/<source>/<日期>.json      不可变原始层：只忠实落盘，不做摘要与去重
              │
              ▼
         raw/<日期>.{json,md}                 发布层：标准化、跨源去重、3 期冷却、分类渲染
              │
              ▼
         final/<日期>.md                      增强层：LLM 生成双语摘要与受控分类标签
              │
              ▼
         dist/                                构建层：静态 HTML + data JSON + sitemap / feed
              │
              ▼
         Cloudflare Workers                  部署：推送到 main 自动构建发布
```

几个刻意的设计：

- **来源层不可变**。原始日文件只落盘、不改写；后来修正的日报是重新生成 `raw`，而不是回头改 `source-raw`。
- **发布层有冷却**。GitHub Trending 是滚动窗口，同一个仓库在 3 期已发布日报里出现过就不再进普通列表，避免榜单前部的旧项目挤掉新发现。
- **产品身份只有一份实现**。日报行、增强匹配、产品库导入、站点构建共用同一个 `productId` 规则，日报里带着生成时的来源哈希，可以离线复算校验。
- **收录是投影**。产品库（MySQL）是发布时的投影，改了历史数据要按范围补跑导入并重建站点快照。

## 仓库结构

```text
web/                        站点前端（构建与浏览器共用的 shared.js、样式、主题、品牌资源）
worker/                     Cloudflare Worker：产品页 / 项目页渲染、Catalog API、验证文件直出
scripts/                    构建与运维脚本（build-site.js、projects.js、trends.js、图片、搜索推送…）
scripts/catalog/            产品库：导入包构建、校验、上传、站点快照、趋势查询
.agents/skills/community-pulse/
                            采集与日报技能：来源采集脚本、离线校验、collect.js、增强、SKILL.md
知识/大家都在做什么/
  source-raw/<source>/      按来源、按天的原始快照（不可变层）
  raw/<日期>.{json,md}      当日日报
  final/<日期>.md           LLM 增强后的最终日报
assets/images/              图片清单 manifest.json 与标志明暗判定 tones.json（图片字节在 R2）
data/catalog/site-snapshot/ 站点快照：分类库、收录历史、可索引性
migrations/mysql/           产品库表结构
tests/                      node:test 用例（构建产物、路由、SEO、解析回归）
docs/                       架构与重构文档
AGENTS.md                   维护者手册：目录约定、数据链路规则、部署检查清单
CHANGELOG.md                按天记录的项目开发史（含取舍与放弃的方案）
```

## 本地运行

需要 Node.js 24 与 npm。

```bash
npm ci          # 安装依赖（只有 mysql2 一个运行时依赖）
npm run build   # 构建站点到 dist/，只读仓库内的日报数据，不联网
npm run preview # 本地预览 http://localhost:4173
npm test        # node:test 用例
npm run check   # build + test，提交前跑这个
```

`npm run build` 完全离线：它读 `知识/大家都在做什么/raw/*.json`，在同日 `final/*.md` 存在时合并 LLM 增强摘要，否则回退到 raw 摘要。没有同步过的图片、非法分类 ID 这类问题会让构建直接失败，而不是产出一个静默降级的页面。

## 配置

站点级配置在 `site.config.json`（提交进 Git，所以 CI 不需要额外变量）：图片镜像域名、IndexNow key、评论仓库。需要密钥的环节如下，**都不提交进仓库**：

| 变量 | 用途 | 何时需要 |
| --- | --- | --- |
| `GITHUB_TOKEN` / `GH_TOKEN` | GitHub API 采集（仓库快照、Issues） | 采集层；GitHub Actions 自动提供 |
| `PRODUCT_HUNT_TOKEN` | Product Hunt GraphQL 采集（可配 `PRODUCT_HUNT_TOKEN_2..N` 轮换） | 只采 Product Hunt 时需要 |
| `ALIYUN_RDS_*` | 产品库 MySQL 连接（读 / 写账号、SSL CA） | 只跑产品库导入与查询时需要 |
| `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` | R2 图片上传、手动部署 | `npm run images:upload` / 手动 `wrangler deploy` |
| `BAIDU_SITE_TOKEN` | 百度搜索资源平台主动推送 | 可选，缺省时整步跳过 |
| `IMAGE_BASE` | 覆盖 `site.config.json` 的镜像域名；`IMAGE_BASE=`（空值）强制回仓库内镜像模式 | 可选 |
| `R2_BUCKET`、`R2_PREFIX`、`R2_CONCURRENCY` | 覆盖 `images:upload` 的桶名 / 前缀 / 并发 | 可选 |

`.env` 与 `.env.*` 已被 `.gitignore` 忽略。

## 图片与存储

- 列表头像只镜像**产品标志**（VibeCafé logo、平台自带图标、项目官网页图标），配图与截图一律回源，不落盘。
- 图片字节存在 Cloudflare R2（`https://img.devtrends.site`），仓库里只提交 `assets/images/manifest.json`（内容寻址的地址清单）和 `tones.json`（浅色标志判定，用来换深色底板）。
- 清单里的地址是相对路径，所以同一份 checkout 在「R2 外置」和「仓库内镜像」两种模式下都能构建。
- 相关命令：`npm run images:sync`（增量下载并更新清单）、`npm run images:upload`（上传到 R2）、`npm run images:verify`（校验全部镜像可达）。
- 页面上的图片地址只有一条本地化通道，白名单以外的外链会被拦掉，避免把第三方图床当成自家资源。

## 数据来源的署名与移除请求

- 日报收录的是**他人的项目与内容**，版权归原作者所有。站内只展示摘要与链接，正文请点击原文或仓库。
- 每个来源都在列表里标明出处并链接回原站；`source-raw` 保留当时的原始记录以便追溯。
- 如果某个项目 / 页面不希望被收录，请在本仓库提 Issue（附上链接），我们会把它从日报和站点中移除。
- 站点 `robots.txt` 对搜索爬虫放行、对训练爬虫（`GPTBot`、`CCBot`、`ClaudeBot`、`Google-Extended`、`Bytespider` 等）声明 `Disallow`；内容信号为 `search=yes,ai-train=no,use=reference`。

## 参与贡献

欢迎提 Issue 反馈数据错误（来源失效、分类错误、重复收录、图片丢失等）。提交 PR 前请先跑 `npm run check`；改动数据链路时请同步更新 `CHANGELOG.md`（按天记录，写清为什么这么选），并遵守 `AGENTS.md` 里的目录与分层约定。细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。

安全漏洞请走私密渠道（[SECURITY.md](SECURITY.md)），不要在公开 Issue 里贴密钥或日志。

## 许可

- **代码**（`web/`、`worker/`、`scripts/`、`tests/`、`.github/` 等）：[MIT](LICENSE)
- **数据与文档**（`知识/`、`assets/images/*.json`、`data/`、`docs/`、`CHANGELOG.md`、`AGENTS.md` 等）：[CC BY 4.0](LICENSE-DATA)

日报中收录的第三方项目介绍、图片与商标归各自作者所有，不在上述许可范围内。

## 更多文档

- `AGENTS.md` —— 维护者手册：目录职责、数据链路规则、发布检查清单
- `CHANGELOG.md` —— 项目开发史：每天做了什么、为什么这么做、试过什么又放弃了
- `CONTRIBUTING.md` —— 怎么报数据错误、怎么提 PR、哪些东西不要提交
- `SECURITY.md` —— 安全漏洞的私密报告渠道
- `docs/` —— 架构与重构规划
- `.agents/skills/community-pulse/SKILL.md` —— 采集与日报技能说明

---

## About (English)

DevTrends aggregates what developers are building right now. Every day it collects public signals from Show HN, V2EX, GitHub Trending, Product Hunt, independent developer communities and tech weekly submissions, then normalizes, deduplicates and classifies them into a daily report published as a static site at <https://devtrends.site> (Chinese and English).

Only public sources are used. The raw layer keeps an immutable per-source snapshot, so every published row can be traced back to its inputs. Code is MIT licensed; data and documentation are CC BY 4.0. Third-party project descriptions, images and trademarks belong to their respective owners — open an issue if you want a project removed.
