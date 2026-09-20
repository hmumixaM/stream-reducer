-- A successful login is the last known activity until the next authenticated request.
ALTER TABLE user ADD COLUMN last_online_at TEXT;
UPDATE user SET last_online_at = last_login_at;
