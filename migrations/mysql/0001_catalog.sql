CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(191) PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sources (
  id VARCHAR(191) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id VARCHAR(191) PRIMARY KEY,
  source_id VARCHAR(191) NOT NULL,
  target_date DATE NOT NULL,
  capture_mode VARCHAR(64) NOT NULL,
  snapshot_path VARCHAR(1024) NOT NULL,
  snapshot_sha256 CHAR(64),
  parser_version VARCHAR(191) NOT NULL,
  status ENUM('running','complete','failed') NOT NULL,
  item_count INT UNSIGNED NOT NULL DEFAULT 0,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3),
  error TEXT,
  CONSTRAINT fk_ingestion_source FOREIGN KEY (source_id) REFERENCES sources(id),
  UNIQUE KEY uq_ingestion_snapshot (source_id, target_date, snapshot_path(300), parser_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(191) PRIMARY KEY,
  canonical_key VARCHAR(1024) NOT NULL,
  title TEXT NOT NULL,
  canonical_url VARCHAR(2048),
  github_repo VARCHAR(512),
  first_seen_date DATE NOT NULL,
  last_seen_date DATE NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_products_canonical_key (canonical_key(768)),
  KEY idx_products_first_seen (first_seen_date, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS product_identities (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id VARCHAR(191) NOT NULL,
  kind VARCHAR(64) NOT NULL,
  normalized_value VARCHAR(1024) NOT NULL,
  display_value TEXT NOT NULL,
  source_id VARCHAR(191),
  confidence DECIMAL(5,4) NOT NULL DEFAULT 1.0,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_identity_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_identity_source FOREIGN KEY (source_id) REFERENCES sources(id),
  UNIQUE KEY uq_identity_value (kind, normalized_value(700))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS identity_conflicts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(64) NOT NULL,
  normalized_value VARCHAR(1024) NOT NULL,
  existing_product_id VARCHAR(191) NOT NULL,
  candidate_product_id VARCHAR(191) NOT NULL,
  source_id VARCHAR(191),
  external_id VARCHAR(512),
  status ENUM('open','merged','dismissed') NOT NULL DEFAULT 'open',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_conflict_existing FOREIGN KEY (existing_product_id) REFERENCES products(id),
  CONSTRAINT fk_conflict_candidate FOREIGN KEY (candidate_product_id) REFERENCES products(id),
  CONSTRAINT fk_conflict_source FOREIGN KEY (source_id) REFERENCES sources(id),
  UNIQUE KEY uq_identity_conflict (kind, normalized_value(300), existing_product_id, candidate_product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS source_items (
  id VARCHAR(191) PRIMARY KEY,
  source_id VARCHAR(191) NOT NULL,
  external_id VARCHAR(512) NOT NULL,
  product_id VARCHAR(191) NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  url VARCHAR(2048),
  published_at DATETIME(3),
  payload_json JSON NOT NULL,
  raw_locator VARCHAR(1024) NOT NULL,
  projection_json JSON NOT NULL,
  first_observed_date DATE NOT NULL,
  last_observed_date DATE NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_source_item_source FOREIGN KEY (source_id) REFERENCES sources(id),
  CONSTRAINT fk_source_item_product FOREIGN KEY (product_id) REFERENCES products(id),
  UNIQUE KEY uq_source_external (source_id, external_id),
  KEY idx_source_items_product (product_id, source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS observations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id VARCHAR(191) NOT NULL,
  source_id VARCHAR(191) NOT NULL,
  source_item_id VARCHAR(191) NOT NULL,
  observed_date DATE NOT NULL,
  published_at DATETIME(3),
  ingestion_run_id VARCHAR(191),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_observation_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_observation_source FOREIGN KEY (source_id) REFERENCES sources(id),
  CONSTRAINT fk_observation_item FOREIGN KEY (source_item_id) REFERENCES source_items(id),
  CONSTRAINT fk_observation_run FOREIGN KEY (ingestion_run_id) REFERENCES ingestion_runs(id),
  UNIQUE KEY uq_observation (source_id, source_item_id, observed_date),
  KEY idx_observations_source_date_product (source_id, observed_date, product_id),
  KEY idx_observations_product_source_date (product_id, source_id, observed_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS product_source_first_seen (
  product_id VARCHAR(191) NOT NULL,
  source_id VARCHAR(191) NOT NULL,
  first_seen_date DATE NOT NULL,
  last_seen_date DATE NOT NULL,
  observation_count INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (product_id, source_id),
  CONSTRAINT fk_first_seen_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_first_seen_source FOREIGN KEY (source_id) REFERENCES sources(id),
  KEY idx_source_first_seen_source_date (source_id, first_seen_date, product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS enrichment_runs (
  id VARCHAR(191) PRIMARY KEY,
  kind VARCHAR(64) NOT NULL,
  processor VARCHAR(191) NOT NULL,
  processor_version VARCHAR(191) NOT NULL,
  prompt_version VARCHAR(191),
  status ENUM('pending','running','complete','failed') NOT NULL,
  started_at DATETIME(3),
  completed_at DATETIME(3),
  error TEXT,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS product_content (
  product_id VARCHAR(191) NOT NULL,
  locale VARCHAR(16) NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  content_source VARCHAR(64) NOT NULL,
  enrichment_run_id VARCHAR(191),
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (product_id, locale, content_source, created_at),
  CONSTRAINT fk_content_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_content_run FOREIGN KEY (enrichment_run_id) REFERENCES enrichment_runs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS taxonomy_terms (
  facet VARCHAR(64) NOT NULL,
  id VARCHAR(191) NOT NULL,
  parent_id VARCHAR(191),
  label_zh VARCHAR(255) NOT NULL,
  label_en VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (facet, id),
  CONSTRAINT fk_taxonomy_parent FOREIGN KEY (facet, parent_id) REFERENCES taxonomy_terms(facet, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS taxonomy_assignments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id VARCHAR(191) NOT NULL,
  facet VARCHAR(64) NOT NULL,
  term_id VARCHAR(191) NOT NULL,
  assignment_source ENUM('llm','rule','manual','source') NOT NULL,
  confidence DECIMAL(5,4),
  processor_version VARCHAR(191) NOT NULL,
  enrichment_run_id VARCHAR(191),
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_assignment_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_assignment_term FOREIGN KEY (facet, term_id) REFERENCES taxonomy_terms(facet, id),
  CONSTRAINT fk_assignment_run FOREIGN KEY (enrichment_run_id) REFERENCES enrichment_runs(id),
  UNIQUE KEY uq_taxonomy_assignment (product_id, facet, term_id, assignment_source, processor_version),
  KEY idx_taxonomy_current_facet_term_product (facet, term_id, is_current, product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS reports (
  id VARCHAR(191) PRIMARY KEY,
  report_date DATE NOT NULL,
  locale VARCHAR(16) NOT NULL DEFAULT 'zh-CN',
  selection_version VARCHAR(191) NOT NULL,
  status ENUM('draft','published','retired') NOT NULL,
  published_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_report_date (report_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS report_items (
  report_id VARCHAR(191) NOT NULL,
  product_id VARCHAR(191) NOT NULL,
  source_item_id VARCHAR(191),
  position INT UNSIGNED NOT NULL,
  selection_reason TEXT,
  snapshot_json JSON NOT NULL,
  PRIMARY KEY (report_id, product_id),
  CONSTRAINT fk_report_item_report FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
  CONSTRAINT fk_report_item_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_report_item_source_item FOREIGN KEY (source_item_id) REFERENCES source_items(id),
  UNIQUE KEY uq_report_position (report_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
