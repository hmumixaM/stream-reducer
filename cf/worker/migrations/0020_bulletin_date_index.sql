-- Read the newest accessible page directly in display order, instead of
-- scanning every completed item's summary and sorting the entire catalog.
CREATE INDEX IF NOT EXISTS ix_item_status_bulletin_date
ON item(status, COALESCE(julianday(published_at), julianday(created_at), 0) DESC, id DESC);
