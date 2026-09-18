-- Per-user language preference for the feed-ready bulletin layer.
-- The detailed summary remains in its original/source language.
ALTER TABLE user ADD COLUMN preferred_language TEXT NOT NULL DEFAULT 'auto';

CREATE TABLE IF NOT EXISTS bulletin_translation (
  item_id    INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  lang       TEXT NOT NULL,
  bulletin   TEXT NOT NULL DEFAULT '[]',
  status     TEXT NOT NULL DEFAULT 'queued',
  error      TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (item_id, lang)
);
