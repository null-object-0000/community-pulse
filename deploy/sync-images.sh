#!/bin/bash
# 把 assets/images/manifest.json 里列出的全部镜像同步到本机目录，供站点容器直接对外提供
# /images/*（见 deploy/compose.yaml 的 volumes）。
#
# 设计取舍：
#   - **只拉缺失的**，可重复执行（幂等）；失败项打印 FAIL，下次运行自动重试，不会因为一次网络
#     抖动就让整批停下来。
#   - 源站用 `r2-img.devtrends.site`（对象存储的自定义域名）。日更只会上新几张，所以一次
#     全量之后每次运行都只发几个请求。
#   - 用 flock 上锁：它可能被 update.sh 定时调用，而首次全量要跑几十分钟，不能重叠。
set -u
REPO=${REPO:-$(cd "$(dirname "$0")/.." && pwd)}
DEST=${DEST:-/root/devtrends-site-images}
BASE=${BASE:-https://r2-img.devtrends.site}
PARALLEL=${PARALLEL:-6}
: "${DEST:?DEST 不能为空}"

exec 9>"/tmp/sync-images.lock"
flock -n 9 || { echo "[$(date '+%F %T')] 已有一个同步在跑，本次跳过"; exit 0; }

mkdir -p "$DEST"
python3 - "$REPO" > /tmp/img-list.txt <<'PY'
import json, sys
m = json.load(open(f"{sys.argv[1]}/assets/images/manifest.json"))
vals = []
for v in m.values():
    if isinstance(v, str):
        vals.append(v)
    elif isinstance(v, list):          # 多图条目，值是列表
        vals.extend(x for x in v if isinstance(x, str))
keep = sorted({v for v in vals if v.startswith("/images/")})
sys.stderr.write(f"manifest {len(m)} 条 → 唯一镜像 {len(keep)} 张\n")
for v in keep:
    print(v)
PY
total=$(wc -l < /tmp/img-list.txt)
echo "[$(date '+%F %T')] 需要 $total 张 → $DEST"

fetch() {
  p="$1"
  f="$DEST/$(basename "$p")"
  [ -s "$f" ] && return 0
  if curl -s -f -m 40 -o "$f.part" "$BASE$p"; then mv -f "$f.part" "$f"; else rm -f "$f.part"; echo "FAIL $p"; fi
}
export DEST BASE
export -f fetch
xargs -a /tmp/img-list.txt -P "$PARALLEL" -I{} bash -c 'fetch "$@"' _ {}

echo "[$(date '+%F %T')] 完成 $(ls -1 "$DEST" | wc -l) 个 / $(du -sh "$DEST" | cut -f1)"
