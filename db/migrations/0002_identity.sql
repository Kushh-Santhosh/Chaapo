-- ═══════════════════════════════════════════════════════════════════════════
-- 0002 — Identity, sessions and access control
--
-- One `users` row per human. Roles are separate rows (`user_roles`), scoped to a
-- shop where the role is shop-scoped, because the same person can legitimately be
-- a customer at one shop and staff at another — and because revoking a role must
-- be an auditable event, not a column overwrite (PRD §14, §15).
--
-- Phone number is the primary credential for customers (OTP) and the secondary
-- identifier for shop owners (password + TOTP). It is stored encrypted with a
-- blind index for lookup: `phone_hash` is a keyed HMAC, unique, non-reversible.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE users (
  id                    uuid PRIMARY KEY,
  -- E.164 phone, encrypted. `phone_hash` is the lookup key.
  phone_encrypted       text        NOT NULL,
  phone_hash            text        NOT NULL,
  phone_masked          text        NOT NULL,      -- '+91 98••• •3210' for display
  phone_verified_at     timestamptz,
  email_encrypted       text,
  email_hash            text,
  email_masked          text,
  email_verified_at     timestamptz,
  -- Display name. Customer-supplied, shown to the shop on the job ticket.
  full_name             text,
  password_hash         text,                      -- NULL for OTP-only customers
  password_updated_at   timestamptz,
  status                account_status NOT NULL DEFAULT 'active',
  locale                text        NOT NULL DEFAULT 'en-IN',
  -- Last IP is kept hashed: useful for fraud correlation, useless for tracking.
  last_ip_hash          text,
  last_login_at         timestamptz,
  -- Set when the user asks for erasure under the DPDP Act. The row is retained
  -- only for the financial-record window; PII columns are overwritten by the
  -- erasure worker and `erased_at` proves it happened (FR-905).
  erasure_requested_at  timestamptz,
  erased_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,

  CONSTRAINT users_phone_hash_len   CHECK (length(phone_hash) BETWEEN 16 AND 128),
  CONSTRAINT users_locale_supported CHECK (locale IN ('en-IN', 'hi-IN', 'mr-IN', 'ta-IN', 'te-IN', 'kn-IN', 'bn-IN')),
  CONSTRAINT users_password_needs_timestamp
    CHECK ((password_hash IS NULL) = (password_updated_at IS NULL))
);

-- One account per phone number, ignoring soft-deleted rows so a closed account
-- does not permanently burn a number.
CREATE UNIQUE INDEX users_phone_hash_key ON users (phone_hash) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_email_hash_key ON users (email_hash) WHERE email_hash IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX users_status_idx ON users (status) WHERE deleted_at IS NULL;
CREATE INDEX users_erasure_pending_idx ON users (erasure_requested_at) WHERE erasure_requested_at IS NOT NULL AND erased_at IS NULL;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE users IS 'One row per human. Roles live in user_roles.';
COMMENT ON COLUMN users.phone_hash IS 'Keyed HMAC blind index. Enables lookup without storing the number in the clear.';


-- ── Roles ──────────────────────────────────────────────────────────────────
-- `shop_id` is required for shop-scoped roles and forbidden for the others, so
-- an admin grant cannot accidentally be scoped, and a staff grant cannot
-- accidentally be global.
CREATE TABLE user_roles (
  id                uuid PRIMARY KEY,
  user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role              user_role   NOT NULL,
  shop_id           uuid,                          -- FK added in 0003 (shops not yet defined)
  granted_by        uuid REFERENCES users (id),    -- NULL for self-service customer role
  granted_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  revoked_by        uuid REFERENCES users (id),
  revoke_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_roles_scope_matches_role CHECK (
    (role IN ('shop_owner', 'shop_staff') AND shop_id IS NOT NULL)
    OR
    (role IN ('customer', 'admin_support', 'admin_finance', 'admin_super') AND shop_id IS NULL)
  ),
  CONSTRAINT user_roles_revocation_complete CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL) OR revoked_at IS NOT NULL
  )
);

-- A person holds a given role at a given scope at most once, actively.
CREATE UNIQUE INDEX user_roles_active_key
  ON user_roles (user_id, role, coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;
CREATE INDEX user_roles_user_idx ON user_roles (user_id) WHERE revoked_at IS NULL;
CREATE INDEX user_roles_shop_idx ON user_roles (shop_id) WHERE shop_id IS NOT NULL AND revoked_at IS NULL;

CREATE TRIGGER user_roles_updated_at BEFORE UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Sessions ───────────────────────────────────────────────────────────────
-- Opaque random tokens, stored hashed. A database dump cannot be replayed as a
-- live session. Sessions are revocable individually and en masse (password
-- change, admin suspension, "sign out everywhere").
CREATE TABLE sessions (
  id                  uuid PRIMARY KEY,
  user_id             uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash          text        NOT NULL,
  -- Rotating refresh token; each use issues a new one and invalidates the old,
  -- so a stolen refresh token is detectable as reuse.
  refresh_token_hash  text        NOT NULL,
  refresh_generation   integer    NOT NULL DEFAULT 1,
  -- Which surface this session is for. A shop-dashboard session must not be
  -- usable against admin routes even if the user holds both roles.
  surface             text        NOT NULL,
  -- Active role for this session; re-checked against user_roles on every request.
  active_role         user_role   NOT NULL,
  active_shop_id      uuid,
  device_encrypted    text,                        -- user agent + platform, PII-adjacent
  ip_hash             text,
  mfa_satisfied_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoke_reason       text,

  CONSTRAINT sessions_surface_valid CHECK (surface IN ('customer', 'shop', 'admin')),
  CONSTRAINT sessions_expiry_ordered CHECK (absolute_expires_at >= expires_at),
  CONSTRAINT sessions_shop_scope CHECK (
    (surface = 'shop') = (active_shop_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE UNIQUE INDEX sessions_refresh_token_hash_key ON sessions (refresh_token_hash);
CREATE INDEX sessions_user_active_idx ON sessions (user_id, expires_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_sweep_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

COMMENT ON COLUMN sessions.surface IS
  'customer | shop | admin. Enforced by the route guard: a session issued for one surface cannot authorise another.';


-- ── OTP challenges ─────────────────────────────────────────────────────────
-- Codes are stored hashed with an attempt counter and a hard expiry. Rate
-- limiting is in Redis; this table is the correctness boundary and the audit
-- record (FR-002, NFR-14).
CREATE TABLE otp_challenges (
  id                uuid PRIMARY KEY,
  purpose           text        NOT NULL,
  -- Blind index of the destination (phone or email), so we can find the live
  -- challenge for a number without storing the number here at all.
  destination_hash  text        NOT NULL,
  channel           notification_channel NOT NULL,
  code_hash         text        NOT NULL,
  attempts          integer     NOT NULL DEFAULT 0,
  max_attempts      integer     NOT NULL DEFAULT 5,
  resend_count      integer     NOT NULL DEFAULT 0,
  -- Set once the code is used. A consumed challenge can never be reused.
  consumed_at       timestamptz,
  -- Set when too many wrong attempts were made; the challenge is dead.
  locked_at         timestamptz,
  expires_at        timestamptz NOT NULL,
  requested_ip_hash text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT otp_purpose_valid CHECK (
    purpose IN ('login', 'signup', 'phone_change', 'email_verify', 'password_reset', 'staff_invite', 'high_value_confirm')
  ),
  CONSTRAINT otp_attempts_bounded CHECK (attempts >= 0 AND attempts <= max_attempts)
);

CREATE INDEX otp_lookup_idx ON otp_challenges (destination_hash, purpose, expires_at DESC)
  WHERE consumed_at IS NULL AND locked_at IS NULL;
CREATE INDEX otp_expiry_sweep_idx ON otp_challenges (expires_at);

CREATE TRIGGER otp_challenges_updated_at BEFORE UPDATE ON otp_challenges
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── TOTP second factor ─────────────────────────────────────────────────────
-- Required for admin roles and for shop-owner actions that move money
-- (bank-account change, payout destination). PRD §15, §57.
CREATE TABLE user_totp (
  user_id             uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  secret_encrypted    text        NOT NULL,
  confirmed_at        timestamptz,
  last_used_at        timestamptz,
  -- Monotonic counter of the last accepted time step, so a code cannot be
  -- replayed inside its validity window.
  last_used_counter   bigint,
  recovery_code_hashes text[]     NOT NULL DEFAULT '{}',
  recovery_codes_used  integer    NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER user_totp_updated_at BEFORE UPDATE ON user_totp
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Login attempts ─────────────────────────────────────────────────────────
-- Kept for lockout decisions and for the security timeline an admin sees when
-- investigating account takeover. No credentials, no plaintext identifiers.
CREATE TABLE login_attempts (
  id                uuid PRIMARY KEY,
  user_id           uuid REFERENCES users (id) ON DELETE SET NULL,
  identifier_hash   text        NOT NULL,
  surface           text        NOT NULL,
  method            text        NOT NULL,
  outcome           text        NOT NULL,
  failure_reason    text,
  ip_hash           text,
  user_agent_family text,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT login_attempts_method_valid  CHECK (method IN ('otp', 'password', 'totp', 'recovery_code', 'refresh')),
  CONSTRAINT login_attempts_outcome_valid CHECK (outcome IN ('success', 'failure', 'locked', 'throttled')),
  CONSTRAINT login_attempts_surface_valid CHECK (surface IN ('customer', 'shop', 'admin'))
);

CREATE INDEX login_attempts_identifier_idx ON login_attempts (identifier_hash, created_at DESC);
CREATE INDEX login_attempts_user_idx ON login_attempts (user_id, created_at DESC) WHERE user_id IS NOT NULL;


-- ── Web push subscriptions ─────────────────────────────────────────────────
-- One row per browser/device. The endpoint is a capability URL, so it is treated
-- as a secret and stored encrypted.
CREATE TABLE push_subscriptions (
  id                uuid PRIMARY KEY,
  user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint_hash     text        NOT NULL,
  endpoint_encrypted text       NOT NULL,
  p256dh_encrypted  text        NOT NULL,
  auth_encrypted    text        NOT NULL,
  surface           text        NOT NULL,
  user_agent_family text,
  failure_count     integer     NOT NULL DEFAULT 0,
  last_success_at   timestamptz,
  last_failure_at   timestamptz,
  -- Set when the push service returns 404/410: the subscription is gone.
  expired_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT push_subscriptions_surface_valid CHECK (surface IN ('customer', 'shop', 'admin'))
);

CREATE UNIQUE INDEX push_subscriptions_endpoint_key ON push_subscriptions (endpoint_hash);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id) WHERE expired_at IS NULL;

CREATE TRIGGER push_subscriptions_updated_at BEFORE UPDATE ON push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Notification preferences ───────────────────────────────────────────────
-- DPDP consent is per purpose, per channel, and withdrawable (FR-901).
-- Transactional order notifications are not marketing and are not opt-out-able,
-- but the channel can be changed.
CREATE TABLE notification_preferences (
  user_id                 uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  order_updates_channels  notification_channel[] NOT NULL DEFAULT '{push,whatsapp}',
  marketing_opted_in      boolean     NOT NULL DEFAULT false,
  marketing_opted_in_at   timestamptz,
  marketing_channels      notification_channel[] NOT NULL DEFAULT '{}',
  -- Quiet hours in IST minutes-from-midnight. Transactional messages ignore
  -- these; digests and marketing respect them.
  quiet_hours_start       integer,
  quiet_hours_end         integer,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_prefs_order_channels_nonempty
    CHECK (array_length(order_updates_channels, 1) >= 1),
  CONSTRAINT notification_prefs_marketing_consistent
    CHECK (marketing_opted_in = false OR marketing_opted_in_at IS NOT NULL),
  CONSTRAINT notification_prefs_quiet_hours_paired
    CHECK ((quiet_hours_start IS NULL) = (quiet_hours_end IS NULL)),
  CONSTRAINT notification_prefs_quiet_hours_range
    CHECK (quiet_hours_start IS NULL OR (quiet_hours_start BETWEEN 0 AND 1439 AND quiet_hours_end BETWEEN 0 AND 1439))
);

CREATE TRIGGER notification_preferences_updated_at BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── DPDP consent records ───────────────────────────────────────────────────
-- Append-only: a consent record is evidence. Withdrawal writes a new row with
-- `withdrawn_at`, it does not delete the grant (FR-901, PRD §57.1).
CREATE TABLE consents (
  id            uuid PRIMARY KEY,
  user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose       text        NOT NULL,
  version       text        NOT NULL,
  granted       boolean     NOT NULL,
  -- The exact notice text hash the user agreed to, so we can prove what was
  -- shown even after the policy is updated.
  notice_hash   text        NOT NULL,
  source        text        NOT NULL,
  ip_hash       text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT consents_purpose_valid CHECK (
    purpose IN ('account', 'order_files', 'transactional_messaging', 'marketing', 'location', 'analytics')
  ),
  CONSTRAINT consents_source_valid CHECK (source IN ('signup', 'settings', 'checkout', 'admin', 'import'))
);

CREATE INDEX consents_user_purpose_idx ON consents (user_id, purpose, created_at DESC);

CREATE TRIGGER consents_append_only
  BEFORE UPDATE OR DELETE ON consents
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
