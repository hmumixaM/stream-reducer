-- Deliberately independent of item/channel/subscription and media queues.
CREATE TABLE rss_source (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  url TEXT NOT NULL,
  feed_url TEXT,
  folo_id TEXT,
  title TEXT NOT NULL,
  last_checked_at TEXT,
  next_poll_at TEXT NOT NULL DEFAULT '',
  last_error TEXT,
  actual_provider TEXT,
  backfill_before TEXT,
  backfill_since TEXT NOT NULL,
  backfill_status TEXT NOT NULL DEFAULT 'pending',
  earliest_at TEXT,
  lease_until TEXT,
  lease_token TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  auth_error INTEGER NOT NULL DEFAULT 0,
  poll_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE rss_follow (
  user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES rss_source(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id, source_id)
);
CREATE TABLE rss_article (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  author TEXT,
  published_at TEXT,
  folo_entry_id TEXT,
  seed_key TEXT,
  body_key TEXT,
  body_hash TEXT,
  body_version INTEGER NOT NULL DEFAULT 0,
  completeness TEXT NOT NULL DEFAULT 'unknown',
  extraction_method TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  lease_token TEXT,
  next_attempt_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE rss_source_article (
  source_id INTEGER NOT NULL REFERENCES rss_source(id) ON DELETE CASCADE,
  article_id INTEGER NOT NULL REFERENCES rss_article(id) ON DELETE CASCADE,
  external_id TEXT,
  PRIMARY KEY(source_id, article_id)
);
CREATE TABLE rss_edition (
  article_id INTEGER NOT NULL REFERENCES rss_article(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  version TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(article_id, lang)
);
CREATE TABLE rss_read (
  user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  article_id INTEGER NOT NULL REFERENCES rss_article(id) ON DELETE CASCADE,
  read_at TEXT,
  saved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, article_id)
);
CREATE INDEX rss_source_due ON rss_source(next_poll_at, lease_until);
CREATE INDEX rss_article_due ON rss_article(status, next_attempt_at, lease_until);
CREATE INDEX rss_source_article_article ON rss_source_article(article_id);
CREATE INDEX rss_article_date ON rss_article(published_at DESC, id DESC);

CREATE TABLE rss_alias (
  alias TEXT PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES rss_article(id) ON DELETE CASCADE
);
CREATE TABLE rss_control (
  id INTEGER PRIMARY KEY CHECK(id=1),
  paused INTEGER NOT NULL DEFAULT 0
);
INSERT INTO rss_control(id) VALUES(1);
CREATE TABLE rss_llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES rss_article(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
