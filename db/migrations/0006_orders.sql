-- ═══════════════════════════════════════════════════════════════════════════
-- 0006 — Orders
--
-- The order is the contract between a customer and a shop, and this table is
-- written to defend that contract:
--
--   • The price is a snapshot. Every amount the customer agreed to is copied onto
--     the order at placement, along with the shop and catalogue details that
--     produced it, and then frozen by a trigger. Changing a price list, a
--     commission rate or a tax rate can never alter a placed order (PRD §F inv.
--     6, FR-320).
--
--   • The money adds up, enforced by CHECK constraints rather than by hope:
--     the customer's total is exactly the shop's payable plus the platform's
--     commission plus the tax on that commission plus any platform fee. A bug
--     that would silently create or destroy money fails the INSERT (PRD §38.4).
--
--   • State changes are events. `order_events` is append-only and carries a
--     per-order monotonic sequence, so it is simultaneously the audit trail, the
--     customer-facing timeline, and the durable outbox that SSE replays from
--     after a reconnect (FR-410, NFR-16).
--
--   • The pickup code is a secret. Only a keyed hash is stored for verification;
--     the displayable copy is encrypted. A database read does not let you collect
--     someone else's documents (FR-425, NFR-14).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE orders (
  id                        uuid PRIMARY KEY,
  -- Human-quotable: CHP-7K2M-9QX4. Crockford base32, no ambiguous characters.
  order_number              text        NOT NULL,
  customer_user_id          uuid        NOT NULL REFERENCES users (id),
  shop_id                   uuid        NOT NULL REFERENCES shops (id),

  state                     order_state  NOT NULL DEFAULT 'draft',
  previous_state            order_state,
  state_changed_at          timestamptz NOT NULL DEFAULT now(),
  -- Monotonic counter for order_events. Incremented under the row lock taken by
  -- the state machine, so events can never interleave or collide.
  event_sequence            bigint      NOT NULL DEFAULT 0,
  -- Optimistic-concurrency token surfaced to clients so two dashboard tabs
  -- cannot both accept the same order (FR-403).
  version                   integer     NOT NULL DEFAULT 1,

  -- ── Idempotency ──
  -- The client generates this before the first placement attempt and resends it
  -- on retry, so a flaky network cannot produce two orders (PRD §D, NFR-17).
  client_request_id         text,

  -- ── Shop snapshot ──
  -- What the customer saw when they chose this shop. Kept so the receipt and the
  -- support view are accurate even after the shop renames or moves.
  shop_name_snapshot        text        NOT NULL,
  shop_address_snapshot     text        NOT NULL,
  shop_phone_masked_snapshot text,
  shop_location_snapshot    geography(Point, 4326),
  -- Straight-line metres from the customer at the time of ordering. Used for
  -- "you're 400 m away" and for analytics, not for billing.
  distance_m_at_order       integer,

  -- ── Job shape ──
  file_count                integer     NOT NULL DEFAULT 0,
  total_pages               integer     NOT NULL DEFAULT 0,
  total_sheets              integer     NOT NULL DEFAULT 0,
  copies                    integer     NOT NULL DEFAULT 1,
  -- Denormalised summary for the shop's queue card: 'A4 · B&W · 2-sided · 3 copies'.
  job_summary               text,

  -- ── Money snapshot (frozen after placement) ──
  currency                  text        NOT NULL DEFAULT 'INR',
  items_subtotal_paise      bigint      NOT NULL DEFAULT 0,
  discount_paise            bigint      NOT NULL DEFAULT 0,
  surcharge_paise           bigint      NOT NULL DEFAULT 0,
  -- Customer-side platform fee. ₹0 in the launch fee model; the column exists so
  -- introducing one later is a config change, not a migration (PRD §38.1).
  platform_fee_paise        bigint      NOT NULL DEFAULT 0,
  -- GST the shop charges the customer on the print service. Zero for shops below
  -- the registration threshold.
  tax_paise                 bigint      NOT NULL DEFAULT 0,
  tax_rate_bps              integer     NOT NULL DEFAULT 0,
  total_paise               bigint      NOT NULL DEFAULT 0,

  -- ── The marketplace split (frozen after placement) ──
  commission_bps            integer     NOT NULL DEFAULT 0,
  commission_paise          bigint      NOT NULL DEFAULT 0,
  -- GST on our commission, which we owe regardless of the shop's registration.
  commission_tax_paise      bigint      NOT NULL DEFAULT 0,
  commission_tax_bps        integer     NOT NULL DEFAULT 0,
  shop_payable_paise        bigint      NOT NULL DEFAULT 0,

  -- The full itemised breakdown exactly as rendered to the customer, including
  -- the labels of every modifier applied. Presentation-stable: replaying it years
  -- later reproduces the screen they agreed to.
  price_snapshot            jsonb,
  -- Which pricing-engine version and platform config produced the snapshot.
  pricing_version           text,
  price_snapshot_at         timestamptz,

  -- ── Quote flow ──
  requires_quote            boolean     NOT NULL DEFAULT false,
  quote_id                  uuid,       -- FK added after `quotes` exists
  quote_reason              text,

  -- ── Payment ──
  is_paid                   boolean     NOT NULL DEFAULT false,
  paid_at                   timestamptz,
  -- Cached from `payments`, for the shop queue and admin lists. Authoritative
  -- payment state lives in `payments`.
  payment_state             payment_state,
  refunded_paise            bigint      NOT NULL DEFAULT 0,
  -- Set when funds have been released into the shop's payable balance, which
  -- happens on collection, never before (PRD §40.1).
  funds_released_at         timestamptz,
  payout_id                 uuid,       -- FK added in 0007

  -- ── Timeline ──
  placed_at                 timestamptz,
  accept_deadline_at        timestamptz,
  accepted_at               timestamptz,
  accepted_by               uuid REFERENCES users (id),
  printing_started_at       timestamptz,
  -- The promise: computed with the shop's *open* hours, so a shop is not late for
  -- time it was shut (PRD §33.4).
  ready_promised_at         timestamptz,
  ready_at                  timestamptz,
  ready_by_user_id          uuid REFERENCES users (id),
  -- After this, the order is stale and the no-show flow starts.
  pickup_deadline_at        timestamptz,
  collected_at              timestamptz,
  settled_at                timestamptz,
  cancelled_at              timestamptz,
  rejected_at               timestamptz,
  closed_at                 timestamptz,

  -- ── Pickup verification ──
  -- Keyed hash for comparison; encrypted copy so the customer can be shown the
  -- code again. Never plaintext.
  pickup_code_hash          text,
  pickup_code_encrypted     text,
  -- Opaque slug behind the QR. Carries no order id and no authority by itself:
  -- resolving it still requires an authenticated shop session for this shop.
  pickup_qr_slug            text,
  pickup_code_issued_at     timestamptz,
  pickup_code_sent_count    integer     NOT NULL DEFAULT 0,
  pickup_failed_attempts    integer     NOT NULL DEFAULT 0,
  pickup_locked_until       timestamptz,
  pickup_verified_at        timestamptz,
  pickup_verified_by        uuid REFERENCES users (id),
  pickup_method             text,

  -- ── Notes ──
  -- Customer instructions are customer content: encrypted at rest.
  customer_note_encrypted   text,
  -- Shop's internal note. Not shown to the customer.
  shop_internal_note        text,
  -- Message from the shop that IS shown to the customer (e.g. "printed on
  -- 80 gsm, we were out of 70").
  shop_message_to_customer  text,

  -- ── Support ──
  -- Raised by an admin. Blocks automatic settlement until cleared.
  admin_hold_at             timestamptz,
  admin_hold_reason         text,
  dispute_id                uuid,       -- FK added in 0009
  -- Denormalised flag so the shop queue can show a badge without a join.
  has_open_dispute          boolean     NOT NULL DEFAULT false,

  source                    text        NOT NULL DEFAULT 'pwa',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT orders_currency_inr CHECK (currency = 'INR'),
  CONSTRAINT orders_number_format CHECK (order_number ~ '^CHP-[0-9A-Z]{4}-[0-9A-Z]{4}$'),
  CONSTRAINT orders_source_valid CHECK (source IN ('pwa', 'web', 'shop_counter', 'admin', 'api')),
  CONSTRAINT orders_pickup_method_valid CHECK (
    pickup_method IS NULL OR pickup_method IN ('code', 'qr', 'admin_override', 'shop_override')
  ),

  -- Amounts are non-negative, except the ones that legitimately are not.
  CONSTRAINT orders_amounts_nonneg CHECK (
    items_subtotal_paise >= 0 AND discount_paise >= 0 AND surcharge_paise >= 0
    AND platform_fee_paise >= 0 AND tax_paise >= 0 AND total_paise >= 0
    AND commission_paise >= 0 AND commission_tax_paise >= 0 AND refunded_paise >= 0
  ),
  CONSTRAINT orders_rates_sane CHECK (
    commission_bps BETWEEN 0 AND 3000 AND tax_rate_bps BETWEEN 0 AND 5000
    AND commission_tax_bps BETWEEN 0 AND 5000
  ),
  CONSTRAINT orders_discount_not_absurd CHECK (discount_paise <= items_subtotal_paise + surcharge_paise),

  -- The customer's total is the sum of its parts. No rounding slack allowed.
  CONSTRAINT orders_total_reconciles CHECK (
    total_paise = items_subtotal_paise - discount_paise + surcharge_paise + platform_fee_paise + tax_paise
  ),
  -- And the split of that total is exhaustive: every paisa the customer paid is
  -- assigned to the shop, to commission, to tax on commission, or to a platform
  -- fee. This is the invariant that makes a pooled-money mistake impossible to
  -- represent (PRD §38.4).
  CONSTRAINT orders_split_reconciles CHECK (
    shop_payable_paise + commission_paise + commission_tax_paise + platform_fee_paise = total_paise
  ),
  CONSTRAINT orders_refund_bounded CHECK (refunded_paise <= total_paise),

  CONSTRAINT orders_counts_nonneg CHECK (
    file_count >= 0 AND total_pages >= 0 AND total_sheets >= 0 AND copies >= 1
  ),
  -- Sheets can never exceed pages: duplex halves sheets, nothing increases them.
  CONSTRAINT orders_sheets_le_pages CHECK (total_sheets <= total_pages),

  -- A placed order has a price snapshot and a number. Draft orders need neither.
  CONSTRAINT orders_placed_has_snapshot CHECK (
    placed_at IS NULL OR (price_snapshot IS NOT NULL AND price_snapshot_at IS NOT NULL)
  ),
  -- Everything from `placed` onward has been paid for or is explicitly a
  -- quote-first order that was paid at acceptance.
  CONSTRAINT orders_paid_states CHECK (
    state NOT IN ('placed', 'accepted', 'printing', 'ready', 'collected', 'settled')
    OR is_paid = true
  ),
  CONSTRAINT orders_paid_has_timestamp CHECK (is_paid = false OR paid_at IS NOT NULL),
  -- A collected order must have been verified. There is no path to `collected`
  -- that skips pickup verification (FR-425).
  CONSTRAINT orders_collected_is_verified CHECK (
    state NOT IN ('collected', 'settled') OR pickup_verified_at IS NOT NULL
  ),
  CONSTRAINT orders_collected_has_timestamp CHECK (
    state NOT IN ('collected', 'settled') OR collected_at IS NOT NULL
  ),
  -- Funds are only ever released after collection (PRD §40.1).
  CONSTRAINT orders_funds_after_collection CHECK (
    funds_released_at IS NULL OR collected_at IS NOT NULL
  ),
  CONSTRAINT orders_ready_has_pickup_code CHECK (
    ready_at IS NULL OR (pickup_code_hash IS NOT NULL AND pickup_qr_slug IS NOT NULL)
  ),
  CONSTRAINT orders_admin_hold_has_reason CHECK (
    admin_hold_at IS NULL OR admin_hold_reason IS NOT NULL
  ),
  CONSTRAINT orders_quote_has_reason CHECK (requires_quote = false OR quote_reason IS NOT NULL),
  CONSTRAINT orders_pickup_attempts_nonneg CHECK (pickup_failed_attempts >= 0)
);

CREATE UNIQUE INDEX orders_number_key ON orders (order_number);
CREATE UNIQUE INDEX orders_qr_slug_key ON orders (pickup_qr_slug) WHERE pickup_qr_slug IS NOT NULL;
-- Idempotent placement: the same client request id from the same customer can
-- only ever produce one order.
CREATE UNIQUE INDEX orders_client_request_key ON orders (customer_user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- The customer's list.
CREATE INDEX orders_customer_idx ON orders (customer_user_id, created_at DESC);
-- The customer's *live* orders, which the app polls and pins to the top.
CREATE INDEX orders_customer_live_idx ON orders (customer_user_id, state)
  WHERE state IN ('payment_pending', 'awaiting_quote', 'placed', 'accepted', 'printing', 'on_hold_file_issue', 'ready');

-- The shop dashboard's queue: the single most-run query in the product. Ordered
-- by the acceptance deadline so the most urgent card is first (NFR-03).
CREATE INDEX orders_shop_queue_idx ON orders (shop_id, state, accept_deadline_at)
  WHERE state IN ('placed', 'accepted', 'printing', 'on_hold_file_issue', 'ready');
CREATE INDEX orders_shop_history_idx ON orders (shop_id, created_at DESC);
CREATE INDEX orders_shop_ready_idx ON orders (shop_id, ready_at) WHERE state = 'ready';

-- Worker sweeps. Each is a partial index over exactly the rows the worker wants.
CREATE INDEX orders_accept_timeout_idx ON orders (accept_deadline_at) WHERE state = 'placed';
CREATE INDEX orders_sla_breach_idx ON orders (ready_promised_at)
  WHERE state IN ('accepted', 'printing');
CREATE INDEX orders_pickup_timeout_idx ON orders (pickup_deadline_at) WHERE state = 'ready';
CREATE INDEX orders_settlement_idx ON orders (collected_at)
  WHERE state = 'collected' AND funds_released_at IS NULL;
CREATE INDEX orders_abandoned_payment_idx ON orders (updated_at) WHERE state = 'payment_pending';
CREATE INDEX orders_stale_draft_idx ON orders (updated_at) WHERE state = 'draft';

CREATE INDEX orders_payout_idx ON orders (payout_id) WHERE payout_id IS NOT NULL;
CREATE INDEX orders_admin_hold_idx ON orders (admin_hold_at) WHERE admin_hold_at IS NOT NULL;
CREATE INDEX orders_dispute_idx ON orders (shop_id) WHERE has_open_dispute;

CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE orders IS
  'Price is snapshotted at placement and frozen by trigger. The split CHECK makes unassigned money unrepresentable.';
COMMENT ON COLUMN orders.pickup_qr_slug IS
  'Opaque. Carries no order identifier and grants nothing on its own; resolution requires a shop session for this shop.';


-- ── Freeze the money after placement ───────────────────────────────────────
-- A generic column-freeze trigger cannot express "immutable *once placed*", so
-- this one is purpose-built. It is the enforcement point for PRD §F invariant 6:
-- the amounts a customer agreed to cannot be edited, by anyone, ever. A
-- legitimate re-price goes through the quote flow, which creates a new snapshot
-- and requires the customer to accept it.
CREATE OR REPLACE FUNCTION forbid_price_change_after_placement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  frozen text[] := ARRAY[
    'items_subtotal_paise', 'discount_paise', 'surcharge_paise', 'platform_fee_paise',
    'tax_paise', 'tax_rate_bps', 'total_paise',
    'commission_bps', 'commission_paise', 'commission_tax_paise', 'commission_tax_bps',
    'shop_payable_paise', 'price_snapshot', 'price_snapshot_at', 'pricing_version',
    'order_number', 'customer_user_id', 'shop_id', 'placed_at', 'currency'
  ];
  col text;
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  -- Before placement the order is a mutable draft; the customer is still editing.
  IF OLD.placed_at IS NULL THEN
    RETURN NEW;
  END IF;

  FOREACH col IN ARRAY frozen LOOP
    IF (old_row -> col) IS DISTINCT FROM (new_row -> col) THEN
      RAISE EXCEPTION
        'orders.% is frozen once the order is placed (order %). Re-pricing must go through the quote flow.',
        col, OLD.order_number
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION forbid_price_change_after_placement() IS
  'PRD §F invariant 6. The agreed price is immutable; re-pricing creates a new quote, it does not edit history.';

CREATE TRIGGER orders_freeze_price_after_placement
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION forbid_price_change_after_placement();


-- ── Order line items ───────────────────────────────────────────────────────
-- Fully snapshotted: the catalogue item's code, name and unit are copied in, so
-- an admin renaming "A4 B&W" or a shop deleting the item cannot change what an
-- old receipt says. `service_item_id` is kept for analytics but is nullable and
-- ON DELETE SET NULL — the snapshot is what matters.
CREATE TABLE order_items (
  id                    uuid PRIMARY KEY,
  order_id              uuid        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  -- Finishing lines point at the print line they apply to, so the breakdown can
  -- be rendered as a nested list and a removed print line takes its binding with
  -- it.
  applies_to_item_id    uuid REFERENCES order_items (id) ON DELETE CASCADE,
  file_id               uuid REFERENCES files (id) ON DELETE SET NULL,
  service_item_id       uuid REFERENCES service_items (id) ON DELETE SET NULL,
  sort_order            integer     NOT NULL DEFAULT 0,

  -- ── Catalogue snapshot ──
  item_code             text        NOT NULL,
  item_name             text        NOT NULL,
  item_kind             text        NOT NULL,
  price_unit            text        NOT NULL,
  paper_size_code       text,
  colour_mode           text,
  sides                 text,

  -- ── Job configuration ──
  copies                integer     NOT NULL DEFAULT 1,
  -- The page selection the customer made, as typed ('1-4, 9, 20-'), and what it
  -- resolved to against the file's actual page count.
  page_range            text,
  pages_selected        integer     NOT NULL DEFAULT 0,
  colour_pages_selected integer,
  sheets                integer     NOT NULL DEFAULT 0,

  -- ── Billable quantity and price snapshot ──
  -- `quantity` is expressed in `price_unit` terms: pages, sheets, copies or 1.
  quantity              integer     NOT NULL,
  unit_price_paise      bigint      NOT NULL,
  band_label            text,
  band_min_quantity     integer,
  band_max_quantity     integer,
  setup_fee_paise       bigint      NOT NULL DEFAULT 0,
  -- Top-up applied to reach the shop's minimum charge for this item, itemised so
  -- the customer sees why a 2-page job cost ₹5 (FR-315).
  min_charge_topup_paise bigint     NOT NULL DEFAULT 0,
  discount_paise         bigint     NOT NULL DEFAULT 0,
  line_total_paise       bigint     NOT NULL,

  -- Free-text the customer attached to this line ("print pages 3-8 in colour").
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_items_kind_valid CHECK (item_kind IN ('print', 'finishing', 'scan', 'handling')),
  CONSTRAINT order_items_price_unit_valid CHECK (
    price_unit IN ('per_page', 'per_sheet', 'per_copy', 'per_order', 'per_sqft')
  ),
  CONSTRAINT order_items_counts_nonneg CHECK (
    copies >= 1 AND pages_selected >= 0 AND sheets >= 0 AND quantity >= 0
    AND (colour_pages_selected IS NULL OR colour_pages_selected >= 0)
  ),
  CONSTRAINT order_items_amounts_nonneg CHECK (
    unit_price_paise >= 0 AND setup_fee_paise >= 0
    AND min_charge_topup_paise >= 0 AND discount_paise >= 0 AND line_total_paise >= 0
  ),
  CONSTRAINT order_items_colour_pages_bounded CHECK (
    colour_pages_selected IS NULL OR colour_pages_selected <= pages_selected
  ),
  -- The line total is a pure function of its snapshot. If this fails, the pricing
  -- engine has a bug and the order must not exist.
  CONSTRAINT order_items_line_total_reconciles CHECK (
    line_total_paise
      = quantity::bigint * unit_price_paise
      + setup_fee_paise
      + min_charge_topup_paise
      - discount_paise
  ),
  -- A print line is attached to a file; a handling line is not. A finishing line
  -- must apply to something.
  CONSTRAINT order_items_print_has_file CHECK (item_kind <> 'print' OR file_id IS NOT NULL),
  CONSTRAINT order_items_finishing_has_parent CHECK (
    item_kind <> 'finishing' OR applies_to_item_id IS NOT NULL
  ),
  CONSTRAINT order_items_no_self_reference CHECK (applies_to_item_id IS DISTINCT FROM id)
);

CREATE INDEX order_items_order_idx ON order_items (order_id, sort_order);
CREATE INDEX order_items_file_idx ON order_items (file_id) WHERE file_id IS NOT NULL;
CREATE INDEX order_items_parent_idx ON order_items (applies_to_item_id) WHERE applies_to_item_id IS NOT NULL;
CREATE INDEX order_items_analytics_idx ON order_items (service_item_id, created_at)
  WHERE service_item_id IS NOT NULL;

CREATE TRIGGER order_items_updated_at BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Order events: audit trail, customer timeline and SSE outbox ────────────
-- Append-only, with a per-order monotonic sequence. Three jobs, one table, on
-- purpose: if the timeline the customer sees and the audit trail an investigator
-- reads could diverge, one of them would be wrong.
--
-- The sequence is what makes reconnection correct: an SSE client sends
-- Last-Event-ID and gets exactly the events it missed, in order, once (FR-410).
CREATE TABLE order_events (
  id                uuid PRIMARY KEY,
  order_id          uuid        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  sequence          bigint      NOT NULL,
  event             text        NOT NULL,
  from_state        order_state,
  to_state          order_state,

  -- Who caused it. `actor_type` distinguishes a shop clicking Accept from a
  -- worker auto-cancelling and from a payment webhook arriving.
  actor_type        text        NOT NULL,
  actor_user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_role        user_role,
  actor_shop_id     uuid REFERENCES shops (id) ON DELETE SET NULL,

  -- Machine-readable cause, e.g. 'accept_window_expired', 'file_unreadable'.
  reason_code       text,
  -- Human sentence. Shown to the customer when `is_customer_visible`.
  message           text,
  -- Structured detail. Redacted on the way in — never file names, never codes.
  metadata          jsonb       NOT NULL DEFAULT '{}',

  is_customer_visible boolean   NOT NULL DEFAULT false,
  is_shop_visible     boolean   NOT NULL DEFAULT false,

  -- Set for events driven by an external message (payment webhook, provider
  -- callback) so a redelivery cannot append a duplicate event.
  idempotency_key   text,
  correlation_id    text,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_events_sequence_positive CHECK (sequence >= 1),
  CONSTRAINT order_events_actor_type_valid CHECK (
    actor_type IN ('customer', 'shop', 'admin', 'system', 'provider')
  ),
  -- A human actor is identified; a system actor is not.
  CONSTRAINT order_events_human_is_identified CHECK (
    actor_type NOT IN ('customer', 'shop', 'admin') OR actor_user_id IS NOT NULL
  ),
  -- A state change records both ends of it.
  CONSTRAINT order_events_transition_complete CHECK (
    (from_state IS NULL AND to_state IS NULL) OR to_state IS NOT NULL
  )
);

CREATE UNIQUE INDEX order_events_sequence_key ON order_events (order_id, sequence);
CREATE UNIQUE INDEX order_events_idempotency_key ON order_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- The SSE replay query and the timeline query are the same shape.
CREATE INDEX order_events_replay_idx ON order_events (order_id, sequence);
CREATE INDEX order_events_customer_timeline_idx ON order_events (order_id, sequence)
  WHERE is_customer_visible;
CREATE INDEX order_events_recent_idx ON order_events (created_at DESC);
CREATE INDEX order_events_actor_idx ON order_events (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE TRIGGER order_events_append_only
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMENT ON TABLE order_events IS
  'Append-only. Audit trail, customer timeline and durable SSE outbox. Sequence enables exactly-once replay.';


-- ── Quotes ─────────────────────────────────────────────────────────────────
-- For jobs that cannot be auto-priced: an unusual format, a DOCX whose page count
-- we will not guess at, a 400-page binding job. The shop proposes a price, the
-- customer accepts, and only then does the order become payable (FR-306, FR-330).
CREATE TABLE quotes (
  id                    uuid PRIMARY KEY,
  order_id              uuid        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  shop_id               uuid        NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  -- Sequential within the order: a shop may revise a quote after a conversation.
  revision              integer     NOT NULL DEFAULT 1,
  state                 text        NOT NULL DEFAULT 'draft',

  -- The proposed lines, in the same shape as `order_items`. Applied verbatim onto
  -- the order when accepted, so what the customer accepted is what they pay.
  proposed_items        jsonb       NOT NULL,
  items_subtotal_paise  bigint      NOT NULL,
  discount_paise        bigint      NOT NULL DEFAULT 0,
  surcharge_paise       bigint      NOT NULL DEFAULT 0,
  tax_paise             bigint      NOT NULL DEFAULT 0,
  tax_rate_bps          integer     NOT NULL DEFAULT 0,
  total_paise           bigint      NOT NULL,
  -- Turnaround the shop is committing to if this quote is accepted.
  turnaround_minutes    integer,

  -- What the shop says about it, and what the customer said when asking.
  shop_message          text,
  customer_request_note text,

  prepared_by           uuid REFERENCES users (id),
  sent_at               timestamptz,
  -- Quotes expire: a price for a 300-page job is not good for a week.
  expires_at            timestamptz,
  responded_at          timestamptz,
  accepted_at           timestamptz,
  rejected_at           timestamptz,
  rejection_reason      text,
  withdrawn_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quotes_state_valid CHECK (
    state IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'withdrawn', 'superseded')
  ),
  CONSTRAINT quotes_revision_positive CHECK (revision >= 1),
  CONSTRAINT quotes_amounts_nonneg CHECK (
    items_subtotal_paise >= 0 AND discount_paise >= 0 AND surcharge_paise >= 0
    AND tax_paise >= 0 AND total_paise > 0
  ),
  CONSTRAINT quotes_total_reconciles CHECK (
    total_paise = items_subtotal_paise - discount_paise + surcharge_paise + tax_paise
  ),
  CONSTRAINT quotes_sent_has_expiry CHECK (sent_at IS NULL OR expires_at IS NOT NULL),
  CONSTRAINT quotes_accepted_is_sent CHECK (accepted_at IS NULL OR sent_at IS NOT NULL),
  CONSTRAINT quotes_turnaround_sane CHECK (
    turnaround_minutes IS NULL OR turnaround_minutes BETWEEN 5 AND 20160
  )
);

CREATE UNIQUE INDEX quotes_order_revision_key ON quotes (order_id, revision);
-- At most one live quote per order.
CREATE UNIQUE INDEX quotes_one_live_per_order ON quotes (order_id) WHERE state IN ('draft', 'sent');
CREATE INDEX quotes_shop_queue_idx ON quotes (shop_id, created_at DESC) WHERE state IN ('draft', 'sent');
CREATE INDEX quotes_expiry_sweep_idx ON quotes (expires_at) WHERE state = 'sent';

CREATE TRIGGER quotes_updated_at BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE orders
  ADD CONSTRAINT orders_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES quotes (id) ON DELETE SET NULL;


-- ── Pickup verification attempts ───────────────────────────────────────────
-- Append-only. Every attempt to collect an order, successful or not, with the
-- method used. A brute-force attempt against a 6-character code is visible here,
-- and `orders.pickup_failed_attempts` locks it out (FR-427, NFR-14).
CREATE TABLE pickup_verifications (
  id                  uuid PRIMARY KEY,
  order_id            uuid        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  shop_id             uuid        NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  method              text        NOT NULL,
  outcome             text        NOT NULL,
  -- Hash of what was presented, so a repeated wrong code is recognisable without
  -- storing guesses in the clear.
  presented_hash      text,
  failure_reason      text,
  -- Set when a shop or admin collected without a code. Requires a reason and is
  -- surfaced in the trust queue.
  override_reason     text,
  verified_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_role          user_role,
  ip_hash             text,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pickup_verifications_method_valid CHECK (
    method IN ('code', 'qr', 'shop_override', 'admin_override')
  ),
  CONSTRAINT pickup_verifications_outcome_valid CHECK (
    outcome IN ('success', 'wrong_code', 'expired', 'locked', 'wrong_state', 'wrong_shop', 'override')
  ),
  CONSTRAINT pickup_verifications_override_has_reason CHECK (
    method NOT IN ('shop_override', 'admin_override') OR override_reason IS NOT NULL
  )
);

CREATE INDEX pickup_verifications_order_idx ON pickup_verifications (order_id, created_at DESC);
CREATE INDEX pickup_verifications_shop_idx ON pickup_verifications (shop_id, created_at DESC);
CREATE INDEX pickup_verifications_failures_idx ON pickup_verifications (created_at DESC)
  WHERE outcome <> 'success';
CREATE INDEX pickup_verifications_overrides_idx ON pickup_verifications (created_at DESC)
  WHERE method IN ('shop_override', 'admin_override');

CREATE TRIGGER pickup_verifications_append_only
  BEFORE UPDATE OR DELETE ON pickup_verifications
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();


-- ── Holds (file problems found at the shop) ────────────────────────────────
-- The shop opens the file and it is a scan of a scan, or the page count is wrong,
-- or it is a 900-page book they cannot bind. The order pauses instead of failing:
-- the customer is asked for a replacement file and the SLA clock stops (FR-418).
CREATE TABLE order_holds (
  id                    uuid PRIMARY KEY,
  order_id              uuid        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  file_id               uuid REFERENCES files (id) ON DELETE SET NULL,
  reason_code           text        NOT NULL,
  -- What the customer is told. Shop-authored, but from a template so it is not
  -- "file bad".
  message_to_customer   text        NOT NULL,
  raised_by             uuid REFERENCES users (id),
  raised_at             timestamptz NOT NULL DEFAULT now(),
  -- The state the order was in when the hold was raised, so it can be restored.
  state_before          order_state NOT NULL,
  -- SLA credit: minutes the clock was stopped, added back to the promise.
  paused_minutes        integer,
  resolution            text,
  replacement_file_id   uuid REFERENCES files (id) ON DELETE SET NULL,
  resolved_at           timestamptz,
  resolved_by           uuid REFERENCES users (id),
  -- Holds expire; an unanswered hold cancels the order with a full refund.
  expires_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_holds_reason_valid CHECK (
    reason_code IN ('unreadable_file', 'wrong_page_count', 'password_protected',
                    'unsupported_format', 'too_large_for_shop', 'colour_mismatch',
                    'paper_unavailable', 'finishing_impossible', 'customer_clarification', 'other')
  ),
  CONSTRAINT order_holds_resolution_valid CHECK (
    resolution IS NULL OR resolution IN ('file_replaced', 'customer_confirmed', 'reconfigured',
                                         'cancelled_refund', 'shop_proceeded', 'expired')
  ),
  CONSTRAINT order_holds_resolved_complete CHECK (
    (resolved_at IS NULL) = (resolution IS NULL)
  )
);

-- At most one open hold per order: two simultaneous holds have no coherent
-- resolution order.
CREATE UNIQUE INDEX order_holds_one_open_per_order ON order_holds (order_id) WHERE resolved_at IS NULL;
CREATE INDEX order_holds_order_idx ON order_holds (order_id, created_at DESC);
CREATE INDEX order_holds_expiry_sweep_idx ON order_holds (expires_at) WHERE resolved_at IS NULL;

CREATE TRIGGER order_holds_updated_at BEFORE UPDATE ON order_holds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Cancellations ──────────────────────────────────────────────────────────
-- One row per cancellation, recording the refund policy that was applied and the
-- version of that policy. When a customer asks in six months why they got 100 %
-- back and their friend got nothing, the answer is here (PRD §39.3).
CREATE TABLE order_cancellations (
  id                    uuid PRIMARY KEY,
  order_id              uuid        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  cancelled_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_type            text        NOT NULL,
  state_at_cancellation order_state NOT NULL,
  reason_code           text        NOT NULL,
  reason_text           text,
  -- Policy outcome, snapshotted.
  refund_rate_bps       integer     NOT NULL,
  refund_paise          bigint      NOT NULL,
  policy_version        text        NOT NULL,
  policy_explanation    text        NOT NULL,
  -- Whether this cancellation counts against the shop's acceptance rate.
  counts_against_shop   boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_cancellations_actor_valid CHECK (
    actor_type IN ('customer', 'shop', 'admin', 'system')
  ),
  CONSTRAINT order_cancellations_reason_valid CHECK (
    reason_code IN ('customer_changed_mind', 'customer_wrong_file', 'customer_found_elsewhere',
                    'shop_too_busy', 'shop_cannot_print', 'shop_closed', 'shop_equipment_down',
                    'accept_window_expired', 'payment_failed', 'hold_unresolved',
                    'pickup_window_expired', 'admin_intervention', 'fraud_suspected', 'other')
  ),
  CONSTRAINT order_cancellations_refund_sane CHECK (
    refund_rate_bps BETWEEN 0 AND 10000 AND refund_paise >= 0
  )
);

CREATE UNIQUE INDEX order_cancellations_order_key ON order_cancellations (order_id);
CREATE INDEX order_cancellations_reason_idx ON order_cancellations (reason_code, created_at DESC);

CREATE TRIGGER order_cancellations_append_only
  BEFORE UPDATE OR DELETE ON order_cancellations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();


-- ── Ratings ────────────────────────────────────────────────────────────────
-- Only a collected order can be rated, so a rating is always attached to a real
-- transaction. That single rule removes most review spam without a moderation
-- team (FR-701).
CREATE TABLE order_ratings (
  id                uuid PRIMARY KEY,
  order_id          uuid        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  shop_id           uuid        NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stars             smallint    NOT NULL,
  -- Structured feedback, so the shop dashboard can show "3 people mentioned
  -- print quality" without running sentiment analysis on free text.
  tags              text[]      NOT NULL DEFAULT '{}',
  comment           text,
  -- Whether the comment is shown on the shop's public profile.
  is_public         boolean     NOT NULL DEFAULT true,
  moderation_state  text        NOT NULL DEFAULT 'published',
  moderated_by      uuid REFERENCES users (id),
  moderated_at      timestamptz,
  moderation_reason text,
  -- The shop's one reply.
  shop_reply        text,
  shop_replied_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_ratings_stars_range CHECK (stars BETWEEN 1 AND 5),
  CONSTRAINT order_ratings_moderation_valid CHECK (
    moderation_state IN ('published', 'pending_review', 'hidden', 'removed')
  ),
  CONSTRAINT order_ratings_moderation_complete CHECK (
    moderation_state = 'published' OR (moderated_at IS NOT NULL AND moderation_reason IS NOT NULL)
  ),
  CONSTRAINT order_ratings_comment_length CHECK (comment IS NULL OR length(comment) <= 2000)
);

CREATE UNIQUE INDEX order_ratings_order_key ON order_ratings (order_id);
CREATE INDEX order_ratings_shop_idx ON order_ratings (shop_id, created_at DESC)
  WHERE moderation_state = 'published';
CREATE INDEX order_ratings_user_idx ON order_ratings (user_id, created_at DESC);
CREATE INDEX order_ratings_moderation_queue_idx ON order_ratings (created_at)
  WHERE moderation_state = 'pending_review';

CREATE TRIGGER order_ratings_updated_at BEFORE UPDATE ON order_ratings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- Deferred FKs now that `orders` exists.
ALTER TABLE files
  ADD CONSTRAINT files_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL;
ALTER TABLE file_upload_sessions
  ADD CONSTRAINT file_upload_sessions_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE;
