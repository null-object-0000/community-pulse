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
# 安装定时任务（本机，取每 30 分钟一次；脚本自带幂等闸门，见下「钱的闸门」）：
#   crontab -e
#   */30 * * * * /bin/bash /path/to/repo/scripts/catalog/daily-enrich.sh >> /tmp/cp-daily-enrich.log 2>&1
# 注意 cron 的 PATH 极干净：node 若来自 nvm 必须显式带上其 bin 目录，否则脚本找不到 node。
# 或者 launchd（macOS，PATH 同样要显式带上 node / gh / git 的目录）。
#
# ── 幂等与「钱的闸门」（重要：改这个脚本前先读这段）────────────────────────────────
# 跑模型是这条链路唯一花钱的一步，而 **artifact 自带的 status 不能用来做续跑判定**：
# 它记录的是**导出那一刻**（日更 00:0x 之后）的库状态，那时本轮还没加工过任何产品，
# 所以它对 `planQueue` 永远显示「全部待加工」—— 同一份产物重跑，必然整批重新付费。
# （实测：3 行队列 + 该产物自带的空 status → `待加工 3，0 请求续跑 0`。）
# 因此闸门以**已付过的产物**为准，不以 status 为准：
#   · SQL 已落盘（`$SQL_GZ` 非空）= 这一轮的钱已经花过 → 跳过模型重跑
#   · apply 成功（`$DONE_MARK`）= 整条链做完 → 后续 tick 直接退出
# cron 每 30 分钟一个 tick，缺这两道闸就等于**每天把整批模型调用重打 48 遍**。
# `--force` 显式覆盖两者（换了模型/prompt、想在同一版本内重算时用）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET=""
DRY_RUN=false
FORCE=false
CONCURRENCY="${CP_ENRICH_CONCURRENCY:-6}"
REPO_SLUG="$(git -C "$ROOT" remote get-url origin 2>/dev/null | sed -E 's#.*github\.com[:/]([^/]+/[^/.]+)(\.git)?#\1#')"

usage() {
  cat <<'USAGE'
用法：scripts/catalog/daily-enrich.sh [--date YYYY-MM-DD] [--dry-run] [--force] [--concurrency N]

  --date        目标日（products.first_seen_date = 该日）。默认北京时间昨天。
  --dry-run     只拉产物 + 跑模型出 SQL 并做一次 `apply-sql.js --dry-run` 校验；
                不提交分支、不触发写库。用于验收「不写库」。
  --force       忽略幂等闸门，强制重跑模型（默认复用已付过的 SQL）。
  --concurrency 模型并发，默认 6（这个自建网关稳态约 1.3 req/s，20 会打出大量 429）。
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --date) TARGET="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --force) FORCE=true; shift ;;
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
SQL_GZ="$WORK/daily-$TARGET.sql.gz"
DONE_MARK="$WORK/applied-$TARGET"
BRANCH="data/product-enrich-$TARGET"
SQL_REL="data/catalog/enrich-replay/daily-$TARGET.sql.gz"

log() { printf '[daily-enrich] %s\n' "$*" >&2; }

mkdir -p "$WORK"

# 完成闸门：整条链（含写库）已成功过一次 → 本 tick 无操作。
if [[ -f "$DONE_MARK" && "$FORCE" != "true" ]]; then
  log "本日已完成（$DONE_MARK 存在），无操作。需要重算加 --force。"
  exit 0
fi

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

# ── 钱的闸门：SQL 已在 → 这一轮已经付过，不再调模型 ──────────────────────────────
# 这里**不**用 `$STATUS` 做续跑判定：它停在导出那一刻（那时本轮还没加工过任何产品），
# 对 `planQueue` 永远显示「全部待加工」，拿它当依据就是整批重付。
# 是否要跑，由「SQL 有没有落盘」决定；`--force` 才重算。
if [[ -s "$SQL_GZ" && "$FORCE" != "true" ]]; then
  log "复用已付过的 SQL：$SQL_GZ（跳过模型重跑；要重算加 --force）"
else
  [[ -f "$STATUS" ]] || { log "缺 $STATUS（缺它 enrich-queue.js 会硬失败拒绝跑）"; exit 1; }
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
  gzip -c "$SQL_RAW" > "$SQL_GZ"
  log "SQL：$(wc -c < "$SQL_RAW") 字节 → gzip $(wc -c < "$SQL_GZ") 字节"
fi

# ③ 写库前的安全预检：`apply-sql.js --dry-run` 只校验语句数、shadow 闸与会自动上架的版本，
#    **不碰库**。这一步在 dry-run 模式下就是验收要求的「证明不写库」。
node "$ROOT/scripts/catalog/apply-sql.js" --file "$SQL_GZ" --dry-run

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
cp "$SQL_GZ" "$WT/$SQL_REL"
git -C "$WT" add "$SQL_REL"
git -C "$WT" -c user.name="daily-enrich" -c user.email="daily-enrich@localhost" \
  commit -m "data(catalog): $TARGET 产品级增强 SQL（本机跑模型，shadow + 自动上架）" --quiet
git -C "$WT" push --force origin "HEAD:refs/heads/$BRANCH"
git -C "$ROOT" worktree remove --force "$WT"

# ⑤ 触发写库 + 自动上架（版本从 SQL 里认，不用调用方传），等它出结论再落完成标记。
log "触发 apply-catalog-sql.yml（ref=$BRANCH）"
gh workflow run apply-catalog-sql.yml --ref "$BRANCH" -f sql_path="$SQL_REL"

# 完成标记只在**写库那一步**成功后写 —— 判据取 run 内单个 step，不取 run 的整体结论。
# 为什么：`apply-catalog-sql.yml` 的权限只有 `contents: read`，它最后一步「提交回滚稿」必然
# 因权限失败，所以**整次 run 的 conclusion 恒为 failure，即使它已经成功写库并上架**
# （实测：run 37500132993 写库步 success、回滚步 failure、run 整体 failure，而 208 个产品确实生效了）。
# 拿 run 结论当闸门，就永远不会落标记 ⇒ 每 30 分钟重推分支、重触发写库。
# 若哪天把那步权限修好，这里仍成立（写库步才是这一步要看的）。
apply_wrote_data() {
  gh run view "$1" --json jobs \
    --jq '[.jobs[].steps[] | select(.name=="应用到产品库") | .conclusion] | .[0]' 2>/dev/null
}
log "等待 apply run 结论（最多 6 分钟）…"
run_id=""
for _ in $(seq 1 36); do
  sleep 10
  run_id="$(gh run list --workflow apply-catalog-sql.yml --branch "$BRANCH" --limit 1 \
    --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
  [[ -n "$run_id" ]] || continue
  step_conclusion="$(apply_wrote_data "$run_id" || true)"
  if [[ -n "$step_conclusion" && "$step_conclusion" != "null" ]]; then
    if [[ "$step_conclusion" == "success" ]]; then
      printf '%s\n' "$(date -Is)" > "$DONE_MARK"
      log "写库步成功（run $run_id）→ 完成标记 $DONE_MARK"
      exit 0
    fi
    log "写库步结论 $step_conclusion（run $run_id）：不写完成标记；SQL 保留，下一 tick 只重试写库。"
    exit 1
  fi
done
log "等写库步结论超时（run ${run_id:-未知}）：不写完成标记。可手查：gh run list --workflow apply-catalog-sql.yml --limit 3"
exit 1
