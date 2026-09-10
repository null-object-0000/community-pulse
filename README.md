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

DevTrends 使用统一的品牌主题，支持简体中文 / 英文和浅色 / 深色 / 跟随系统。导航包含今日发现、历史日报和我的收藏，适配手机与电脑。

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
- `/favorites/`、`/en/favorites/`：保存在本浏览器的收藏。

详情页按规范化的 `owner/repo` 聚合跨来源和跨日期的条目，展示现有介绍、仓库信息、收录记录及按仓库 topics 匹配的相关项目。只识别仓库根地址，避免把 Issue、文件和用户主页当作项目。暂不为无仓库地址的产品生成详情页，也不会在构建时请求 GitHub 或编造额外项目介绍。指标显示采集快照日期。

语言字典、内容选择和列表组件集中在 `web/shared.js`，供浏览器和构建阶段共用。每日 LLM 增强会在 final Markdown 中写入隐藏的双语元数据：中文页面使用 `summaryZh`，英文页面使用 `summaryEn`；中文产品名称同时生成 `titleEn`。兼容旧的 `summary_en` / `summary_zh` 字段，历史日报缺少译文时标注原文，不在构建阶段联网补译。

收藏使用 `localStorage` 的 `devtrends-favorites-v1`，与旧版本兼容；主题使用 `devtrends-theme-v1`。收藏不上传服务器。语言切换保留当前页面和筛选参数。旧 `?date=` 链接仍能导航到日报，旧 `?style=` 参数不再改变界面。

### 构建与部署

构建产物位于 `dist/`，不提交 Git。静态 HTML 已包含正文和 SEO 元数据，不依赖浏览器请求完成后才能索引；详情页同时加入 sitemap。无效地址由 Cloudflare `404-page` 返回真实 404。

Cloudflare Workers Builds 连接本仓库 `main` 分支，每次推送（包括每日数据任务）都会自动构建和发布。对外主域名统一使用 <https://devtrends.site>。

发布前运行 `npm run check`。发布后检查首页、静态资源、最新日报 JSON、robots、sitemap、中英文日报及项目详情页，同时核对 canonical、最新日报 `llm-final` 状态和不存在页面的 404 状态。
