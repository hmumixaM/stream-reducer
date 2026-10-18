ALTER TABLE rss_source ADD COLUMN substack_access TEXT NOT NULL DEFAULT 'unknown' CHECK (substack_access IN ('free','paid','unknown'));
