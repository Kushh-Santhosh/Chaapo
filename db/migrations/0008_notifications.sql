-- ═══════════════════════════════════════════════════════════════════════════
-- 0008 — Notifications
--
-- A print job is a five-minute errand, so a late notification is a broken
-- product. The design is a template registry plus a per-recipient message row
-- plus a per-channel delivery attempt row:
--
--   notification_templates → notifications → notification_deliveries
--
-- Splitting deliveries out is what makes fan-out and fallback honest: "order
-- ready" may go to push *and* WhatsApp, and if push fails we know it failed on
-- push specifically, retried twice, and that SMS covered it. One row per attempt
-- per channel, with the provider's message id, is also what lets support answer
-- "did they get told?" (FR-601…FR-618).
--
-- Content is rendered from templates, never assembled ad hoc at the call site, so
-- every message is reviewable, translatable, and cannot accidentally interpolate
-- a file name into an SMS (PRD §46, §57.3).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Templates ──────────────────────────────────────────────────────────────
-- One row per (key, channel, locale). The registry is data so copy can be fixed
-- without a deploy, and versioned so we know which wording a customer received.
CREATE TABLE notification_templates (
  id                    uuid PRIMARY KEY,
  -- Stable event key: 'order.ready', 'order.accepted', 'payout.paid'.
  key                   citext      NOT NULL,
  channel               notification_channel NOT NULL,
  locale                text        NOT NULL DEFAULT 'en-IN',
  version               integer     NOT NULL DEFAULT 1,

  -- Which surface's audience this is for; the same event reads differently to a
  -- customer and to a shop.
  audience              text        NOT NULL,

  -- Channel-specific fields. Only the relevant ones are filled.
  subject               text,                   -- email
  title                 text,                   -- push, in-app
  body                  text        NOT NULL,
  -- Deep link path, e.g. '/orders/{{orderNumber}}'.
  action_path           text,
  action_label          text,
  -- WhatsApp requires pre-approved templates registered with the provider; this
  -- is the provider's name for it.
  provider_template_name text,
  provider_template_lang text,

  -- Declared variables, used to validate at render time so a missing value is a
  -- caught error rather than a message reading "Your order  is ready".
  variables             text[]      NOT NULL DEFAULT '{}',

  -- Whether this message is transactional. Transactional messages ignore quiet
  -- hours and marketing opt-out; anything else respects both (PRD §46.4).
  is_transactional      boolean     NOT NULL DEFAULT true,
  -- Suppression window: don't send the same key to the same recipient twice
  -- within this many seconds.
  dedupe_window_seconds integer     NOT NULL DEFAULT 0,
  priority              text        NOT NULL DEFAULT 'normal',
  is_active             boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_templates_audience_valid CHECK (audience IN ('customer', 'shop', 'admin')),
  CONSTRAINT notification_templates_priority_valid CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  CONSTRAINT notification_templates_locale_supported CHECK (
    locale IN ('en-IN', 'hi-IN', 'mr-IN', 'ta-IN', 'te-IN', 'kn-IN', 'bn-IN')
  ),
  CONSTRAINT notification_templates_dedupe_nonneg CHECK (dedupe_window_seconds >= 0),
  -- Email needs a subject; push and in-app need a title.
  CONSTRAINT notification_templates_email_has_subject CHECK (
    channel <> 'email' OR subject IS NOT NULL
  ),
  CONSTRAINT notification_templates_push_has_title CHECK (
    channel NOT IN ('push', 'in_app') OR title IS NOT NULL
  ),
  CONSTRAINT notification_templates_whatsapp_registered CHECK (
    channel <> 'whatsapp' OR provider_template_name IS NOT NULL
  )
);

CREATE UNIQUE INDEX notification_templates_key ON notification_templates (key, channel, locale, audience)
  WHERE is_active;
CREATE INDEX notification_templates_lookup_idx ON notification_templates (key, audience) WHERE is_active;

CREATE TRIGGER notification_templates_updated_at BEFORE UPDATE ON notification_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Notifications ──────────────────────────────────────────────────────────
-- One row per (event, recipient). This is also the in-app inbox, which is why
-- `read_at` lives here and not on a delivery.
CREATE TABLE notifications (
  id                    uuid PRIMARY KEY,
  template_key          citext      NOT NULL,
  template_version      integer,
  audience              text        NOT NULL,
  recipient_user_id     uuid REFERENCES users (id) ON DELETE CASCADE,
  -- For shop-audience messages, which shop this concerns; the message may fan out
  -- to several staff.
  shop_id               uuid REFERENCES shops (id) ON DELETE CASCADE,

  -- Subject links, for the deep link and for support.
  order_id              uuid REFERENCES orders (id) ON DELETE SET NULL,
  payout_id             uuid REFERENCES payouts (id) ON DELETE SET NULL,
  dispute_id            uuid,       -- FK added in 0009

  -- Rendered content, stored so the inbox does not re-render (and so we know
  -- exactly what was sent). Redacted: no file names, no pickup codes (§57.3).
  title                 text,
  body                  text        NOT NULL,
  action_path           text,
  action_label          text,
  -- The variables used, for debugging a bad render. PII-redacted on write.
  render_context        jsonb       NOT NULL DEFAULT '{}',

  state                 notification_state NOT NULL DEFAULT 'queued',
  priority              text        NOT NULL DEFAULT 'normal',
  is_transactional      boolean     NOT NULL DEFAULT true,

  -- Channels we intend to use, resolved against the recipient's preferences at
  -- queue time.
  channels              notification_channel[] NOT NULL DEFAULT '{}',
  -- Set when we decided not to send at all, with the reason: consent withdrawn,
  -- quiet hours, deduplicated, no channel available.
  suppressed_at         timestamptz,
  suppression_reason    text,

  -- Deduplication key, e.g. 'order:<id>:ready'. Unique while live.
  dedupe_key            text,
  -- Scheduled sends (a digest, a pickup reminder at T+24 h).
  scheduled_for         timestamptz,

  read_at               timestamptz,
  dismissed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notifications_audience_valid CHECK (audience IN ('customer', 'shop', 'admin')),
  CONSTRAINT notifications_priority_valid CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  CONSTRAINT notifications_has_recipient CHECK (
    recipient_user_id IS NOT NULL OR shop_id IS NOT NULL
  ),
  CONSTRAINT notifications_suppression_complete CHECK (
    (suppressed_at IS NULL) = (suppression_reason IS NULL)
  ),
  CONSTRAINT notifications_suppressed_state CHECK (
    (state = 'suppressed') = (suppressed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX notifications_dedupe_key ON notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL;
-- The in-app inbox query.
CREATE INDEX notifications_inbox_idx ON notifications (recipient_user_id, created_at DESC)
  WHERE recipient_user_id IS NOT NULL AND dismissed_at IS NULL;
CREATE INDEX notifications_unread_idx ON notifications (recipient_user_id)
  WHERE recipient_user_id IS NOT NULL AND read_at IS NULL AND dismissed_at IS NULL;
CREATE INDEX notifications_shop_idx ON notifications (shop_id, created_at DESC) WHERE shop_id IS NOT NULL;
CREATE INDEX notifications_order_idx ON notifications (order_id) WHERE order_id IS NOT NULL;
-- The dispatch worker's queues.
CREATE INDEX notifications_dispatch_idx ON notifications (created_at) WHERE state = 'queued';
CREATE INDEX notifications_scheduled_idx ON notifications (scheduled_for)
  WHERE state = 'queued' AND scheduled_for IS NOT NULL;

CREATE TRIGGER notifications_updated_at BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN notifications.body IS
  'Rendered and redacted. Pickup codes and file names are never placed in an outbound message body.';


-- ── Delivery attempts ──────────────────────────────────────────────────────
-- One row per channel per attempt. Retries append rows rather than overwriting,
-- so a flapping provider is visible instead of averaged away.
CREATE TABLE notification_deliveries (
  id                    uuid PRIMARY KEY,
  notification_id       uuid        NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  channel               notification_channel NOT NULL,
  attempt               integer     NOT NULL DEFAULT 1,
  state                 notification_state NOT NULL DEFAULT 'queued',

  provider              text,
  provider_message_id   text,
  -- What the destination was, in a form we can support without storing PII: the
  -- masked phone or the push endpoint hash.
  destination_masked    text,
  push_subscription_id  uuid REFERENCES push_subscriptions (id) ON DELETE SET NULL,

  -- Cost, where the provider reports it. WhatsApp and SMS are not free and this
  -- is how the notification bill is attributed (PRD §46.7).
  cost_paise            bigint,

  queued_at             timestamptz NOT NULL DEFAULT now(),
  sent_at               timestamptz,
  delivered_at          timestamptz,
  failed_at             timestamptz,
  failure_code          text,
  failure_message       text,
  -- Whether this failure is worth retrying. A 410 from a push service is not.
  is_permanent_failure  boolean     NOT NULL DEFAULT false,
  next_retry_at         timestamptz,
  -- Provider callbacks (delivered / read receipts) land here.
  provider_status       text,
  provider_updated_at   timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_deliveries_attempt_positive CHECK (attempt >= 1),
  CONSTRAINT notification_deliveries_cost_nonneg CHECK (cost_paise IS NULL OR cost_paise >= 0),
  CONSTRAINT notification_deliveries_failure_has_code CHECK (
    failed_at IS NULL OR failure_code IS NOT NULL
  ),
  CONSTRAINT notification_deliveries_sent_before_delivered CHECK (
    delivered_at IS NULL OR sent_at IS NOT NULL
  )
);

CREATE UNIQUE INDEX notification_deliveries_attempt_key
  ON notification_deliveries (notification_id, channel, attempt);
CREATE UNIQUE INDEX notification_deliveries_provider_message_key
  ON notification_deliveries (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX notification_deliveries_notification_idx ON notification_deliveries (notification_id);
CREATE INDEX notification_deliveries_retry_idx ON notification_deliveries (next_retry_at)
  WHERE next_retry_at IS NOT NULL AND is_permanent_failure = false;
CREATE INDEX notification_deliveries_failures_idx ON notification_deliveries (failed_at DESC)
  WHERE failed_at IS NOT NULL;
CREATE INDEX notification_deliveries_cost_idx ON notification_deliveries (channel, sent_at)
  WHERE cost_paise IS NOT NULL;

CREATE TRIGGER notification_deliveries_updated_at BEFORE UPDATE ON notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Outbound provider log ──────────────────────────────────────────────────
-- Append-only record of every request we made to a notification provider and the
-- status we got back. Separate from deliveries because one delivery can involve
-- several provider calls (send, then a status poll), and because this is the table
-- we read when a provider claims we never called them.
CREATE TABLE notification_provider_calls (
  id                    uuid PRIMARY KEY,
  delivery_id           uuid REFERENCES notification_deliveries (id) ON DELETE SET NULL,
  provider              text        NOT NULL,
  channel               notification_channel NOT NULL,
  operation             text        NOT NULL,
  http_status           integer,
  duration_ms           integer,
  -- Request and response with all recipient identifiers and content redacted.
  -- Kept for debugging shapes, not for reading messages.
  request_digest        jsonb,
  response_digest       jsonb,
  error_code            text,
  correlation_id        text,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_provider_calls_operation_valid CHECK (
    operation IN ('send', 'status', 'template_sync', 'subscribe', 'unsubscribe')
  )
);

CREATE INDEX notification_provider_calls_delivery_idx ON notification_provider_calls (delivery_id)
  WHERE delivery_id IS NOT NULL;
CREATE INDEX notification_provider_calls_recent_idx ON notification_provider_calls (created_at DESC);
CREATE INDEX notification_provider_calls_errors_idx ON notification_provider_calls (provider, created_at DESC)
  WHERE error_code IS NOT NULL;

CREATE TRIGGER notification_provider_calls_append_only
  BEFORE UPDATE OR DELETE ON notification_provider_calls
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
