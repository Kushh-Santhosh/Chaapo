-- ═══════════════════════════════════════════════════════════════════════════
-- 0007 — Money: payments, refunds, the ledger, payouts and invoices
--
-- Chaapo is a marketplace, so it never holds customer money in a pooled account
-- of its own. The customer pays a payment aggregator; the aggregator holds the
-- funds; on successful collection we instruct a transfer to the shop's registered
-- bank account, minus commission (PRD §38, §40). Two consequences shape this file:
--
--   • `payments` is a *mirror* of provider state, not a source of truth. Every
--     transition arrives via a signed webhook, is recorded in
--     `payment_webhook_events` before it is acted on, and is idempotent on the
--     provider's event id. A redelivered webhook changes nothing (NFR-17).
--
--   • `ledger_entries` is double-entry and append-only. Every movement of money
--     is a balanced group of debits and credits, so "where did this ₹9.60 go" is
--     always answerable and a reconciliation break is detectable rather than
--     invisible. The balance is enforced by a deferred constraint trigger in 0010.
--
-- Funds are released to a shop's payable balance only after `orders.collected_at`
-- is set. There is no code path and no table state that pays a shop for an order
-- the customer never received.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Generic idempotency store ──────────────────────────────────────────────
-- Used by every mutating API call that a client might retry: order placement,
-- payment initiation, accept, ready, collect, refund. The first request records
-- its response; a replay with the same key returns the stored response instead of
-- performing the action again (PRD §D, NFR-17).
CREATE TABLE idempotency_keys (
  key               text        PRIMARY KEY,
  -- Namespace, so an order key and a refund key cannot collide.
  scope             text        NOT NULL,
  user_id           uuid REFERENCES users (id) ON DELETE CASCADE,
  -- Hash of the request body. A replay with the *same* key but a different body
  -- is a client bug and is rejected with 422 rather than silently answered.
  request_hash      text        NOT NULL,
  state             text        NOT NULL DEFAULT 'in_progress',
  response_status   integer,
  response_body     jsonb,
  -- Set while the first request is in flight, so two concurrent retries do not
  -- both execute.
  locked_at         timestamptz,
  locked_by         text,
  completed_at      timestamptz,
  error_code        text,
  attempts          integer     NOT NULL DEFAULT 1,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT idempotency_state_valid CHECK (state IN ('in_progress', 'completed', 'failed')),
  CONSTRAINT idempotency_completed_has_response CHECK (
    state <> 'completed' OR (response_status IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX idempotency_keys_sweep_idx ON idempotency_keys (expires_at);
CREATE INDEX idempotency_keys_user_idx ON idempotency_keys (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX idempotency_keys_stuck_idx ON idempotency_keys (locked_at) WHERE state = 'in_progress';

CREATE TRIGGER idempotency_keys_updated_at BEFORE UPDATE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Payments ───────────────────────────────────────────────────────────────
CREATE TABLE payments (
  id                        uuid PRIMARY KEY,
  order_id                  uuid        NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  customer_user_id          uuid        NOT NULL REFERENCES users (id),
  shop_id                   uuid        NOT NULL REFERENCES shops (id),

  provider                  text        NOT NULL,
  -- The provider's order/intent id, created before the customer is redirected.
  provider_order_id         text,
  -- The provider's payment id, known only after an attempt.
  provider_payment_id       text,
  -- Route/split transfer id, created when we instruct the shop's share.
  provider_transfer_id      text,
  -- The provider's account id for the shop (linked account / beneficiary).
  provider_shop_account_id  text,

  state                     payment_state NOT NULL DEFAULT 'created',
  currency                  text        NOT NULL DEFAULT 'INR',
  -- What we asked for, and what actually moved.
  amount_paise              bigint      NOT NULL,
  amount_captured_paise     bigint      NOT NULL DEFAULT 0,
  amount_refunded_paise     bigint      NOT NULL DEFAULT 0,

  -- The split we instructed the provider to hold for the shop. Held on the
  -- aggregator side until collection, then released (PRD §40.2).
  shop_transfer_paise       bigint      NOT NULL DEFAULT 0,
  platform_keep_paise       bigint      NOT NULL DEFAULT 0,
  transfer_on_hold          boolean     NOT NULL DEFAULT true,
  transfer_released_at      timestamptz,

  -- Provider charges. Recorded because they are a real cost and must appear in
  -- the ledger, not be quietly absorbed.
  provider_fee_paise        bigint      NOT NULL DEFAULT 0,
  provider_tax_paise        bigint      NOT NULL DEFAULT 0,

  method                    text,
  -- Masked descriptor for the receipt: 'UPI · rahul@okhdfc', 'Card ···4242'.
  method_display            text,
  bank                      text,
  wallet                    text,
  vpa_masked                text,

  attempts                  integer     NOT NULL DEFAULT 0,
  failure_code              text,
  -- Customer-safe sentence. Never raw provider text, which leaks internals and
  -- reads like a stack trace.
  failure_message           text,
  -- Raw provider reason, for support. Not returned on customer endpoints.
  failure_provider_reason   text,

  -- Set true only after HMAC verification of the provider's callback/webhook.
  signature_verified        boolean     NOT NULL DEFAULT false,

  idempotency_key           text,
  -- When the payment page/intent stops being valid.
  expires_at                timestamptz,
  authorized_at             timestamptz,
  captured_at               timestamptz,
  failed_at                 timestamptz,
  cancelled_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payments_provider_valid CHECK (provider IN ('mock', 'razorpay')),
  CONSTRAINT payments_currency_inr CHECK (currency = 'INR'),
  CONSTRAINT payments_method_valid CHECK (
    method IS NULL OR method IN ('upi', 'card', 'netbanking', 'wallet', 'emi', 'paylater', 'mock')
  ),
  CONSTRAINT payments_amounts_nonneg CHECK (
    amount_paise > 0 AND amount_captured_paise >= 0 AND amount_refunded_paise >= 0
    AND shop_transfer_paise >= 0 AND platform_keep_paise >= 0
    AND provider_fee_paise >= 0 AND provider_tax_paise >= 0
  ),
  CONSTRAINT payments_captured_bounded CHECK (amount_captured_paise <= amount_paise),
  CONSTRAINT payments_refunded_bounded CHECK (amount_refunded_paise <= amount_captured_paise),
  -- The split we instruct must equal what we captured. A mismatch means money
  -- with no owner.
  CONSTRAINT payments_split_reconciles CHECK (
    amount_captured_paise = 0
    OR shop_transfer_paise + platform_keep_paise = amount_captured_paise
  ),
  CONSTRAINT payments_captured_has_timestamp CHECK (
    state <> 'captured' OR (captured_at IS NOT NULL AND amount_captured_paise > 0)
  ),
  -- A captured payment came from a verified provider message. We never mark money
  -- as received on the strength of a client-side callback alone (NFR-14).
  CONSTRAINT payments_captured_is_verified CHECK (
    state NOT IN ('captured', 'refunded', 'partially_refunded') OR signature_verified = true
  ),
  CONSTRAINT payments_failure_has_message CHECK (
    state <> 'failed' OR failure_message IS NOT NULL
  ),
  CONSTRAINT payments_release_after_capture CHECK (
    transfer_released_at IS NULL OR captured_at IS NOT NULL
  )
);

CREATE UNIQUE INDEX payments_provider_order_key ON payments (provider, provider_order_id)
  WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX payments_provider_payment_key ON payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX payments_idempotency_key ON payments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- At most one live payment attempt per order. A customer retrying gets the same
-- row until it fails.
CREATE UNIQUE INDEX payments_one_live_per_order ON payments (order_id)
  WHERE state IN ('created', 'pending', 'authorized');
CREATE INDEX payments_order_idx ON payments (order_id, created_at DESC);
CREATE INDEX payments_shop_idx ON payments (shop_id, captured_at DESC) WHERE state = 'captured';
CREATE INDEX payments_customer_idx ON payments (customer_user_id, created_at DESC);
-- The reconciliation worker: captured payments whose transfer is still held even
-- though the order has been collected.
CREATE INDEX payments_release_due_idx ON payments (captured_at)
  WHERE state = 'captured' AND transfer_on_hold = true AND transfer_released_at IS NULL;
CREATE INDEX payments_stuck_idx ON payments (updated_at) WHERE state IN ('created', 'pending', 'authorized');

CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER payments_immutable_identity
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('order_id', 'provider', 'amount_paise', 'currency');

COMMENT ON TABLE payments IS
  'Mirror of aggregator state. Only signed webhooks advance it. Chaapo never holds pooled customer funds (PRD §38).';


-- ── Webhook inbox ──────────────────────────────────────────────────────────
-- Append-only. Every provider message is durably recorded *before* it is
-- interpreted, keyed on the provider's own event id. That makes redelivery free,
-- gives us a replayable record when a handler has a bug, and means a webhook
-- storm cannot lose an event (NFR-17, PRD §38.7).
CREATE TABLE payment_webhook_events (
  id                    uuid PRIMARY KEY,
  provider              text        NOT NULL,
  provider_event_id     text        NOT NULL,
  event_type            text        NOT NULL,
  -- The body as received, minus anything we refuse to store. Card numbers and
  -- VPAs are redacted by the handler before insert.
  payload               jsonb       NOT NULL,
  signature_verified    boolean     NOT NULL,
  signature_algorithm   text,

  -- Resolved links, filled in when we can identify them.
  payment_id            uuid REFERENCES payments (id) ON DELETE SET NULL,
  order_id              uuid REFERENCES orders (id) ON DELETE SET NULL,
  refund_id             uuid,       -- FK added after `refunds` exists

  received_at           timestamptz NOT NULL DEFAULT now(),
  processed_at          timestamptz,
  processing_attempts   integer     NOT NULL DEFAULT 0,
  processing_error      text,
  -- Set when the event is a duplicate of one we already applied.
  skipped_reason        text,
  -- Provider clock, for ordering out-of-order deliveries.
  provider_created_at   timestamptz,

  CONSTRAINT payment_webhook_provider_valid CHECK (provider IN ('mock', 'razorpay')),
  CONSTRAINT payment_webhook_attempts_nonneg CHECK (processing_attempts >= 0)
);

-- The idempotency guarantee: one row per provider event, forever.
CREATE UNIQUE INDEX payment_webhook_events_provider_event_key
  ON payment_webhook_events (provider, provider_event_id);
CREATE INDEX payment_webhook_events_unprocessed_idx ON payment_webhook_events (received_at)
  WHERE processed_at IS NULL AND skipped_reason IS NULL;
CREATE INDEX payment_webhook_events_payment_idx ON payment_webhook_events (payment_id, received_at)
  WHERE payment_id IS NOT NULL;
CREATE INDEX payment_webhook_events_failed_idx ON payment_webhook_events (received_at DESC)
  WHERE processing_error IS NOT NULL;
-- Unverified signatures are an attack signal and are reviewed.
CREATE INDEX payment_webhook_events_unverified_idx ON payment_webhook_events (received_at DESC)
  WHERE signature_verified = false;

-- Append-only except for the processing bookkeeping columns, which is why this
-- table gets a bespoke guard rather than `forbid_mutation()`.
CREATE OR REPLACE FUNCTION guard_webhook_event_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mutable text[] := ARRAY[
    'processed_at', 'processing_attempts', 'processing_error', 'skipped_reason',
    'payment_id', 'order_id', 'refund_id'
  ];
  col text;
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  FOR col IN SELECT jsonb_object_keys(old_row) LOOP
    IF NOT (col = ANY (mutable)) AND (old_row -> col) IS DISTINCT FROM (new_row -> col) THEN
      RAISE EXCEPTION
        'payment_webhook_events.% is immutable; only processing bookkeeping may be updated', col
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_webhook_events_guard
  BEFORE UPDATE ON payment_webhook_events
  FOR EACH ROW EXECUTE FUNCTION guard_webhook_event_update();

CREATE TRIGGER payment_webhook_events_no_delete
  BEFORE DELETE ON payment_webhook_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();


-- ── Refunds ────────────────────────────────────────────────────────────────
CREATE TABLE refunds (
  id                    uuid PRIMARY KEY,
  order_id              uuid        NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  payment_id            uuid        NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
  provider              text        NOT NULL,
  provider_refund_id    text,

  state                 refund_state NOT NULL DEFAULT 'requested',
  amount_paise          bigint      NOT NULL,
  -- Whether this covers the whole captured amount.
  is_full               boolean     NOT NULL,
  speed                 text        NOT NULL DEFAULT 'normal',

  reason_code           text        NOT NULL,
  reason_text           text,
  -- The policy that produced this amount, snapshotted for later questions.
  policy_version        text,
  policy_rate_bps       integer,

  -- Who asked and who approved. Refunds above a configured threshold need a
  -- second pair of eyes from admin_finance (PRD §39.5).
  requested_by          uuid REFERENCES users (id) ON DELETE SET NULL,
  requested_actor_type  text        NOT NULL,
  requires_approval     boolean     NOT NULL DEFAULT false,
  approved_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_at           timestamptz,
  rejected_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  rejected_at           timestamptz,
  rejection_reason      text,

  -- Whether the shop bears this refund (their fault) or the platform does.
  borne_by              text        NOT NULL DEFAULT 'platform',

  idempotency_key       text,
  processing_started_at timestamptz,
  succeeded_at          timestamptz,
  failed_at             timestamptz,
  failure_code          text,
  failure_message       text,
  -- Provider's settlement reference, for the customer's bank statement.
  provider_reference    text,
  expected_settled_by   timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT refunds_provider_valid CHECK (provider IN ('mock', 'razorpay')),
  CONSTRAINT refunds_amount_positive CHECK (amount_paise > 0),
  CONSTRAINT refunds_speed_valid CHECK (speed IN ('normal', 'instant')),
  CONSTRAINT refunds_borne_by_valid CHECK (borne_by IN ('platform', 'shop', 'shared')),
  CONSTRAINT refunds_actor_valid CHECK (
    requested_actor_type IN ('customer', 'shop', 'admin', 'system')
  ),
  CONSTRAINT refunds_reason_valid CHECK (
    reason_code IN ('order_cancelled_by_customer', 'order_cancelled_by_shop',
                    'order_rejected', 'accept_window_expired', 'hold_unresolved',
                    'print_quality', 'wrong_output', 'not_collected', 'duplicate_payment',
                    'overcharge_correction', 'dispute_resolution', 'goodwill', 'other')
  ),
  CONSTRAINT refunds_approval_complete CHECK (
    requires_approval = false OR state = 'requested' OR approved_at IS NOT NULL OR rejected_at IS NOT NULL
  ),
  CONSTRAINT refunds_rejection_has_reason CHECK (
    rejected_at IS NULL OR rejection_reason IS NOT NULL
  ),
  CONSTRAINT refunds_succeeded_has_provider_id CHECK (
    state <> 'succeeded' OR (succeeded_at IS NOT NULL AND provider_refund_id IS NOT NULL)
  ),
  CONSTRAINT refunds_failure_has_message CHECK (state <> 'failed' OR failure_message IS NOT NULL)
);

CREATE UNIQUE INDEX refunds_provider_refund_key ON refunds (provider, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
CREATE UNIQUE INDEX refunds_idempotency_key ON refunds (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX refunds_order_idx ON refunds (order_id, created_at DESC);
CREATE INDEX refunds_payment_idx ON refunds (payment_id);
CREATE INDEX refunds_approval_queue_idx ON refunds (created_at)
  WHERE state = 'requested' AND requires_approval = true;
CREATE INDEX refunds_processing_idx ON refunds (updated_at) WHERE state IN ('approved', 'processing');
CREATE INDEX refunds_failed_idx ON refunds (failed_at DESC) WHERE state = 'failed';

CREATE TRIGGER refunds_updated_at BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER refunds_immutable_identity
  BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('order_id', 'payment_id', 'amount_paise', 'provider');

ALTER TABLE payment_webhook_events
  ADD CONSTRAINT payment_webhook_events_refund_id_fkey
  FOREIGN KEY (refund_id) REFERENCES refunds (id) ON DELETE SET NULL;


-- ── The ledger ─────────────────────────────────────────────────────────────
-- Double-entry, append-only, integer paise. Every financial event writes a
-- *group* of entries whose debits equal its credits; the group is identified by
-- `entry_group_id` and the balance is checked by a deferred constraint trigger
-- (0010), so an unbalanced group fails at COMMIT rather than living forever.
--
-- Corrections are new reversing groups, never edits. That is the whole point.
CREATE TABLE ledger_entries (
  id                uuid PRIMARY KEY,
  -- All entries of one financial event share this. Debits must equal credits.
  entry_group_id    uuid        NOT NULL,
  -- What happened, for reading the ledger without reverse-engineering it.
  event_type        text        NOT NULL,
  sequence_in_group smallint    NOT NULL DEFAULT 0,

  account           ledger_account   NOT NULL,
  direction         ledger_direction NOT NULL,
  amount_paise      bigint      NOT NULL,
  currency          text        NOT NULL DEFAULT 'INR',

  -- Subject links. At least one is always present.
  order_id          uuid REFERENCES orders (id) ON DELETE RESTRICT,
  shop_id           uuid REFERENCES shops (id) ON DELETE RESTRICT,
  payment_id        uuid REFERENCES payments (id) ON DELETE RESTRICT,
  refund_id         uuid REFERENCES refunds (id) ON DELETE RESTRICT,
  payout_id         uuid,       -- FK added after `payouts` exists

  description       text        NOT NULL,
  -- When the money actually moved, which is not always when we recorded it.
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  -- The group this one reverses, if it is a correction.
  reverses_group_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ledger_amount_positive CHECK (amount_paise > 0),
  CONSTRAINT ledger_currency_inr CHECK (currency = 'INR'),
  CONSTRAINT ledger_event_type_valid CHECK (
    event_type IN ('payment_captured', 'commission_earned', 'commission_tax', 'provider_fee',
                   'funds_released', 'refund_issued', 'refund_reversed_commission',
                   'payout_initiated', 'payout_paid', 'payout_reversed',
                   'tds_withheld', 'adjustment', 'correction', 'chargeback')
  ),
  CONSTRAINT ledger_has_subject CHECK (
    order_id IS NOT NULL OR shop_id IS NOT NULL OR payout_id IS NOT NULL
  ),
  -- Shop-side accounts must name the shop, or the payable balance is unknowable.
  CONSTRAINT ledger_shop_accounts_have_shop CHECK (
    account NOT IN ('shop_payable', 'settlement_paid') OR shop_id IS NOT NULL
  )
);

CREATE INDEX ledger_entries_group_idx ON ledger_entries (entry_group_id, sequence_in_group);
CREATE INDEX ledger_entries_order_idx ON ledger_entries (order_id, occurred_at) WHERE order_id IS NOT NULL;
-- The shop's payable balance query.
CREATE INDEX ledger_entries_shop_account_idx ON ledger_entries (shop_id, account, occurred_at)
  WHERE shop_id IS NOT NULL;
CREATE INDEX ledger_entries_payout_idx ON ledger_entries (payout_id) WHERE payout_id IS NOT NULL;
CREATE INDEX ledger_entries_account_period_idx ON ledger_entries (account, occurred_at);
CREATE INDEX ledger_entries_reversal_idx ON ledger_entries (reverses_group_id)
  WHERE reverses_group_id IS NOT NULL;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMENT ON TABLE ledger_entries IS
  'Append-only double-entry ledger in integer paise. Corrections are reversing groups, never edits.';


-- ── Payouts ────────────────────────────────────────────────────────────────
CREATE TABLE payouts (
  id                        uuid PRIMARY KEY,
  shop_id                   uuid        NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  bank_account_id           uuid REFERENCES shop_bank_accounts (id) ON DELETE RESTRICT,
  -- Human reference on the shop's dashboard and in support conversations.
  reference                 text        NOT NULL,

  state                     payout_state NOT NULL DEFAULT 'accruing',
  -- The settlement window this payout covers.
  period_start              timestamptz NOT NULL,
  period_end                timestamptz NOT NULL,

  order_count               integer     NOT NULL DEFAULT 0,
  -- Sum of the orders' totals.
  gross_paise               bigint      NOT NULL DEFAULT 0,
  commission_paise          bigint      NOT NULL DEFAULT 0,
  commission_tax_paise      bigint      NOT NULL DEFAULT 0,
  -- Tax deducted at source under section 194-O, withheld and paid to the
  -- government on the shop's behalf.
  tds_paise                 bigint      NOT NULL DEFAULT 0,
  tds_rate_bps              integer     NOT NULL DEFAULT 0,
  -- Refunds and corrections carried into this window. Can be negative.
  adjustments_paise         bigint      NOT NULL DEFAULT 0,
  net_paise                 bigint      NOT NULL DEFAULT 0,

  provider                  text,
  provider_payout_id        text,
  -- Bank reference the shop can quote to their bank.
  utr                       text,

  idempotency_key           text,
  initiated_at              timestamptz,
  initiated_by              uuid REFERENCES users (id) ON DELETE SET NULL,
  paid_at                   timestamptz,
  failed_at                 timestamptz,
  failure_code              text,
  failure_message           text,
  retry_count               integer     NOT NULL DEFAULT 0,

  -- Holds. A payout can be frozen by risk rules, by a pending dispute, or by an
  -- admin, and the reason is always recorded (PRD §41.6).
  hold_reason               text,
  held_at                   timestamptz,
  held_by                   uuid REFERENCES users (id) ON DELETE SET NULL,
  released_at               timestamptz,
  released_by               uuid REFERENCES users (id) ON DELETE SET NULL,

  statement_storage_key     text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payouts_period_ordered CHECK (period_end > period_start),
  CONSTRAINT payouts_provider_valid CHECK (provider IS NULL OR provider IN ('mock', 'razorpay')),
  CONSTRAINT payouts_amounts_nonneg CHECK (
    order_count >= 0 AND gross_paise >= 0 AND commission_paise >= 0
    AND commission_tax_paise >= 0 AND tds_paise >= 0
  ),
  CONSTRAINT payouts_net_reconciles CHECK (
    net_paise = gross_paise - commission_paise - commission_tax_paise - tds_paise + adjustments_paise
  ),
  -- We never instruct a negative or zero bank transfer. A window that nets to
  -- nothing carries forward as an adjustment instead.
  CONSTRAINT payouts_positive_when_leaving_accrual CHECK (
    state = 'accruing' OR state = 'reversed' OR net_paise > 0
  ),
  -- Money only leaves to a verified destination.
  CONSTRAINT payouts_needs_account_when_paying CHECK (
    state NOT IN ('pending', 'processing', 'paid') OR bank_account_id IS NOT NULL
  ),
  CONSTRAINT payouts_paid_has_reference CHECK (
    state <> 'paid' OR (paid_at IS NOT NULL AND provider_payout_id IS NOT NULL)
  ),
  CONSTRAINT payouts_hold_has_reason CHECK (held_at IS NULL OR hold_reason IS NOT NULL),
  CONSTRAINT payouts_failure_has_message CHECK (state <> 'failed' OR failure_message IS NOT NULL),
  CONSTRAINT payouts_tds_rate_sane CHECK (tds_rate_bps BETWEEN 0 AND 2000)
);

CREATE UNIQUE INDEX payouts_reference_key ON payouts (reference);
CREATE UNIQUE INDEX payouts_provider_payout_key ON payouts (provider, provider_payout_id)
  WHERE provider_payout_id IS NOT NULL;
CREATE UNIQUE INDEX payouts_idempotency_key ON payouts (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- Exactly one accruing payout per shop: the open window everything lands in.
CREATE UNIQUE INDEX payouts_one_accruing_per_shop ON payouts (shop_id) WHERE state = 'accruing';
CREATE INDEX payouts_shop_idx ON payouts (shop_id, period_end DESC);
CREATE INDEX payouts_due_idx ON payouts (period_end) WHERE state = 'accruing';
CREATE INDEX payouts_processing_idx ON payouts (updated_at) WHERE state IN ('pending', 'processing');
CREATE INDEX payouts_held_idx ON payouts (held_at) WHERE state = 'on_hold';
CREATE INDEX payouts_failed_idx ON payouts (failed_at DESC) WHERE state = 'failed';

CREATE TRIGGER payouts_updated_at BEFORE UPDATE ON payouts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_payout_id_fkey FOREIGN KEY (payout_id) REFERENCES payouts (id) ON DELETE RESTRICT;
ALTER TABLE orders
  ADD CONSTRAINT orders_payout_id_fkey FOREIGN KEY (payout_id) REFERENCES payouts (id) ON DELETE SET NULL;


-- ── Payout line items ──────────────────────────────────────────────────────
-- One row per order in a payout, with the amounts snapshotted. An order can
-- appear in exactly one payout, enforced by a unique index, which is what makes
-- double payment impossible rather than merely unlikely (PRD §41.3).
CREATE TABLE payout_items (
  id                    uuid PRIMARY KEY,
  payout_id             uuid        NOT NULL REFERENCES payouts (id) ON DELETE CASCADE,
  order_id              uuid        NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  kind                  text        NOT NULL DEFAULT 'order',
  order_total_paise     bigint      NOT NULL,
  commission_paise      bigint      NOT NULL,
  commission_tax_paise  bigint      NOT NULL,
  refunded_paise        bigint      NOT NULL DEFAULT 0,
  net_paise             bigint      NOT NULL,
  -- For adjustment rows: what this corrects.
  adjustment_reason     text,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payout_items_kind_valid CHECK (kind IN ('order', 'adjustment', 'refund_recovery', 'correction')),
  CONSTRAINT payout_items_order_amounts CHECK (
    order_total_paise >= 0 AND commission_paise >= 0 AND commission_tax_paise >= 0 AND refunded_paise >= 0
  ),
  CONSTRAINT payout_items_net_reconciles CHECK (
    kind <> 'order'
    OR net_paise = order_total_paise - commission_paise - commission_tax_paise - refunded_paise
  ),
  CONSTRAINT payout_items_adjustment_has_reason CHECK (
    kind = 'order' OR adjustment_reason IS NOT NULL
  )
);

-- An order is settled once. This index is the guarantee.
CREATE UNIQUE INDEX payout_items_order_key ON payout_items (order_id) WHERE kind = 'order';
CREATE INDEX payout_items_payout_idx ON payout_items (payout_id);


-- ── Invoices and receipts ──────────────────────────────────────────────────
-- Two documents per completed order: the customer's receipt from the shop, and
-- our commission invoice to the shop. Numbering is sequential per series and per
-- financial year, which is a GST requirement, not a nicety (PRD §42).
CREATE TABLE invoice_series (
  id                uuid PRIMARY KEY,
  code              text        NOT NULL,
  financial_year    text        NOT NULL,     -- '2026-27'
  prefix            text        NOT NULL,
  next_number       bigint      NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invoice_series_fy_format CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT invoice_series_next_positive CHECK (next_number >= 1)
);

CREATE UNIQUE INDEX invoice_series_key ON invoice_series (code, financial_year);

CREATE TRIGGER invoice_series_updated_at BEFORE UPDATE ON invoice_series
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE invoices (
  id                    uuid PRIMARY KEY,
  kind                  text        NOT NULL,
  series_id             uuid        NOT NULL REFERENCES invoice_series (id),
  invoice_number        text        NOT NULL,
  sequence_number       bigint      NOT NULL,

  order_id              uuid REFERENCES orders (id) ON DELETE RESTRICT,
  payout_id             uuid REFERENCES payouts (id) ON DELETE RESTRICT,
  shop_id               uuid        NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  customer_user_id      uuid REFERENCES users (id) ON DELETE SET NULL,

  issued_at             timestamptz NOT NULL DEFAULT now(),
  -- Party details snapshotted: an invoice must not change when a shop edits its
  -- address next year.
  supplier_name         text        NOT NULL,
  supplier_address      text        NOT NULL,
  supplier_gstin_masked text,
  recipient_name        text        NOT NULL,
  recipient_address     text,
  recipient_gstin_masked text,
  place_of_supply       text,

  taxable_paise         bigint      NOT NULL,
  cgst_paise            bigint      NOT NULL DEFAULT 0,
  sgst_paise            bigint      NOT NULL DEFAULT 0,
  igst_paise            bigint      NOT NULL DEFAULT 0,
  total_paise           bigint      NOT NULL,
  hsn_sac               text,
  line_items            jsonb       NOT NULL,

  storage_key           text,
  storage_bucket        text,
  -- Cancellation is a credit note, not a delete.
  cancelled_at          timestamptz,
  credit_note_for_id    uuid REFERENCES invoices (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invoices_kind_valid CHECK (
    kind IN ('customer_receipt', 'commission_invoice', 'credit_note', 'payout_statement')
  ),
  CONSTRAINT invoices_amounts_nonneg CHECK (
    taxable_paise >= 0 AND cgst_paise >= 0 AND sgst_paise >= 0 AND igst_paise >= 0 AND total_paise >= 0
  ),
  CONSTRAINT invoices_total_reconciles CHECK (
    total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise
  ),
  -- Intra-state uses CGST+SGST, inter-state uses IGST. Never both.
  CONSTRAINT invoices_gst_split_coherent CHECK (
    (igst_paise = 0) OR (cgst_paise = 0 AND sgst_paise = 0)
  ),
  CONSTRAINT invoices_subject_present CHECK (order_id IS NOT NULL OR payout_id IS NOT NULL),
  CONSTRAINT invoices_credit_note_has_parent CHECK (
    kind <> 'credit_note' OR credit_note_for_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX invoices_number_key ON invoices (invoice_number);
CREATE UNIQUE INDEX invoices_series_sequence_key ON invoices (series_id, sequence_number);
CREATE UNIQUE INDEX invoices_order_kind_key ON invoices (order_id, kind)
  WHERE order_id IS NOT NULL AND kind <> 'credit_note';
CREATE INDEX invoices_shop_idx ON invoices (shop_id, issued_at DESC);
CREATE INDEX invoices_customer_idx ON invoices (customer_user_id, issued_at DESC)
  WHERE customer_user_id IS NOT NULL;
CREATE INDEX invoices_payout_idx ON invoices (payout_id) WHERE payout_id IS NOT NULL;

-- Invoices are legal documents. They are never edited; a mistake is corrected by
-- a credit note plus a fresh invoice.
CREATE OR REPLACE FUNCTION guard_invoice_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.cancelled_at IS DISTINCT FROM NEW.cancelled_at
     AND to_jsonb(OLD) - 'cancelled_at' = to_jsonb(NEW) - 'cancelled_at' THEN
    RETURN NEW;
  END IF;
  IF OLD.storage_key IS NULL AND NEW.storage_key IS NOT NULL
     AND to_jsonb(OLD) - 'storage_key' - 'storage_bucket' = to_jsonb(NEW) - 'storage_key' - 'storage_bucket' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'Invoices are immutable. Issue a credit note instead of editing invoice %', OLD.invoice_number
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER invoices_guard BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION guard_invoice_update();

CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();


-- ── Shop balances ──────────────────────────────────────────────────────────
-- Derived from the ledger, never stored. The shop dashboard's "₹4,320 awaiting
-- payout" is a query against this view, so it can never drift from the ledger it
-- claims to summarise.
CREATE VIEW shop_balances AS
SELECT
  shop_id,
  sum(CASE WHEN account = 'shop_payable'    AND direction = 'credit' THEN amount_paise ELSE 0 END)
    - sum(CASE WHEN account = 'shop_payable' AND direction = 'debit'  THEN amount_paise ELSE 0 END)
    AS payable_paise,
  sum(CASE WHEN account = 'settlement_paid' AND direction = 'debit'  THEN amount_paise ELSE 0 END)
    AS settled_paise,
  max(occurred_at) AS last_movement_at
FROM ledger_entries
WHERE shop_id IS NOT NULL
GROUP BY shop_id;

COMMENT ON VIEW shop_balances IS
  'Derived from ledger_entries. Never cached, so it cannot disagree with the ledger.';
