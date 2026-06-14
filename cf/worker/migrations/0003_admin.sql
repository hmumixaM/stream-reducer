-- Admin role. Admins manage users + the global processing queue and are the
-- only accounts allowed to see/change model + provider settings.
ALTER TABLE user ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- Seed the initial admin (no-op if they haven't signed in yet; the Worker also
-- promotes ADMIN_EMAILS on login).
UPDATE user SET is_admin = 1 WHERE email = 'huyangmax@gmail.com';
