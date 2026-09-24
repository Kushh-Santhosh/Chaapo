-- ═══════════════════════════════════════════════════════════════════════════
-- 0003 — Geography, shops, staff and verification
--
-- Discovery is the first screen of the product and the hardest query in it:
-- "verified shops near me that are open, can do what I need, and will have it
-- ready before I get there". That query is served by a single GiST index on
-- `shops.location` plus a partial index restricted to discoverable shops, so the
-- planner never walks a draft or suspended shop (FR-101, NFR-02, NFR-10).
--
-- The verification gate is structural, not a convention: `shops.discoverable` is
-- a GENERATED column derived from status and verification, and every discovery
-- query filters on it. There is no code path that can list an unverified shop
-- because there is no code path that computes discoverability itself.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Cities and localities ──────────────────────────────────────────────────
-- Reference geography. Used for the city switcher, for "shops in Kothrud", and
-- for admin reporting. Seeded in 0011; extended by admins.
CREATE TABLE cities (
  id            uuid PRIMARY KEY,
  slug          citext      NOT NULL,
  name          text        NOT NULL,
  state         text        NOT NULL,
  -- City centre; used as the map default when we have no device location.
  centre        geography(Point, 4326) NOT NULL,
  -- Rough radius in metres, for sanity-checking that a shop pin is in the city.
  radius_m      integer     NOT NULL DEFAULT 25000,
  timezone      text        NOT NULL DEFAULT 'Asia/Kolkata',
  -- Whether Chaapo is launched here. Unlaunched cities exist so we can collect
  -- waitlist interest without showing an empty discovery screen (FR-108).
  is_live       boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cities_radius_sane CHECK (radius_m BETWEEN 1000 AND 200000)
);

CREATE UNIQUE INDEX cities_slug_key ON cities (slug);
CREATE INDEX cities_centre_gix ON cities USING gist (centre);
CREATE INDEX cities_live_idx ON cities (is_live) WHERE is_live;

CREATE TRIGGER cities_updated_at BEFORE UPDATE ON cities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE localities (
  id            uuid PRIMARY KEY,
  city_id       uuid        NOT NULL REFERENCES cities (id) ON DELETE CASCADE,
  slug          citext      NOT NULL,
  name          text        NOT NULL,
  centre        geography(Point, 4326),
  pincodes      text[]      NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX localities_city_slug_key ON localities (city_id, slug);
CREATE INDEX localities_centre_gix ON localities USING gist (centre) WHERE centre IS NOT NULL;
CREATE INDEX localities_name_trgm ON localities USING gin (name gin_trgm_ops);

CREATE TRIGGER localities_updated_at BEFORE UPDATE ON localities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Shops ──────────────────────────────────────────────────────────────────
CREATE TABLE shops (
  id                    uuid PRIMARY KEY,
  slug                  citext      NOT NULL,
  -- Public-facing name. Trigram-indexed for search.
  name                  text        NOT NULL,
  -- Registered legal name, used on invoices. Not shown in discovery.
  legal_name            text,
  tagline               text,
  about                 text,
  owner_user_id         uuid        NOT NULL REFERENCES users (id),

  status                shop_status NOT NULL DEFAULT 'draft',
  verification_status   verification_status NOT NULL DEFAULT 'not_submitted',
  verified_at           timestamptz,
  verified_by           uuid REFERENCES users (id),

  -- Address. Kept as structured fields because we display them, geocode them,
  -- and print them on invoices.
  address_line1         text        NOT NULL DEFAULT '',
  address_line2         text,
  landmark              text,
  city_id               uuid REFERENCES cities (id),
  locality_id           uuid REFERENCES localities (id),
  pincode               text,
  location              geography(Point, 4326),
  -- How the coordinates were obtained, so admins can tell a hand-dropped pin
  -- from a geocoded one during verification review.
  location_source       text,
  location_accuracy_m   integer,

  contact_phone_encrypted text,
  contact_phone_hash      text,
  contact_phone_masked    text,
  contact_email_encrypted text,
  contact_email_masked    text,
  -- Whether the shop's phone number may be shown to a customer with a live
  -- order. Default off; shops opt in (PRD §57.4).
  show_phone_to_customer  boolean   NOT NULL DEFAULT false,

  -- Operational promises shown in discovery.
  -- Base turnaround in *open* minutes; the SLA clock uses shop hours, so a job
  -- placed five minutes before closing is not instantly late (PRD §33.4).
  default_turnaround_minutes integer NOT NULL DEFAULT 30,
  -- Order acceptance window: how long the shop has to accept before the order
  -- auto-cancels and the customer is refunded in full (FR-407).
  accept_window_minutes      integer NOT NULL DEFAULT 10,
  -- How long a Ready order waits before it becomes stale and the grace timer
  -- starts (FR-431).
  pickup_grace_hours         integer NOT NULL DEFAULT 48,
  -- Ceiling on a single order so a shop is not handed a 4,000-page job it
  -- cannot deliver. NULL = platform default from platform_config.
  max_pages_per_order        integer,
  max_files_per_order        integer,
  -- Minimum order value; below this the shop would lose money on the job.
  min_order_value_paise      bigint  NOT NULL DEFAULT 0,

  -- Commission the platform charges this shop, in basis points. Defaults to the
  -- platform rate in platform_config; overridable per shop by admin_finance for
  -- launch deals, and every change is audited (PRD §38.2).
  commission_bps            integer,

  -- Cached aggregates. Recomputed by a worker, never authoritative — the source
  -- of truth is order_ratings and orders. Denormalised because discovery reads
  -- them on every card and must not join two aggregates per shop (NFR-02).
  rating_avg_centi          integer,          -- 431 = 4.31 stars; integer, no floats
  rating_count              integer NOT NULL DEFAULT 0,
  orders_completed          integer NOT NULL DEFAULT 0,
  on_time_rate_bps          integer,
  acceptance_rate_bps       integer,
  median_ready_minutes      integer,
  aggregates_updated_at     timestamptz,

  -- Owner's temporary pause. Distinct from `status = 'paused'`, which is durable;
  -- this is the "busy, back in 40 minutes" toggle on the dashboard (FR-206).
  paused_until              timestamptz,
  pause_reason              text,

  -- Set when an admin suspends the shop. Reason is shown to the owner.
  suspended_at              timestamptz,
  suspended_by              uuid REFERENCES users (id),
  suspension_reason         text,

  onboarding_step           text        NOT NULL DEFAULT 'profile',
  submitted_for_review_at   timestamptz,
  went_live_at              timestamptz,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                timestamptz,

  -- ── The verification gate, in the schema ─────────────────────────────────
  -- A shop is discoverable only when it is live, verified, has a location, and
  -- is not deleted. Generated, so no query can compute this differently and no
  -- unverified shop can leak into discovery (NFR-10, PRD §17.6).
  discoverable boolean GENERATED ALWAYS AS (
    status = 'live'
    AND verification_status = 'verified'
    AND location IS NOT NULL
    AND deleted_at IS NULL
    AND suspended_at IS NULL
  ) STORED,

  CONSTRAINT shops_turnaround_sane CHECK (default_turnaround_minutes BETWEEN 5 AND 2880),
  CONSTRAINT shops_accept_window_sane CHECK (accept_window_minutes BETWEEN 2 AND 120),
  CONSTRAINT shops_grace_sane CHECK (pickup_grace_hours BETWEEN 6 AND 336),
  CONSTRAINT shops_commission_sane CHECK (commission_bps IS NULL OR commission_bps BETWEEN 0 AND 3000),
  CONSTRAINT shops_rating_range CHECK (rating_avg_centi IS NULL OR rating_avg_centi BETWEEN 100 AND 500),
  CONSTRAINT shops_min_order_nonneg CHECK (min_order_value_paise >= 0),
  CONSTRAINT shops_pincode_format CHECK (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$'),
  CONSTRAINT shops_location_source_valid CHECK (
    location_source IS NULL OR location_source IN ('device_gps', 'map_pin', 'geocoded', 'admin')
  ),
  CONSTRAINT shops_verified_has_verifier CHECK (
    verification_status <> 'verified' OR (verified_at IS NOT NULL)
  ),
  -- A live shop must be complete enough to take an order.
  CONSTRAINT shops_live_is_complete CHECK (
    status <> 'live' OR (location IS NOT NULL AND city_id IS NOT NULL AND address_line1 <> '')
  ),
  CONSTRAINT shops_suspension_has_reason CHECK (
    suspended_at IS NULL OR suspension_reason IS NOT NULL
  ),
  CONSTRAINT shops_onboarding_step_valid CHECK (
    onboarding_step IN ('profile', 'location', 'hours', 'capabilities', 'catalogue', 'kyc', 'bank', 'review', 'done')
  )
);

CREATE UNIQUE INDEX shops_slug_key ON shops (slug) WHERE deleted_at IS NULL;
CREATE INDEX shops_owner_idx ON shops (owner_user_id) WHERE deleted_at IS NULL;

-- The discovery index. Partial, so it holds only rows discovery can return —
-- typically a small fraction of the table — and every entry is a live verified
-- shop with coordinates.
CREATE INDEX shops_discovery_gix ON shops USING gist (location) WHERE discoverable;
CREATE INDEX shops_city_discovery_idx ON shops (city_id) WHERE discoverable;
CREATE INDEX shops_name_trgm ON shops USING gin (name gin_trgm_ops) WHERE discoverable;
CREATE INDEX shops_address_trgm ON shops USING gin (address_line1 gin_trgm_ops) WHERE discoverable;

-- Admin queues: shops waiting on a human.
CREATE INDEX shops_review_queue_idx ON shops (submitted_for_review_at)
  WHERE status IN ('pending_review', 'changes_requested');
CREATE INDEX shops_status_idx ON shops (status) WHERE deleted_at IS NULL;

CREATE TRIGGER shops_updated_at BEFORE UPDATE ON shops
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN shops.discoverable IS
  'Generated. The single definition of "may appear in discovery" (NFR-10). Never write this column.';
COMMENT ON COLUMN shops.rating_avg_centi IS
  'Rating x100 as an integer. 431 = 4.31 stars. Cached from order_ratings.';

-- Deferred FK from 0002: a shop-scoped role must point at a real shop.
ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_active_shop_id_fkey
  FOREIGN KEY (active_shop_id) REFERENCES shops (id) ON DELETE CASCADE;


-- ── Opening hours ──────────────────────────────────────────────────────────
-- One row per interval per weekday, so a split shift (9–14, 16–21) is two rows.
-- Minutes from IST midnight; `close_minute` may exceed 1440 for a shop that
-- shuts after midnight. This is exactly the shape `WeeklyHours` in
-- `src/lib/time.ts` consumes.
CREATE TABLE shop_hours (
  id            uuid PRIMARY KEY,
  shop_id       uuid        NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  weekday       smallint    NOT NULL,     -- 0 = Sunday
  open_minute   integer     NOT NULL,
  close_minute  integer     NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT shop_hours_weekday_range CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT shop_hours_open_range CHECK (open_minute BETWEEN 0 AND 1439),
  -- Close may run past midnight but not by more than 8 hours.
  CONSTRAINT shop_hours_close_range CHECK (close_minute > open_minute AND close_minute <= 1920)
);

CREATE INDEX shop_hours_shop_idx ON shop_hours (shop_id, weekday, open_minute);
-- No two intervals on the same day may start at the same minute; full overlap
-- checking happens in the domain layer where we can return a usable message.
CREATE UNIQUE INDEX shop_hours_no_duplicate_start ON shop_hours (shop_id, weekday, open_minute);

CREATE TRIGGER shop_hours_updated_at BEFORE UPDATE ON shop_hours
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Closures (holidays, one-off shutdowns) ────────────────────────────────
CREATE TABLE shop_closures (
  id            uuid PRIMARY KEY,
  shop_id       uuid        NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  reason        text,
  -- Whether customers see the reason ("Diwali") or just "Closed".
  reason_public boolean     NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT shop_closures_ordered CHECK (ends_at > starts_at)
);

CREATE INDEX shop_closures_shop_window_idx ON shop_closures (shop_id, starts_at, ends_at);

CREATE TRIGGER shop_closures_updated_at BEFORE UPDATE ON shop_closures
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Staff ──────────────────────────────────────────────────────────────────
-- A staff member is a user with a shop-scoped role. This table carries the
-- shop-specific facts about them: display name on the ticket, what they may do,
-- and whether they are currently on shift.
CREATE TABLE shop_staff (
  id                uuid PRIMARY KEY,
  shop_id           uuid        NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  display_name      text        NOT NULL,
  -- Granular within-shop permissions. The role gives access to the dashboard;
  -- these decide whether this person can refund, change prices, or see payouts.
  can_accept_orders boolean     NOT NULL DEFAULT true,
  can_verify_pickup boolean     NOT NULL DEFAULT true,
  can_edit_catalogue boolean    NOT NULL DEFAULT false,
  can_view_payouts  boolean     NOT NULL DEFAULT false,
  can_manage_staff  boolean     NOT NULL DEFAULT false,
  is_active         boolean     NOT NULL DEFAULT true,
  invited_by        uuid REFERENCES users (id),
  joined_at         timestamptz NOT NULL DEFAULT now(),
  removed_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX shop_staff_active_key ON shop_staff (shop_id, user_id) WHERE removed_at IS NULL;
CREATE INDEX shop_staff_shop_idx ON shop_staff (shop_id) WHERE removed_at IS NULL;
CREATE INDEX shop_staff_user_idx ON shop_staff (user_id) WHERE removed_at IS NULL;

CREATE TRIGGER shop_staff_updated_at BEFORE UPDATE ON shop_staff
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Staff invites ──────────────────────────────────────────────────────────
CREATE TABLE staff_invites (
  id                uuid PRIMARY KEY,
  shop_id           uuid        NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  invited_by        uuid        NOT NULL REFERENCES users (id),
  phone_encrypted   text        NOT NULL,
  phone_hash        text        NOT NULL,
  phone_masked      text        NOT NULL,
  display_name      text        NOT NULL,
  role              user_role   NOT NULL,
  permissions       jsonb       NOT NULL DEFAULT '{}',
  token_hash        text        NOT NULL,
  expires_at        timestamptz NOT NULL,
  accepted_at       timestamptz,
  accepted_user_id  uuid REFERENCES users (id),
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT staff_invites_role_is_shop_scoped CHECK (role IN ('shop_owner', 'shop_staff'))
);

CREATE UNIQUE INDEX staff_invites_token_key ON staff_invites (token_hash);
CREATE UNIQUE INDEX staff_invites_pending_key ON staff_invites (shop_id, phone_hash)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TRIGGER staff_invites_updated_at BEFORE UPDATE ON staff_invites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Capabilities ───────────────────────────────────────────────────────────
-- What the shop's machines can physically do. Discovery filters on this before
-- it filters on price, because a shop that cannot print A3 colour is not a
-- candidate for an A3 colour job at any price (FR-104).
CREATE TABLE shop_capabilities (
  shop_id                 uuid PRIMARY KEY REFERENCES shops (id) ON DELETE CASCADE,
  -- Paper sizes the shop stocks, as catalogue codes ('a4','a3','legal',...).
  paper_sizes             text[]      NOT NULL DEFAULT '{a4}',
  supports_colour         boolean     NOT NULL DEFAULT false,
  supports_bw             boolean     NOT NULL DEFAULT true,
  supports_duplex         boolean     NOT NULL DEFAULT true,
  -- Finishing codes ('staple','spiral','soft_bind','lamination',...).
  finishings              text[]      NOT NULL DEFAULT '{}',
  -- Special media the shop can handle.
  supports_card_stock     boolean     NOT NULL DEFAULT false,
  supports_photo_paper    boolean     NOT NULL DEFAULT false,
  supports_large_format   boolean     NOT NULL DEFAULT false,
  supports_scanning       boolean     NOT NULL DEFAULT false,
  -- Realistic daily capacity in pages, used for the "can they actually do this
  -- today" signal and for capacity-aware SLA estimates.
  daily_page_capacity     integer,
  -- Machine count drives concurrency in the SLA estimate.
  printer_count           smallint    NOT NULL DEFAULT 1,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT shop_capabilities_prints_something CHECK (supports_bw OR supports_colour),
  CONSTRAINT shop_capabilities_has_paper CHECK (array_length(paper_sizes, 1) >= 1),
  CONSTRAINT shop_capabilities_printer_count CHECK (printer_count BETWEEN 1 AND 50),
  CONSTRAINT shop_capabilities_capacity CHECK (daily_page_capacity IS NULL OR daily_page_capacity > 0)
);

CREATE INDEX shop_capabilities_paper_gin ON shop_capabilities USING gin (paper_sizes);
CREATE INDEX shop_capabilities_finishing_gin ON shop_capabilities USING gin (finishings);

CREATE TRIGGER shop_capabilities_updated_at BEFORE UPDATE ON shop_capabilities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── KYC ────────────────────────────────────────────────────────────────────
-- PAN and GSTIN are stored encrypted with blind indexes so we can detect the
-- same PAN being used by two shops (a real fraud pattern) without holding the
-- numbers in the clear. Aadhaar is NOT stored in any form — not encrypted, not
-- hashed, not the last four digits (PRD §57.2). Where Aadhaar-based
-- verification is used, the provider's reference id is stored instead.
CREATE TABLE shop_kyc (
  shop_id                 uuid PRIMARY KEY REFERENCES shops (id) ON DELETE CASCADE,
  business_type           text        NOT NULL DEFAULT 'proprietorship',

  pan_encrypted           text,
  pan_hash                text,
  pan_masked              text,
  pan_name                text,               -- name as printed on the PAN card
  pan_verified_at         timestamptz,

  gstin_encrypted         text,
  gstin_hash              text,
  gstin_masked            text,
  gstin_verified_at       timestamptz,
  -- Shops below the GST threshold legitimately have no GSTIN; invoices then
  -- omit the shop's GST and only the platform's commission GST applies.
  gst_registered          boolean     NOT NULL DEFAULT false,

  -- Aadhaar-based e-KYC: only the provider's opaque reference is persisted.
  aadhaar_ref_encrypted   text,
  aadhaar_verified_at     timestamptz,

  -- Uploaded proofs live in the private KYC bucket; only object keys here.
  shop_photo_key          text,
  signboard_photo_key     text,
  address_proof_key       text,
  address_proof_type      text,

  status                  verification_status NOT NULL DEFAULT 'not_submitted',
  submitted_at            timestamptz,
  reviewed_at             timestamptz,
  reviewed_by             uuid REFERENCES users (id),
  rejection_reason        text,
  -- Notes the admin leaves for the owner. Distinct from internal notes, which
  -- live on shop_verification_events.
  reviewer_notes_public   text,
  expires_at              timestamptz,        -- re-verification date, if any

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT shop_kyc_business_type_valid CHECK (
    business_type IN ('proprietorship', 'partnership', 'llp', 'private_limited', 'other')
  ),
  CONSTRAINT shop_kyc_gst_consistency CHECK (gst_registered = false OR gstin_encrypted IS NOT NULL),
  CONSTRAINT shop_kyc_rejection_has_reason CHECK (
    status <> 'rejected' OR rejection_reason IS NOT NULL
  ),
  CONSTRAINT shop_kyc_verified_needs_pan CHECK (
    status <> 'verified' OR pan_encrypted IS NOT NULL
  )
);

-- Duplicate-PAN detection across shops. Not unique — one owner may legitimately
-- run two branches — but indexed so the trust queue can flag it.
CREATE INDEX shop_kyc_pan_hash_idx ON shop_kyc (pan_hash) WHERE pan_hash IS NOT NULL;
CREATE INDEX shop_kyc_gstin_hash_idx ON shop_kyc (gstin_hash) WHERE gstin_hash IS NOT NULL;
CREATE INDEX shop_kyc_queue_idx ON shop_kyc (submitted_at) WHERE status IN ('pending', 'in_review');
CREATE INDEX shop_kyc_expiry_idx ON shop_kyc (expires_at) WHERE expires_at IS NOT NULL AND status = 'verified';

CREATE TRIGGER shop_kyc_updated_at BEFORE UPDATE ON shop_kyc
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE shop_kyc IS
  'Aadhaar numbers are never stored — only an opaque provider reference (PRD §57.2).';


-- ── Bank accounts (payout destinations) ────────────────────────────────────
-- Changing a payout destination is the highest-risk self-service action in the
-- product: it is how a compromised shop account is monetised. So a change
-- requires TOTP, is audited, and puts the shop's payouts on hold for a cooling
-- period (PRD §41.5).
CREATE TABLE shop_bank_accounts (
  id                      uuid PRIMARY KEY,
  shop_id                 uuid        NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  account_holder_name     text        NOT NULL,
  account_number_encrypted text       NOT NULL,
  account_number_hash     text        NOT NULL,
  account_number_last4    text        NOT NULL,
  ifsc                    text        NOT NULL,
  bank_name               text,
  branch_name             text,
  account_type            text        NOT NULL DEFAULT 'savings',

  -- Penny-drop verification through the payment provider.
  verification_status     verification_status NOT NULL DEFAULT 'not_submitted',
  verified_at             timestamptz,
  verification_reference  text,
  verification_failure    text,
  -- Name returned by the penny drop. If it does not match the KYC name the
  -- account is held for manual review rather than silently accepted.
  verified_holder_name    text,

  is_primary              boolean     NOT NULL DEFAULT false,
  -- Payouts are frozen until this instant after a destination change.
  hold_payouts_until      timestamptz,
  -- Provider-side beneficiary/fund-account id, so we do not re-register on
  -- every payout.
  provider_account_id     text,

  created_by              uuid REFERENCES users (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  archived_at             timestamptz,

  CONSTRAINT shop_bank_ifsc_format CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  CONSTRAINT shop_bank_last4_format CHECK (account_number_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT shop_bank_account_type_valid CHECK (account_type IN ('savings', 'current')),
  CONSTRAINT shop_bank_verified_has_timestamp CHECK (
    verification_status <> 'verified' OR verified_at IS NOT NULL
  )
);

-- Exactly one primary account per shop.
CREATE UNIQUE INDEX shop_bank_primary_key ON shop_bank_accounts (shop_id)
  WHERE is_primary AND archived_at IS NULL;
CREATE INDEX shop_bank_shop_idx ON shop_bank_accounts (shop_id) WHERE archived_at IS NULL;
-- Same account number across shops is a fraud signal for the trust queue.
CREATE INDEX shop_bank_account_hash_idx ON shop_bank_accounts (account_number_hash);

CREATE TRIGGER shop_bank_accounts_updated_at BEFORE UPDATE ON shop_bank_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The account number itself can never be edited in place: a different account is
-- a different row, so the audit trail shows exactly which destination was live
-- when each payout was made.
CREATE TRIGGER shop_bank_accounts_immutable_number
  BEFORE UPDATE ON shop_bank_accounts
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('account_number_encrypted', 'account_number_hash', 'ifsc', 'shop_id');


-- ── Verification event log ─────────────────────────────────────────────────
-- Append-only. Every step of the trust decision for a shop: submitted, notes
-- requested, approved, suspended, reinstated — with who and why (FR-802, NFR-16).
CREATE TABLE shop_verification_events (
  id            uuid PRIMARY KEY,
  shop_id       uuid        NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  event         text        NOT NULL,
  from_status   shop_status,
  to_status     shop_status,
  from_verification verification_status,
  to_verification   verification_status,
  actor_user_id uuid REFERENCES users (id),
  actor_role    user_role,
  -- Shown to the shop owner.
  public_note   text,
  -- Internal only; never returned on a shop-facing endpoint.
  internal_note text,
  -- Which checks were performed, as a structured record.
  checks        jsonb       NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT shop_verification_event_valid CHECK (
    event IN (
      'submitted', 'changes_requested', 'resubmitted', 'approved', 'rejected',
      'suspended', 'reinstated', 'paused', 'unpaused', 'closed',
      'kyc_verified', 'kyc_rejected', 'bank_verified', 'bank_rejected',
      'documents_uploaded', 'reverification_due', 'note_added'
    )
  )
);

CREATE INDEX shop_verification_events_shop_idx ON shop_verification_events (shop_id, created_at DESC);
CREATE INDEX shop_verification_events_actor_idx ON shop_verification_events (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE TRIGGER shop_verification_events_append_only
  BEFORE UPDATE OR DELETE ON shop_verification_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();


-- ── Favourites ─────────────────────────────────────────────────────────────
CREATE TABLE favourite_shops (
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  shop_id     uuid        NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, shop_id)
);

CREATE INDEX favourite_shops_shop_idx ON favourite_shops (shop_id);
