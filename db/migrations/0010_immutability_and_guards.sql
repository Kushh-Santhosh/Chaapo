-- ═══════════════════════════════════════════════════════════════════════════
-- 0010 — Invariants that need more than a CHECK
--
-- The previous migrations pushed as much correctness as possible into column
-- types, CHECK constraints and partial unique indexes, because those cannot be
-- forgotten by a caller. What is left here is the set of rules that are genuinely
-- multi-row or cross-table, and therefore need triggers:
--
--   1. A ledger group balances. Debits equal credits, checked at COMMIT, so an
--      unbalanced financial event cannot be persisted even briefly.
--   2. The order state machine is data, and it is enforced. `order_state_transitions`
--      is the single definition of what may follow what; the domain layer reads it
--      to authorise actors, and a trigger enforces reachability so no SQL path —
--      including a hand-written admin fix — can teleport an order into `collected`.
--   3. Placement preconditions. An order becomes `placed` only if every file it
--      references is scanned, processed and owned by the customer, and only if the
--      shop is genuinely discoverable.
--   4. A file belongs to exactly one customer and one shop, consistently with the
--      order it is attached to.
--   5. Refunds cannot exceed what was captured.
--   6. A closed payout's totals equal the sum of its line items.
--   7. A shop cannot be verified without KYC and a verified bank account, and
--      cannot go live without hours, capabilities and priced services.
--
-- Every one of these is a rule the PRD states in prose. Encoding them once, in the
-- database, is what makes them true rather than intended.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The ledger balances ─────────────────────────────────────────────────
-- A deferred constraint trigger, so the entries of one group may be inserted
-- across several statements inside a transaction and are only required to balance
-- when that transaction commits.
CREATE OR REPLACE FUNCTION assert_ledger_group_balances()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  debits  bigint;
  credits bigint;
  n       bigint;
BEGIN
  SELECT
    count(*),
    coalesce(sum(amount_paise) FILTER (WHERE direction = 'debit'), 0),
    coalesce(sum(amount_paise) FILTER (WHERE direction = 'credit'), 0)
  INTO n, debits, credits
  FROM ledger_entries
  WHERE entry_group_id = NEW.entry_group_id;

  IF n < 2 THEN
    RAISE EXCEPTION
      'Ledger group % has only % entry; a financial event needs at least one debit and one credit',
      NEW.entry_group_id, n
      USING ERRCODE = 'check_violation';
  END IF;

  IF debits <> credits THEN
    RAISE EXCEPTION
      'Ledger group % does not balance: % paise debited, % paise credited',
      NEW.entry_group_id, debits, credits
      USING ERRCODE = 'check_violation',
            HINT = 'Every movement of money is a balanced group. Corrections are reversing groups, never edits.';
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION assert_ledger_group_balances() IS
  'Deferred to COMMIT so a group may be built up across statements, but never persisted unbalanced.';

CREATE CONSTRAINT TRIGGER ledger_entries_group_balances
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_group_balances();


-- ── 2. The order state machine, as data ────────────────────────────────────
-- One row per legal transition. Two consumers, one definition:
--
--   • the domain layer reads this table to decide whether *this actor* may make
--     *this move*, and whether a reason is required;
--   • the trigger below enforces that the move exists at all.
--
-- Anything not listed here is unreachable. That is the point: the PRD's twenty
-- states are only trustworthy if the edges between them are finite and visible
-- (PRD §34, FR-401…FR-435).
CREATE TABLE order_state_transitions (
  from_state      order_state NOT NULL,
  to_state        order_state NOT NULL,
  -- Who is allowed to make this move. Read by the domain layer's guard.
  actor_types     text[]      NOT NULL,
  -- Whether the domain layer must record a reason on the resulting order_event.
  requires_reason boolean     NOT NULL DEFAULT false,
  -- Short description, used in the admin console's state-machine view.
  note            text        NOT NULL,

  PRIMARY KEY (from_state, to_state),
  CONSTRAINT order_state_transitions_no_self CHECK (from_state <> to_state),
  CONSTRAINT order_state_transitions_has_actor CHECK (array_length(actor_types, 1) >= 1),
  CONSTRAINT order_state_transitions_actors_valid CHECK (
    actor_types <@ ARRAY['customer', 'shop', 'admin', 'system', 'provider']
  )
);

COMMENT ON TABLE order_state_transitions IS
  'The single definition of the order state machine. Read by the domain layer for actor authorisation, enforced by trigger for reachability.';

INSERT INTO order_state_transitions (from_state, to_state, actor_types, requires_reason, note) VALUES
  -- Draft: the customer is still building the job.
  ('draft', 'awaiting_quote', '{customer}', false, 'Job cannot be auto-priced; the customer asks the shop for a quote'),
  ('draft', 'payment_pending', '{customer}', false, 'Customer proceeds to checkout with an auto-priced job'),
  ('draft', 'cancelled_by_customer', '{customer}', false, 'Customer discards the draft'),
  ('draft', 'auto_cancelled', '{system}', true, 'Abandoned draft swept, files scheduled for deletion'),

  -- Quote flow.
  ('awaiting_quote', 'payment_pending', '{customer}', false, 'Customer accepts the shop''s quote'),
  ('awaiting_quote', 'draft', '{customer}', false, 'Customer goes back to editing the job'),
  ('awaiting_quote', 'cancelled_by_customer', '{customer}', false, 'Customer withdraws the quote request'),
  ('awaiting_quote', 'rejected', '{shop,admin}', true, 'Shop declines to quote for this job'),
  ('awaiting_quote', 'expired', '{system}', true, 'Quote was never answered within its validity'),

  -- Payment.
  ('payment_pending', 'placed', '{system,provider}', false, 'Payment captured and verified by signed webhook'),
  ('payment_pending', 'failed', '{system,provider}', true, 'Payment attempt failed at the aggregator'),
  ('payment_pending', 'draft', '{customer}', false, 'Customer backs out of checkout to change the job'),
  ('payment_pending', 'cancelled_by_customer', '{customer}', false, 'Customer abandons before paying'),
  ('payment_pending', 'auto_cancelled', '{system}', true, 'Payment never completed; intent expired'),
  ('failed', 'payment_pending', '{customer,system}', false, 'Customer retries payment on the same order'),
  ('failed', 'cancelled_by_customer', '{customer}', false, 'Customer gives up after a failed payment'),
  ('failed', 'auto_cancelled', '{system}', true, 'Repeated payment failure; order released'),

  -- With the shop.
  ('placed', 'accepted', '{shop,admin}', false, 'Shop accepts the job'),
  ('placed', 'rejected', '{shop,admin}', true, 'Shop declines the job; full refund'),
  ('placed', 'auto_cancelled', '{system}', true, 'Acceptance window expired; full refund'),
  ('placed', 'cancelled_by_customer', '{customer}', false, 'Free cancellation before the shop accepts'),
  ('placed', 'cancelled_by_shop', '{admin}', true, 'Admin cancels on the shop''s behalf'),

  ('accepted', 'printing', '{shop}', false, 'Shop starts printing'),
  ('accepted', 'ready', '{shop}', false, 'Small job printed and ready in one step'),
  ('accepted', 'on_hold_file_issue', '{shop}', true, 'Shop found a problem with the file'),
  ('accepted', 'cancelled_by_customer', '{customer}', false, 'Customer cancels before printing; full refund'),
  ('accepted', 'cancelled_by_shop', '{shop,admin}', true, 'Shop cannot complete the job; full refund'),
  ('accepted', 'disputed', '{admin}', true, 'Admin opens a dispute on a live order'),

  ('printing', 'ready', '{shop}', false, 'Print complete; pickup code issued'),
  ('printing', 'on_hold_file_issue', '{shop}', true, 'Problem discovered mid-print'),
  ('printing', 'cancelled_by_shop', '{shop,admin}', true, 'Shop cannot finish; refund per policy'),
  ('printing', 'disputed', '{admin}', true, 'Admin opens a dispute on a live order'),

  ('on_hold_file_issue', 'accepted', '{shop,customer,system}', false, 'Hold resolved before printing began'),
  ('on_hold_file_issue', 'printing', '{shop}', false, 'Hold resolved; printing resumes'),
  ('on_hold_file_issue', 'cancelled_by_customer', '{customer}', false, 'Customer cancels rather than fix the file'),
  ('on_hold_file_issue', 'cancelled_by_shop', '{shop,admin}', true, 'Shop cannot proceed even after the hold'),
  ('on_hold_file_issue', 'auto_cancelled', '{system}', true, 'Hold expired unanswered; full refund'),

  -- Pickup.
  ('ready', 'collected', '{shop,admin}', false, 'Pickup verified by code, QR or an audited override'),
  ('ready', 'printing', '{shop}', true, 'Marked ready in error; shop reprints'),
  ('ready', 'expired', '{system}', true, 'Pickup grace window elapsed with no collection'),
  ('ready', 'cancelled_by_shop', '{admin}', true, 'Admin cancels a ready order after investigation'),
  ('ready', 'disputed', '{customer,admin}', true, 'Customer disputes before collecting'),

  ('collected', 'settled', '{system}', false, 'Funds released to the shop''s payable balance'),
  ('collected', 'disputed', '{customer,admin}', true, 'Dispute raised after collection; settlement paused'),
  ('settled', 'disputed', '{admin}', true, 'Dispute raised after settlement; recovered on the next payout'),

  -- Dispute resolutions.
  ('disputed', 'settled', '{admin}', true, 'Resolved in the shop''s favour'),
  ('disputed', 'collected', '{admin}', true, 'Dispute withdrawn; the order stands'),
  ('disputed', 'refunded', '{admin}', true, 'Resolved with a full refund'),
  ('disputed', 'partially_refunded', '{admin}', true, 'Resolved with a partial refund'),
  ('disputed', 'closed_no_refund', '{admin}', true, 'Resolved with no refund'),

  -- Refund outcomes of the cancellation states.
  ('rejected', 'refunded', '{system}', false, 'Full refund for a shop rejection'),
  ('auto_cancelled', 'refunded', '{system}', false, 'Full refund for a platform-side cancellation'),
  ('auto_cancelled', 'closed_no_refund', '{system}', false, 'Nothing to refund; the order was never paid'),
  ('cancelled_by_customer', 'refunded', '{system}', false, 'Refund per the cancellation policy'),
  ('cancelled_by_customer', 'partially_refunded', '{system}', false, 'Partial refund per the cancellation policy'),
  ('cancelled_by_customer', 'closed_no_refund', '{system}', false, 'No refund due, or the order was never paid'),
  ('cancelled_by_shop', 'refunded', '{system}', false, 'Full refund when the shop cancels'),
  ('expired', 'closed_no_refund', '{system}', false, 'No-show after the grace window; work was done'),
  ('expired', 'refunded', '{admin}', true, 'Goodwill refund for an expired order'),
  ('expired', 'collected', '{shop,admin}', true, 'Customer collected late; the shop handed the job over'),
  ('partially_refunded', 'settled', '{system}', false, 'Remaining balance released to the shop');


-- The trigger. Also maintains `previous_state` and `state_changed_at` so those can
-- never disagree with reality, and bumps `version` so an optimistic-concurrency
-- check on a dashboard tab is always meaningful.
CREATE OR REPLACE FUNCTION assert_order_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM order_state_transitions
    WHERE from_state = OLD.state AND to_state = NEW.state
  ) THEN
    RAISE EXCEPTION
      'Illegal order transition %→% for order %', OLD.state, NEW.state, OLD.order_number
      USING ERRCODE = 'restrict_violation',
            HINT = 'Legal transitions are listed in order_state_transitions. Add a row there if the product genuinely needs this edge.';
  END IF;

  NEW.previous_state   := OLD.state;
  NEW.state_changed_at := now();
  NEW.version          := OLD.version + 1;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION assert_order_transition() IS
  'Server-side enforcement of the order state machine (PRD §34). No SQL path can skip a state.';

CREATE TRIGGER orders_guard_state_transition
  BEFORE UPDATE OF state ON orders
  FOR EACH ROW EXECUTE FUNCTION assert_order_transition();


-- ── Order events are gapless ───────────────────────────────────────────────
-- The unique index on (order_id, sequence) already stops duplicates. This adds the
-- other half: no gaps. A gap would make SSE replay silently lossy, because a client
-- resuming from Last-Event-ID would have no way to know an event was missing.
CREATE OR REPLACE FUNCTION assert_order_event_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected bigint;
BEGIN
  SELECT coalesce(max(sequence), 0) + 1 INTO expected
  FROM order_events WHERE order_id = NEW.order_id;

  IF NEW.sequence <> expected THEN
    RAISE EXCEPTION
      'order_events.sequence must be contiguous: expected % for order %, got %',
      expected, NEW.order_id, NEW.sequence
      USING ERRCODE = 'check_violation',
            HINT = 'Take the order row lock and use orders.event_sequence + 1.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER order_events_sequence_contiguous
  BEFORE INSERT ON order_events
  FOR EACH ROW EXECUTE FUNCTION assert_order_event_sequence();


-- ── 3. Placement preconditions ─────────────────────────────────────────────
-- The moment an order becomes `placed`, the customer has paid and the shop is
-- about to be handed the job. Everything that must be true is checked here, in one
-- place, against the actual rows rather than against what the request body claimed.
CREATE OR REPLACE FUNCTION assert_order_placeable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bad_files integer;
  item_count integer;
  shop_ok boolean;
BEGIN
  SELECT count(*) INTO item_count FROM order_items WHERE order_id = NEW.id;
  IF item_count = 0 THEN
    RAISE EXCEPTION 'Order % cannot be placed with no line items', NEW.order_number
      USING ERRCODE = 'check_violation';
  END IF;

  -- Every referenced file must be scanned, processed, still present, and owned by
  -- the customer placing the order (FR-212, NFR-13).
  SELECT count(*) INTO bad_files
  FROM order_items oi
  JOIN files f ON f.id = oi.file_id
  WHERE oi.order_id = NEW.id
    AND (
      f.state <> 'ready'
      OR f.bytes_deleted_at IS NOT NULL
      OR f.owner_user_id <> NEW.customer_user_id
    );

  IF bad_files > 0 THEN
    RAISE EXCEPTION
      'Order % references % file(s) that are not ready, already deleted, or not owned by the customer',
      NEW.order_number, bad_files
      USING ERRCODE = 'check_violation';
  END IF;

  -- Orders are only ever placed at shops that are live, verified and not
  -- suspended — the same condition that governs discovery (NFR-10).
  SELECT discoverable INTO shop_ok FROM shops WHERE id = NEW.shop_id;
  IF shop_ok IS NOT TRUE THEN
    RAISE EXCEPTION
      'Order % cannot be placed: shop % is not currently discoverable', NEW.order_number, NEW.shop_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_guard_placement
  BEFORE UPDATE ON orders
  FOR EACH ROW
  WHEN (NEW.state = 'placed' AND OLD.state <> 'placed')
  EXECUTE FUNCTION assert_order_placeable();


-- Funds and settlement follow collection, never precede it. `funds_released_at` is
-- already constrained; the payout link needs the same treatment, because appearing
-- in a payout is how a shop actually gets paid.
ALTER TABLE orders
  ADD CONSTRAINT orders_payout_after_collection CHECK (
    payout_id IS NULL OR collected_at IS NOT NULL
  );


-- ── Pickup codes are unambiguous within a shop ─────────────────────────────
-- A shop types six characters at the counter. If two live orders at that shop
-- could share a code, verification would be ambiguous — and ambiguity at the
-- counter means handing documents to the wrong person (FR-425).
CREATE UNIQUE INDEX orders_live_pickup_code_key
  ON orders (shop_id, pickup_code_hash)
  WHERE pickup_code_hash IS NOT NULL
    AND state IN ('accepted', 'printing', 'on_hold_file_issue', 'ready');


-- ── 4. Files stay consistent with their order ──────────────────────────────
CREATE OR REPLACE FUNCTION assert_file_order_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  o record;
BEGIN
  IF NEW.order_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT customer_user_id, shop_id INTO o FROM orders WHERE id = NEW.order_id;
  IF NOT FOUND THEN
    RETURN NEW;   -- the FK will reject this
  END IF;

  IF NEW.owner_user_id <> o.customer_user_id THEN
    RAISE EXCEPTION
      'File % cannot be attached to an order belonging to a different customer', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- The shop authorised to read the file is the shop fulfilling the order. Nothing
  -- else may be written here, because this column is a second gate on every signed
  -- URL we issue.
  IF NEW.shop_id IS NOT NULL AND NEW.shop_id <> o.shop_id THEN
    RAISE EXCEPTION
      'File % is scoped to shop % but its order is at shop %', NEW.id, NEW.shop_id, o.shop_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER files_guard_order_consistency
  BEFORE INSERT OR UPDATE OF order_id, shop_id ON files
  FOR EACH ROW EXECUTE FUNCTION assert_file_order_consistency();


-- A line item may only reference a file the ordering customer owns. Checked at
-- attach time so a crafted request fails immediately rather than at placement.
CREATE OR REPLACE FUNCTION assert_order_item_file_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  file_owner uuid;
  order_customer uuid;
BEGIN
  IF NEW.file_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT owner_user_id INTO file_owner FROM files WHERE id = NEW.file_id;
  SELECT customer_user_id INTO order_customer FROM orders WHERE id = NEW.order_id;

  IF file_owner IS NOT NULL AND order_customer IS NOT NULL AND file_owner <> order_customer THEN
    RAISE EXCEPTION
      'Line item references file % which belongs to another user', NEW.file_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER order_items_guard_file_owner
  BEFORE INSERT OR UPDATE OF file_id ON order_items
  FOR EACH ROW EXECUTE FUNCTION assert_order_item_file_owner();


-- ── 5. Refunds cannot exceed the capture ───────────────────────────────────
-- `payments.amount_refunded_paise` is bounded by a CHECK, but that column is
-- updated from webhooks and lags. This checks the refund rows themselves, which is
-- what a support agent issuing a second partial refund actually creates.
CREATE OR REPLACE FUNCTION assert_refund_within_capture()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  captured  bigint;
  committed bigint;
BEGIN
  SELECT amount_captured_paise INTO captured FROM payments WHERE id = NEW.payment_id;
  IF captured IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(sum(amount_paise), 0) INTO committed
  FROM refunds
  WHERE payment_id = NEW.payment_id
    AND id <> NEW.id
    AND state IN ('requested', 'approved', 'processing', 'succeeded');

  IF NEW.state IN ('requested', 'approved', 'processing', 'succeeded')
     AND committed + NEW.amount_paise > captured THEN
    RAISE EXCEPTION
      'Refunds for payment % would total % paise against % paise captured',
      NEW.payment_id, committed + NEW.amount_paise, captured
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER refunds_guard_within_capture
  BEFORE INSERT OR UPDATE OF state, amount_paise ON refunds
  FOR EACH ROW EXECUTE FUNCTION assert_refund_within_capture();


-- ── 6. A closed payout equals the sum of its items ─────────────────────────
-- During accrual the window is open and items arrive one at a time, so no check
-- applies. The instant the window closes — the state leaves `accruing` — the header
-- totals must equal the lines, because those totals are what we instruct the bank
-- with (PRD §41.3).
CREATE OR REPLACE FUNCTION check_payout_totals(p_payout_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  p record;
  s record;
BEGIN
  SELECT * INTO p FROM payouts WHERE id = p_payout_id;
  IF NOT FOUND THEN
    RETURN;   -- the payout was deleted in this transaction
  END IF;

  IF p.state = 'accruing' THEN
    RETURN;
  END IF;

  SELECT
    count(*) FILTER (WHERE kind = 'order')                                  AS n,
    coalesce(sum(order_total_paise)    FILTER (WHERE kind = 'order'), 0)    AS gross,
    coalesce(sum(commission_paise)     FILTER (WHERE kind = 'order'), 0)    AS commission,
    coalesce(sum(commission_tax_paise) FILTER (WHERE kind = 'order'), 0)    AS commission_tax
  INTO s
  FROM payout_items
  WHERE payout_id = p_payout_id;

  IF p.order_count <> s.n
     OR p.gross_paise <> s.gross
     OR p.commission_paise <> s.commission
     OR p.commission_tax_paise <> s.commission_tax THEN
    RAISE EXCEPTION
      'Payout % header does not match its line items (header: % orders / % gross / % commission / % commission tax; lines: % / % / % / %)',
      p.reference, p.order_count, p.gross_paise, p.commission_paise, p.commission_tax_paise,
      s.n, s.gross, s.commission, s.commission_tax
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION assert_payout_totals_from_header()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM check_payout_totals(NEW.id);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION assert_payout_totals_from_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM check_payout_totals(coalesce(NEW.payout_id, OLD.payout_id));
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER payouts_totals_match_items
  AFTER UPDATE ON payouts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_payout_totals_from_header();

CREATE CONSTRAINT TRIGGER payout_items_totals_match_header
  AFTER INSERT OR UPDATE OR DELETE ON payout_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_payout_totals_from_item();


-- An order may only be settled through a payout once it was actually collected.
-- The unique index in 0007 stops a second payout; this stops the first one being
-- wrong.
CREATE OR REPLACE FUNCTION assert_payout_item_order_collected()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  collected timestamptz;
  num text;
BEGIN
  IF NEW.kind <> 'order' THEN
    RETURN NEW;
  END IF;

  SELECT collected_at, order_number INTO collected, num FROM orders WHERE id = NEW.order_id;

  IF collected IS NULL THEN
    RAISE EXCEPTION
      'Order % has not been collected and cannot be included in a payout', coalesce(num, NEW.order_id::text)
      USING ERRCODE = 'check_violation',
            HINT = 'Funds are held until the customer collects (PRD §40.1).';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payout_items_guard_collected
  BEFORE INSERT OR UPDATE OF order_id, kind ON payout_items
  FOR EACH ROW EXECUTE FUNCTION assert_payout_item_order_collected();


-- ── 7. Verification and go-live preconditions ──────────────────────────────
-- `shops.discoverable` is generated from status and verification, so this is the
-- gate on the inputs to that column: what it takes to become verified, and what it
-- takes to go live (FR-105, FR-108, PRD §57.2).
CREATE OR REPLACE FUNCTION assert_shop_readiness()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.verification_status = 'verified'
     AND (TG_OP = 'INSERT' OR OLD.verification_status IS DISTINCT FROM 'verified') THEN

    IF NOT EXISTS (SELECT 1 FROM shop_kyc WHERE shop_id = NEW.id AND status = 'verified') THEN
      RAISE EXCEPTION 'Shop % cannot be verified before its KYC is verified', NEW.slug
        USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM shop_bank_accounts
      WHERE shop_id = NEW.id AND is_primary AND archived_at IS NULL
        AND verification_status = 'verified'
    ) THEN
      RAISE EXCEPTION 'Shop % cannot be verified without a verified primary bank account', NEW.slug
        USING ERRCODE = 'check_violation',
              HINT = 'A verified shop can be paid, so the payout destination must be proven first.';
    END IF;
  END IF;

  IF NEW.status = 'live' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'live') THEN

    IF NEW.verification_status <> 'verified' THEN
      RAISE EXCEPTION 'Shop % cannot go live before it is verified', NEW.slug
        USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM shop_hours WHERE shop_id = NEW.id) THEN
      RAISE EXCEPTION 'Shop % cannot go live without opening hours', NEW.slug
        USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM shop_capabilities WHERE shop_id = NEW.id) THEN
      RAISE EXCEPTION 'Shop % cannot go live without declared capabilities', NEW.slug
        USING ERRCODE = 'check_violation';
    END IF;

    -- At least one available service with a price. A live shop with no priced
    -- service is a shop that can be found and cannot be ordered from.
    IF NOT EXISTS (
      SELECT 1
      FROM shop_service_items ssi
      JOIN price_bands pb ON pb.shop_service_item_id = ssi.id
      WHERE ssi.shop_id = NEW.id AND ssi.is_available
    ) THEN
      RAISE EXCEPTION 'Shop % cannot go live without at least one priced, available service', NEW.slug
        USING ERRCODE = 'check_violation',
              HINT = 'A quantity with no matching price band is a pricing error, never free.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER shops_guard_readiness
  BEFORE INSERT OR UPDATE OF status, verification_status ON shops
  FOR EACH ROW EXECUTE FUNCTION assert_shop_readiness();


-- ── Ratings follow real transactions ───────────────────────────────────────
-- The anti-spam rule from the PRD, enforced rather than assumed: you can only rate
-- an order you collected (FR-701).
CREATE OR REPLACE FUNCTION assert_rating_is_earned()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  o record;
BEGIN
  SELECT customer_user_id, shop_id, state, collected_at INTO o FROM orders WHERE id = NEW.order_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF o.collected_at IS NULL THEN
    RAISE EXCEPTION 'Only a collected order can be rated'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.user_id <> o.customer_user_id THEN
    RAISE EXCEPTION 'Only the customer who placed the order may rate it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.shop_id <> o.shop_id THEN
    RAISE EXCEPTION 'Rating shop does not match the order''s shop'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER order_ratings_guard_earned
  BEFORE INSERT ON order_ratings
  FOR EACH ROW EXECUTE FUNCTION assert_rating_is_earned();


-- ── Role scoping ───────────────────────────────────────────────────────────
-- `user_roles` already CHECKs that shop-scoped roles carry a shop id. This adds the
-- other direction: an admin role may not be granted with a shop scope, and a shop
-- role may only be granted for a shop that exists and is not deleted.
CREATE OR REPLACE FUNCTION assert_role_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.shop_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM shops WHERE id = NEW.shop_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Cannot grant a shop-scoped role for a deleted or missing shop'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_roles_guard_scope
  BEFORE INSERT OR UPDATE OF shop_id ON user_roles
  FOR EACH ROW EXECUTE FUNCTION assert_role_scope();


-- ── A pickup code can never enter a message template ───────────────────────
-- The one templating mistake with real consequences: a pickup code in an SMS or a
-- push payload defeats pickup verification, because both are readable on a locked
-- screen and neither is under our control once sent (PRD §57.3, FR-425).
--
-- This is deliberately a constraint on the *template*, not on the rendered body.
-- Checking rendered bodies would need a heuristic, and a heuristic false positive
-- would abort the transaction that moves an order to `ready` — losing an order to
-- protect a code. Checking the template is exact, and it fails when someone writes
-- the template rather than when a customer is waiting.
ALTER TABLE notification_templates
  ADD CONSTRAINT notification_templates_no_pickup_secret CHECK (
    NOT (variables && ARRAY['pickupCode', 'pickup_code', 'pickupQrSlug', 'pickup_qr_slug'])
    AND body !~ '\{\{\s*pickup'
    AND (title IS NULL OR title !~ '\{\{\s*pickup')
    AND (subject IS NULL OR subject !~ '\{\{\s*pickup')
  );

COMMENT ON CONSTRAINT notification_templates_no_pickup_secret ON notification_templates IS
  'Pickup codes are shown in the app only. Messages link to the order; they never carry the secret.';

