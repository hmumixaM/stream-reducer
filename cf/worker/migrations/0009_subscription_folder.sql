-- Let a subscription target a folder: every episode it ingests is filed into
-- this folder. NULL (the default) keeps ingested items unfiled, matching the
-- prior behavior. ON DELETE SET NULL so deleting a folder just unfiles the
-- subscription rather than cascading.
ALTER TABLE subscription ADD COLUMN folder_id INTEGER REFERENCES itemgroup(id) ON DELETE SET NULL;
