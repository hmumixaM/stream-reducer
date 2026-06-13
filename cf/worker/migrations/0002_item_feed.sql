-- Global item <-> feed/channel association.
--
-- Decouples the "subscribed people" prioritization signal from per-user state:
-- an item is linked to every feed/channel it belongs to (its channel RSS when
-- added manually, and the subscription feed when ingested by a poll). Subscriber
-- demand is then the number of distinct users subscribed to any linked feed,
-- regardless of who currently has the item in their library.
CREATE TABLE IF NOT EXISTS item_feed (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  feed_url   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(item_id, feed_url)
);
CREATE INDEX IF NOT EXISTS ix_item_feed_item ON item_feed(item_id);
CREATE INDEX IF NOT EXISTS ix_item_feed_feed ON item_feed(feed_url);
