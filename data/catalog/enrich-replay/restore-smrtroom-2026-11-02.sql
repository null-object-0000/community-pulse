-- 恢复 SMRTROOM 的 travel-mobility 归属（人工复核，仅此 1 个产品）
-- 任务：.scratch/dsh-restore-smrtroom.md
-- assignment_source 用 'manual'：表 ENUM 只有 llm/rule/manual/source，'manual-review' 会被拒
-- processor_version 保留 manual-review-2026-11-02 作为人工复核批次标识
-- 本行按任务要求直接写成当前有效（is_current 取 VALUES 的 1），不经过 shadow 批次
INSERT INTO taxonomy_assignments
  (product_id, facet, term_id, assignment_source, confidence, processor_version, enrichment_run_id, is_current)
VALUES
  ('prd_e2993b2217e0293178bc417a', 'useCases', 'travel-mobility', 'manual', NULL, 'manual-review-2026-11-02', NULL, 1)
ON DUPLICATE KEY UPDATE
  is_current = VALUES(is_current),
  confidence = VALUES(confidence);
