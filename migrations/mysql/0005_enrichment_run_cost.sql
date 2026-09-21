-- 0005：产品级 LLM 加工流水线（第一批）需要补的两处 schema 缺口。
--
-- ① enrichment_product_status.status 缺一个**独立终态**。
--    入口门禁把「没有描述、不发请求」的产品标成 skipped_no_input。它既不是 failed（失败要重试、
--    要计入失败率），也不是 complete（完成意味着真有加工结果）。两者混在一起的话，「无描述产品
--    零模型请求」就只能靠读代码分支来证明，而不是按状态计数证明 —— 而按计数证明正是这一批的验收。
--    追加在枚举末尾：已有行的值不变，不需要重写表。**MODIFY COLUMN 本身幂等**（改成同一个定义是
--    无操作），所以这一条不需要守卫。
--
-- ② enrichment_runs 缺**成本列**。这一批的主要产出是成本曲线（每产品多少钱 / 多少机时 / 失败率），
--    运行记录只有 status 的话，成本只能去翻日志，连续多天就攒不出可比的曲线。口径按「新增桶 /
--    重入臂」分开记，因为按天增量的成本曲线只应该由新增桶定义（见 CHANGELOG 2026-09-21 的决策）。
--
-- **为什么这里没有 information_schema + PREPARE 守卫**（2026-09-21 实测，踩过一次）：
-- 生产的写入通道是 Cloudflare Hyperdrive（`worker/catalog-import.mjs`），它**不支持 MySQL 的
-- SQL 级 prepared statement** —— 带 `PREPARE … FROM @ddl` 的守卫在本地直连 MySQL 8.4 上跑得通、
-- 在 Hyperdrive 上直接 500（`error code: 1104`，"Hyperdrive does not currently support MySQL
-- prepared statements"）。而 MySQL 8 又没有 `ADD COLUMN IF NOT EXISTS`，所以「按列是否存在决定
-- 要不要 ALTER」这件事在 SQL 里做不到。**幂等改由应用器负责**：
--   `scripts/catalog/apply-mysql-migrations.js` 先读 `schema_migrations` 跳过已应用的版本，
--   再逐条执行；对「已存在」类错误（1060/1061/1062）视为已应用（这是给已经存在的库补记账的引导路径）。
-- 所以这个文件是**普通 DDL**，重复执行会报 Duplicate column name —— 那是预期行为，不要直接手跑两遍。

-- ① 状态枚举追加 skipped_no_input
ALTER TABLE enrichment_product_status
  MODIFY COLUMN status ENUM('pending','running','complete','failed','skipped_no_input') NOT NULL;

-- ② 运行记录：口径与成本
ALTER TABLE enrichment_runs ADD COLUMN target_date DATE NULL AFTER prompt_version;
ALTER TABLE enrichment_runs ADD COLUMN mode VARCHAR(32) NOT NULL DEFAULT 'shadow' AFTER target_date;

-- 队列大小与它的两个来源：新增桶（first_seen_date = target_date）+ 重入臂（终态但输入已变）。
ALTER TABLE enrichment_runs ADD COLUMN product_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER mode;
ALTER TABLE enrichment_runs ADD COLUMN new_product_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER product_count;
ALTER TABLE enrichment_runs ADD COLUMN reentry_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER new_product_count;

-- 逐产品结果
ALTER TABLE enrichment_runs ADD COLUMN requested_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER reentry_count;
ALTER TABLE enrichment_runs ADD COLUMN completed_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER requested_count;
ALTER TABLE enrichment_runs ADD COLUMN failed_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER completed_count;
ALTER TABLE enrichment_runs ADD COLUMN skipped_no_input_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER failed_count;

-- 0 请求续跑命中数：终态且输入哈希未变，因此既没进模型调用、也没改状态。
ALTER TABLE enrichment_runs ADD COLUMN resumed_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER skipped_no_input_count;

-- 成本：模型请求总数 + 墙钟机时。每条平均耗时 = wall_clock_ms / requested_count，不单独存列。
ALTER TABLE enrichment_runs ADD COLUMN model_request_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER resumed_count;
ALTER TABLE enrichment_runs ADD COLUMN wall_clock_ms BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER model_request_count;

-- 按原因分的跳过明细与其它不便单独开列的观测，留一份可读快照。
ALTER TABLE enrichment_runs ADD COLUMN summary_json JSON NULL AFTER wall_clock_ms;
