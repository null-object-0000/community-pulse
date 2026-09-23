UPDATE taxonomy_assignments SET is_current=1
WHERE processor_version='travel-localize-v1' AND is_current=0;
UPDATE taxonomy_assignments ta
JOIN taxonomy_assignments llm
  ON llm.product_id = ta.product_id
 AND llm.processor_version = 'travel-localize-v1'
SET ta.is_current=0
WHERE ta.assignment_source='rule'
  AND ta.facet NOT IN ('languages');
