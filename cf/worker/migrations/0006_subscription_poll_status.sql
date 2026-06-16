-- Per-poll observability for subscriptions. Previously a failed/empty poll was
-- silently swallowed (only last_checked_at was bumped), so a broken feed looked
-- identical to a healthy one with no new episodes. These columns record the
-- outcome of the most recent poll so the UI can explain why nothing showed up.
ALTER TABLE subscription ADD COLUMN last_status TEXT;            -- ok|empty|error
ALTER TABLE subscription ADD COLUMN last_error TEXT;            -- error message when last_status='error'
ALTER TABLE subscription ADD COLUMN last_entry_count INTEGER NOT NULL DEFAULT 0;  -- entries the feed returned last poll
ALTER TABLE subscription ADD COLUMN last_new_count INTEGER NOT NULL DEFAULT 0;    -- episodes actually enqueued last poll
ALTER TABLE subscription ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
