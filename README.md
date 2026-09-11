# DevTrends 开发者趋势

「大家都在做什么」开发者趋势日报的独立工作区与独立 Hermes agent（profile: `communitypulse`）。对外网站：<https://devtrends.site>。

## 职责边界

- **采集层**：仅由 GitHub Actions 每天北京时间 00:07 执行（`cron: 7 16 * * *`），负责来源采集 → source-raw 校验 → raw 日报生成（md + json）→ 提交推送。
- **交付层**：Hermes `communitypulse` profile 每天北京时间 07:30 执行 `~/.hermes/scripts/community_pulse_send.sh`，git pull → 校验 raw 完整 → LLM 增强（`enhance.js`）→ 写入并推送 final/ 触发网站重建 → 输出 final 路径，由 agent 用 MEDIA: 发送飞书。
- 交付层**禁止**：调用任何来源 API、重跑/dispatch Actions、探测 Product Hunt、把 raw 复制成 final、发送缺源/过期/未增强文件。脚本失败只报告原始错误并停止。

## 目录

- `知识/大家都在做什么/source-raw/<source>/YYYY-MM-DD.json` — 不可变来源原始层
- `知识/大家都在做什么/raw/YYYY-MM-DD.{md,json}` — Actions 生成的当日日报
- `知识/大家都在做什么/final/YYYY-MM-DD.md` — 本地 LLM 增强后的最终日报
- `.agents/skills/community-pulse/` — 技能（采集/校验/增强脚本 + SKILL.md）

## 迁移自

2026-09-09 从 MyVault 独立出来（原 `知识/大家都在做什么/` + `.agents/skills/community-pulse/`），原因：日报数据量大（source-raw 28M + raw 22M）且需独立 profile 隔离，myvault 不再维护日报。

## 网站

DevTrends 使用统一的品牌主题，支持简体中文 / 英文和浅色 / 深色 / 跟随系统。导航包含今日发现和历史日报，适配手机与电脑。

网站以 `raw/*.json` 保留指标与链接；存在同日 `final/*.md` 时，将增强摘要匹配回填。历史 final 若只覆盖部分内容，则保留 `mixed` 状态，其他条目使用 raw。2026-09-06 的旧 final 为部分覆盖；构建不会伪造完整增强状态。

```bash
npm run build
npm run preview
npm run check
```

### 页面与内容

- `/`、`/en/`：最新发现。
- `/reports/`、`/en/reports/`：历史日报归档。
- `/reports/YYYY-MM-DD/`：独立静态日报，支持对应英文页面。
- `/projects/owner/repo/`：有 GitHub 仓库地址的项目详情，支持对应英文页面。

详情页按规范化的 `owner/repo` 聚合跨来源和跨日期的条目，展示现有介绍、仓库信息、收录记录及按仓库 topics 匹配的相关项目。只识别仓库根地址，避免把 Issue、文件和用户主页当作项目。暂不为无仓库地址的产品生成详情页，也不会在构建时请求 GitHub 或编造额外项目介绍。指标显示采集快照日期。

语言字典、内容选择和列表组件集中在 `web/shared.js`，供浏览器和构建阶段共用。筛选栏（首页按主题分类、日报页按来源）在构建时渲染全部 chip，浏览器只按容器宽度把放不下的部分收进「更多分类」菜单，因此桌面端始终单行、不出现横向滚动条，英文长标签也适用；`0` 条的分类保留但置灰不可点，`≤600px` 换成原生下拉选择器。若被收纳的正是当前选中的分类，触发按钮会显示它的名字。网站使用经过近 90 天历史日报验证的单一主题分类：AI 与智能体、开发工具、数据与基础设施、设计与媒体、效率与协作、商业与增长、学习与研究、生活与娱乐、其他。每日 LLM 增强会在 final Markdown 中写入隐藏元数据，一次完成双语摘要和 `primaryCategory` 归类；构建阶段校验分类 ID，旧日报缺少分类时使用同一模块中的本地规则回退。中文页面使用 `summaryZh`，英文页面使用 `summaryEn`；中文产品名称同时生成 `titleEn`。兼容旧的 `summary_en` / `summary_zh` 字段，历史日报缺少译文时标注原文，不在构建阶段联网补译。

主题使用 `localStorage` 的 `devtrends-theme-v1`，语言偏好使用 `devtrends-locale-v1`。语言切换保留当前页面和筛选参数。旧 `?date=` 链接仍能导航到日报，旧 `?style=` 参数不再改变界面。

### 构建与部署

构建产物位于 `dist/`，不提交 Git。静态 HTML 已包含正文和 SEO 元数据，不依赖浏览器请求完成后才能索引；详情页同时加入 sitemap。无效地址由 Cloudflare `404-page` 返回真实 404。

Cloudflare Workers Builds 连接本仓库 `main` 分支，每次推送（包括每日数据任务）都会自动构建和发布。对外主域名统一使用 <https://devtrends.site>。

发布前运行 `npm run check`。发布后检查首页、静态资源、最新日报 JSON、robots、sitemap、中英文日报及项目详情页，同时核对 canonical、最新日报 `llm-final` 状态和不存在页面的 404 状态。

### 站点图片存储

列表使用的 `image` / `logo` / `icon` / `siteLogo` 由 `npm run images:sync` 增量下载到 `assets/images/`，按文件内容 SHA-256 去重；`manifest.json` 保存原始 URL 到本地文件的映射。图片文件与清单需一起提交，随 Cloudflare 静态资源发布，访问地址为 `https://devtrends.site/images/<hash>.<ext>`。原始日报保留来源 URL 供追溯。

每日工作流在日报生成后自动同步并提交图片。手动新增、回填日报后先运行 `npm run images:sync`，再运行 `npm run check`。构建不访问外网，发现未经同步的新图片会提示先运行同步命令；生成的日报 JSON 和页面只使用本地图片。外网失效、超过 10 MiB 或非支持的图片会记录为空并显示文字占位，后续同步会重试，浏览器不会回退到外网。已有成功文件会复用，不重复下载。

本地 Node.js 24 使用代理时可运行 `NODE_USE_ENV_PROXY=1 npm run images:sync`。下载支持 PNG、JPEG、GIF、WebP、AVIF 、ICO 和 SVG，通过文件字节识别格式，不把源站错误页保存成图片。
SVG 随图片响应附带 CSP sandbox，禁止脚本及外部资源请求。

没有平台产品标志的行（阮一峰/HelloGitHub 投稿、中国独立开发者、GitHub Trending 等）会兜底使用项目官网自己声明的图标，以 `siteLogo` 字段保存：每日工作流在 GitHub 仓库快照之后抓取并离线校验（`source-raw/site-logos/<date>.json`），`logo` → `icon` → `siteLogo` → 文字首字母 依次回退，官网也拿不到时才显示首字母。历史日报可用 `node scripts/backfill_site_logos.js --start <开始> --end <结束>` 回填后再同步图片；命令与取舍见 `.agents/skills/community-pulse/SKILL.md` 的「官网 Logo 兜底层」。
