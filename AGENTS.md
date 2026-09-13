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

GitHub Trending 的 `daily` 榜是滚动窗口。来源层保留每天完整快照，日报与「今日发现」在发布层按规范化 `owner/repo` 执行 3 期冷却：过去 3 份已发布日报出现过的仓库不再进入普通项目列表；全球榜和中文榜同日重复时全球榜优先。聚合器读取完整榜单，排重后再按来源上限截断，避免榜单前部的旧项目挤掉后面的新发现。持续热门按当日新增 star 选最多 3 个，折叠展示并写入报告顶层 `trendingPolicy`。

仅有有效 GitHub 仓库根地址的项目生成详情页：`/projects/<owner>/<repo>/`，英文路径加 `/en` 前缀。所有者和仓库名统一小写，同仓库跨来源、跨日报合并，Issue / Blob / 用户主页不当作仓库。列表标题进入详情页，GitHub 和官网保留外链；其他产品仍直接访问外部地址。

- `web/shared.js`：构建与浏览器共用的语言字典、仓库识别、摘要、列表渲染和筛选 chip 标记。
- 列表标题（`D.displayTitle`）会去掉开头的**投稿标签**：`【开源自荐】`、`[开源推荐]`、`〖工具自荐〗`、`[Open Source]`、`[Tool Recommendation]`、`[Show HN] / [Tool]`、`Recommend: ` 等中英双语写法（`TITLE_LABEL_WORD` / `TITLE_BRACKET_LABEL` / `TITLE_PLAIN_LABEL`）。命中条件是「括号里含投稿动词」或「括号里整段都是标签词」，所以拿方括号当书名号的产品名（`【Tokenscope】`、`【Wegent】`、`[MAC]`）与 `AI-Native PM: …`、`Recommendation Engine — …` 这类正常标题不受影响；整个标题就是标签时退回原标题，不出现空标题。标签词数量都设了上限，避免正则指数回溯。原始 `title` 仍留在日报 JSON 里，重建即生效，不改历史文件。
- 列表标签 chip 过滤掉采集层的来源脚手架标签（`producthunt`、`ruanyf-weekly`、`hellogithub`、`indie-dev`、`new`、`official`、`submission` 等，见 `web/shared.js` 的 `sourceScaffoldTags`）：来源列已用徽标和名称标明来源，Product Hunt 这类行不再重复显示同名标签。同时去掉与「主语言 chip」重复的标签（github-trending 采集器会把语言写进 `tags`），大小写不同的同一标签只保留一个，每行最多 3 个。中国独立开发者各版块会把行首状态 emoji 写成标签（`已上线` / `开发中` / `已关闭`），状态不是主题、「已上线」也几乎每行都成立，所以一并过滤（`web/shared.js` 的 `collectionStatusTags`）；原始标签仍留在日报 JSON 里，区分主版 / 程序员版 / 游戏版的 `程序员版`、`游戏版` 标签照常显示。
- 列表标题（`.item-primary h2`，两种视图都是一行省略号）与描述（列表视图一行、宫格视图三行）都会截断（`web/styles.css`）。`web/app.js` 在悬停时用 `D.isClipped` 判断标题/描述是否真的被裁掉，只有被裁掉才挂 `title` 显示完整内容，未截断的行不会出现多余提示。
- 产品图片分三类：`logo`（VibeCafé 的 `logoUrl` / Product Hunt 的 `thumbnail`，平台自带的**产品标志**）、`siteLogo`（没有平台标志时，兜底取自项目官网自己声明的图标）与 `images`（`imageUrls` 全部配图，1~9 张）。`image` 仍为首张配图，仅作回退。列表 48px 头像的取值链是 `logo` → `icon` → `siteLogo` → 文字首字母（`web/shared.js` 的 `renderItem`）：**截图不再进头像**，它属于配图。前两者与 `siteLogo` 都渲染为 `img.is-logo` 白底 contain。配图由 `D.galleryHtml` 渲染缩略图条，点击后 `web/app.js` 的灯箱查看器（Esc / ← / → 关闭与翻页）展示全部配图；缩略图条只在宫格视图显示（`.card-view .item-gallery`），列表视图保持一行密集排版，项目详情页的配图区也照常显示（`.panel .item-gallery`）。
- 图片只镜像**产品标志**：`npm run images:sync` 下载全部日报里 item 的 `logo`/`icon`/`siteLogo`（都很小：VibeCafé logo 平均 ~46KB、官网页图标中位数 ~9KB）；`ph-files.imgix.net` 上的 Product Hunt 标志是唯一例外——那些 `thumbnail` 常是发布原图（实测最大 9MB，含动态 GIF），却只渲染成 48px 头像，所以 `scripts/image-store.js` 的 `isMirroredMark()` 跳过该 host，PH 标志一律回源不落盘（`IMAGES_RETENTION_DAYS>0` 的整期镜像模式除外），并删除不再被引用的清单项与文件；`image` / `images`（配图与截图，几百 KB 一张）不落盘，页面直接回源。需要连配图也镜像时设 `IMAGES_RETENTION_DAYS=N`（只镜像最新 N 期，默认 0）。回源域名白名单在 `web/shared.js` 的 `hotlinkOrigins`（VibeCafé 的 vercel blob 与 `ph-files.imgix.net`），由 `D.hotlinkable` 校验；白名单以外的外链仍会被 `D.localImage` 拦掉，构建对「既未同步又不可回源」的图片直接报错。VibeCafé 抓取时全量保留 `imageUrls`，Product Hunt 精选子集保留 `thumbnail`/`media`（`--refresh-featured` 可补历史）。
- 图片可外置到 R2（方案 A，默认仍是仓库内镜像）：镜像域名由仓库根的 `site.config.json` 的 `imageBase` 决定（提交进 Git，所以 Workers Builds 触发器和 CI 都不需要额外配置）；`IMAGE_BASE` 环境变量覆盖它，且 **`IMAGE_BASE=`（空值）强制回到仓库内镜像模式**，本地预览与测试用这个。设了域名后，`scripts/image-store.js` 的 `mirrorUrl()` 把清单里的相对路径重写成 `<origin>/images/<name>`，`copyImages()` 不再往 `dist/` 复制字节，`dist/_headers` 也不再输出 `/images/*` 规则；`web/shared.js` 的 `imageOrigins` 只放行该镜像域名，且路径形状仍必须是 64 位 sha256 + 白名单扩展名。`assets/images/manifest.json` 始终存相对路径，所以同一份 checkout 两种模式都能构建（`npm run check` 在两种模式下都必须通过）。
  - 上传：`npm run images:upload`（origin 取自 `site.config.json` / `IMAGE_BASE`；脚本 `scripts/image-upload.js`，默认桶 `community-pulse-images`、key 前缀 `images/`，用 `npx wrangler r2 object put` 上传并带 `Cache-Control: immutable`；已能从 origin 取到的对象自动跳过，支持 `--dry-run` / `--force`，可复用 `R2_BUCKET` / `R2_PREFIX` / `R2_CONCURRENCY` / `WRANGLER_BIN`）。预检通道整体不可用时会直接失败（而不是把 900 个对象重传一遍），`403/429/5xx` 记为无法判定而不是缺失。
  - 校验：`npm run images:verify`（脚本 `scripts/image-verify.js`，HEAD 全部镜像；非 200 或 `content-type` 不是 `image/*` 都会列出并以退出码 1 结束，`--sample N` 可抽样）。**这是从 Git 移除镜像的前置门槛，也是每次上传后的冒烟检查。**
  - 日报 workflow 在 `images:sync` 之后有「上传新图片到 R2」步骤：**缺 `CLOUDFLARE_API_TOKEN` 时直接失败**（镜像已移出 Git，不上传就会线上破图，所以不允许静默跳过）；上传失败或需要手动补传时跑 `.github/workflows/images-r2.yml`（sync → upload → verify，幂等可重复）。两个 workflow 都用 `vars.R2_BUCKET` 覆盖桶名，`IMAGE_BASE` 缺省回落到 `https://img.devtrends.site`。
  - **镜像文件不落 Git**：`.gitignore` 里 `assets/images/*` + `!assets/images/manifest.json`，所以只跟踪清单；`git add assets/images/` 在日报 workflow 里仍然有效（只会带上 manifest）。
  - 切到外置的顺序：① 建 R2 桶并把 `img.devtrends.site` 绑到桶（已完成）；② 跑一次 `images:upload` 全量上传（已完成）；③ 把 `site.config.json` 的 `imageBase` 填成 `https://img.devtrends.site` 并提交——**不需要动 Cloudflare 后台**（`IMAGE_BASE` 环境变量仍可临时覆盖，`IMAGE_BASE=` 强制回仓库内模式）；④ 加 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 仓库密钥（已完成，`.github/workflows/images-r2.yml` 手动 workflow 验证通过）；⑤ 跑 `images:verify` 确认全部可达后把 `assets/images/*` 移出 Git（**已完成**：`.gitignore` + `git rm -r --cached`，只保留 manifest，日报 workflow 的上传步骤同时改为缺凭证即失败）；⑥ 历史清理（**已完成**）：`git filter-repo --path-regex '^assets/images/[a-f0-9]{64}\.(png|jpg|jpeg|gif|webp|avif|ico|svg)$' --invert-paths` 后 force-push，`main` 历史里已无图标 blob（本地 `.git` 493 MB → 415 MB）。
  - 注：本机 `.git` 的剩余体积由 agent harness 自己的 `refs/codex/turn-diffs/checkpoints/*`（15 个，从未推送）持有旧图标对象；要回收需删除这些 ref 后 `git gc --prune=now`，但那会丢掉 harness 的历史 turn diff，按需决定。GitHub 侧空间要等它自己 gc 才回落。
  - 清历史前的全量 bundle 备份在 `.wrangler/tmp/backup-before-purge.bundle`（440 MB，未跟踪），线上稳定几天后可删。
- 官网 Logo 兜底层（`source-raw/site-logos/<date>.json`）：没有平台标志的行改读项目官网自己声明的图标。日报 workflow 在 GitHub 仓库快照之后运行 `capture_site_logos_raw.js --date $TARGET --observed-date $OBSERVED --strict`，`validate_site_logos_raw.js` 离线校验；`source_raw_items.js` 只在下游离线把 `siteLogo` 挂到缺标志的行上，`collect.js` 不联网。候选官网取 `websiteUrl` → 仓库 `homepage` → 行自身 URL，并跳过 GitHub / 应用商店 / 微信知乎等内容平台（平台图标会重复且认错对象）；图标按 apple-touch-icon → ≥96px icon → SVG icon → 其他 icon → schema.org logo → `/favicon.ico` 排序，超过 256KiB 的「品牌大图」（可用 `SITE_LOGO_MAX_KB` 调整）会跳到下一个候选，避免把 1MB 的图永久写进 Git。历史日报用 `node scripts/backfill_site_logos.js --start --end [--dry-run]` 回填，再跑 `npm run images:sync` 与 `npm run check`；细节见 `.agents/skills/community-pulse/SKILL.md`。
- 筛选栏只有「分类」一种：今日发现和历史日报都用 `D.chipFilterHtml(options, locale)` 在构建时渲染预制分类 chip；日报页侧栏的「数据来源」只是带官网链接的目录，不再提供来源筛选。`web/app.js` 只把放不下的收进「更多分类」菜单，桌面端始终单行且没有横向滚动条，≤600px 换成原生下拉。加减分类不需要改这段逻辑，宽度自适应；被收纳的当前分类会显示在触发按钮上。
- `web/theme.js`：首屏前应用主题，存储键 `devtrends-theme-v1`。
- 日报与项目详情页的评论由公开仓库 `null-object-0000/devtrends-comments` 的 GitHub Discussions / giscus 承载；日报讨论键为 `report:<YYYY-MM-DD>`，项目讨论键为 `project:<owner>/<repo>`，中英文共用同一讨论。历史日报页按月渲染周一开头的 7 列月历，日期格展示项目数、去重数据源数和评论数；评论数来自 `data/comment-counts.json` 静态快照，日报 workflow 用 `npm run comments:sync` 批量刷新，不在浏览器暴露 GitHub Token，也不为每个日期加载 giscus iframe。手机断点（≤600px）隐藏星期头与空日期，退化为按月份分组的单列日报列表。
- `scripts/render-site.js`：通用 HTML、日报和历史归档模板。
- `scripts/projects.js`：项目聚合、仓库快照、收录历史、相关项目及详情 SEO。
- `scripts/enhanced-report.js`：沿用原 final 摘要匹配策略，未匹配项仍为 raw，部分匹配标记 mixed。
- 中英文内容优先使用 `summaryZh` / `summaryEn`（兼容下划线字段）；英文缺译文时优先使用英文仓库介绍，否则显示原文并标注。中文 final 摘要仍优先于 raw。
- 语言由 URL 确定；切换语言保留路由、搜索和分类筛选。旧的 `?source=` 参数不再过滤，加载时从地址栏清掉。
- 周期刊来源（`weekly-issue` / `hellogithub-issue`）的行必须落在 release commit 的**北京日**：`collect.js` 只读 `source-raw/<source>/<date>.json`（`loadDocument` 强制 `targetDate === date`），`capture_periodicals_raw.js` 用「发布：《HelloGitHub》第 N 期」这类提交信息反推日期。已退役的实时采集器（`.agents/skills/community-pulse/scripts/sources/*.js`）按「运行日是不是发布日」触发、内容却取当时最新一期，历史重算时把同一期铺到了多个日期（HelloGitHub 125 期 × 3 天、阮一峰周刊 411 期 × 27 个周五，详情页的「收录记录」因此出现重复行）；2026-09-11 已用 source-raw 离线重放修正受影响的 43 个日报（raw 的 json + md），重建时非周期刊来源与 md 其它分区逐字节未变。
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
