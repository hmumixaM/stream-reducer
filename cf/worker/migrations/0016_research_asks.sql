-- Backfill the on-demand research history for databases that already applied
-- 0015 before the ask workflow was added. IF NOT EXISTS also keeps fresh
-- installs safe because 0015 contains the same table definition.
CREATE TABLE IF NOT EXISTS research_ask (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  sources     TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_research_ask_user_date
  ON research_ask(user_id, created_at);
