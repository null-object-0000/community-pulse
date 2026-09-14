PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  target_date TEXT NOT NULL,
  capture_mode TEXT NOT NULL,
  snapshot_path TEXT NOT NULL,
  snapshot_sha256 TEXT,
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  item_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  error TEXT,
  UNIQUE (source_id, target_date, snapshot_path, parser_version)
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  canonical_url TEXT,
  github_repo TEXT,
  first_seen_date TEXT NOT NULL,
  last_seen_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  display_value TEXT NOT NULL,
  source_id TEXT REFERENCES sources(id),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (kind, normalized_value)
);

CREATE TABLE IF NOT EXISTS identity_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  existing_product_id TEXT NOT NULL REFERENCES products(id),
  candidate_product_id TEXT NOT NULL REFERENCES products(id),
  source_id TEXT REFERENCES sources(id),
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (kind, normalized_value, existing_product_id, candidate_product_id)
);

CREATE TABLE IF NOT EXISTS source_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  title TEXT NOT NULL DEFAULT '',
  url TEXT,
  published_at TEXT,
  payload_json TEXT NOT NULL,
  first_observed_date TEXT NOT NULL,
  last_observed_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_id, external_id)
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  observed_date TEXT NOT NULL,
  published_at TEXT,
  ingestion_run_id TEXT REFERENCES ingestion_runs(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_id, source_item_id, observed_date)
);

CREATE TABLE IF NOT EXISTS product_source_first_seen (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id),
  first_seen_date TEXT NOT NULL,
  last_seen_date TEXT NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (product_id, source_id)
);

CREATE TABLE IF NOT EXISTS enrichment_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  processor TEXT NOT NULL,
  processor_version TEXT NOT NULL,
  prompt_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  started_at TEXT,
  completed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_content (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  content_source TEXT NOT NULL,
  enrichment_run_id TEXT REFERENCES enrichment_runs(id),
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, locale, content_source, created_at)
);

CREATE TABLE IF NOT EXISTS taxonomy_terms (
  facet TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_id TEXT,
  label_zh TEXT NOT NULL,
  label_en TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (facet, id),
  FOREIGN KEY (facet, parent_id) REFERENCES taxonomy_terms(facet, id)
);

CREATE TABLE IF NOT EXISTS taxonomy_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  facet TEXT NOT NULL,
  term_id TEXT NOT NULL,
  assignment_source TEXT NOT NULL CHECK (assignment_source IN ('llm', 'rule', 'manual', 'source')),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  processor_version TEXT NOT NULL,
  enrichment_run_id TEXT REFERENCES enrichment_runs(id),
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (facet, term_id) REFERENCES taxonomy_terms(facet, id),
  UNIQUE (product_id, facet, term_id, assignment_source, processor_version)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  report_date TEXT NOT NULL UNIQUE,
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  selection_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS report_items (
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  source_item_id TEXT REFERENCES source_items(id),
  position INTEGER NOT NULL,
  selection_reason TEXT,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (report_id, product_id),
  UNIQUE (report_id, position)
);

CREATE INDEX IF NOT EXISTS idx_observations_source_date_product
  ON observations(source_id, observed_date, product_id);
CREATE INDEX IF NOT EXISTS idx_observations_product_source_date
  ON observations(product_id, source_id, observed_date);
CREATE INDEX IF NOT EXISTS idx_source_first_seen_source_date
  ON product_source_first_seen(source_id, first_seen_date, product_id);
CREATE INDEX IF NOT EXISTS idx_taxonomy_current_facet_term_product
  ON taxonomy_assignments(facet, term_id, is_current, product_id);
CREATE INDEX IF NOT EXISTS idx_products_first_seen
  ON products(first_seen_date, id);
CREATE INDEX IF NOT EXISTS idx_source_items_product
  ON source_items(product_id, source_id);
