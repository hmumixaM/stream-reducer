-- Languages automatically generated after an item in this collection finishes.
-- JSON keeps the schema extensible without another join table for a tiny list.
ALTER TABLE collection
  ADD COLUMN auto_translate_langs TEXT NOT NULL DEFAULT '[]';

UPDATE collection
   SET auto_translate_langs = '["zh"]',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE slug = 'ai4-2026';
