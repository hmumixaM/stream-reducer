-- Keep the short, feed-ready bulletin separate from longer research points.
-- Existing rows remain readable through the structured JSON fallback.
ALTER TABLE research_brief ADD COLUMN bulletin TEXT NOT NULL DEFAULT '[]';
