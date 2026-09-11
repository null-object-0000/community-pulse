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

收藏使用浏览器本地 `localStorage`（键名 `devtrends-favorites-v1`），不上传服务端；顶部“我的收藏”入口对应 `/favorites/`。旧收藏按规范化仓库 URL 去重，保留快照并连接已生成的详情页。

仅有有效 GitHub 仓库根地址的项目生成详情页：`/projects/<owner>/<repo>/`，英文路径加 `/en` 前缀。所有者和仓库名统一小写，同仓库跨来源、跨日报合并，Issue / Blob / 用户主页不当作仓库。列表标题进入详情页，GitHub 和官网保留外链；其他产品仍直接访问外部地址。

- `web/shared.js`：构建与浏览器共用的语言字典、仓库识别、摘要、列表渲染和筛选 chip 标记。
- 筛选栏（分类 / 来源）由 `D.chipFilterHtml` 在构建时渲染全部 chip；`web/app.js` 只把放不下的收进「更多分类」菜单，桌面端始终单行且没有横向滚动条，≤600px 换成原生下拉。加减分类不需要改这段逻辑，宽度自适应；被收纳的当前分类会显示在触发按钮上。
- `web/theme.js`：首屏前应用主题，存储键 `devtrends-theme-v1`。
- `scripts/render-site.js`：通用 HTML、日报、历史归档和收藏模板。
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

新版部署后还需检查一个中英文项目详情页均返回 200、sitemap 包含详情页、不存在的项目地址返回 404。收藏页应为 noindex。
