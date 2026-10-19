# 把 devtrends.site 搬到自建服务器（阿里云 ECS / 上海）

这份目录只做一件事：让站点能在**自己的机器上**跑起来，并且**不再依赖 Cloudflare 才能服务**。

## 为什么是这样一个形状

| 事实（实测） | 推论 |
|---|---|
| 真人访客 CN 占 56%（Clarity），但量极小：约 30 会话/天 | 不需要为性能做复杂设计；重点是「能跑、能自动更新」 |
| 峰值小时只用掉 3 Mbps 出网上限的 1.8% | 带宽不是约束，也不需要 nginx 前置 |
| 动态路由 37,450 条，其中 36,112 条可索引 | 全静态化要预渲染 3.6 万页（≈1.8 GB）→ 不划算，保留动态渲染 |

于是：**一个容器**，Node 同时服务静态站与动态详情页；渲染逻辑**逐字复用** `worker/` 里那份
（见 `server.mjs` 顶部注释），只把 Cloudflare 的两个运行时绑定换成自建环境的等价物。

## 跑起来

> **部署目录不要放在 `/home` 下。** 这台机器的 docker 是 snap 安装的，snap 的 AppArmor
> 限制读不到 `/home` 里的**隐藏目录**（构建报 `open …/.agents: permission denied`，而权限位
> 明明是 755 root:root）。放到 `/srv/devtrends-site` 这类路径下即可 —— 已经实测。

```bash
# 1) 取代码（直连 GitHub 会间歇性 GnuTLS 报错，带上 HTTP/1.1 更稳）
git -c http.version=HTTP/1.1 clone --depth 1 --branch main \
  https://github.com/null-object-0000/community-pulse.git /srv/devtrends-site

# 2) 数据库凭据（只读账号；不填也能跑，动态路径走过渡反代）
cd /srv/devtrends-site && cp deploy/.env.example deploy/.env && vi deploy/.env

# 3) 构建并启动
docker compose -f deploy/compose.yaml up -d --build

# 4) 验证
curl -sI http://127.0.0.1:8080/ | head -3          # 首页 200
curl -s  http://127.0.0.1:8080/healthz              # ok
curl -sI http://127.0.0.1:8080/products/prd_xxxxxxxxxxxxxxxxxxxxxxxx/ | head -3
```

## 接入对外访问（两种，选一种）

**A. 走 nginx-proxy-manager（推荐，与现有 15 条规则一致）**
在 NPM 里加一条 Proxy Host：`devtrends.site` → `devtrends-site` : `8080`，勾上 SSL（Let's Encrypt）。

**B. 绕过 NPM，让阿里云 CDN 直接回源到本机端口**
CDN 源站填 `47.103.155.183:8080`，安全组放行该端口。适合「不想动 NPM 配置」时。

两条路都需要在阿里云侧把 `devtrends.site` 的解析（CNAME）指向 CDN —— 这一步是备案核查要的
「解析到阿里云国内节点」，**只有账号持有人能操作**。

## 每日自动更新（「站点别停更」）

站点内容每天由日报流程产出，所以部署链必须自己会跑，不能依赖某个人。

**推荐：Dockhand Git 栈**（本机已在运行）
1. Dockhand → Git → 添加仓库：`https://github.com/null-object-0000/community-pulse.git`，分支按需（当前是 `main`），公开仓库免凭据
2. Stacks → 新建 Git 栈，composePath 填 `deploy/compose.yaml`，开启自动更新（cron 或 push webhook）
3. 之后 `main` 一旦有新提交 → Dockhand 拉取并重建容器 → 站点更新

也可以手工触发：`docker compose -f deploy/compose.yaml up -d --build`。

## 注意事项

- **`dist/` 不进 Git**，所以镜像构建必须在容器内跑 `npm run build`（Dockerfile 已这么做）。
- 构建只需要仓库里已提交的日报、站点快照与图片清单；图片本体走 `IMAGE_BASE`（`site.config.json`），
  当前指向 Cloudflare R2 `img.devtrends.site` —— 内地访问图片仍走境外，后续可改阿里云 OSS。
- 缓存策略不另写一份：`server.mjs` 解析构建产物 `dist/_headers`，与 Cloudflare 上行为一致。
- 容器健康检查打 `/healthz`（不由 worker 处理），Dockhand 与本机 `docker ps` 都能看到状态。
