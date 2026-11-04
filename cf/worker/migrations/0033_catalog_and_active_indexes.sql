-- Default public Browse can stop after the requested publication-ordered page.
CREATE INDEX IF NOT EXISTS ix_item_public_published
  ON item(published_at DESC, created_at DESC) WHERE status != 'excluded';

-- Personal libraries read the user's most recently saved items in index order.
CREATE INDEX IF NOT EXISTS ix_user_item_added ON user_item(user_id, added_at DESC);

-- The frequently polled sidebar count visits only active items before checking
-- membership, instead of looking up every item in a large saved library.
CREATE INDEX IF NOT EXISTS ix_item_active_id
  ON item(id) WHERE status NOT IN ('done', 'excluded', 'error');
