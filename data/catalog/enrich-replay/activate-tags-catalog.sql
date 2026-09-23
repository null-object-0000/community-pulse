UPDATE taxonomy_assignments SET is_current=1
WHERE processor_version='catalog-localize-v1' AND is_current=0;
UPDATE taxonomy_assignments ta
JOIN taxonomy_assignments llm
  ON llm.product_id = ta.product_id
 AND llm.processor_version = 'catalog-localize-v1'
SET ta.is_current=0
WHERE ta.assignment_source='rule'
  AND ta.facet NOT IN ('languages');
UPDATE taxonomy_assignments ta
JOIN taxonomy_assignments hi
  ON hi.product_id = ta.product_id
 AND hi.facet = ta.facet
 AND hi.is_current = 1
 AND hi.processor_version IN ('travel-localize-v1')
SET ta.is_current=0
WHERE ta.processor_version='catalog-localize-v1'
  AND ta.is_current=1;
