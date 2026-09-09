#!/bin/bash
# 本机重跑失败的天 (避开 Actions rate limit)
# 用法: bash refetch_failed.sh [日期文件]  默认 /tmp/failed_days.txt
set -uo pipefail
DAYS_FILE="${1:-/tmp/failed_days.txt}"
SKILL="/home/nichangen/文档/MyVault/.agents/skills/community-pulse"
RAW="/home/nichangen/文档/MyVault/知识/大家都在做什么/raw"
cd "$SKILL"

ok=0; fail=0
while IFS= read -r d; do
  [ -z "$d" ] && continue
  done_flag=0
  for attempt in 1 2 3 4 5; do
    if node scripts/collect.js --source chinese-indie-dev,weekly-issue,hellogithub-issue,weekly-issues,hellogithub-issues --date "$d" --out "$RAW/$d.json" >/dev/null 2>&1 && \
       node scripts/collect.js --source chinese-indie-dev,weekly-issue,hellogithub-issue,weekly-issues,hellogithub-issues --date "$d" --markdown --out "$RAW/$d.md" >/dev/null 2>&1; then
      # 验证不是空/error
      if python3 -c "
import json,sys
d = json.load(open('$RAW/$d.json'))
errs = [r for r in d['results'] if r.get('error')]
if errs: sys.exit(1)
total = sum(len(r.get('items',[])) for r in d['results'])
print(f'  {total} 条', file=sys.stderr)
" 2>/dev/null; then
        echo "OK $d"; ok=$((ok+1)); done_flag=1; break
      fi
    fi
    echo "  重试 $d (${attempt}/5)" >&2
    sleep 5
  done
  if [ $done_flag -eq 0 ]; then echo "FAIL $d"; fail=$((fail+1)); fi
  sleep 1
done < "$DAYS_FILE"
echo "完成: ok=$ok fail=$fail"
