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

网站以 `raw/*.json` 保留指标、链接和图片等结构化数据；存在同日 `final/*.md` 时，构建阶段会将 LLM 翻译/归纳后的摘要回填到列表 JSON。因此 GitHub Trending、VibeCafé、Product Hunt 和 Markdown 四种展示风格使用同一份增强内容；没有 final 的历史日期才回退到 raw。网站适配手机与电脑。

```bash
npm run build
npm run preview
```

构建产物在 `dist/`。`wrangler.toml` 已配置为 Cloudflare Workers 静态资源站点。Cloudflare Workers Builds 连接本仓库的 `main` 分支后，每次推送（包括每日数据任务的提交）都会自动构建并发布。

绑定域名时在 `wrangler.toml` 增加 Custom Domain 配置，例如：

    [[routes]]
    pattern = "pulse.example.com"
    custom_domain = true
