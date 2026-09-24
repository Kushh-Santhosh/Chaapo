-- ═══════════════════════════════════════════════════════════════════════════
-- 0001 — Extensions, conventions and shared types
--
-- Conventions used throughout the schema:
--
--   • Primary keys are UUID v7, generated in the application (`newId()`), so an
--     id is time-ordered and index inserts stay at the right edge of the B-tree.
--     We do NOT use gen_random_uuid() defaults: the application always knows the
--     id before the insert, which it needs in order to write the audit row and
--     the outbox row in the same transaction.
--
--   • Money is `bigint` paise. Never numeric, never float. Column names end in
--     `_paise` without exception so a review can grep for them.
--
--   • Rates are `integer` basis points (bps). 1800 = 18 %.
--
--   • Timestamps are `timestamptz`, always UTC. Display is IST, done in the app.
--
--   • `created_at` / `updated_at` on every mutable table; `updated_at` is
--     maintained by a trigger, not by the application, so a stray UPDATE cannot
--     leave it stale.
--
--   • Reversible PII lives in `*_encrypted` text columns (AES-256-GCM envelopes)
--     with a `*_hash` blind index beside it when we need to look the value up,
--     and a `*_last4` / `*_masked` column when we need to display it. The
--     plaintext is never a column.
--
--   • Soft deletion (`deleted_at`) is used only where a record must survive for
--     audit or financial reasons. Files are hard-deleted from object storage by
--     the retention worker; the row survives with `deleted_at` set as proof of
--     deletion.
-- ═══════════════════════════════════════════════════════════════════════════

-- PostGIS: nearby-shop discovery uses geography(Point,4326) with ST_DWithin and
-- a KNN ordering, which is the whole reason this is Postgres and not something
-- with a bolted-on geo index (FR-101, NFR-02).
CREATE EXTENSION IF NOT EXISTS postgis;

-- Trigram search for shop names and addresses ("sharma xerox", "kothrud").
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- citext for case-insensitive slugs and template keys.
CREATE EXTENSION IF NOT EXISTS citext;

-- ── Shared trigger: maintain updated_at ────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION set_updated_at() IS
  'Maintains updated_at on UPDATE. Attached to every mutable table.';

-- ── Shared trigger: block UPDATE and DELETE entirely ───────────────────────
-- Attached to the append-only tables: order_events, audit_logs, ledger_entries,
-- payment_webhook_events. The application cannot rewrite history even with a
-- bug, and a compromised application credential cannot quietly erase an audit
-- trail (PRD §F invariant 4, NFR-16).
CREATE OR REPLACE FUNCTION forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION forbid_mutation() IS
  'Raises on UPDATE/DELETE. Enforces append-only audit and ledger tables at the database level.';

-- ── Shared trigger: forbid changing selected columns after insert ──────────
-- Used for the immutable price snapshot on orders: once an order is placed the
-- amounts are frozen (PRD §F invariant 6). Re-pricing goes through an explicit,
-- customer-approved flow that writes a NEW snapshot row, it does not edit this
-- one.
CREATE OR REPLACE FUNCTION forbid_column_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  col text;
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF (old_row -> col) IS DISTINCT FROM (new_row -> col) THEN
      RAISE EXCEPTION 'Column %.% is immutable once written (was %, tried %)',
        TG_TABLE_NAME, col, coalesce(old_row ->> col, 'NULL'), coalesce(new_row ->> col, 'NULL')
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION forbid_column_change() IS
  'Trigger factory: pass column names as trigger arguments to freeze them after insert.';

-- ── Enumerated types ───────────────────────────────────────────────────────
-- Enums are used where the PRD fixes the set and the application switches on it
-- exhaustively. Where the set is expected to grow with the catalogue (paper
-- sizes, finishing kinds), a reference table is used instead.

-- PRD §14 — the six roles.
CREATE TYPE user_role AS ENUM (
  'customer',
  'shop_owner',
  'shop_staff',
  'admin_support',
  'admin_finance',
  'admin_super'
);

CREATE TYPE account_status AS ENUM (
  'active',
  'pending_verification',
  'suspended',
  'closed'
);

-- PRD §17 — shop lifecycle. Only 'live' shops are discoverable (NFR-10).
CREATE TYPE shop_status AS ENUM (
  'draft',              -- owner is still filling in onboarding
  'pending_review',     -- submitted, waiting on admin
  'changes_requested',  -- admin sent it back with notes
  'live',               -- verified and discoverable
  'paused',             -- owner temporarily stopped taking orders
  'suspended',          -- admin action
  'closed'              -- permanently off the platform
);

CREATE TYPE verification_status AS ENUM (
  'not_submitted',
  'pending',
  'in_review',
  'verified',
  'rejected',
  'expired'
);

-- PRD §20 / §F — the order state machine. Twenty states, no more, no fewer.
-- Transitions are enforced in `src/server/domains/orders/state-machine.ts` and
-- every change writes an `order_events` row.
CREATE TYPE order_state AS ENUM (
  'draft',
  'awaiting_quote',
  'payment_pending',
  'failed',
  'placed',
  'accepted',
  'printing',
  'on_hold_file_issue',
  'ready',
  'collected',
  'settled',
  'rejected',
  'auto_cancelled',
  'cancelled_by_customer',
  'cancelled_by_shop',
  'expired',
  'refunded',
  'partially_refunded',
  'closed_no_refund',
  'disputed'
);

CREATE TYPE payment_state AS ENUM (
  'created',            -- provider order created, customer has not paid
  'pending',            -- customer is on the provider's page / UPI collect sent
  'authorized',         -- funds authorised but not captured
  'captured',           -- money taken, held at the aggregator
  'failed',
  'cancelled',
  'refund_pending',
  'refunded',
  'partially_refunded',
  'disputed'            -- chargeback raised
);

CREATE TYPE payout_state AS ENUM (
  'accruing',           -- collecting eligible orders
  'pending',            -- submitted to the aggregator
  'processing',
  'paid',
  'failed',
  'on_hold',            -- admin or risk hold
  'reversed'
);

CREATE TYPE refund_state AS ENUM (
  'requested',
  'approved',
  'processing',
  'succeeded',
  'failed',
  'rejected'
);

CREATE TYPE file_state AS ENUM (
  'reserved',           -- upload session created, no bytes yet
  'uploading',
  'uploaded',           -- bytes present, not yet inspected
  'scanning',
  'processing',         -- page count / preview generation
  'ready',              -- safe, priced, printable
  'rejected',           -- malware, corrupt, password-protected, unsupported
  'expired',            -- retention window passed
  'deleted'             -- bytes removed from object storage
);

CREATE TYPE notification_channel AS ENUM ('whatsapp', 'sms', 'email', 'push', 'in_app');

CREATE TYPE notification_state AS ENUM (
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'suppressed'          -- consent withdrawn, quiet hours, or duplicate
);

CREATE TYPE dispute_state AS ENUM (
  'open',
  'awaiting_customer',
  'awaiting_shop',
  'in_review',
  'resolved_refund',
  'resolved_no_refund',
  'resolved_partial',
  'withdrawn'
);

-- Which side of the marketplace an amount belongs to. Used by the ledger.
CREATE TYPE ledger_account AS ENUM (
  'customer_payment',   -- money received from a customer
  'shop_payable',       -- amount owed to a shop
  'platform_revenue',   -- commission earned
  'tax_payable',        -- GST / TDS / TCS collected and owed onward
  'provider_fee',       -- payment gateway charges
  'refund_payable',     -- amount owed back to a customer
  'settlement_paid'     -- money actually moved to a shop
);

CREATE TYPE ledger_direction AS ENUM ('debit', 'credit');

COMMENT ON TYPE order_state IS
  'PRD §F. The application state machine is the only writer; see state-machine.ts.';
