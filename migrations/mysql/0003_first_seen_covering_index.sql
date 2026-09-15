-- Multi-source trend queries group by product and inspect source/date without touching table rows.
ALTER TABLE product_source_first_seen
  ADD KEY idx_first_seen_product_source_date (product_id, source_id, first_seen_date);
