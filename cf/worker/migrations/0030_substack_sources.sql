-- Connections supply acquisition credentials, never reading entitlements.
-- All acquired articles/editions remain globally shared and URL-deduplicated.
CREATE TABLE substack_connection (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  credentials TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  last_checked_at TEXT,
  last_error TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE rss_source ADD COLUMN substack_connection_id TEXT REFERENCES substack_connection(id);
ALTER TABLE rss_source ADD COLUMN substack_publication_id TEXT;
ALTER TABLE rss_source ADD COLUMN substack_subdomain TEXT;
ALTER TABLE rss_source ADD COLUMN backfill_cursor TEXT;
ALTER TABLE rss_article ADD COLUMN substack_post_id TEXT;
CREATE INDEX rss_source_substack ON rss_source(substack_connection_id,substack_publication_id);
