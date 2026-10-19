#!/bin/sh
# 站点自动更新：跟着仓库最新提交重建并滚动重启容器 —— 日报每天写进仓库，站点就得跟着走，
# 「站点别停更」靠的是这条链而不是某个人记得手动跑一次。
#
# 设计取舍：轮询而不是 webhook。日报的落地时间是凌晨的日更流程，误差以十分钟计，而这里
# 一次 `git fetch` 的成本可以忽略；webhook 需要公网入口与额外凭据，反而多一处会坏的地方。
# 由 /etc/cron.d/devtrends-site 每 30 分钟调用一次，日志追加在仓库根的 update.log。
#
# 幂等且失败安全：只在远端有新提交时才重建；重建失败时容器继续跑旧版本（不 down 再 up），
# 日志留下失败原因。
set -eu

REPO_DIR=${REPO_DIR:-/root/devtrends-site}
REPO_SLUG=${REPO_SLUG:-null-object-0000/community-pulse}
BRANCH=${BRANCH:-$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)}
LOG=$REPO_DIR/update.log
PATH=/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

cd "$REPO_DIR"

# 取远端：直连 GitHub 会间歇性 `GnuTLS recv error (-110)`（实测有一轮就撞上、被优雅跳过），
# 所以备几个国内可达的镜像。只用来取公开代码，不涉及任何凭据；第一个成功的就用它 reset。
# 直连成功时不写日志（否则每 30 分钟一行噪音），只有走镜像或失败才留痕。
if git -c http.version=HTTP/1.1 fetch --quiet --depth 1 origin "$BRANCH" 2>>"$LOG"; then
  :
else
  echo "$(date '+%F %T') 直连 GitHub 失败，试镜像通道" >>"$LOG"
  fetched=0
  for url in \
    "https://ghfast.top/https://github.com/$REPO_SLUG.git" \
    "https://gitclone.com/github.com/$REPO_SLUG.git" \
    "https://ghproxy.net/https://github.com/$REPO_SLUG.git"; do
    if git -c http.version=HTTP/1.1 fetch --quiet --depth 1 "$url" "$BRANCH" 2>>"$LOG"; then
      fetched=1
      echo "$(date '+%F %T') 已从 $url 取到远端" >>"$LOG"
      break
    fi
    echo "$(date '+%F %T') $url 也失败" >>"$LOG"
  done
  if [ "$fetched" != 1 ]; then
    echo "$(date '+%F %T') 所有通道都取不到代码，本轮跳过（30 分钟后再试）" >>"$LOG"
    exit 0
  fi
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse FETCH_HEAD)
[ "$LOCAL" = "$REMOTE" ] && exit 0

echo "$(date '+%F %T') 发现新提交 $REMOTE（本地 $LOCAL），开始更新" >>"$LOG"
# 用 `reset --hard` 而不是 `pull` / `merge --ff-only`：这是浅克隆（服务器上没必要拉全量历史），
# 而浅克隆之间 `git merge --ff-only FETCH_HEAD` 会报 `refusing to merge unrelated histories`
# —— 实测踩到。部署克隆本来就该与远端一致、不留本地改动，重置最贴合语义（也顺带容忍 force-push）。
if ! git reset --hard FETCH_HEAD >>"$LOG" 2>&1; then
  echo "$(date '+%F %T') 重置失败（远端历史被改写？需要人工看一眼）" >>"$LOG"
  exit 1
fi

# 起得来才算成功：给容器最多 60 秒，健康检查与首页都必须 200。
# 只比退出码是不够的 —— 镜像构建成功但站点起不来（配置错、依赖变更）正是「停更」的模样。
selfcheck() {
  i=0
  while [ "$i" -lt 12 ]; do
    if curl -fsS -m 5 http://127.0.0.1:8080/healthz >/dev/null 2>&1 \
       && curl -fsS -m 15 -o /dev/null http://127.0.0.1:8080/; then
      return 0
    fi
    i=$((i + 1))
    sleep 5
  done
  return 1
}

# 更新前把当前镜像留一份给回退用（有 tag 的镜像不会被 prune 清掉；不依赖 git 历史，
# 因为这是浅克隆，旧提交未必还在本地）。
docker image inspect devtrends-site:local >/dev/null 2>&1 \
  && docker tag devtrends-site:local devtrends-site:previous

if docker compose -f deploy/compose.yaml up -d --build >>"$LOG" 2>&1; then
  if selfcheck; then
    echo "$(date '+%F %T') 更新完成：$(docker ps --filter name=devtrends-site --format '{{.Status}}')" >>"$LOG"
    # 回收：一周前的旧镜像与构建缓存。这台机器只有 40 GB 盘，每次重建会留 1~3 GB 中间层
    # （实测构建缓存已累计 5.7 GB、可回收 3.3 GB），不回收迟早撑满；保留一周则重建不必从零开始。
    docker image prune -f --filter until=168h >>"$LOG" 2>&1 || true
    docker builder prune -f --filter until=168h >>"$LOG" 2>&1 || true
  else
    echo "$(date '+%F %T') 自检失败（健康检查/首页不通），回退到上一版镜像" >>"$LOG"
    docker tag devtrends-site:previous devtrends-site:local
    docker compose -f deploy/compose.yaml up -d --no-build >>"$LOG" 2>&1 || true
    if selfcheck; then
      echo "$(date '+%F %T') 已回退，站点恢复（代码已是新提交，镜像回退到上一版；请查构建日志）" >>"$LOG"
    else
      echo "$(date '+%F %T') 回退后自检仍失败，需要人工处理" >>"$LOG"
    fi
    exit 1
  fi
else
  echo "$(date '+%F %T') 构建失败，容器仍跑旧版本（见上文日志）" >>"$LOG"
  exit 1
fi
