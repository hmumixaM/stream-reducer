-- A concise reading brief in a language other than the source summary.
-- The original-language brief stays in reading_summary.
CREATE TABLE IF NOT EXISTS reading_summary_lang (
  item_id INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  content TEXT NOT NULL DEFAULT '{}',
  model TEXT,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (item_id, lang)
);
