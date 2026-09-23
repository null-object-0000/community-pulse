UPDATE product_content pc

SET pc.is_current = 1
WHERE pc.content_source = 'llm:travel-localize-v1' AND pc.is_current = 0 ;
UPDATE product_content pc
JOIN product_content win
  ON win.product_id = pc.product_id
 AND win.locale = pc.locale
 AND win.is_current = 1
 AND win.content_source = 'llm:travel-localize-v1'
SET pc.is_current = 0
WHERE pc.content_source <> 'llm:travel-localize-v1' AND pc.is_current = 1;
UPDATE product_content pc
LEFT JOIN product_content keep
  ON keep.product_id = pc.product_id
 AND keep.locale = pc.locale
 AND keep.is_current = 1
 AND keep.content_source IN ('llm:travel-localize-v1')
SET pc.is_current = 1
WHERE pc.content_source = 'llm:catalog-localize-v1' AND pc.is_current = 0 AND keep.product_id IS NULL;
UPDATE product_content pc
JOIN product_content win
  ON win.product_id = pc.product_id
 AND win.locale = pc.locale
 AND win.is_current = 1
 AND win.content_source = 'llm:catalog-localize-v1'
SET pc.is_current = 0
WHERE pc.content_source <> 'llm:catalog-localize-v1' AND pc.is_current = 1;
