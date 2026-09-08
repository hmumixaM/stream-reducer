-- Collections may opt into an infographic only after an item's source summary
-- has completed successfully. Existing summaries are queued separately by the
-- admin backfill; this flag covers future completions without generating early.
ALTER TABLE collection ADD COLUMN auto_infographic INTEGER NOT NULL DEFAULT 0;

UPDATE collection
   SET auto_infographic = 1
 WHERE slug = 'ai4-2026';
