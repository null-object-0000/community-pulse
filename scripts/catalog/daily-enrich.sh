#!/usr/bin/env bash
#
# 本机定时任务：产品级增强的**中间那一跳**（跑模型 → 出 SQL → 提交到分支 → 触发写库）。
#
# 为什么必须在本机（不是在 Actions）：模型网关 `127.0.0.1:18640` 是本机自建，GitHub Actions
# 到不了；而「读队列」「写库」两件事本机也做不了（本机网络在协议层重置到 RDS 3306 的 TLS 握手）。
# 所以日更自动化固定是三段式：
#   ① Actions（daily-report.yml）：导入 MySQL → 导出当天队列为 artifact `enrich-queue-<date>`
#   ② **本脚本**：拉 artifact → 跑模型出 SQL → 把 SQL 提交到 `data/product-enrich-<date>` 分支
#   ③ Actions（apply-catalog-sql.yml）：写库 + 自动上架（版本从 SQL 里认）
#
# 安装定时任务（本机，每分钟一次太密，取每 30 分钟一次；脚本自己幂等，重跑只会续跑）：
#   crontab -e
#   */30 * * * * /bin/bash /path/to/repo/scripts/catalog/daily-enrich.sh >> /tmp/cp-daily-enrich.log 2>&1
# 或者 launchd（macOS，PATH 要显式带上 node / gh / git 的目录）。
#
# 幂等：同一天重跑会命中已存在的分支/已存在的 run；`enrich-queue.js` 用导出的状态做续跑判定，
# 已加工的产品 0 请求，apply 全是 upsert / 先删自己的 shadow 行。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET=""
DRY_RUN=false
CONCURRENCY="${CP_ENRICH_CONCURRENCY:-6}"
REPO_SLUG="$(git -C "$ROOT" remote get-url origin 2>/dev/null | sed -E 's#.*github\.com[:/]([^/]+/[^/.]+)(\.git)?#\1#')"

usage() {
  cat <<'USAGE'
用法：scripts/catalog/daily-enrich.sh [--date YYYY-MM-DD] [--dry-run] [--concurrency N]

  --date        目标日（products.first_seen_date = 该日）。默认北京时间昨天。
  --dry-run     只拉产物 + 跑模型出 SQL 并做一次 `apply-sql.js --dry-run` 校验；
                不提交分支、不触发写库。用于验收「不写库」。
  --concurrency 模型并发，默认 6（这个自建网关稳态约 1.3 req/s，20 会打出大量 429）。
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --date) TARGET="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --concurrency) CONCURRENCY="${2:-6}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$TARGET" ]] || TARGET="$(TZ=Asia/Shanghai date -d 'yesterday' +%F 2>/dev/null || TZ=Asia/Shanghai date -v-1d +%F)"
[[ "$TARGET" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "--date 必须是 YYYY-MM-DD：$TARGET" >&2; exit 2; }

WORK="$ROOT/.scratch/daily-enrich/$TARGET"
ARTIFACT_NAME="enrich-queue-$TARGET"
SQL_RAW="$WORK/sql-$TARGET.sql"
SUMMARY="$WORK/summary-$TARGET.json"
BRANCH="data/product-enrich-$TARGET"
SQL_REL="data/catalog/enrich-replay/daily-$TARGET.sql.gz"

log() { printf '[daily-enrich] %s\n' "$*" >&2; }

mkdir -p "$WORK"

# ① 找到日更链里带今天队列产物的那一次运行并下载。
#    只认 `daily-report.yml`（导出步骤排在「写入 MySQL」之后，见该 workflow 的注释）。
download_artifact() {
  local run_id
  run_id="$(gh run list --workflow daily-report.yml --limit 40 --json databaseId,conclusion \
    --jq '.[] | select(.conclusion=="success" or .conclusion=="failure") | .databaseId' 2>/dev/null || true)"
  local candidate
  for candidate in $run_id; do
    if gh run view "$candidate" --json artifacts --jq '.artifacts[].name' 2>/dev/null | grep -qx "$ARTIFACT_NAME"; then
      log "找到产物：daily-report run $candidate → $ARTIFACT_NAME"
      rm -rf "$WORK/artifact"
      gh run download "$candidate" -n "$ARTIFACT_NAME" -D "$WORK/artifact"
      return 0
    fi
  done
  return 1
}

if [[ ! -f "$WORK/artifact/queue-$TARGET.json" ]]; then
  if ! download_artifact; then
    log "没找到 $ARTIFACT_NAME 产物（最近 40 次 daily-report）。"
    log "可能原因：当天日报还没跑完、导出步骤失败（看 workflow 日志）、或产物已过 14 天保留期。"
    log "不要空跑 —— 队列拿不到就什么都不做，等下次定时触发或手工补跑。"
    exit 1
  fi
fi

QUEUE="$WORK/artifact/queue-$TARGET.json"
STATUS="$WORK/artifact/status-$TARGET.json"
[[ -f "$QUEUE" ]] || { log "缺 $QUEUE"; exit 1; }
[[ -f "$STATUS" ]] || { log "缺 $STATUS（没有状态文件就会把已加工产品当新的重付，硬失败）"; exit 1; }

# ② 本机跑模型，出回放 SQL。enrich-queue.js 走的是与日更链逐字相同的代码路径
#    （localizationInput → inputHashFor → planQueue → resultBatchSql），绝不自己拼 SQL。
log "跑模型：$QUEUE（并发 $CONCURRENCY）"
node "$ROOT/scripts/catalog/enrich-queue.js" \
  --in "$QUEUE" --status "$STATUS" --date "$TARGET" \
  --concurrency "$CONCURRENCY" \
  --out "$SQL_RAW" --summary "$SUMMARY"

if [[ ! -s "$SQL_RAW" ]]; then
  log "SQL 为空（本批 0 个产品需要加工）→ 不提交、不触发写库。"
  exit 0
fi

# ③ 写库前的安全预检：`apply-sql.js --dry-run` 只校验语句数、shadow 闸与会自动上架的版本，
#    **不碰库**。这一步在 dry-run 模式下就是验收要求的「证明不写库」。
gzip -c "$SQL_RAW" > "$WORK/daily-$TARGET.sql.gz"
log "SQL：$(wc -c < "$SQL_RAW") 字节 → gzip $(wc -c < "$WORK/daily-$TARGET.sql.gz") 字节"
node "$ROOT/scripts/catalog/apply-sql.js" --file "$WORK/daily-$TARGET.sql.gz" --dry-run

if [[ "$DRY_RUN" == "true" ]]; then
  log "--dry-run：不提交分支、不触发 apply-catalog-sql.yml。"
  exit 0
fi

# ④ 用一个临时 worktree 把 SQL 提交到专用分支，**不动主 checkout 的当前分支**。
git -C "$ROOT" fetch origin main --quiet
WT="$WORK/repo"
rm -rf "$WT"
git -C "$ROOT" worktree prune
git -C "$ROOT" worktree add --detach "$WT" origin/main --quiet
mkdir -p "$WT/data/catalog/enrich-replay"
cp "$WORK/daily-$TARGET.sql.gz" "$WT/$SQL_REL"
git -C "$WT" add "$SQL_REL"
git -C "$WT" -c user.name="daily-enrich" -c user.email="daily-enrich@localhost" \
  commit -m "data(catalog): $TARGET 产品级增强 SQL（本机跑模型，shadow + 自动上架）" --quiet
git -C "$WT" push --force origin "HEAD:refs/heads/$BRANCH"
git -C "$ROOT" worktree remove --force "$WT"

# ⑤ 触发写库 + 自动上架（版本从 SQL 里认，不用调用方传）。
log "触发 apply-catalog-sql.yml（ref=$BRANCH）"
gh workflow run apply-catalog-sql.yml --ref "$BRANCH" -f sql_path="$SQL_REL"
log "完成。可观察：gh run list --workflow apply-catalog-sql.yml --limit 3"
