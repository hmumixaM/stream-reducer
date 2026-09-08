ALTER TABLE collection
  ADD COLUMN cover_url TEXT NOT NULL DEFAULT '';

UPDATE collection
   SET cover_url = CASE slug
     WHEN 'ai4-2025' THEN '/collection-covers/ai4-2025.svg'
     WHEN 'ai4-2026' THEN '/collection-covers/ai4-2026.svg'
     ELSE cover_url
   END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE slug IN ('ai4-2025', 'ai4-2026');
