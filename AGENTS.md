# DevTrends agent notes

## 开发日志（CHANGELOG.md）

仓库根的 `CHANGELOG.md` 是**项目开发史的唯一落点**，按天记录。

- **每完成一项改动就补当天的条目**（同一批工作内顺手补，不要攒着），新增一天就在「总览」表加一行并在下方加一个小节。
- 记**决策**，不只记改动 —— 写清「为什么这么选」「试过什么又放弃了」，纯功能罗列次要。
- 口径：改动按路径分**代码 / 文档 / 数据**三类；日报、回溯这类数据提交聚合成一句，不逐条列。
- 更新它不需要改代码、也不用跑构建。历史起点见该文件的「维护约定」与「统计说明」（项目前 86 个提交在 `MyVault` 仓库）。

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
- 一级 `primaryCategory` 继续承担互斥的主分类；发现与趋势分析另用 `taxonomy` 多分面描述业务场景（`useCases`）、Agent 生态角色（`agentRoles`）、产品形态（`productForms`）、运行平台（`platforms`）和适配生态（`integrations`）。受控 ID 与历史规则回填都定义在 `web/shared.js`；新日报的 LLM 隐藏元数据使用 schema v3 直接产出受控标签，旧日报在构建时确定性推断，原始 `source-raw` / `raw` 均不改写。列表只优先展示最多 3 个高信息密度标签，详情页可展示更多；对外 chip 用 `DT` 标记 DevTrends 后续归类、用 `原始` 标记项目或来源原始标签、用 `语言` 标记主编程语言，原始标签存在时列表会为它预留一个语义标签位。
- 业务场景支持二级主题：层级只写在 `web/shared.js` 的 `taxonomyParents`（目前 `novel-writing` 小说创作 ⊂ `content-creation` 内容创作；`travel-mobility` 的细分场景以后往这里加）。项目**只存最细粒度的 ID**——`normalizeTaxonomy` 遇到「父 + 子」会丢掉父级，LLM 提示词也要求只写最细的那个；父级由 `facetAncestors` / `facetDescendants` 在读的时候推出来，所以同一个项目不会在一个分面里被算两次，而父级的计数、周序列和分类库都是「直接命中 + 全部子主题」的合计（`clusterMemberships` 把子项挂到祖先上）。chip 上仍只显示最细的那个标签，层级出现在趋势卡的 `业务场景 · 内容创作的子主题`、分类页面包屑与 tooltip（`facetPathLabel`）。加减子主题只要改 `taxonomyParents` 一条映射，重建即生效。
- `/trends/` 与 `/en/trends/` 是构建期趋势页，`scripts/trends.js` 按规范化 GitHub 仓库或去除 UTM 的官网 URL 去重，只统计项目在站内的首次出现；默认比较最近 7 天与此前 28 天，至少 3 个新项目、覆盖 2 个来源且日均出现速度提升 25%（或此前窗口为 0）才展示一个业务场景或 Agent 角色趋势簇。趋势卡支持查看最近 4 / 8 / 12 周变化；每个趋势簇生成可索引的中英文分类页（如 `/trends/use-cases/content-creation/`），复用项目列表展示当前周期内全部首次发现项目，并支持搜索、排序和首次发现日期。模型同时写入 `/data/trends.json`，趋势页和分类页都进入 sitemap。
- 分类页同时是「分类库」：页面顶部有「收录范围」切换（本周期 / 近 4 周 / 近 12 周 / 全部历史），默认仍是服务器渲染的本周期列表，所以没有 JavaScript 也能读；更宽的范围按需拉取 `data/trends/<segment>/<id>.json`（构建期 `buildClusterLibrary` 生成，只保留列表渲染需要的字段并写入算好的 `taxonomy`，`content` 不进清单），宽范围每次只画 60 行、其余用「显示更多」增量加载，范围状态保存在 `?range=`。计数、来源数和最早 / 最近收录日期在构建期算好写进页面（`cluster.ranges`），切换范围时由 `web/app.js` 就地更新统计与列表，无需重新构建；英文分类页共用同一份数据文件。
- `web/theme.js`：首屏前应用主题，存储键 `devtrends-theme-v1`。
- 站点分析：`web/index.html` 的 `<head>` 里内联两个第三方标签——Google Analytics（`G-1E9PXZ2EVK`）和 Microsoft Clarity（项目 `yhhvfzftgj`），经 `scripts/render-site.js` 的同一个 shell 输出到**每个页面**（中英文、日报、项目页、404 都带）。两者都是官方 `async` 片段，不阻塞渲染；`tests/site.test.js` 会断言标签与 ID，换 ID 时要同步改测试。Clarity 记录的是会话回放，需要遮蔽敏感内容或做同意管理时在 Clarity 后台设置（仓库里没有 consent banner）。
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

- `/robots.txt`。线上看到的是 Cloudflare Managed robots.txt 在前、我们这份在后的拼接结果：内容信号（`search=yes,ai-train=no,use=reference`）与 `GPTBot` / `CCBot` / `ClaudeBot` / `Google-Extended` / `Bytespider` 等训练爬虫的 `Disallow` 由 Cloudflare 追加，`OAI-SearchBot` 没有被屏蔽（ChatGPT 搜索能抓、训练不能），所以仓库里的 `dist/robots.txt` 故意只写 `User-agent: *` + `Sitemap`，不要重复 Cloudflare 那一段。
- `/sitemap.xml`：每个 `<url>` 都带 `xhtml:link` 的 `zh-CN` / `en` / `x-default` 对应关系（中英各一条 `<url>`）。
- `/sitemap-baidu.xml`：只有中文 canonical URL、不含国际化扩展的独立站点地图，给百度搜索资源平台用。
- `/feed.xml` 与 `/en/feed.xml`：最近 30 期日报的 RSS，页面用 `<link rel="alternate" type="application/rss+xml">` 声明。
- `/og-image.png`（1200×630 品牌分享图）与 `/logo-512.png`（Apple Touch Icon）；每个页面输出 `og:image` 与 `twitter:summary_large_image`。这两个 PNG 是提交进仓库的成品，可编辑源文件是 `web/og-image.svg` 与 `web/logo.svg`——仓库没有依赖，所以不做构建期栅格化，改图后要人工重新导出一次（`build-site.js` 只负责复制）。
- `/<indexNowKey>.txt`：IndexNow 的公开 key 文件，key 存在 `site.config.json` 的 `indexNowKey`（8~128 位十六进制，构建时校验，非法直接报错），页面源文件在 `web/<key>.txt`。
- 站长平台的**归属验证文件**（百度的 `baidu_verify_code*.html`、既有的 `dd375fa2…txt` 等）统一放在仓库根的 `verification/`，构建时整目录原样复制到站点根：接新平台只要把文件丢进那个目录，不用改代码。`tests/site.test.js` 会核对每个文件都按原字节出现在 `dist/`；**验证通过后不要删文件**（删掉验证就失效），百度下发的验证码也在测试里固定断言，避免被误改。
  - Cloudflare 静态资源的默认 `html_handling`（`auto-trailing-slash`）会把 `/x.html` **307** 跳到 `/x`，而百度这类文件验证要求下发的那条 `.html` 地址本身返回 200（实测 check-host 30 个节点里 29 个都是 307，百度因此报「无法连接到您网站的服务器」）。所以 `wrangler.toml` 配了 `main = "worker/index.js"` + `run_worker_first = ["/baidu_verify_*"]`，由 `worker/index.js` 用 `ASSETS` 绑定取同名无扩展名资源并以 200 直出；**其余请求不经过脚本**，目录路由、`/index.html` 的规范化 307 与 404 行为都不变。注意 `html_handling = "none"` 能把 `.html` 变回 200，但它同时会让 `/reports/` 这类目录索引全部 404，**不能用**；`_redirects` 也不支持 200 重写（官方文档明确 Rewrites ❌）。接新平台时在 `worker/index.js` 的正则和 `run_worker_first` 里各加一条。
- `/reports/` 历史归档与 `/reports/<YYYY-MM-DD>/` 独立静态报告页。
- `/projects/<owner>/<repo>/` GitHub 项目详情页及 `/en/` 对应页，包含 canonical、hreflang 与 WebSite / Organization / CollectionPage / SoftwareSourceCode / BreadcrumbList 结构化数据（首页是 `WebSite` + `Organization` 的锚点，其余页面用 `isPartOf` 指回去）。
- `404.html` / `en/404.html`；Cloudflare 使用 `404-page` 返回真实 404，避免无效项目地址返回首页 200。

- 搜索引擎主动推送：`scripts/search-submit.js`（`npm run search:submit -- --date YYYY-MM-DD [--dry-run] [--indexnow-only|--baidu-only]`）用同一份日报算出本期变化的 URL，IndexNow 一次推送全部中英地址（POST `https://api.indexnow.org/indexnow`，`key` 取自 `site.config.json`，`keyLocation` 就是 `/<key>.txt`），百度「普通收录」只推中文 canonical URL。`.github/workflows/search-index.yml` 在「大家都在做什么·日报」成功后触发：先轮询 `/data/index.json` 直到线上出现该日报（最多 10 分钟，避免推送 Cloudflare 还没上线的地址），轮询顺序是生产 Worker 的 `workers.dev` 备用入口 → 公开主域：**公开主域对 CI 出口返回的是 Cloudflare 浏览器验证 HTML（HTTP 403），跟部署有没有完成无关**，所以 CI 侧一律先走备用入口、主域只兜底，再依次推送；百度按条提交、当天配额用满即停（百度对超额批次整批拒绝，见 `CHANGELOG.md` 2026-09-16），未推的部分由 `/sitemap-baidu.xml` 兜底；缺 `BAIDU_SITE_TOKEN` 仓库 Secret 时整步跳过而不失败（**现已配置**），所以接入前后都不影响日报发布。支持手动 `workflow_dispatch` 指定 `date` 或 `dry_run` 补推某一期。IndexNow 不需要注册；Bing Webmaster Tools（可直接从 Google Search Console 导入站点与 Sitemap）和百度搜索资源平台的站点验证、Sitemap 提交仍需人工在各自后台做一次。

部署后还需检查 `/robots.txt`、`/sitemap.xml` 与最新一期 `/reports/<latest>/` 均返回 200，页面 canonical 必须指向 `devtrends.site`；`/feed.xml`、`/en/feed.xml`、`/sitemap-baidu.xml`、`/og-image.png`（1200×630 PNG）、`/logo-512.png` 与 `/<indexNowKey>.txt` 也都要返回 200，`/sitemap.xml` 的每个 `<url>` 带 3 条 `xhtml:link`、`/sitemap-baidu.xml` 的 `<loc>` 数量正好是它的一半。

新版部署后还需检查一个中英文项目详情页均返回 200、sitemap 包含详情页、不存在的项目地址返回 404。
