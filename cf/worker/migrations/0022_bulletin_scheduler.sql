ALTER TABLE bulletin_translation ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bulletin_translation ADD COLUMN next_attempt_at TEXT;
CREATE INDEX idx_bulletin_translation_pending ON bulletin_translation(lang, status, next_attempt_at);
