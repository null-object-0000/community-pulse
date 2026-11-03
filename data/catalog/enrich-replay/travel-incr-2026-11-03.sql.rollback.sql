UPDATE taxonomy_assignments ta
JOIN taxonomy_assignments llm
  ON llm.product_id = ta.product_id
 AND llm.processor_version = 'travel-localize-v1'
SET ta.is_current=1
WHERE ta.assignment_source='rule'
  AND ta.facet NOT IN ('languages');
UPDATE taxonomy_assignments SET is_current=0
WHERE processor_version='travel-localize-v1';
UPDATE product_content SET is_current = 0
WHERE content_source = 'llm:travel-localize-v1';
