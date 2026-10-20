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

> **部署目录必须放在 `/root` 下**（本文用 `/root/devtrends-site`）。这台机器的 docker 是
> snap 安装的，snap 的 AppArmor 对路径放行很挑。同一个最小构建（`COPY . /x` 后读 `.hidden/f`）
> 实测：
>
> | 路径 | buildkit 读构建上下文（含隐藏目录） |
> |---|---|
> | `/root/…` | ✅ 可读 |
> | `/var/snap/docker/common/…` | ✅ 可读 |
> | `/home/…` | ❌ `open .hidden: permission denied` —— `.agents` 就是这么失败的 |
> | `/srv`、`/opt`、`/mnt`、`/media` | ❌ 客户端根本看不见（被解析成 `/var/lib/snapd/void/…`）|
>
> 注意 `/srv` 看着「正规」但完全不可见，别照搬常规习惯。

```bash
# 1) 取代码（直连 GitHub 会间歇性 GnuTLS 报错，带上 HTTP/1.1 更稳）
git -c http.version=HTTP/1.1 clone --depth 1 --branch main \
  https://github.com/null-object-0000/community-pulse.git /root/devtrends-site

# 2) 数据库凭据（只读账号；不填也能跑，动态路径走过渡反代）
cd /root/devtrends-site && cp deploy/.env.example deploy/.env && vi deploy/.env

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

站点内容每天由日报流程写进仓库，所以部署链必须自己会跑，不能依赖某个人记得手动部署。
`deploy/update.sh` 干这件事：`fetch` 当前分支 → 有新提交就 `reset --hard` + 重建镜像 + 滚动
重启容器（失败时容器保持旧版本继续服务，日志留在仓库根的 `update.log`）。

> 用 `reset --hard` 而不是 `pull`：这是浅克隆（`--depth 1`），而浅克隆之间
> `git merge --ff-only FETCH_HEAD` 会报 `refusing to merge unrelated histories` —— 实测踩到。
> 因此**不要在服务器上改仓库里的文件**（会被下一次更新覆盖），要改就改仓库、推上去。

```bash
# 安装（一次性）：脚本随仓库来，这里只装 cron
chmod +x /root/devtrends-site/deploy/update.sh
cat >/etc/cron.d/devtrends-site <<'EOF'
SHELL=/bin/sh
PATH=/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/30 * * * * root /root/devtrends-site/deploy/update.sh
EOF
chmod 644 /etc/cron.d/devtrends-site

# 手工触发一次（等价于 cron 那一跑）
/root/devtrends-site/deploy/update.sh && tail -5 /root/devtrends-site/update.log
```

为什么轮询而不是 webhook：日报落地时间在凌晨，误差以十分钟计，一次 `git fetch` 的成本可以忽略；
webhook 需要公网入口与额外凭据，反而多一处会坏的地方。

**替代方案：Dockhand Git 栈**（本机已在运行，若想让更新也走 Dockhand 的可视化界面）
1. Dockhand → Git → 添加仓库 `https://github.com/null-object-0000/community-pulse.git`
2. Stacks → 新建 Git 栈，composePath 填 `deploy/compose.yaml`，开启自动更新
   （注意 Dockhand 在容器里跑，构建上下文必须是它能读到的路径 —— snap docker 的路径限制见上文）

## 部署状态（2026-10-19 首次落地）

| 项 | 状态 |
|---|---|
| 镜像 / 容器 | `devtrends-site:local`（1.37 GB）；容器 `devtrends-site` healthy，监听 8080 |
| 静态 | 由本机 Node 服务：首页、日报、`/en/`、`/cards/`、数据 JSON、`robots.txt`、百度验证文件 |
| 动态 | **仍走过渡反代**（响应头 `x-devtrends-upstream: cloudflare-worker`）—— 等只读库账号 |
| 自动更新 | `/etc/cron.d/devtrends-site` 每 30 分钟跑一次 `deploy/update.sh` |
| 对外访问 | **未接** —— 需阿里云 CDN（或 NPM vhost）+ 解析指向本机，只有账号持有人能操作 |
| 图片 | 仍在 Cloudflare R2（`img.devtrends.site`），内地访问偏慢，后续可换阿里云 OSS |

## 操作 NPM（长期接入方式）

NPM 有完整 REST API（`/api/`，OpenAPI 定义在 `/api/schema`，**无需鉴权即可读**）。它的令牌正常
要用邮箱+密码去换（默认 1 天过期），但那一步不需要也不应该走：令牌载荷是固定的
`{ iss: "api", attrs: { id: <用户 id> }, scope: ["user"] }`，用容器内 `/data/keys.json` 的 RSA 私钥
以 **RS256** 签发、公钥验签（实现见 `/app/models/token.js` 与 `/app/lib/access.js`；少一个字段就 403）。

所以接入方式是**令牌现签现用**：

```bash
~/.hermes/profiles/communitypulse/scripts/npm-api.sh GET /api/nginx/proxy-hosts
~/.hermes/profiles/communitypulse/scripts/npm-api.sh GET /api/nginx/proxy-hosts/16
~/.hermes/profiles/communitypulse/scripts/npm-api.sh PUT /api/nginx/proxy-hosts/16 @body.json
```

脚本在 NPM 容器内签一个短时（默认 1 小时）令牌、就地发请求，**令牌不落到本机、不进命令行、
不进日志**；宿主机访问仍走既有的 workbench 通道。

- PUT 必须发**完整的可写字段集**（`domain_names`/`forward_*`/`certificate_id`/`ssl_forced`/
  `http2_support`/`block_exploits`/`advanced_config`/`locations`…）—— 只传改动字段会被校验拒绝；
  先 `GET` 一条拿到现状，改完整体发回去最稳。
- 列表接口**不返回软删除的条目**（`is_deleted=1`，UI 里删过的），所以「API 里没看到某条」不等于
  它不存在，要核实得看 `/data/database.sqlite` 的 `proxy_host` 表。
- **不存长期令牌**：令牌等价于管理员凭据，短时现签的暴露面最小；而签发密钥本来就在机器上，
  能力不受影响。撤销 = 换 `keys.json`（或重建/升级 NPM），既有令牌全部失效。

## 注意事项

- **`dist/` 不进 Git**，所以镜像构建必须在容器内跑 `npm run build`（Dockerfile 已这么做）。
- 构建只需要仓库里已提交的日报、站点快照与图片清单；图片本体走 `IMAGE_BASE`（`site.config.json`），
  当前指向 Cloudflare R2 `img.devtrends.site` —— 内地访问图片仍走境外，后续可改阿里云 OSS。
- 缓存策略不另写一份：`server.mjs` 解析构建产物 `dist/_headers`，与 Cloudflare 上行为一致。
- 容器健康检查打 `/healthz`（不由 worker 处理），Dockhand 与本机 `docker ps` 都能看到状态。
