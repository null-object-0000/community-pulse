-- The immutable raw response already lives in source-raw/R2. D1 only needs a
-- compact query projection plus a locator back to that evidence; keeping the
-- legacy payload_json column preserves the already-applied v1 migration while
-- new importers write an empty object there.
ALTER TABLE source_items ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE source_items ADD COLUMN raw_locator TEXT NOT NULL DEFAULT '';
ALTER TABLE source_items ADD COLUMN projection_json TEXT NOT NULL DEFAULT '{}';
