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
BRANCH=${BRANCH:-$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)}
LOG=$REPO_DIR/update.log
PATH=/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

cd "$REPO_DIR"

if ! git -c http.version=HTTP/1.1 fetch --quiet --depth 1 origin "$BRANCH" 2>>"$LOG"; then
  echo "$(date '+%F %T') fetch 失败（网络抖动？），本轮跳过" >>"$LOG"
  exit 0
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

if docker compose -f deploy/compose.yaml up -d --build >>"$LOG" 2>&1; then
  echo "$(date '+%F %T') 更新完成：$(docker ps --filter name=devtrends-site --format '{{.Status}}')" >>"$LOG"
  # 只清一周前的旧镜像，留几代用于回退。
  docker image prune -f --filter until=168h >>"$LOG" 2>&1 || true
else
  echo "$(date '+%F %T') 构建失败，容器仍跑旧版本（见上文日志）" >>"$LOG"
  exit 1
fi
