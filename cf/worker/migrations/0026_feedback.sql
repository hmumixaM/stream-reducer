-- User bug reports and suggestions. Images live in R2; only an admin can read them.
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  page_url TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_feedback_created ON feedback(created_at DESC);

CREATE TABLE feedback_image (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id INTEGER NOT NULL,
  image_key TEXT NOT NULL,
  mime_type TEXT NOT NULL
);

CREATE INDEX idx_feedback_image_feedback ON feedback_image(feedback_id);
