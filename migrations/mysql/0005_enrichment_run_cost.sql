-- 0005：产品级 LLM 加工流水线（第一批）需要补的两处 schema 缺口。
--
-- ① enrichment_product_status.status 缺一个**独立终态**。
--    入口门禁把「没有描述、不发请求」的产品标成 skipped_no_input。它既不是 failed（失败要重试、
--    要计入失败率），也不是 complete（完成意味着真有加工结果）。两者混在一起的话，「无描述产品
--    零模型请求」就只能靠读代码分支来证明，而不是按状态计数证明 —— 而按计数证明正是这一批的验收。
--    追加在枚举末尾：已有行的值不变，不需要重写表。
--
-- ② enrichment_runs 缺**成本列**。这一批的主要产出是成本曲线（每产品多少钱 / 多少机时 / 失败率），
--    运行记录只有 status 的话，成本只能去翻日志，连续多天就攒不出可比的曲线。口径按「新增桶 /
--    重入臂」分开记，因为按天增量的成本曲线只应该由新增桶定义（见 CHANGELOG 2026-09-21 的决策）。
--
-- 幂等：迁移会被上传通道重放（scripts/catalog/upload-mysql.js 每次上传都会 POST 一遍迁移文件），
-- 而 MySQL 8 没有 ADD COLUMN IF NOT EXISTS / MODIFY COLUMN IF NOT EXISTS，所以每条 ALTER 都用
-- information_schema 守卫，重复执行是 DO 0。注意 DDL 在 MySQL 里隐式提交，上传 Worker 的
-- beginTransaction 包不住它 —— 这不是问题，只是别指望 DDL 能回滚。

-- ① 状态枚举追加 skipped_no_input
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enrichment_product_status'
      AND COLUMN_NAME = 'status' AND COLUMN_TYPE LIKE '%skipped_no_input%') = 0,
  'ALTER TABLE enrichment_product_status MODIFY COLUMN status ENUM(''pending'',''running'',''complete'',''failed'',''skipped_no_input'') NOT NULL',
  'DO 0');
PREPARE enrichment_ddl FROM @ddl;
EXECUTE enrichment_ddl;
DEALLOCATE PREPARE enrichment_ddl;

-- ② 运行记录：口径与成本
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enrichment_runs' AND COLUMN_NAME = 'target_date') = 0,
  'ALTER TABLE enrichment_runs ADD COLUMN target_date DATE NULL AFTER prompt_version',
  'DO 0');
PREPARE enrichment_ddl FROM @ddl;
EXECUTE enrichment_ddl;
DEALLOCATE PREPARE enrichment_ddl;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enrichment_runs' AND COLUMN_NAME = 'mode') = 0,
  'ALTER TABLE enrichment_runs ADD COLUMN mode VARCHAR(32) NOT NULL DEFAULT ''shadow'' AFTER target_date',
  'DO 0');
PREPARE enrichment_ddl FROM @ddl;
EXECUTE enrichment_ddl;
DEALLOCATE PREPARE enrichment_ddl;

-- 队列大小与它的两个来源：新增桶（first_seen_date = target_date）+ 重入臂（终态但输入已变）。
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enrichment_runs' AND COLUMN_NAME = 'product_count') = 0,
  'ALTER TABLE enrichment_runs ADD COLUMN product_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER mode',
  'DO 0');
PREPARE enrichment_ddl FROM @ddl;
EXECUTE enrichment_ddl;
DEALLOCATE PREPARE enrichment_ddl;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enrichment_runs' AND COLUMN_NAME = 'new_product_count') = 0,
  'ALTER TABLE enrichment_runs ADD COLUMN new_product_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER product_count',
  'DO 0');
PREPARE enrichment_ddl FROM @ddl;
EXECUTE enrichment_ddl;
DEALLOCATE PREPARE enrichment_ddl;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enrichment_runs' AND COLUMN_NAME = 'reentry_count') = 0,
  'ALTER TABLE enrichment_runs ADD COLUMN reentry_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER new_product_count',
  'DO 0');
PREPARE enrichment_ddl FROM @ddl;
EXECUTE enrichment_ddl;
DEALLOCATE PREPARE enrichment_ddl;

-- 逐产品结果
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enrichment_runs' AND COLUMN_NAME = 'requested_count') = 0,
  'ALTER TABLE enrichment_runs ADD COLUMN requested_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER reentry_count',
  'DO 0');
PREPARE enrichment_ddl FROM @ddl;
EXECUTE enrichment_ddl;
DEALLOCATE PREPARE enrichment_ddl;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enrichment_runs' AND COLUMN_NAME = 'completed_count') = 0,
  'ALTER TABLE enrichment_runs ADD COLUMN completed_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER requested_count',
  'DO 0');
PREPARE enrichment_ddl FROM @ddl;
EXECUTE enrichment_ddl;
DEALLOCATE PREPARE enrichment_ddl;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enrichment_runs' AND COLUMN_NAME = 'failed_count') = 0,
  'ALTER TABLE enrichment_runs ADD COLUMN failed_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER completed_count',
  'DO 0');
PREPARE enrichment_ddl FROM @ddl;
EXECUTE enrichment_ddl;
DEALLOCATE PREPARE enrichment_ddl;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enrichment_runs' AND COLUMN_NAME = 'skipped_no_input_count') = 0,
  'ALTER TABLE enrichment_runs ADD COLUMN skipped_no_input_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER failed_count',
  'DO 0');
PREPARE enrichment_ddl FROM @ddl;
EXECUTE enrichment_ddl;
DEALLOCATE PREPARE enrichment_ddl;

-- 0 请求续跑命中数：终态且输入哈希未变，因此既没进模型调用、也没改状态。
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enrichment_runs' AND COLUMN_NAME = 'resumed_count') = 0,
  'ALTER TABLE enrichment_runs ADD COLUMN resumed_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER skipped_no_input_count',
  'DO 0');
PREPARE enrichment_ddl FROM @ddl;
EXECUTE enrichment_ddl;
DEALLOCATE PREPARE enrichment_ddl;

-- 成本：模型请求总数 + 墙钟机时。每条平均耗时 = wall_clock_ms / requested_count，不单独存列。
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enrichment_runs' AND COLUMN_NAME = 'model_request_count') = 0,
  'ALTER TABLE enrichment_runs ADD COLUMN model_request_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER resumed_count',
  'DO 0');
PREPARE enrichment_ddl FROM @ddl;
EXECUTE enrichment_ddl;
DEALLOCATE PREPARE enrichment_ddl;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enrichment_runs' AND COLUMN_NAME = 'wall_clock_ms') = 0,
  'ALTER TABLE enrichment_runs ADD COLUMN wall_clock_ms BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER model_request_count',
  'DO 0');
PREPARE enrichment_ddl FROM @ddl;
EXECUTE enrichment_ddl;
DEALLOCATE PREPARE enrichment_ddl;

-- 按原因分的跳过明细与其它不便单独开列的观测，留一份可读快照。
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enrichment_runs' AND COLUMN_NAME = 'summary_json') = 0,
  'ALTER TABLE enrichment_runs ADD COLUMN summary_json JSON NULL AFTER wall_clock_ms',
  'DO 0');
PREPARE enrichment_ddl FROM @ddl;
EXECUTE enrichment_ddl;
DEALLOCATE PREPARE enrichment_ddl;
