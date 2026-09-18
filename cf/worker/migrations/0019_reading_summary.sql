-- A concise reading edition, separate from the lossless original summary.
CREATE TABLE IF NOT EXISTS reading_summary (
  item_id INTEGER PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  content TEXT NOT NULL DEFAULT '{}',
  model TEXT,
  error TEXT,
  updated_at TEXT NOT NULL
);

