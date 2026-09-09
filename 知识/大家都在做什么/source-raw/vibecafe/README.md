# VibeCafé 原始日数据

这里是 VibeCafé 的来源层（source/bronze），与 `知识/大家都在做什么/raw/` 中旧的混合日报数据分开。

- 一天一个 `YYYY-MM-DD.json`。
- `records` 原样保存 `/api/products` 返回的产品对象，不做字段转换、标签、GitHub 补全或去重。
- 日期统一按 `Asia/Shanghai`，根据产品的 `createdAt` 归日。
- `status: ok` 表示当天有产品；`status: empty` 表示完整翻页后确认当天确实没有产品。
- `complete: true` 表示抓取翻到了数据源末尾，或已经越过目标日期范围的下边界。
- `capture.mode: historical-reconstruction` 表示历史回溯：记录是在 `fetchedAt` 时观察到的当前源站数据，并非当日实时快照。
- 已存在文件默认不覆盖；内容变化时必须人工检查后显式使用 `--replace`。

采集：

```bash
cd .agents/skills/community-pulse
node scripts/capture_vibecafe_raw.js --start 2026-06-02 --end 2026-09-07
```

每日增量补齐（从起始日寻找最早缺失文件；正常情况下只抓取北京时间昨天）：

```bash
node scripts/capture_vibecafe_raw.js --resume --end "$(TZ=Asia/Shanghai date -d yesterday +%F)"
```

校验：

```bash
node scripts/validate_vibecafe_raw.js --start 2026-06-02 --end 2026-09-07
```

GitHub Actions 每天北京时间 07:07 先执行增量补齐和全区间校验，通过后才生成混合日报。
