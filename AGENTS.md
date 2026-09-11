# DevTrends agent notes

## 网站与部署

- 对外唯一主域名：<https://devtrends.site>
- 英文品牌：`DevTrends`
- 中文品牌：`开发者趋势`
- 主栏目 / Slogan：`大家都在做什么`
- 品牌标志：`web/logo.svg`（深色 D 字母 + 蓝色上升趋势线）
- Cloudflare Workers 生产地址：<https://community-pulse.nichangen.workers.dev>
- Cloudflare 预览地址规则：`*-community-pulse.nichangen.workers.dev`
- Cloudflare Worker / 项目名称：`community-pulse`
- GitHub 仓库：`null-object-0000/community-pulse`
- 生产分支：`main`

Cloudflare Workers Builds 已直接连接 GitHub 仓库。任何推送到 `main` 的提交都会触发构建和部署；这包括每日数据任务写入新日报后的提交。

构建配置：

- Root directory：仓库根目录
- Build command：`npm run build`
- Deploy command：`npx wrangler deploy`
- 静态资源输出目录：`dist/`（构建产物，不提交 Git）
- Workers 静态资源配置：`wrangler.toml`

网站源码在 `web/`，`scripts/build-site.js` 会读取 `知识/大家都在做什么/raw/*.json`的结构化数据，并在同日 `final/*.md` 存在时将 LLM 增强摘要合并进列表 JSON；只有没有 final 的日期才回退到 raw 摘要。网站采用统一 DevTrends 主题，支持简体中文 / 英文与浅色 / 深色 / 跟随系统模式。Markdown 保留为日报下载入口。

仅有有效 GitHub 仓库根地址的项目生成详情页：`/projects/<owner>/<repo>/`，英文路径加 `/en` 前缀。所有者和仓库名统一小写，同仓库跨来源、跨日报合并，Issue / Blob / 用户主页不当作仓库。列表标题进入详情页，GitHub 和官网保留外链；其他产品仍直接访问外部地址。

- `web/shared.js`：构建与浏览器共用的语言字典、仓库识别、摘要、列表渲染和筛选 chip 标记。
- 列表标签 chip 过滤掉采集层的来源脚手架标签（`producthunt`、`ruanyf-weekly`、`hellogithub`、`indie-dev`、`new`、`official`、`submission` 等，见 `web/shared.js` 的 `sourceScaffoldTags`）：来源列已用徽标和名称标明来源，Product Hunt 这类行不再重复显示同名标签。同时去掉与「主语言 chip」重复的标签（github-trending 采集器会把语言写进 `tags`），大小写不同的同一标签只保留一个，每行最多 3 个。
- 列表描述在列表视图截成一行、宫格视图截成三行（`web/styles.css`）。`web/app.js` 在悬停时用 `D.isClipped` 判断描述是否真的被裁掉，只有被裁掉才挂 `title` 显示完整描述，未截断的行不会出现多余提示。
- 产品图片分三类：`logo`（VibeCafé 的 `logoUrl` / Product Hunt 的 `thumbnail`，平台自带的**产品标志**）、`siteLogo`（没有平台标志时，兜底取自项目官网自己声明的图标）与 `images`（`imageUrls` 全部配图，1~9 张）。`image` 仍为首张配图，仅作回退。列表 48px 头像的取值链是 `logo` → `icon` → `siteLogo` → 文字首字母（`web/shared.js` 的 `renderItem`）：**截图不再进头像**，它属于配图。前两者与 `siteLogo` 都渲染为 `img.is-logo` 白底 contain。配图由 `D.galleryHtml` 渲染缩略图条，点击后 `web/app.js` 的灯箱查看器（Esc / ← / → 关闭与翻页）展示全部配图；缩略图条只在宫格视图显示（`.card-view .item-gallery`），列表视图保持一行密集排版，项目详情页的配图区也照常显示（`.panel .item-gallery`）。
- 图片只镜像**产品标志**：`npm run images:sync` 下载全部日报里 item 的 `logo`/`icon`/`siteLogo`（都很小：VibeCafé logo 平均 ~46KB、Product Hunt thumbnail ~13KB、官网页图标中位数 ~9KB），并删除不再被引用的清单项与文件；`image` / `images`（配图与截图，几百 KB 一张）不落盘，页面直接回源。需要连配图也镜像时设 `IMAGES_RETENTION_DAYS=N`（只镜像最新 N 期，默认 0）。回源域名白名单在 `web/shared.js` 的 `hotlinkOrigins`（VibeCafé 的 vercel blob 与 `ph-files.imgix.net`），由 `D.hotlinkable` 校验；白名单以外的外链仍会被 `D.localImage` 拦掉，构建对「既未同步又不可回源」的图片直接报错。VibeCafé 抓取时全量保留 `imageUrls`，Product Hunt 精选子集保留 `thumbnail`/`media`（`--refresh-featured` 可补历史）。
- 官网 Logo 兜底层（`source-raw/site-logos/<date>.json`）：没有平台标志的行改读项目官网自己声明的图标。日报 workflow 在 GitHub 仓库快照之后运行 `capture_site_logos_raw.js --date $TARGET --observed-date $OBSERVED --strict`，`validate_site_logos_raw.js` 离线校验；`source_raw_items.js` 只在下游离线把 `siteLogo` 挂到缺标志的行上，`collect.js` 不联网。候选官网取 `websiteUrl` → 仓库 `homepage` → 行自身 URL，并跳过 GitHub / 应用商店 / 微信知乎等内容平台（平台图标会重复且认错对象）；图标按 apple-touch-icon → ≥96px icon → SVG icon → 其他 icon → schema.org logo → `/favicon.ico` 排序，超过 256KiB 的「品牌大图」（可用 `SITE_LOGO_MAX_KB` 调整）会跳到下一个候选，避免把 1MB 的图永久写进 Git。历史日报用 `node scripts/backfill_site_logos.js --start --end [--dry-run]` 回填，再跑 `npm run images:sync` 与 `npm run check`；细节见 `.agents/skills/community-pulse/SKILL.md`。
- 筛选栏（分类 / 来源）由 `D.chipFilterHtml` 在构建时渲染全部 chip；`web/app.js` 只把放不下的收进「更多分类」菜单，桌面端始终单行且没有横向滚动条，≤600px 换成原生下拉。加减分类不需要改这段逻辑，宽度自适应；被收纳的当前分类会显示在触发按钮上。
- `web/theme.js`：首屏前应用主题，存储键 `devtrends-theme-v1`。
- `scripts/render-site.js`：通用 HTML、日报和历史归档模板。
- `scripts/projects.js`：项目聚合、仓库快照、收录历史、相关项目及详情 SEO。
- `scripts/enhanced-report.js`：沿用原 final 摘要匹配策略，未匹配项仍为 raw，部分匹配标记 mixed。
- 中英文内容优先使用 `summaryZh` / `summaryEn`（兼容下划线字段）；英文缺译文时优先使用英文仓库介绍，否则显示原文并标注。中文 final 摘要仍优先于 raw。
- 语言由 URL 确定；切换语言保留路由、搜索和来源筛选。
- 完整验证：`npm run check`（构建 + 模型 / 主题 / SEO 路由测试）。

部署后至少检查：

- `/` 返回 HTML 200
- `/styles.css` 与 `/app.js` 返回 200
- `/data/index.json` 返回最新日期和历史日期列表
- `/data/reports/<latest>.json` 返回最新日报；存在同日 final 时 `presentation.summarySource` 必须为 `llm-final`

对外链接、canonical、站点地图和分享元数据统一使用 `https://devtrends.site`；旧域名不再作为对外地址。`workers.dev` 地址仅作为生产备用入口。

SEO 产物由 `scripts/build-site.js` 随日报一起生成：

- `/robots.txt`
- `/sitemap.xml`
- `/reports/` 历史归档
- `/reports/<YYYY-MM-DD>/` 独立静态报告页
- `/projects/<owner>/<repo>/` GitHub 项目详情页及 `/en/` 对应页，包含 canonical、hreflang 与 SoftwareSourceCode / BreadcrumbList 结构化数据
- `404.html` / `en/404.html`；Cloudflare 使用 `404-page` 返回真实 404，避免无效项目地址返回首页 200

部署后还需检查 `/robots.txt`、`/sitemap.xml` 与最新一期 `/reports/<latest>/` 均返回 200，页面 canonical 必须指向 `devtrends.site`。

新版部署后还需检查一个中英文项目详情页均返回 200、sitemap 包含详情页、不存在的项目地址返回 404。
