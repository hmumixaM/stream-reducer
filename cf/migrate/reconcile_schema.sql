-- Reconcile the live D1 schema with the committed code.
--
-- These objects were added to the already-applied 0001_init.sql (so D1's
-- migration runner will never re-apply them) plus 0002_item_feed.sql. All
-- statements are additive and idempotent (item_interest etc. via IF NOT EXISTS;
-- the interest_count column is new and added once).

ALTER TABLE item ADD COLUMN interest_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS item_interest (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, item_id)
);
CREATE INDEX IF NOT EXISTS ix_interest_item ON item_interest(item_id);
CREATE INDEX IF NOT EXISTS ix_interest_user ON item_interest(user_id);

CREATE TABLE IF NOT EXISTS subscription_comment (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_sub_comment_sub ON subscription_comment(subscription_id);
CREATE INDEX IF NOT EXISTS ix_sub_comment_user ON subscription_comment(user_id);

CREATE TABLE IF NOT EXISTS subscription_highlight (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  quote           TEXT NOT NULL,
  note            TEXT NOT NULL DEFAULT '',
  color           TEXT NOT NULL DEFAULT 'yellow',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_sub_highlight_sub ON subscription_highlight(subscription_id);
CREATE INDEX IF NOT EXISTS ix_sub_highlight_user ON subscription_highlight(user_id);

CREATE TABLE IF NOT EXISTS item_feed (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  feed_url   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(item_id, feed_url)
);
CREATE INDEX IF NOT EXISTS ix_item_feed_item ON item_feed(item_id);
CREATE INDEX IF NOT EXISTS ix_item_feed_feed ON item_feed(feed_url);
