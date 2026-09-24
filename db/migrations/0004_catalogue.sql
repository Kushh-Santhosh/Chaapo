-- ═══════════════════════════════════════════════════════════════════════════
-- 0004 — Catalogue and pricing
--
-- Three layers, deliberately separated:
--
--   1. Platform catalogue (`service_categories`, `paper_sizes`, `service_items`)
--      — the canonical, admin-curated list of things a print shop can sell.
--      "A4 · B&W · single-sided" is one row, with a stable code. Because every
--      shop prices the *same* item codes, discovery can compare prices across
--      shops with a join instead of guessing at free-text service names, and a
--      customer's configuration is portable between shops (FR-104, FR-303).
--
--   2. Shop offering (`shop_service_items`) — this shop's price and availability
--      for a platform item. A shop that does not offer an item simply has no row.
--
--   3. Quantity bands (`price_bands`) — bulk tiers on a shop's item. 1–50 pages
--      at ₹2, 51–200 at ₹1.60, 201+ at ₹1.20. Bands are the *only* place
--      per-unit money lives for print work, so the pricing engine has exactly
--      one lookup path (PRD §35).
--
-- Every amount here is the *list* price. What a customer pays is snapshotted onto
-- the order at placement and never read back from these tables (PRD §F inv. 6).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Paper sizes ────────────────────────────────────────────────────────────
-- A reference table rather than an enum: shops in different cities stock
-- different sizes (legal, FS, 12x18 art card) and admins add them without a
-- deploy.
CREATE TABLE paper_sizes (
  code          citext PRIMARY KEY,
  name          text        NOT NULL,
  width_mm      integer     NOT NULL,
  height_mm     integer     NOT NULL,
  -- Sheets of this size per "standard sheet" for capacity maths; A4 = 1, A3 = 2.
  sheet_factor_centi integer NOT NULL DEFAULT 100,
  is_large_format boolean   NOT NULL DEFAULT false,
  sort_order    integer     NOT NULL DEFAULT 100,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT paper_sizes_dimensions CHECK (width_mm BETWEEN 10 AND 5000 AND height_mm BETWEEN 10 AND 5000),
  CONSTRAINT paper_sizes_sheet_factor CHECK (sheet_factor_centi > 0)
);

CREATE INDEX paper_sizes_active_idx ON paper_sizes (sort_order) WHERE is_active;

CREATE TRIGGER paper_sizes_updated_at BEFORE UPDATE ON paper_sizes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Categories ─────────────────────────────────────────────────────────────
CREATE TABLE service_categories (
  id            uuid PRIMARY KEY,
  code          citext      NOT NULL,
  name          text        NOT NULL,
  description   text,
  -- Lucide icon name, so the customer app does not ship a mapping table.
  icon          text,
  sort_order    integer     NOT NULL DEFAULT 100,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX service_categories_code_key ON service_categories (code);

CREATE TRIGGER service_categories_updated_at BEFORE UPDATE ON service_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Platform catalogue items ───────────────────────────────────────────────
CREATE TABLE service_items (
  id                uuid PRIMARY KEY,
  category_id       uuid        NOT NULL REFERENCES service_categories (id),
  code              citext      NOT NULL,
  name              text        NOT NULL,
  short_name        text,                       -- 'A4 B&W' for chips and tables
  description       text,

  -- What kind of thing this is. The pricing engine dispatches on it.
  kind              text        NOT NULL,

  -- Print attributes. Present when kind = 'print', NULL otherwise.
  paper_size_code   citext REFERENCES paper_sizes (code),
  colour_mode       text,                       -- 'bw' | 'colour'
  sides             text,                       -- 'single' | 'double'

  -- What the price is per. Determines which quantity the engine multiplies.
  --   per_page   — printed page images (a 10-page double-sided job = 10 pages)
  --   per_sheet  — physical sheets (that same job = 5 sheets)
  --   per_copy   — once per copy of the document (binding)
  --   per_order  — once per order (a fixed handling charge)
  --   per_sqft   — large format
  price_unit        text        NOT NULL,

  -- Finishing attributes. Present when kind = 'finishing'.
  -- Which paper sizes this finishing can be applied to; empty = any.
  applies_to_paper_sizes citext[] NOT NULL DEFAULT '{}',
  -- Page-count bounds within which the finishing is physically possible
  -- (a spiral binding cannot take 900 pages).
  min_pages         integer,
  max_pages         integer,

  -- Whether a job using this item can be auto-priced at all. Set false for
  -- things that genuinely need a human look (custom sizes, artwork, unusual
  -- media) so the order routes to the quote flow instead of guessing (FR-306).
  auto_priceable    boolean     NOT NULL DEFAULT true,

  -- Baseline minutes this item adds to the turnaround estimate, per unit and
  -- flat. Shops can override; this makes a new shop's estimates sane on day one.
  setup_minutes     integer     NOT NULL DEFAULT 0,
  minutes_per_100_units integer NOT NULL DEFAULT 0,

  sort_order        integer     NOT NULL DEFAULT 100,
  is_active         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT service_items_kind_valid CHECK (kind IN ('print', 'finishing', 'scan', 'handling')),
  CONSTRAINT service_items_price_unit_valid CHECK (
    price_unit IN ('per_page', 'per_sheet', 'per_copy', 'per_order', 'per_sqft')
  ),
  CONSTRAINT service_items_colour_valid CHECK (colour_mode IS NULL OR colour_mode IN ('bw', 'colour')),
  CONSTRAINT service_items_sides_valid CHECK (sides IS NULL OR sides IN ('single', 'double')),
  -- A print item is fully specified: size, colour and sides. Anything less and
  -- two shops could interpret the same code differently.
  CONSTRAINT service_items_print_is_specified CHECK (
    kind <> 'print'
    OR (paper_size_code IS NOT NULL AND colour_mode IS NOT NULL AND sides IS NOT NULL)
  ),
  CONSTRAINT service_items_page_bounds CHECK (
    min_pages IS NULL OR max_pages IS NULL OR max_pages >= min_pages
  ),
  CONSTRAINT service_items_minutes_nonneg CHECK (setup_minutes >= 0 AND minutes_per_100_units >= 0)
);

CREATE UNIQUE INDEX service_items_code_key ON service_items (code);
CREATE INDEX service_items_category_idx ON service_items (category_id, sort_order) WHERE is_active;
CREATE INDEX service_items_kind_idx ON service_items (kind) WHERE is_active;
-- The discovery comparison key: "cheapest A4 B&W single-sided near me".
CREATE UNIQUE INDEX service_items_print_config_key
  ON service_items (paper_size_code, colour_mode, sides)
  WHERE kind = 'print';

CREATE TRIGGER service_items_updated_at BEFORE UPDATE ON service_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN service_items.price_unit IS
  'per_page counts page images; per_sheet counts physical sheets. Duplex halves sheets, not pages.';


-- ── A shop's offering ──────────────────────────────────────────────────────
CREATE TABLE shop_service_items (
  id                    uuid PRIMARY KEY,
  shop_id               uuid        NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  service_item_id       uuid        NOT NULL REFERENCES service_items (id) ON DELETE CASCADE,

  is_available          boolean     NOT NULL DEFAULT true,
  -- Temporarily out (paper ran out, laminator broken). Distinct from
  -- is_available, which is the durable "we don't do this".
  unavailable_until     timestamptz,
  unavailable_reason    text,

  -- Flat charge added once when this item appears on an order, on top of the
  -- per-unit bands. Covers machine setup for small jobs.
  setup_fee_paise       bigint      NOT NULL DEFAULT 0,
  -- Order-level floor for this item: a 2-page job still costs at least this.
  min_charge_paise      bigint      NOT NULL DEFAULT 0,

  min_quantity          integer     NOT NULL DEFAULT 1,
  max_quantity          integer,

  -- Turnaround contribution overrides. NULL falls back to the catalogue item.
  setup_minutes         integer,
  minutes_per_100_units integer,

  -- Force the quote flow for this item at this shop regardless of the catalogue
  -- default — e.g. a shop that wants to eyeball every binding job.
  requires_quote        boolean     NOT NULL DEFAULT false,
  -- Above this quantity the shop wants to quote manually rather than auto-price.
  quote_above_quantity  integer,

  notes                 text,       -- shown to the customer on the configure screen
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT shop_service_items_fees_nonneg CHECK (setup_fee_paise >= 0 AND min_charge_paise >= 0),
  CONSTRAINT shop_service_items_quantity_bounds CHECK (
    min_quantity >= 1 AND (max_quantity IS NULL OR max_quantity >= min_quantity)
  ),
  CONSTRAINT shop_service_items_minutes_nonneg CHECK (
    (setup_minutes IS NULL OR setup_minutes >= 0)
    AND (minutes_per_100_units IS NULL OR minutes_per_100_units >= 0)
  ),
  CONSTRAINT shop_service_items_unavailable_paired CHECK (
    unavailable_until IS NULL OR unavailable_reason IS NOT NULL
  )
);

CREATE UNIQUE INDEX shop_service_items_key ON shop_service_items (shop_id, service_item_id);
CREATE INDEX shop_service_items_shop_idx ON shop_service_items (shop_id) WHERE is_available;
-- Reverse direction: "which shops offer A3 colour", used by discovery filters.
CREATE INDEX shop_service_items_item_idx ON shop_service_items (service_item_id) WHERE is_available;

CREATE TRIGGER shop_service_items_updated_at BEFORE UPDATE ON shop_service_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Quantity bands ─────────────────────────────────────────────────────────
-- Half-open ranges: `min_quantity` inclusive, `max_quantity` inclusive, NULL
-- meaning "and above". Exactly one band must match any quantity; the domain
-- layer validates coverage and contiguity on save, and the pricing engine treats
-- a missing band as an error rather than falling back to zero (PRD §35.3).
CREATE TABLE price_bands (
  id                    uuid PRIMARY KEY,
  shop_service_item_id  uuid        NOT NULL REFERENCES shop_service_items (id) ON DELETE CASCADE,
  min_quantity          integer     NOT NULL,
  max_quantity          integer,
  unit_price_paise      bigint      NOT NULL,
  -- Optional label shown on the price breakdown: "Bulk (200+)".
  label                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT price_bands_min_positive CHECK (min_quantity >= 1),
  CONSTRAINT price_bands_range_ordered CHECK (max_quantity IS NULL OR max_quantity >= min_quantity),
  CONSTRAINT price_bands_price_nonneg CHECK (unit_price_paise >= 0),
  -- A ₹500-per-page rate is a data-entry accident, not a business model.
  CONSTRAINT price_bands_price_sane CHECK (unit_price_paise <= 10000000)
);

CREATE UNIQUE INDEX price_bands_start_key ON price_bands (shop_service_item_id, min_quantity);
CREATE INDEX price_bands_lookup_idx ON price_bands (shop_service_item_id, min_quantity DESC);
-- At most one open-ended top band per item.
CREATE UNIQUE INDEX price_bands_single_open_band
  ON price_bands (shop_service_item_id)
  WHERE max_quantity IS NULL;

CREATE TRIGGER price_bands_updated_at BEFORE UPDATE ON price_bands
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE price_bands IS
  'The only source of per-unit print pricing. A quantity with no matching band is a pricing error, never free.';


-- ── Which finishings a shop will apply to which print items ────────────────
-- Not every finishing pairs with every print item at every shop: a shop may
-- spiral-bind A4 but not A3. Absence of a row means "not offered", so the
-- configure screen only shows achievable combinations (FR-304).
CREATE TABLE shop_finishing_compatibility (
  id                        uuid PRIMARY KEY,
  shop_id                   uuid  NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  finishing_item_id         uuid  NOT NULL REFERENCES service_items (id) ON DELETE CASCADE,
  paper_size_code           citext NOT NULL REFERENCES paper_sizes (code),
  max_pages                 integer,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX shop_finishing_compatibility_key
  ON shop_finishing_compatibility (shop_id, finishing_item_id, paper_size_code);
CREATE INDEX shop_finishing_compatibility_shop_idx ON shop_finishing_compatibility (shop_id);


-- ── Shop-level pricing modifiers ───────────────────────────────────────────
-- Rush surcharges and coupon-free discounts, kept as data so a shop owner can
-- run "10 % off before 10 am" without a deploy. Applied by the pricing engine in
-- a fixed order and itemised on the quote, never folded silently into the total
-- (PRD §35.6).
CREATE TABLE shop_price_modifiers (
  id                uuid PRIMARY KEY,
  shop_id           uuid        NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  code              citext      NOT NULL,
  label             text        NOT NULL,     -- shown on the customer's breakdown
  kind              text        NOT NULL,     -- 'surcharge' | 'discount'
  -- Either a percentage of the matched subtotal or a flat amount, not both.
  rate_bps          integer,
  flat_paise        bigint,
  -- What it applies to: the whole order or one catalogue item.
  scope             text        NOT NULL DEFAULT 'order',
  service_item_id   uuid REFERENCES service_items (id) ON DELETE CASCADE,
  -- Conditions. NULL means "no condition of this type".
  min_order_paise   bigint,
  min_quantity      integer,
  -- Time window in IST minutes-from-midnight, and the weekdays it applies on.
  active_from_minute integer,
  active_to_minute   integer,
  active_weekdays    smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  starts_at         timestamptz,
  ends_at           timestamptz,
  -- Cap on how much a percentage discount can take off.
  max_discount_paise bigint,
  priority          integer     NOT NULL DEFAULT 100,
  is_active         boolean     NOT NULL DEFAULT true,
  created_by        uuid REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT shop_price_modifiers_kind_valid CHECK (kind IN ('surcharge', 'discount')),
  CONSTRAINT shop_price_modifiers_scope_valid CHECK (scope IN ('order', 'item')),
  CONSTRAINT shop_price_modifiers_item_scope CHECK (
    (scope = 'item') = (service_item_id IS NOT NULL)
  ),
  -- Exactly one of rate or flat amount.
  CONSTRAINT shop_price_modifiers_one_amount CHECK (
    (rate_bps IS NOT NULL AND flat_paise IS NULL)
    OR (rate_bps IS NULL AND flat_paise IS NOT NULL)
  ),
  CONSTRAINT shop_price_modifiers_rate_sane CHECK (rate_bps IS NULL OR rate_bps BETWEEN 0 AND 5000),
  CONSTRAINT shop_price_modifiers_flat_positive CHECK (flat_paise IS NULL OR flat_paise > 0),
  CONSTRAINT shop_price_modifiers_window_paired CHECK (
    (active_from_minute IS NULL) = (active_to_minute IS NULL)
  ),
  CONSTRAINT shop_price_modifiers_window_range CHECK (
    active_from_minute IS NULL
    OR (active_from_minute BETWEEN 0 AND 1439 AND active_to_minute BETWEEN 0 AND 1440)
  ),
  CONSTRAINT shop_price_modifiers_dates_ordered CHECK (
    starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at
  )
);

CREATE UNIQUE INDEX shop_price_modifiers_code_key ON shop_price_modifiers (shop_id, code);
CREATE INDEX shop_price_modifiers_active_idx ON shop_price_modifiers (shop_id, priority) WHERE is_active;

CREATE TRIGGER shop_price_modifiers_updated_at BEFORE UPDATE ON shop_price_modifiers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Price-list change history ──────────────────────────────────────────────
-- Append-only. A customer disputing "the price went up between me looking and me
-- paying" is answered from this table, and an admin investigating a shop that
-- doubles prices at 6 pm can see it (PRD §35.8, NFR-16).
CREATE TABLE shop_price_history (
  id                    uuid PRIMARY KEY,
  shop_id               uuid        NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  service_item_id       uuid REFERENCES service_items (id) ON DELETE SET NULL,
  change               text        NOT NULL,
  -- The full before/after of the affected shop_service_item and its bands.
  before               jsonb,
  after                jsonb,
  actor_user_id        uuid REFERENCES users (id),
  actor_role           user_role,
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT shop_price_history_change_valid CHECK (
    change IN ('item_added', 'item_removed', 'item_updated', 'bands_updated',
               'availability_changed', 'modifier_added', 'modifier_updated',
               'modifier_removed', 'bulk_import')
  )
);

CREATE INDEX shop_price_history_shop_idx ON shop_price_history (shop_id, created_at DESC);

CREATE TRIGGER shop_price_history_append_only
  BEFORE UPDATE OR DELETE ON shop_price_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
