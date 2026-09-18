-- Ethmos-style research layer. Content stays global; assignments and briefs
-- belong to the user who created them.
CREATE TABLE IF NOT EXISTS research_coverage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  normalized    TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'name',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, normalized)
);
CREATE INDEX IF NOT EXISTS ix_research_coverage_user
  ON research_coverage(user_id, created_at);

CREATE TABLE IF NOT EXISTS research_agent (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'theme',
  prompt        TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_research_agent_user
  ON research_agent(user_id, enabled, created_at);

CREATE TABLE IF NOT EXISTS research_brief (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  agent_id      INTEGER REFERENCES research_agent(id) ON DELETE CASCADE,
  coverage_id   INTEGER REFERENCES research_coverage(id) ON DELETE CASCADE,
  item_id       INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  brief_type    TEXT NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL,
  key_points    TEXT NOT NULL DEFAULT '[]',
  matched_text  TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, agent_id, coverage_id, item_id)
);
CREATE INDEX IF NOT EXISTS ix_research_brief_user_date
  ON research_brief(user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_research_brief_item
  ON research_brief(item_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_research_brief_assignment
  ON research_brief(user_id, ifnull(agent_id, 0), ifnull(coverage_id, 0), item_id);

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
