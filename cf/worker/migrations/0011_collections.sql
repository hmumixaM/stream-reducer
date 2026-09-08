-- Public, curated collections. Unlike itemgroup/folders these are global and
-- readable without a user session.
CREATE TABLE IF NOT EXISTS collection (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_url  TEXT NOT NULL DEFAULT '',
  is_public   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS collection_section (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,
  title         TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(collection_id, slug)
);
CREATE INDEX IF NOT EXISTS ix_collection_section_collection
  ON collection_section(collection_id, position);

CREATE TABLE IF NOT EXISTS collection_track (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id INTEGER NOT NULL REFERENCES collection_section(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  UNIQUE(section_id, title)
);
CREATE INDEX IF NOT EXISTS ix_collection_track_section
  ON collection_track(section_id, position);

-- One row per unique video in a collection. import_enqueued_at makes the
-- administrator import resumable without re-enqueueing completed batches.
CREATE TABLE IF NOT EXISTS collection_item (
  collection_id      INTEGER NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
  item_id            INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL DEFAULT 0,
  import_enqueued_at TEXT,
  PRIMARY KEY(collection_id, item_id)
);
CREATE INDEX IF NOT EXISTS ix_collection_item_item ON collection_item(item_id);

-- Videos may appear in more than one track while retaining an independent
-- position in each track.
CREATE TABLE IF NOT EXISTS collection_track_item (
  track_id  INTEGER NOT NULL REFERENCES collection_track(id) ON DELETE CASCADE,
  item_id   INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(track_id, item_id)
);
CREATE INDEX IF NOT EXISTS ix_collection_track_item_item
  ON collection_track_item(item_id);
