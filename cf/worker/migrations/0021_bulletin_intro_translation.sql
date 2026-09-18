-- Localize the complete first reading layer, keeping the full summary intact.
ALTER TABLE bulletin_translation ADD COLUMN headline TEXT NOT NULL DEFAULT '';
ALTER TABLE bulletin_translation ADD COLUMN subhead TEXT NOT NULL DEFAULT '';
ALTER TABLE bulletin_translation ADD COLUMN tldr TEXT NOT NULL DEFAULT '';
ALTER TABLE bulletin_translation ADD COLUMN source_hash TEXT NOT NULL DEFAULT '';
