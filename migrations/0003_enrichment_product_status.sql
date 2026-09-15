CREATE TABLE IF NOT EXISTS enrichment_product_status (
  enrichment_run_id TEXT NOT NULL REFERENCES enrichment_runs(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed', 'skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  model_request_count INTEGER NOT NULL DEFAULT 0,
  input_hash TEXT NOT NULL,
  error TEXT,
  skip_reason TEXT CHECK (skip_reason IS NULL OR skip_reason IN
    ('missing_description', 'missing_title', 'missing_title_and_description')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (enrichment_run_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_enrichment_product_status_run_status
  ON enrichment_product_status(enrichment_run_id, status, product_id);
