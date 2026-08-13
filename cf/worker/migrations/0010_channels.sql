-- Shared channel catalog. The existing subscription table remains the
-- per-user follow record so its IDs and annotation/library references survive.
CREATE TABLE IF NOT EXISTS channel (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  platform      TEXT NOT NULL,
  channel_key   TEXT NOT NULL,
  key_kind      TEXT NOT NULL,
  feed_url      TEXT NOT NULL,
  source_url    TEXT,
  title         TEXT,
  image_url     TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(platform, channel_key)
);

CREATE INDEX IF NOT EXISTS ix_channel_title ON channel(title);
CREATE INDEX IF NOT EXISTS ix_channel_feed ON channel(feed_url);

CREATE TABLE IF NOT EXISTS channel_item (
  channel_id    INTEGER NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  item_id       INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(channel_id, item_id)
);

CREATE INDEX IF NOT EXISTS ix_channel_item_item ON channel_item(item_id);

ALTER TABLE subscription
  ADD COLUMN channel_id INTEGER REFERENCES channel(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_sub_channel ON subscription(channel_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sub_user_channel
  ON subscription(user_id, channel_id)
  WHERE channel_id IS NOT NULL;
