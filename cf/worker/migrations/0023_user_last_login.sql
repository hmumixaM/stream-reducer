ALTER TABLE user ADD COLUMN last_login_at TEXT;

-- Recover only actual retained login evidence. Accounts with no surviving
-- session or consumed magic link remain NULL rather than using sign-up time.
UPDATE user SET last_login_at = (
  SELECT MAX(logged_in_at) FROM (
    SELECT created_at AS logged_in_at FROM session WHERE user_id = user.id
    UNION ALL
    SELECT used_at AS logged_in_at FROM auth_token
      WHERE email = user.email AND purpose = 'magic_link' AND used_at IS NOT NULL
  )
);
