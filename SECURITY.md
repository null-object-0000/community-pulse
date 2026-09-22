# 安全策略

## 报告漏洞

请通过 GitHub 的**私密漏洞报告**渠道提交：本仓库 **Security** 标签页 → **Report a vulnerability**（GitHub Security Advisories）。这条渠道只有维护者可见，适合附上复现步骤、请求样本或日志。

**不要在公开 Issue、PR 或讨论里粘贴任何密钥、令牌、Cookie、数据库连接串或完整的请求日志** —— 那等于把凭据公开。如果已经贴出，请立刻删除并视为已泄露、需要轮换。

## 适用范围

- `worker/` —— Cloudflare Worker：站点路由、项目 / 产品详情页渲染、Catalog API、验证文件直出
- `scripts/` 与 `.agents/skills/community-pulse/` —— 构建、采集与导入脚本
- `.github/workflows/` —— 日报与部署流水线
- 线上站点 <https://devtrends.site> 本身（XSS、开放重定向、缓存投毒、越权访问等）

## 不在范围内

- 被聚合的第三方项目或平台自身的问题（请直接反馈给对应作者或平台）
- 第三方依赖里已公开披露的漏洞（可以提 Issue 提醒升级，但不必走私密渠道）
- 缺少 CSP、缺少 Cookie 同意横幅、第三方分析脚本（Google Analytics / Microsoft Clarity）这类已知的设计取舍
- 对公开只读数据的抓取或大量请求（这是本站的公开用途；但如果你发现的是**放大攻击**或可被用来消耗资源的路径，那属于范围内）

## 已知的设计取舍

- 站点是公开只读的：`/api/v1/*` 只提供聚合后的公开数据，没有账号体系，也不接受写入。
- 图片只从镜像域名与两个白名单回源 host 加载，白名单以外的地址会被拦掉。
- 凭据只存放在仓库 secrets/vars 或本机未提交的 `.env` 里；`.env`、`.dev.vars` 与 Cloudflare 本地状态目录都在 `.gitignore` 中。

---

# Security Policy (English)

Report vulnerabilities privately through this repository's **Security → Report a vulnerability** tab (GitHub Security Advisories). Never post secrets, tokens, cookies or connection strings in a public issue.

In scope: the Cloudflare Worker (`worker/`), the build and collection scripts (`scripts/`, `.agents/skills/`), the GitHub Actions pipelines, and the live site at <https://devtrends.site>. Out of scope: issues in the third-party projects and platforms we aggregate, already-disclosed dependency CVEs, and known design choices such as the absence of a CSP or a cookie-consent banner.
