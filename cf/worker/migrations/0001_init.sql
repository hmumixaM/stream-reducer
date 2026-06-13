-- stream-reduce multi-user schema (Cloudflare D1 / SQLite).
-- Content rows (item/transcript/summary/chunk/stage_run + graph tables) are
-- GLOBAL and deduped. Per-user state lives in user / user_item / itemgroup /
-- subscription / comment / highlight.

-- ---------------------------------------------------------------------------
-- Accounts + auth
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Single-use magic-link tokens. We store only a SHA-256 hash of the token.
CREATE TABLE IF NOT EXISTS auth_token (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  user_id     INTEGER,
  purpose     TEXT NOT NULL DEFAULT 'magic_link',
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_auth_token_email ON auth_token(email);

-- Session tokens (httpOnly cookie). Hash stored, not the raw token.
CREATE TABLE IF NOT EXISTS session (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_session_user ON session(user_id);

-- ---------------------------------------------------------------------------
-- Global content
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS item (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  platform      TEXT NOT NULL DEFAULT 'unknown',
  source_url    TEXT NOT NULL UNIQUE,
  external_id   TEXT,
  title         TEXT,
  author        TEXT,
  description   TEXT,
  duration_s    INTEGER,
  published_at  TEXT,
  thumbnail     TEXT,
  view_count    INTEGER,
  like_count    INTEGER,
  dislike_count INTEGER,
  status        TEXT NOT NULL DEFAULT 'queued',  -- queued|fetching|transcribing|summarizing|done|error
  error         TEXT,
  -- Prioritization signals (see lib/priority.ts).
  request_count       INTEGER NOT NULL DEFAULT 0,  -- # users who want it
  interest_count      INTEGER NOT NULL DEFAULT 0,  -- # users explicitly interested
  subscriber_demand   INTEGER NOT NULL DEFAULT 0,  -- # subscribers to its source feed
  priority_score      REAL NOT NULL DEFAULT 0,
  -- Media + processing metrics.
  media_key         TEXT,           -- R2 object key for the downloaded audio
  media_bytes       INTEGER NOT NULL DEFAULT 0,
  audio_duration_s  REAL,
  enqueued_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at        TEXT,
  completed_at      TEXT,
  total_processing_ms INTEGER NOT NULL DEFAULT 0,
  total_api_requests  INTEGER NOT NULL DEFAULT 0,
  total_tokens        INTEGER NOT NULL DEFAULT 0,
  total_cost_usd      REAL NOT NULL DEFAULT 0,
  retry_count         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_item_status ON item(status);
CREATE INDEX IF NOT EXISTS ix_item_platform ON item(platform);
CREATE INDEX IF NOT EXISTS ix_item_priority ON item(priority_score);
CREATE INDEX IF NOT EXISTS ix_item_external ON item(external_id);

CREATE TABLE IF NOT EXISTS transcript (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL UNIQUE REFERENCES item(id) ON DELETE CASCADE,
  language   TEXT,
  source     TEXT NOT NULL,             -- native|openrouter_whisper|gemini
  segments   TEXT NOT NULL DEFAULT '[]',-- JSON [{start,end,text}]
  text       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS summary (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id        INTEGER NOT NULL UNIQUE REFERENCES item(id) ON DELETE CASCADE,
  model          TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL DEFAULT '',
  markdown       TEXT NOT NULL DEFAULT '',
  structured     TEXT NOT NULL DEFAULT '{}', -- JSON
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Chunk rows carry the source text + locator AND the embedding (JSON float[]),
-- so the nightly graph build can read vectors without a Vectorize export.
-- Vectorize holds the same vectors keyed by chunk id for fast semantic search.
CREATE TABLE IF NOT EXISTS chunk (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,   -- transcript|summary
  field           TEXT NOT NULL DEFAULT '',
  chunk_index     INTEGER NOT NULL DEFAULT 0,
  text            TEXT NOT NULL DEFAULT '',
  start_s         REAL,
  end_s           REAL,
  char_start      INTEGER,
  char_end        INTEGER,
  token_count     INTEGER NOT NULL DEFAULT 0,
  content_hash    TEXT NOT NULL DEFAULT '',
  embedding_model TEXT NOT NULL DEFAULT '',
  embedding       TEXT,            -- JSON float[] (unit-normalized)
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_chunk_item ON chunk(item_id);
CREATE INDEX IF NOT EXISTS ix_chunk_source ON chunk(source);

CREATE TABLE IF NOT EXISTS stage_run (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  stage        TEXT NOT NULL,   -- download|transcribe|summarize|embed|graph
  status       TEXT NOT NULL DEFAULT 'running',
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at  TEXT,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  provider     TEXT,
  model        TEXT,
  request_count    INTEGER NOT NULL DEFAULT 0,
  chunk_count      INTEGER NOT NULL DEFAULT 0,
  chunk_done       INTEGER NOT NULL DEFAULT 0,
  prompt_tokens    INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL NOT NULL DEFAULT 0,
  http_429_count   INTEGER NOT NULL DEFAULT 0,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS ix_stage_item ON stage_run(item_id);

-- ---------------------------------------------------------------------------
-- Per-user state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS itemgroup (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL DEFAULT 'unknown',
  external_id TEXT,
  source_url  TEXT NOT NULL DEFAULT '',
  title       TEXT,
  item_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_group_user ON itemgroup(user_id);

-- The personal library: many users -> one global item (dedup).
CREATE TABLE IF NOT EXISTS user_item (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  item_id         INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  folder_id       INTEGER REFERENCES itemgroup(id) ON DELETE SET NULL,
  group_position  INTEGER,
  is_favorite     INTEGER NOT NULL DEFAULT 0,
  is_archived     INTEGER NOT NULL DEFAULT 0,
  personal_status TEXT NOT NULL DEFAULT 'waiting',  -- waiting|done
  subscription_id INTEGER REFERENCES subscription(id) ON DELETE SET NULL,
  added_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, item_id)
);
CREATE INDEX IF NOT EXISTS ix_user_item_user ON user_item(user_id);
CREATE INDEX IF NOT EXISTS ix_user_item_item ON user_item(item_id);
CREATE INDEX IF NOT EXISTS ix_user_item_folder ON user_item(folder_id);

CREATE TABLE IF NOT EXISTS item_interest (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, item_id)
);
CREATE INDEX IF NOT EXISTS ix_interest_item ON item_interest(item_id);
CREATE INDEX IF NOT EXISTS ix_interest_user ON item_interest(user_id);

CREATE TABLE IF NOT EXISTS subscription (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL DEFAULT 'rss',
  feed_url        TEXT NOT NULL,
  title           TEXT,
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  -- Only ingest videos published within this many days of subscribing
  -- (default 90 = last 3 months).
  window_days     INTEGER NOT NULL DEFAULT 90,
  min_published_at TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_seen_guid  TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, feed_url)
);
CREATE INDEX IF NOT EXISTS ix_sub_user ON subscription(user_id);
CREATE INDEX IF NOT EXISTS ix_sub_feed ON subscription(feed_url);

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

CREATE TABLE IF NOT EXISTS comment (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_comment_item ON comment(item_id);
CREATE INDEX IF NOT EXISTS ix_comment_user ON comment(user_id);

CREATE TABLE IF NOT EXISTS highlight (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  source     TEXT NOT NULL DEFAULT 'summary',
  quote      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT 'yellow',
  prefix     TEXT NOT NULL DEFAULT '',
  suffix     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_highlight_item ON highlight(item_id);
CREATE INDEX IF NOT EXISTS ix_highlight_user ON highlight(user_id);

-- ---------------------------------------------------------------------------
-- Knowledge graph (global, derived; per-user views filter by user_item)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS graph_paragraph (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id  INTEGER NOT NULL DEFAULT 0,
  chunk_id  INTEGER NOT NULL,
  item_id   INTEGER NOT NULL,
  field     TEXT NOT NULL DEFAULT '',
  text      TEXT NOT NULL DEFAULT '',
  community INTEGER NOT NULL DEFAULT 0,
  degree    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_gp_chunk ON graph_paragraph(chunk_id);
CREATE INDEX IF NOT EXISTS ix_gp_item ON graph_paragraph(item_id);

CREATE TABLE IF NOT EXISTS graph_link (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  src_chunk_id INTEGER NOT NULL,
  dst_chunk_id INTEGER NOT NULL,
  weight       REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_gl_src ON graph_link(src_chunk_id);
CREATE INDEX IF NOT EXISTS ix_gl_dst ON graph_link(dst_chunk_id);

CREATE TABLE IF NOT EXISTS item_recommendation (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER NOT NULL,
  related_item_id INTEGER NOT NULL,
  score           REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_rec_item ON item_recommendation(item_id);

CREATE TABLE IF NOT EXISTS graph_cache (
  id          INTEGER PRIMARY KEY,
  build_id    INTEGER NOT NULL DEFAULT 0,
  blob        TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL DEFAULT '',
  node_count  INTEGER NOT NULL DEFAULT 0,
  item_count  INTEGER NOT NULL DEFAULT 0,
  built_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
