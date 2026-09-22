#!/bin/bash
# 补投稿源缺失的天: 只跑 weekly-issues + hellogithub-issues, 合并进 raw json
set -uo pipefail
DAYS_FILE="${1:-/tmp/missing_sub.txt}"
# 仓库根从脚本位置推导，不写死本机路径。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
SKILL="$ROOT/.agents/skills/community-pulse"
RAW="$ROOT/知识/大家都在做什么/raw"
cd "$SKILL"

ok=0; fail=0
while IFS= read -r d; do
  [ -z "$d" ] && continue
  done_flag=0
  for attempt in 1 2 3 4 5; do
    # 单独跑投稿源
    if timeout 120 node scripts/collect.js --source weekly-issues,hellogithub-issues --date "$d" --out /tmp/sub_tmp.json >/dev/null 2>&1; then
      # 合并进 raw json (只替换投稿源)
      if python3 -c "
import json, sys
d = sys.argv[1]
raw_f = '$RAW/' + d + '.json'
sub = json.load(open('/tmp/sub_tmp.json'))
sub_items = {}
for r in sub['results']:
    sub_items[r['sourceId']] = r.get('items', [])
data = json.load(open(raw_f))
for r in data['results']:
    if r['sourceId'] in sub_items:
        r['items'] = sub_items[r['sourceId']]
json.dump(data, open(raw_f, 'w'))
print('merged')
" "$d" 2>/dev/null; then
        echo "OK $d"; ok=$((ok+1)); done_flag=1; break
      fi
    fi
    echo "  重试 $d (${attempt}/5)" >&2
    sleep 5
  done
  [ $done_flag -eq 0 ] && { echo "FAIL $d"; fail=$((fail+1)); }
  sleep 2
done < "$DAYS_FILE"
echo "完成: ok=$ok fail=$fail"
