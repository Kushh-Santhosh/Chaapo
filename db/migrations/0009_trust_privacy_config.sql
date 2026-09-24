-- ═══════════════════════════════════════════════════════════════════════════
-- 0009 — Trust, privacy, configuration and analytics
--
-- Four concerns that all reduce to the same requirement: an admin's power over
-- money, verification, privacy and overrides must leave a record that the admin
-- cannot alter (PRD §50, §57, NFR-16).
--
--   • `audit_logs` — append-only, one row per consequential action, on every
--     surface. Not a debug log: a deliberate record with actor, target, before,
--     after and reason.
--   • `disputes` — the escalation path when a customer and a shop disagree, with
--     the money held while it is open.
--   • `platform_config` — every business number the PRD leaves tunable
--     (commission, SLA defaults, refund windows, retention days, upload caps)
--     lives here, versioned and audited, so Super Admin changes policy without a
--     deploy and we can always see what the policy was on a given date.
--   • `data_erasure_requests` / `data_export_requests` — the DPDP Act rights,
--     implemented as tracked jobs rather than an inbox someone forgets.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Audit log ──────────────────────────────────────────────────────────────
CREATE TABLE audit_logs (
  id                uuid PRIMARY KEY,
  -- Dotted action name: 'shop.verification.approved', 'refund.approved',
  -- 'order.pickup.overridden', 'file.admin_accessed', 'config.changed'.
  action            text        NOT NULL,
  -- Coarse grouping for the admin audit browser and for retention policy.
  category          text        NOT NULL,
  severity          text        NOT NULL DEFAULT 'info',

  actor_type        text        NOT NULL,
  actor_user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_role        user_role,
  -- Denormalised so the log is readable after the user is erased.
  actor_label       text,
  actor_shop_id     uuid REFERENCES shops (id) ON DELETE SET NULL,
  -- Set when an admin is acting as another user for support. Both identities are
  -- recorded; impersonation is never anonymous (PRD §50.6).
  impersonated_user_id uuid REFERENCES users (id) ON DELETE SET NULL,

  -- What was acted on.
  target_type       text        NOT NULL,
  target_id         uuid,
  target_label      text,

  -- State before and after, PII-redacted. Only the fields that changed.
  before            jsonb,
  after             jsonb,
  -- Free-text justification. Required for overrides and money movements; the
  -- domain layer enforces which actions demand one.
  reason            text,
  -- Amount involved, where the action moves money. Makes "show me everything
  -- above ₹5,000 an admin did last week" a single indexed query.
  amount_paise      bigint,

  correlation_id    text,
  ip_hash           text,
  user_agent_family text,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_logs_category_valid CHECK (
    category IN ('auth', 'account', 'shop', 'verification', 'catalogue', 'order',
                 'payment', 'refund', 'payout', 'file', 'privacy', 'config',
                 'notification', 'dispute', 'admin', 'security')
  ),
  CONSTRAINT audit_logs_severity_valid CHECK (severity IN ('info', 'notice', 'warning', 'critical')),
  CONSTRAINT audit_logs_actor_type_valid CHECK (
    actor_type IN ('customer', 'shop', 'admin', 'system', 'provider')
  ),
  CONSTRAINT audit_logs_human_is_identified CHECK (
    actor_type NOT IN ('customer', 'shop', 'admin') OR actor_user_id IS NOT NULL
  )
);

CREATE INDEX audit_logs_recent_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);
CREATE INDEX audit_logs_category_idx ON audit_logs (category, created_at DESC);
-- The reviews that matter most: admin actions, money, and privacy access.
CREATE INDEX audit_logs_admin_idx ON audit_logs (created_at DESC) WHERE actor_type = 'admin';
CREATE INDEX audit_logs_money_idx ON audit_logs (amount_paise DESC, created_at DESC)
  WHERE amount_paise IS NOT NULL;
CREATE INDEX audit_logs_privacy_idx ON audit_logs (created_at DESC) WHERE category = 'privacy';
CREATE INDEX audit_logs_impersonation_idx ON audit_logs (impersonated_user_id, created_at DESC)
  WHERE impersonated_user_id IS NOT NULL;
CREATE INDEX audit_logs_correlation_idx ON audit_logs (correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMENT ON TABLE audit_logs IS
  'Append-only, enforced by trigger. A compromised application credential cannot erase its own trail (NFR-16).';


-- ── Disputes ───────────────────────────────────────────────────────────────
-- Opened when a customer says the print is wrong, or a shop says the customer
-- never came, or an admin spots something. While a dispute is open the order's
-- funds do not settle (PRD §43).
CREATE TABLE disputes (
  id                    uuid PRIMARY KEY,
  reference             text        NOT NULL,
  order_id              uuid        NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  shop_id               uuid        NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  customer_user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  state                 dispute_state NOT NULL DEFAULT 'open',
  raised_by             text        NOT NULL,
  raised_by_user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  category              text        NOT NULL,
  summary               text        NOT NULL,
  -- What the customer wants: a refund, a reprint, or an explanation.
  requested_remedy      text,
  -- Amount in contention.
  amount_paise          bigint      NOT NULL,

  assigned_to           uuid REFERENCES users (id) ON DELETE SET NULL,
  assigned_at           timestamptz,
  -- SLA for the support team.
  respond_by            timestamptz,
  first_response_at     timestamptz,

  resolution            text,
  resolution_note       text,
  resolved_refund_paise bigint,
  -- Who ends up paying for the resolution.
  cost_borne_by         text,
  resolved_at           timestamptz,
  resolved_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Whether this counts against the shop's quality score.
  counts_against_shop   boolean     NOT NULL DEFAULT false,

  -- Evidence: file ids and photo storage keys, no URLs.
  evidence              jsonb       NOT NULL DEFAULT '[]',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT disputes_raised_by_valid CHECK (raised_by IN ('customer', 'shop', 'admin', 'system')),
  CONSTRAINT disputes_category_valid CHECK (
    category IN ('print_quality', 'wrong_output', 'missing_pages', 'not_ready', 'never_collected',
                 'overcharged', 'file_privacy', 'rude_service', 'payment_not_received',
                 'chargeback', 'other')
  ),
  CONSTRAINT disputes_remedy_valid CHECK (
    requested_remedy IS NULL OR requested_remedy IN ('refund_full', 'refund_partial', 'reprint', 'explanation', 'other')
  ),
  CONSTRAINT disputes_resolution_valid CHECK (
    resolution IS NULL OR resolution IN ('refund_full', 'refund_partial', 'reprint_arranged',
                                         'no_action', 'shop_at_fault', 'customer_at_fault',
                                         'inconclusive', 'withdrawn')
  ),
  CONSTRAINT disputes_cost_borne_valid CHECK (
    cost_borne_by IS NULL OR cost_borne_by IN ('platform', 'shop', 'shared', 'none')
  ),
  CONSTRAINT disputes_amount_nonneg CHECK (amount_paise >= 0),
  CONSTRAINT disputes_resolved_complete CHECK (
    (resolved_at IS NULL) OR (resolution IS NOT NULL AND resolved_by IS NOT NULL)
  ),
  CONSTRAINT disputes_refund_bounded CHECK (
    resolved_refund_paise IS NULL OR (resolved_refund_paise >= 0 AND resolved_refund_paise <= amount_paise)
  )
);

CREATE UNIQUE INDEX disputes_reference_key ON disputes (reference);
-- One open dispute per order at a time.
CREATE UNIQUE INDEX disputes_one_open_per_order ON disputes (order_id)
  WHERE state NOT IN ('resolved_refund', 'resolved_no_refund', 'resolved_partial', 'withdrawn');
CREATE INDEX disputes_queue_idx ON disputes (respond_by)
  WHERE state IN ('open', 'awaiting_customer', 'awaiting_shop', 'in_review');
CREATE INDEX disputes_shop_idx ON disputes (shop_id, created_at DESC);
CREATE INDEX disputes_customer_idx ON disputes (customer_user_id, created_at DESC);
CREATE INDEX disputes_assigned_idx ON disputes (assigned_to, respond_by) WHERE assigned_to IS NOT NULL;

CREATE TRIGGER disputes_updated_at BEFORE UPDATE ON disputes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE orders
  ADD CONSTRAINT orders_dispute_id_fkey FOREIGN KEY (dispute_id) REFERENCES disputes (id) ON DELETE SET NULL;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_dispute_id_fkey FOREIGN KEY (dispute_id) REFERENCES disputes (id) ON DELETE SET NULL;


-- ── Dispute messages ───────────────────────────────────────────────────────
-- The conversation. Append-only, because editing what you said in a dispute is
-- not a feature. Visibility is explicit: an internal admin note is not shown to
-- either party.
CREATE TABLE dispute_messages (
  id                uuid PRIMARY KEY,
  dispute_id        uuid        NOT NULL REFERENCES disputes (id) ON DELETE CASCADE,
  sequence          integer     NOT NULL,
  author_type       text        NOT NULL,
  author_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  author_label      text,
  body              text        NOT NULL,
  -- Attachment storage keys in the private dispute bucket. No URLs.
  attachment_keys   text[]      NOT NULL DEFAULT '{}',
  visible_to        text[]      NOT NULL DEFAULT '{customer,shop,admin}',
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dispute_messages_author_valid CHECK (
    author_type IN ('customer', 'shop', 'admin', 'system')
  ),
  CONSTRAINT dispute_messages_sequence_positive CHECK (sequence >= 1),
  CONSTRAINT dispute_messages_visibility_nonempty CHECK (array_length(visible_to, 1) >= 1),
  CONSTRAINT dispute_messages_body_length CHECK (length(body) BETWEEN 1 AND 5000)
);

CREATE UNIQUE INDEX dispute_messages_sequence_key ON dispute_messages (dispute_id, sequence);
CREATE INDEX dispute_messages_dispute_idx ON dispute_messages (dispute_id, sequence);

CREATE TRIGGER dispute_messages_append_only
  BEFORE UPDATE OR DELETE ON dispute_messages
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();


-- ── Risk flags ─────────────────────────────────────────────────────────────
-- The trust queue. Raised by rules (a shop overriding pickup verification
-- repeatedly, a PAN reused across shops, a customer disputing every order) and
-- worked by admin_support. Kept separate from disputes because a flag is our
-- suspicion, not a party's complaint (PRD §51).
CREATE TABLE risk_flags (
  id                uuid PRIMARY KEY,
  rule_code         text        NOT NULL,
  severity          text        NOT NULL DEFAULT 'medium',
  subject_type      text        NOT NULL,
  subject_id        uuid        NOT NULL,
  subject_label     text,
  -- What tripped, with the numbers that tripped it.
  detail            jsonb       NOT NULL DEFAULT '{}',
  -- Rolling score contribution, so several small signals can add up.
  score             integer     NOT NULL DEFAULT 1,
  state             text        NOT NULL DEFAULT 'open',
  assigned_to       uuid REFERENCES users (id) ON DELETE SET NULL,
  resolution        text,
  resolution_note   text,
  resolved_at       timestamptz,
  resolved_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Actions taken automatically when the flag was raised (payout held, shop
  -- paused), so an admin knows what is already in force.
  auto_actions      text[]      NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT risk_flags_severity_valid CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT risk_flags_subject_valid CHECK (subject_type IN ('user', 'shop', 'order', 'payment', 'file')),
  CONSTRAINT risk_flags_state_valid CHECK (state IN ('open', 'investigating', 'confirmed', 'dismissed', 'auto_resolved')),
  CONSTRAINT risk_flags_resolved_complete CHECK (
    (resolved_at IS NULL) = (resolution IS NULL)
  )
);

CREATE INDEX risk_flags_queue_idx ON risk_flags (severity, created_at) WHERE state IN ('open', 'investigating');
CREATE INDEX risk_flags_subject_idx ON risk_flags (subject_type, subject_id, created_at DESC);
CREATE INDEX risk_flags_rule_idx ON risk_flags (rule_code, created_at DESC);
-- Don't raise the same rule for the same subject twice while it is open.
CREATE UNIQUE INDEX risk_flags_open_key ON risk_flags (rule_code, subject_type, subject_id)
  WHERE state IN ('open', 'investigating');

CREATE TRIGGER risk_flags_updated_at BEFORE UPDATE ON risk_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Platform configuration ─────────────────────────────────────────────────
-- Every tunable business number in one place, typed, validated and audited.
-- The alternative — constants in code — means a commission change is a deploy and
-- nobody can answer "what was the refund window in March" (PRD §52).
--
-- Values are stored as jsonb with a declared `value_type` so the loader can
-- validate them, and `min_value`/`max_value` bound the numeric ones so a typo in
-- the admin console cannot set commission to 800 %.
CREATE TABLE platform_config (
  key               citext PRIMARY KEY,
  value             jsonb       NOT NULL,
  value_type        text        NOT NULL,
  -- Grouping for the admin console's settings screens.
  section           text        NOT NULL,
  label             text        NOT NULL,
  description       text        NOT NULL,
  unit              text,
  min_value         numeric,
  max_value         numeric,
  -- Whether changing this requires a Super Admin rather than admin_finance.
  requires_super_admin boolean  NOT NULL DEFAULT false,
  -- Whether the value is safe to send to a browser. Most are; a few are not.
  is_public         boolean     NOT NULL DEFAULT false,
  -- Set for values we deliberately do not let the console edit (they exist here
  -- for visibility and are changed by migration).
  is_readonly       boolean     NOT NULL DEFAULT false,
  version           integer     NOT NULL DEFAULT 1,
  updated_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT platform_config_value_type_valid CHECK (
    value_type IN ('integer', 'bps', 'paise', 'boolean', 'string', 'string_array', 'json', 'minutes', 'days', 'hours')
  ),
  CONSTRAINT platform_config_bounds_ordered CHECK (
    min_value IS NULL OR max_value IS NULL OR max_value >= min_value
  ),
  CONSTRAINT platform_config_version_positive CHECK (version >= 1)
);

CREATE INDEX platform_config_section_idx ON platform_config (section, key);
CREATE INDEX platform_config_public_idx ON platform_config (key) WHERE is_public;

CREATE TRIGGER platform_config_updated_at BEFORE UPDATE ON platform_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE platform_config IS
  'Business policy as data: commission, SLA defaults, refund windows, retention days, caps. Versioned and audited.';


-- Append-only history. This is how "what was the commission on 3 March" is
-- answered, and how a bad change is reverted with confidence.
CREATE TABLE platform_config_history (
  id                uuid PRIMARY KEY,
  key               citext      NOT NULL,
  version           integer     NOT NULL,
  old_value         jsonb,
  new_value         jsonb       NOT NULL,
  changed_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  reason            text        NOT NULL,
  -- When the new value took effect, which may be later than when it was set.
  effective_from    timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX platform_config_history_key ON platform_config_history (key, version);
CREATE INDEX platform_config_history_recent_idx ON platform_config_history (key, effective_from DESC);

CREATE TRIGGER platform_config_history_append_only
  BEFORE UPDATE OR DELETE ON platform_config_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();


-- ── Feature flags ──────────────────────────────────────────────────────────
CREATE TABLE feature_flags (
  key               citext PRIMARY KEY,
  label             text        NOT NULL,
  description       text        NOT NULL,
  is_enabled        boolean     NOT NULL DEFAULT false,
  -- Percentage rollout in basis points, evaluated against a stable hash of the
  -- subject id so a user does not flip between variants.
  rollout_bps       integer     NOT NULL DEFAULT 0,
  -- Explicit allow/deny lists, which beat the percentage.
  enabled_user_ids  uuid[]      NOT NULL DEFAULT '{}',
  enabled_shop_ids  uuid[]      NOT NULL DEFAULT '{}',
  enabled_city_ids  uuid[]      NOT NULL DEFAULT '{}',
  updated_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT feature_flags_rollout_range CHECK (rollout_bps BETWEEN 0 AND 10000)
);

CREATE TRIGGER feature_flags_updated_at BEFORE UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── DPDP rights: erasure ───────────────────────────────────────────────────
-- A tracked job, not a support inbox. The worker deletes what it can, retains
-- what the law requires (financial records for the statutory period), and records
-- exactly what it did (FR-905, PRD §57.6).
CREATE TABLE data_erasure_requests (
  id                    uuid PRIMARY KEY,
  user_id               uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  requested_by          text        NOT NULL DEFAULT 'user',
  requested_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  state                 text        NOT NULL DEFAULT 'pending',
  -- Verification that the requester is the account holder.
  verified_at           timestamptz,
  verification_method   text,
  -- Grace period before execution, so an account taken over cannot be erased to
  -- cover tracks and so a user can change their mind.
  scheduled_for         timestamptz NOT NULL,
  started_at            timestamptz,
  completed_at          timestamptz,
  cancelled_at          timestamptz,
  cancellation_reason   text,
  -- What was done: counts per table, files deleted, what was retained and why.
  execution_report      jsonb,
  -- Records we are legally required to keep, with the date they can go.
  retained_until        timestamptz,
  retention_basis       text,
  failure_reason        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT data_erasure_requested_by_valid CHECK (requested_by IN ('user', 'admin', 'regulator')),
  CONSTRAINT data_erasure_state_valid CHECK (
    state IN ('pending', 'awaiting_verification', 'scheduled', 'blocked', 'running', 'completed', 'cancelled', 'failed')
  ),
  CONSTRAINT data_erasure_completed_has_report CHECK (
    state <> 'completed' OR (completed_at IS NOT NULL AND execution_report IS NOT NULL)
  ),
  CONSTRAINT data_erasure_cancellation_has_reason CHECK (
    cancelled_at IS NULL OR cancellation_reason IS NOT NULL
  )
);

-- One live erasure request per user.
CREATE UNIQUE INDEX data_erasure_requests_live_key ON data_erasure_requests (user_id)
  WHERE state IN ('pending', 'awaiting_verification', 'scheduled', 'blocked', 'running');
CREATE INDEX data_erasure_requests_due_idx ON data_erasure_requests (scheduled_for) WHERE state = 'scheduled';
CREATE INDEX data_erasure_requests_blocked_idx ON data_erasure_requests (created_at) WHERE state = 'blocked';

CREATE TRIGGER data_erasure_requests_updated_at BEFORE UPDATE ON data_erasure_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── DPDP rights: export ────────────────────────────────────────────────────
CREATE TABLE data_export_requests (
  id                uuid PRIMARY KEY,
  user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  state             text        NOT NULL DEFAULT 'pending',
  -- The export archive lands in a private bucket with a short-lived signed URL
  -- issued only to the requesting user, once.
  storage_bucket    text,
  storage_key       text,
  byte_size         bigint,
  -- Single-use download token, hashed.
  download_token_hash text,
  download_count    integer     NOT NULL DEFAULT 0,
  max_downloads     integer     NOT NULL DEFAULT 3,
  started_at        timestamptz,
  completed_at      timestamptz,
  -- The archive is deleted after this.
  expires_at        timestamptz NOT NULL,
  bytes_deleted_at  timestamptz,
  failure_reason    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT data_export_state_valid CHECK (
    state IN ('pending', 'running', 'ready', 'expired', 'failed')
  ),
  CONSTRAINT data_export_downloads_bounded CHECK (download_count >= 0 AND download_count <= max_downloads),
  CONSTRAINT data_export_ready_has_object CHECK (
    state <> 'ready' OR (storage_key IS NOT NULL AND download_token_hash IS NOT NULL)
  )
);

CREATE UNIQUE INDEX data_export_requests_token_key ON data_export_requests (download_token_hash)
  WHERE download_token_hash IS NOT NULL;
CREATE INDEX data_export_requests_user_idx ON data_export_requests (user_id, created_at DESC);
CREATE INDEX data_export_requests_pending_idx ON data_export_requests (created_at) WHERE state = 'pending';
CREATE INDEX data_export_requests_expiry_idx ON data_export_requests (expires_at)
  WHERE bytes_deleted_at IS NULL AND storage_key IS NOT NULL;

CREATE TRIGGER data_export_requests_updated_at BEFORE UPDATE ON data_export_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Retention job log ──────────────────────────────────────────────────────
-- Proof that the retention policy actually runs. An empty table here means files
-- are not being deleted, which is a privacy incident, not a quiet success
-- (FR-903, NFR-15).
CREATE TABLE retention_runs (
  id                uuid PRIMARY KEY,
  job               text        NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  candidates        integer     NOT NULL DEFAULT 0,
  deleted           integer     NOT NULL DEFAULT 0,
  skipped           integer     NOT NULL DEFAULT 0,
  failed            integer     NOT NULL DEFAULT 0,
  bytes_freed       bigint      NOT NULL DEFAULT 0,
  -- Reasons for skips, aggregated: {"dispute_hold": 3, "legal_hold": 1}.
  skip_reasons      jsonb       NOT NULL DEFAULT '{}',
  error             text,

  CONSTRAINT retention_runs_job_valid CHECK (
    job IN ('file_expiry', 'preview_expiry', 'upload_session_sweep', 'export_expiry',
            'otp_sweep', 'session_sweep', 'idempotency_sweep', 'analytics_rollup', 'user_erasure')
  ),
  CONSTRAINT retention_runs_counts_nonneg CHECK (
    candidates >= 0 AND deleted >= 0 AND skipped >= 0 AND failed >= 0 AND bytes_freed >= 0
  )
);

CREATE INDEX retention_runs_job_idx ON retention_runs (job, started_at DESC);
CREATE INDEX retention_runs_failures_idx ON retention_runs (started_at DESC) WHERE failed > 0 OR error IS NOT NULL;


-- ── Analytics events ───────────────────────────────────────────────────────
-- Product analytics, deliberately thin: an event name, a subject, and a small
-- typed property bag. No page-view firehose, no third-party pixel, no PII. It
-- exists to answer the funnel questions in the PRD (discovery → upload →
-- configure → pay → collect) and nothing else (PRD §54).
CREATE TABLE analytics_events (
  id                uuid PRIMARY KEY,
  event             text        NOT NULL,
  surface           text        NOT NULL,
  -- Hashed session identifier so a funnel can be reconstructed without
  -- identifying anyone.
  anon_id_hash      text,
  user_id           uuid REFERENCES users (id) ON DELETE SET NULL,
  shop_id           uuid REFERENCES shops (id) ON DELETE SET NULL,
  order_id          uuid REFERENCES orders (id) ON DELETE SET NULL,
  city_id           uuid REFERENCES cities (id) ON DELETE SET NULL,
  properties        jsonb       NOT NULL DEFAULT '{}',
  -- Client-reported performance numbers for the NFR budgets.
  duration_ms       integer,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT analytics_events_surface_valid CHECK (surface IN ('customer', 'shop', 'admin', 'worker')),
  CONSTRAINT analytics_events_duration_nonneg CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE INDEX analytics_events_event_time_idx ON analytics_events (event, occurred_at DESC);
CREATE INDEX analytics_events_funnel_idx ON analytics_events (anon_id_hash, occurred_at)
  WHERE anon_id_hash IS NOT NULL;
CREATE INDEX analytics_events_shop_idx ON analytics_events (shop_id, occurred_at DESC) WHERE shop_id IS NOT NULL;
CREATE INDEX analytics_events_order_idx ON analytics_events (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX analytics_events_sweep_idx ON analytics_events (occurred_at);

CREATE TRIGGER analytics_events_append_only
  BEFORE UPDATE OR DELETE ON analytics_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();


-- ── Daily rollups ──────────────────────────────────────────────────────────
-- Pre-aggregated per shop per IST day, so the shop dashboard's charts and the
-- admin console's city view are single-row-range reads rather than scans over
-- orders (NFR-04).
CREATE TABLE shop_daily_stats (
  shop_id                   uuid        NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  -- IST calendar date, not UTC. A shop's "Tuesday" is its own Tuesday.
  stat_date                 date        NOT NULL,
  orders_placed             integer     NOT NULL DEFAULT 0,
  orders_accepted           integer     NOT NULL DEFAULT 0,
  orders_rejected           integer     NOT NULL DEFAULT 0,
  orders_auto_cancelled     integer     NOT NULL DEFAULT 0,
  orders_collected          integer     NOT NULL DEFAULT 0,
  orders_cancelled          integer     NOT NULL DEFAULT 0,
  pages_printed             integer     NOT NULL DEFAULT 0,
  gross_paise               bigint      NOT NULL DEFAULT 0,
  commission_paise          bigint      NOT NULL DEFAULT 0,
  refunded_paise            bigint      NOT NULL DEFAULT 0,
  net_paise                 bigint      NOT NULL DEFAULT 0,
  -- Operational quality.
  median_accept_seconds     integer,
  median_ready_minutes      integer,
  on_time_count             integer     NOT NULL DEFAULT 0,
  late_count                integer     NOT NULL DEFAULT 0,
  rating_sum                integer     NOT NULL DEFAULT 0,
  rating_count              integer     NOT NULL DEFAULT 0,
  computed_at               timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (shop_id, stat_date),
  CONSTRAINT shop_daily_stats_counts_nonneg CHECK (
    orders_placed >= 0 AND orders_accepted >= 0 AND orders_collected >= 0 AND pages_printed >= 0
  )
);

CREATE INDEX shop_daily_stats_date_idx ON shop_daily_stats (stat_date DESC);


CREATE TABLE platform_daily_stats (
  stat_date                 date        PRIMARY KEY,
  city_id                   uuid REFERENCES cities (id) ON DELETE CASCADE,
  new_customers             integer     NOT NULL DEFAULT 0,
  new_shops                 integer     NOT NULL DEFAULT 0,
  shops_live                integer     NOT NULL DEFAULT 0,
  orders_placed             integer     NOT NULL DEFAULT 0,
  orders_collected          integer     NOT NULL DEFAULT 0,
  gmv_paise                 bigint      NOT NULL DEFAULT 0,
  revenue_paise             bigint      NOT NULL DEFAULT 0,
  refunded_paise            bigint      NOT NULL DEFAULT 0,
  disputes_opened           integer     NOT NULL DEFAULT 0,
  computed_at               timestamptz NOT NULL DEFAULT now()
);
