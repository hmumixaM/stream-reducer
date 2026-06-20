-- Live pipeline progress for an item, heartbeated by the queue consumer while a
-- job streams from the container (cf/pipeline/server.py /process_stream). Lets
-- the Queue UI render the current stage + a live progress bar between the
-- coarse status transitions. Reset to NULL on (re)queue/claim and on finish.
ALTER TABLE item ADD COLUMN progress_stage TEXT;        -- download|transcribe|summarize
ALTER TABLE item ADD COLUMN progress_pct REAL;          -- 0..100 within the stage
ALTER TABLE item ADD COLUMN progress_detail TEXT;       -- e.g. "2.4 MB/s · ETA 12s" / "chunk 3/10"
ALTER TABLE item ADD COLUMN progress_updated_at TEXT;
