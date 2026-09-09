# CommunityPulse agent notes

## 网站与部署

- 对外唯一主域名：<https://devtrends.site>
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

网站源码在 `web/`，`scripts/build-site.js` 会读取 `知识/大家都在做什么/raw/*.json`，生成日期索引并复制全部日报到 `dist/data/reports/`。网站支持 GitHub Trending、VibeCafé、Product Hunt 和 Markdown 四种展示风格。

部署后至少检查：

- `/` 返回 HTML 200
- `/styles.css` 与 `/app.js` 返回 200
- `/data/index.json` 返回最新日期和历史日期列表
- `/data/reports/<latest>.json` 返回最新日报

对外链接、canonical、站点地图和分享元数据统一使用 `https://devtrends.site`；旧域名不再作为对外地址。`workers.dev` 地址仅作为生产备用入口。

SEO 产物由 `scripts/build-site.js` 随日报一起生成：

- `/robots.txt`
- `/sitemap.xml`
- `/reports/<YYYY-MM-DD>/` 独立静态报告页

部署后还需检查 `/robots.txt`、`/sitemap.xml` 与最新一期 `/reports/<latest>/` 均返回 200，页面 canonical 必须指向 `devtrends.site`。
