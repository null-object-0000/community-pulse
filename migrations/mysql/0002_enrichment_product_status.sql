CREATE TABLE IF NOT EXISTS enrichment_product_status (
  enrichment_run_id VARCHAR(191) NOT NULL,
  product_id VARCHAR(191) NOT NULL,
  status ENUM('pending','running','complete','failed') NOT NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  model_request_count INT UNSIGNED NOT NULL DEFAULT 0,
  input_hash CHAR(64) NOT NULL,
  error TEXT,
  started_at DATETIME(3),
  completed_at DATETIME(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (enrichment_run_id, product_id),
  CONSTRAINT fk_enrichment_product_status_run FOREIGN KEY (enrichment_run_id) REFERENCES enrichment_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_enrichment_product_status_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  KEY idx_enrichment_product_status_run_status (enrichment_run_id, status, product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
