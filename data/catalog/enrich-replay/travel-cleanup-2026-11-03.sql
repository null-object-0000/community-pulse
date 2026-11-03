-- travel-mobility 误分类清理（2026-11-03）：只移出这 3 个产品，删除它们在 useCases/travel-mobility 上的全部分配行。
-- 保留 Impakto Navigator（智能运动鞋）与 Prevo（签证面试练习）。
-- 回滚：这 3 行的来源/版本未在快照中保留；如需恢复，可按产品重新生成标签（不要凭记忆编造 confidence）。
-- diff-tour
DELETE FROM taxonomy_assignments WHERE product_id='prd_28026da02899a23498054beb' AND facet='useCases' AND term_id='travel-mobility';
-- Show HN: Nonce – Open-source, least-privilege Gmail access for AI agents
DELETE FROM taxonomy_assignments WHERE product_id='prd_80130fd50e45f57b05213fe5' AND facet='useCases' AND term_id='travel-mobility';
-- Atlas Bird
DELETE FROM taxonomy_assignments WHERE product_id='prd_97fc301222e46ab510c3380c' AND facet='useCases' AND term_id='travel-mobility';
