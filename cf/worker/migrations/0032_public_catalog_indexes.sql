-- Public lists and sitemap counts must not read every full summary body.
-- Keep the existing nonblank-summary rule in a small, automatically maintained
-- partial index. Queries explicitly use it instead of the unique item_id index.
CREATE INDEX IF NOT EXISTS ix_summary_public_item ON summary(item_id)
  WHERE length(trim(markdown)) > 0;

-- Read only the requested page in completion order, rather than sorting the
-- entire completed catalogue before applying LIMIT.
CREATE INDEX IF NOT EXISTS ix_item_status_completed
  ON item(status, completed_at DESC, id DESC);

-- Popular picks only need language eligibility, never transcript text/segments.
CREATE INDEX IF NOT EXISTS ix_transcript_item_language
  ON transcript(item_id, language);
