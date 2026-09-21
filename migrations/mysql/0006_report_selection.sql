-- 0006：发布记录（第二批「发布层」）需要给 `reports` 补一个 JSON 列。
--
-- 为什么必须补：`reports` 现有列只有 `selection_version` 一个版本位，而这一批要把
-- **选品规则、冷却、持续热门、准入决策、当期加工版本**都落成可复核的记录：
--   - `publication`：这一期读的是哪些不可变来源文件（source-raw 的哈希 + taxonomyVersion）
--   - `admission`：准入决策（含被排除的条目与原因）——冻在写入时，渲染期不再重算，
--     否则改一次准入规则就会把历史日报悄悄改写，违反「已发布日报固定其版本」
--   - `trendingPolicy`：冷却期数、被压制条数与**被压制的全部条目**（回答「这期为什么没有 X」）
-- 这些是同一期发布的一组元数据、结构不固定，用 JSON 列而不是再摊成 8 个列；
-- 逐行的内容（含冻结的发布行）在 `report_items.snapshot_json`。
--
-- 幂等：MySQL 8 没有 `ADD COLUMN IF NOT EXISTS`，而 Hyperdrive 又不支持 SQL 级 `PREPARE`
-- （0005 踩过），所以这里**不加守卫**：幂等由 `scripts/catalog/apply-mysql-migrations.js`
-- 的 `schema_migrations` 记账 + 「已存在」容错负责。重复手跑会报 Duplicate column name，
-- 那是预期行为。

ALTER TABLE reports ADD COLUMN selection_json JSON NULL AFTER selection_version;
