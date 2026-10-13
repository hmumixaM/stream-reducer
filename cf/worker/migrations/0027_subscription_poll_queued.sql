-- When the cron last enqueued a poll for this follow that has not run yet.
ALTER TABLE subscription ADD COLUMN poll_queued_at TEXT;
