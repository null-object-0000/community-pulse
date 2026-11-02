-- 回滚稿：删除本次人工复核补的 SMRTROOM travel-mobility 归属
DELETE FROM taxonomy_assignments
WHERE product_id='prd_e2993b2217e0293178bc417a'
  AND facet='useCases'
  AND term_id='travel-mobility'
  AND assignment_source='manual'
  AND processor_version='manual-review-2026-11-02';
