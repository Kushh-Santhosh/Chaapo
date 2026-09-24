-- ═══════════════════════════════════════════════════════════════════════════
-- 0011 — Reference data
--
-- Everything in this migration is platform-owned data that the product cannot
-- function without: paper sizes, the service catalogue, launch cities, invoice
-- series, the business-policy config store, feature flags, and the message
-- templates. It is data rather than code because admins change it without a
-- deploy, and it is a migration rather than a seed script because a fresh database
-- with no paper sizes is not a working system.
--
-- This is deliberately NOT demo data. There are no shops, no users and no orders
-- here; those live in the seed script, which is only ever run in development.
-- ═══════════════════════════════════════════════════════════════════════════

-- Reference rows need stable ids: a shop's catalogue points at `service_items.id`,
-- so those ids must be identical in every environment. Derived from the row's own
-- code, so there is no hand-typed UUID to mistype and no ordering dependency.
CREATE OR REPLACE FUNCTION reference_uuid(seed text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (
    substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-7' || substr(h, 14, 3)
    || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12)
  )::uuid
  FROM (SELECT md5('chaapo:reference:' || seed) AS h) s;
$$;

COMMENT ON FUNCTION reference_uuid(text) IS
  'Deterministic id for platform reference data, so catalogue ids match across environments. Application rows use newId() (UUIDv7) instead.';


-- ── Paper sizes ────────────────────────────────────────────────────────────
-- sheet_factor_centi is A4-relative area, used for capacity and turnaround maths:
-- an A3 sheet is two A4s through the machine.
INSERT INTO paper_sizes (code, name, width_mm, height_mm, sheet_factor_centi, is_large_format, sort_order) VALUES
  ('A4',      'A4',            210,  297,  100,  false, 10),
  ('A3',      'A3',            297,  420,  200,  false, 20),
  ('A5',      'A5',            148,  210,   50,  false, 30),
  ('LEGAL',   'Legal',         216,  356,  123,  false, 40),
  ('FS',      'Foolscap (FS)', 203,  330,  107,  false, 50),
  ('LETTER',  'Letter',        216,  279,   97,  false, 60),
  ('A2',      'A2',            420,  594,  400,  true,  70),
  ('A1',      'A1',            594,  841,  800,  true,  80),
  ('A0',      'A0',            841, 1189, 1600,  true,  90),
  ('PHOTO4R', 'Photo 4R (4x6)',102,  152,   25,  false,100);


-- ── Categories ─────────────────────────────────────────────────────────────
-- `icon` is a Lucide name so the customer app renders the catalogue without
-- shipping its own mapping table.
INSERT INTO service_categories (id, code, name, description, icon, sort_order)
SELECT reference_uuid('service_category:' || code), code, name, description, icon, sort_order
FROM (VALUES
  ('printing',     'Printing',              'Documents printed from your uploaded files',        'printer',    10),
  ('finishing',    'Binding & Finishing',   'Binding, lamination and stapling for printed jobs', 'book-open',  20),
  ('large_format', 'Posters & Large Format','A2, A1 and A0 prints',                              'scaling',    30),
  ('scanning',     'Scanning',              'Physical documents scanned to PDF at the counter',  'scan-line',  40),
  ('handling',     'Service Charges',       'Handling, packaging and quoted custom work',        'receipt',    50)
) AS t(code, name, description, icon, sort_order);


-- ── Print items ────────────────────────────────────────────────────────────
-- Generated as size × colour × sides rather than written out, because the set must
-- be complete and consistent: `service_items_print_config_key` makes each
-- combination unique, and a shop's price list is keyed on these ids.
--
-- price_unit is per_page for every print item: Indian print shops quote per printed
-- side, and duplex is expressed as a lower per-page rate rather than as sheet maths.
WITH sizes AS (
  SELECT * FROM (VALUES
    ('A4',     'A4',     1, 1.0),
    ('A3',     'A3',     2, 2.0),
    ('A5',     'A5',     3, 1.0),
    ('LEGAL',  'Legal',  4, 1.2),
    ('FS',     'FS',     5, 1.1),
    ('LETTER', 'Letter', 6, 1.0)
  ) AS t(size_code, size_label, size_sort, minute_factor)
), modes AS (
  SELECT * FROM (VALUES
    ('bw',     'B&W',     1,  4),
    ('colour', 'Colour',  2, 10)
  ) AS t(colour_mode, colour_label, colour_sort, base_minutes)
), faces AS (
  SELECT * FROM (VALUES
    ('single', 'Single-sided', 1, 0),
    ('double', 'Double-sided', 2, 1)
  ) AS t(sides, sides_label, sides_sort, extra_minutes)
)
INSERT INTO service_items (
  id, category_id, code, name, short_name, description,
  kind, paper_size_code, colour_mode, sides, price_unit,
  auto_priceable, setup_minutes, minutes_per_100_units, sort_order
)
SELECT
  reference_uuid('service_item:' || code),
  reference_uuid('service_category:printing'),
  code,
  sz.size_label || ' ' || md.colour_label || ' (' || fc.sides_label || ')',
  sz.size_label || ' ' || md.colour_label,
  'Printed on ' || sz.size_label || ' paper, ' || lower(fc.sides_label) || ', ' || lower(md.colour_label) || '.',
  'print',
  sz.size_code,
  md.colour_mode,
  fc.sides,
  'per_page',
  true,
  2,
  round((md.base_minutes + fc.extra_minutes) * sz.minute_factor)::integer,
  sz.size_sort * 10 + md.colour_sort * 2 + fc.sides_sort
FROM sizes sz
CROSS JOIN modes md
CROSS JOIN faces fc
CROSS JOIN LATERAL (
  SELECT 'print_' || lower(sz.size_code) || '_' || md.colour_mode || '_' || fc.sides AS code
) c;


-- Large format is single-sided colour only; nobody duplex-prints a poster.
INSERT INTO service_items (
  id, category_id, code, name, short_name, description,
  kind, paper_size_code, colour_mode, sides, price_unit,
  auto_priceable, setup_minutes, minutes_per_100_units, sort_order
)
SELECT
  reference_uuid('service_item:' || code),
  reference_uuid('service_category:large_format'),
  code, name, short_name, description,
  'print', paper_size_code, 'colour', 'single', 'per_sheet',
  true, 5, minutes_per_100, sort_order
FROM (VALUES
  ('print_a2_poster', 'A2 Poster', 'A2 Poster', 'Full-colour A2 poster print.', 'A2', 300, 110),
  ('print_a1_poster', 'A1 Poster', 'A1 Poster', 'Full-colour A1 poster print.', 'A1', 500, 120),
  ('print_a0_poster', 'A0 Poster', 'A0 Poster', 'Full-colour A0 poster print.', 'A0', 800, 130)
) AS t(code, name, short_name, description, paper_size_code, minutes_per_100, sort_order);


-- ── Finishing ──────────────────────────────────────────────────────────────
-- min_pages / max_pages are physical limits, not pricing rules: a spiral comb does
-- not close over 500 pages. The pricing engine refuses the combination rather than
-- quoting something the shop cannot make (FR-305).
INSERT INTO service_items (
  id, category_id, code, name, short_name, description,
  kind, price_unit, applies_to_paper_sizes, min_pages, max_pages,
  auto_priceable, setup_minutes, minutes_per_100_units, sort_order
)
SELECT
  reference_uuid('service_item:' || code),
  reference_uuid('service_category:finishing'),
  code, name, short_name, description,
  'finishing', price_unit, applies_to::citext[], min_pages, max_pages,
  true, setup_minutes, 0, sort_order
FROM (VALUES
  ('finish_spiral_binding', 'Spiral Binding',      'Spiral',     'Plastic comb binding with a transparent front cover.',
     'per_copy', ARRAY['A4','A3','A5','LEGAL','FS','LETTER'],  10, 500, 3, 210),
  ('finish_soft_binding',   'Soft Binding',        'Soft bind',  'Thermal soft binding with a printed card cover.',
     'per_copy', ARRAY['A4','A5','LEGAL','FS','LETTER'],        20, 400, 5, 220),
  ('finish_hard_binding',   'Hard Binding',        'Hard bind',  'Hardbound with gold lettering, typical for project reports.',
     'per_copy', ARRAY['A4','LEGAL','FS','LETTER'],             20, 600,15, 230),
  ('finish_staple',         'Stapling',            'Staple',     'Corner or side stapling.',
     'per_copy', ARRAY['A4','A3','A5','LEGAL','FS','LETTER'],    2,  60, 1, 240),
  ('finish_punching',       'Hole Punching',       'Punch',      'Two-hole punch for filing.',
     'per_copy', ARRAY['A4','A3','A5','LEGAL','FS','LETTER'],    1, 200, 1, 250),
  ('finish_lamination',     'Lamination',          'Lamination', 'Glossy or matte lamination, priced per sheet.',
     'per_sheet', ARRAY['A4','A3','A5','LEGAL','FS','LETTER','PHOTO4R'], NULL, NULL, 2, 260),
  ('finish_cover_page',     'Transparent Cover',   'Cover',      'Clear front sheet and card back sheet.',
     'per_copy', ARRAY['A4','A3','A5','LEGAL','FS','LETTER'],  NULL, NULL, 1, 270)
) AS t(code, name, short_name, description, price_unit, applies_to, min_pages, max_pages, setup_minutes, sort_order);


-- ── Scanning and service charges ───────────────────────────────────────────
INSERT INTO service_items (
  id, category_id, code, name, short_name, description,
  kind, colour_mode, price_unit,
  auto_priceable, setup_minutes, minutes_per_100_units, sort_order
)
SELECT
  reference_uuid('service_item:' || code),
  reference_uuid('service_category:scanning'),
  code, name, short_name, description,
  'scan', colour_mode, 'per_page',
  true, 3, minutes_per_100, sort_order
FROM (VALUES
  ('scan_bw',     'Scan to PDF',        'Scan',        'Black-and-white scan of a physical document, delivered as a PDF.', 'bw',      8, 310),
  ('scan_colour', 'Colour Scan to PDF', 'Colour scan', 'Colour scan of a physical document, delivered as a PDF.',          'colour', 14, 320)
) AS t(code, name, short_name, description, colour_mode, minutes_per_100, sort_order);

INSERT INTO service_items (
  id, category_id, code, name, short_name, description,
  kind, price_unit, auto_priceable, setup_minutes, minutes_per_100_units, sort_order
)
SELECT
  reference_uuid('service_item:' || code),
  reference_uuid('service_category:handling'),
  code, name, short_name, description,
  'handling', 'per_order', auto_priceable, setup_minutes, 0, sort_order
FROM (VALUES
  ('handling_packaging', 'Packaging',   'Packaging', 'Envelope or carry bag for the finished job.',                       true,  0, 410),
  ('handling_urgent',    'Rush Job',    'Rush',      'Moved to the front of the queue where the shop offers it.',         true,  0, 420),
  -- The quote path made explicit. A job that cannot be auto-priced becomes a single
  -- line of this kind, so the order still has a real, itemised line item once the
  -- shop has quoted it (FR-306).
  ('quote_custom_job',   'Custom Job',  'Custom',    'Work the shop prices by hand: unusual media, artwork, or bulk.',    false, 0, 430)
) AS t(code, name, short_name, description, auto_priceable, setup_minutes, sort_order);


-- ── Cities ─────────────────────────────────────────────────────────────────
-- All start not-live. A city goes live from the admin console once it has verified
-- shops, because a live city with nothing in it is a worse first impression than a
-- waitlist (FR-108).
INSERT INTO cities (id, slug, name, state, centre, radius_m, is_live)
SELECT
  reference_uuid('city:' || slug), slug, name, state,
  ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
  radius_m, false
FROM (VALUES
  ('mumbai',    'Mumbai',    'Maharashtra',    72.8777, 19.0760, 45000),
  ('pune',      'Pune',      'Maharashtra',    73.8567, 18.5204, 30000),
  ('delhi',     'Delhi',     'Delhi',          77.2090, 28.6139, 45000),
  ('gurugram',  'Gurugram',  'Haryana',        77.0266, 28.4595, 25000),
  ('noida',     'Noida',     'Uttar Pradesh',  77.3910, 28.5355, 25000),
  ('bengaluru', 'Bengaluru', 'Karnataka',      77.5946, 12.9716, 40000),
  ('hyderabad', 'Hyderabad', 'Telangana',      78.4867, 17.3850, 40000),
  ('chennai',   'Chennai',   'Tamil Nadu',     80.2707, 13.0827, 35000),
  ('kolkata',   'Kolkata',   'West Bengal',    88.3639, 22.5726, 35000),
  ('ahmedabad', 'Ahmedabad', 'Gujarat',        72.5714, 23.0225, 30000),
  ('jaipur',    'Jaipur',    'Rajasthan',      75.7873, 26.9124, 25000),
  ('indore',    'Indore',    'Madhya Pradesh', 75.8577, 22.7196, 25000),
  ('lucknow',   'Lucknow',   'Uttar Pradesh',  80.9462, 26.8467, 25000),
  ('kochi',     'Kochi',     'Kerala',         76.2673,  9.9312, 25000),
  ('coimbatore','Coimbatore','Tamil Nadu',     76.9558, 11.0168, 22000),
  ('bhopal',    'Bhopal',    'Madhya Pradesh', 77.4126, 23.2599, 22000),
  ('nagpur',    'Nagpur',    'Maharashtra',    79.0882, 21.1458, 25000),
  ('chandigarh','Chandigarh','Chandigarh',     76.7794, 30.7333, 20000)
) AS t(slug, name, state, lon, lat, radius_m);


-- ── Invoice series ─────────────────────────────────────────────────────────
-- Sequential numbering per series per financial year is a GST requirement. The
-- application opens the next year's series on 1 April; these are the current ones.
INSERT INTO invoice_series (id, code, financial_year, prefix, next_number)
SELECT reference_uuid('invoice_series:' || code || ':' || financial_year), code, financial_year, prefix, 1
FROM (VALUES
  ('customer_receipt',   '2026-27', 'CHP/R/2026-27/'),
  ('commission_invoice', '2026-27', 'CHP/C/2026-27/'),
  ('credit_note',        '2026-27', 'CHP/CN/2026-27/'),
  ('payout_statement',   '2026-27', 'CHP/PS/2026-27/')
) AS t(code, financial_year, prefix);


-- ── Business policy ────────────────────────────────────────────────────────
-- Every number the business might want to change without a deploy lives here, with
-- bounds, so a mistyped commission rate is rejected by the database rather than
-- discovered in a shop's payout. Money is paise, rates are basis points, and the
-- unit is recorded so the console renders "8%" rather than "800".
--
-- The commission model is shop-side only: the customer pays the shop's price and
-- nothing more, and the platform's 8% comes out of the shop's share (PRD open
-- question 1). `customer.platform_fee_paise` exists at zero so the plumbing is real
-- if that ever changes.
INSERT INTO platform_config (
  key, value, value_type, section, label, description, unit,
  min_value, max_value, requires_super_admin, is_public, is_readonly
)
SELECT key, value::jsonb, value_type, section, label, description, unit,
       min_value, max_value, requires_super_admin, is_public, false
FROM (VALUES
  -- Commission and taxes.
  ('commission.rate_bps', '800', 'bps', 'commission', 'Commission rate',
   'Platform commission taken from the shop''s share of every collected order.', '%', 0, 3000, true, false),
  ('commission.min_paise', '200', 'paise', 'commission', 'Minimum commission',
   'Floor on commission per order, so tiny orders still cover payment costs.', '₹', 0, 10000, true, false),
  ('commission.tax_rate_bps', '1800', 'bps', 'commission', 'GST on commission',
   'GST charged on the platform''s commission invoice to the shop.', '%', 0, 3000, true, false),
  ('commission.tds_rate_bps', '10', 'bps', 'commission', 'TDS rate (194-O)',
   'Tax deducted at source on gross order value, withheld from payouts.', '%', 0, 500, true, false),
  ('customer.platform_fee_paise', '0', 'paise', 'commission', 'Customer platform fee',
   'Fee added to the customer''s total. Zero: the customer pays the shop''s price.', '₹', 0, 5000, true, true),

  -- Order lifecycle timers.
  ('orders.accept_window_minutes', '15', 'minutes', 'orders', 'Shop acceptance window',
   'How long a shop has to accept a paid order before it is auto-cancelled and refunded.', 'min', 5, 120, false, true),
  ('orders.payment_intent_ttl_minutes', '20', 'minutes', 'orders', 'Checkout window',
   'How long a payment intent stays valid before the order returns to draft.', 'min', 5, 60, false, false),
  ('orders.draft_ttl_hours', '24', 'hours', 'orders', 'Draft lifetime',
   'Abandoned drafts are cancelled and their files scheduled for deletion after this.', 'h', 1, 168, false, false),
  ('orders.quote_response_hours', '4', 'hours', 'orders', 'Quote response target',
   'How long a shop has to answer a quote request before it is escalated.', 'h', 1, 72, false, true),
  ('orders.quote_validity_hours', '24', 'hours', 'orders', 'Quote validity',
   'How long a customer has to accept a quote before it expires.', 'h', 1, 168, false, true),
  ('orders.hold_response_minutes', '120', 'minutes', 'orders', 'File-issue hold window',
   'How long an order may sit on hold for a file problem before it is auto-cancelled.', 'min', 15, 1440, false, true),
  ('orders.max_open_per_customer', '5', 'integer', 'orders', 'Concurrent open orders',
   'How many live orders one customer may have at once.', NULL, 1, 50, false, false),

  -- Pickup and collection.
  ('pickup.grace_hours', '48', 'hours', 'pickup', 'Pickup grace period',
   'After an order is ready, how long the customer has to collect before it expires with no refund.', 'h', 6, 336, false, true),
  ('pickup.reminder_hours', '12', 'hours', 'pickup', 'Pickup reminder',
   'How long after ready the first collection reminder is sent.', 'h', 1, 168, false, false),
  ('pickup.code_max_attempts', '5', 'integer', 'pickup', 'Pickup code attempts',
   'Failed pickup-code entries before verification locks at that shop.', NULL, 3, 20, false, false),
  ('pickup.lock_minutes', '15', 'minutes', 'pickup', 'Pickup lockout',
   'How long pickup verification is locked after too many failed attempts.', 'min', 1, 120, false, false),

  -- Refunds. The policy the PRD's open question 2 settles on.
  ('refunds.free_cancel_until_accepted', 'true', 'boolean', 'refunds', 'Free cancellation before acceptance',
   'A customer may cancel for a full refund at any time before the shop accepts.', NULL, NULL, NULL, true, true),
  ('refunds.accepted_pre_print_bps', '10000', 'bps', 'refunds', 'Refund after acceptance, before printing',
   'Share refunded when a customer cancels after acceptance but before printing starts.', '%', 0, 10000, true, true),
  ('refunds.during_printing_bps', '0', 'bps', 'refunds', 'Refund during or after printing',
   'Share refunded once printing has started. Zero: the paper and toner are spent.', '%', 0, 10000, true, true),
  ('refunds.expired_pickup_bps', '0', 'bps', 'refunds', 'Refund after pickup expiry',
   'Share refunded when the customer never collects. Zero: the work was done.', '%', 0, 10000, true, true),
  ('refunds.auto_approve_below_paise', '50000', 'paise', 'refunds', 'Auto-approve refunds below',
   'Refunds under this amount are processed without an admin looking at them.', '₹', 0, 1000000, true, false),

  -- Files, privacy and retention.
  ('files.max_bytes', '52428800', 'integer', 'files', 'Maximum file size',
   'Largest single upload accepted.', 'bytes', 1048576, 524288000, false, true),
  ('files.max_per_order', '20', 'integer', 'files', 'Files per order',
   'How many files one order may contain.', NULL, 1, 100, false, true),
  ('files.max_pages_per_file', '1000', 'integer', 'files', 'Pages per file',
   'Page-count ceiling for a single document.', NULL, 1, 5000, false, true),
  ('files.signed_url_ttl_seconds', '300', 'integer', 'files', 'Signed URL lifetime',
   'How long a download link for a customer file stays valid. Short by design.', 's', 30, 3600, true, false),
  ('files.retention_days_after_collection', '7', 'days', 'files', 'Retention after collection',
   'Days a completed order''s files are kept before the bytes are deleted.', 'd', 1, 90, true, true),
  ('files.retention_days_unused', '2', 'days', 'files', 'Retention for unused uploads',
   'Days an uploaded file with no placed order is kept.', 'd', 1, 30, true, true),
  ('files.retention_days_cancelled', '3', 'days', 'files', 'Retention after cancellation',
   'Days a cancelled order''s files are kept, in case the customer reorders.', 'd', 1, 30, true, true),

  -- Discovery.
  ('discovery.default_radius_m', '3000', 'integer', 'discovery', 'Default search radius',
   'Radius used when a customer opens discovery with a device location.', 'm', 500, 25000, false, true),
  ('discovery.max_radius_m', '15000', 'integer', 'discovery', 'Maximum search radius',
   'Furthest a customer may widen the search.', 'm', 1000, 50000, false, true),
  ('discovery.max_results', '50', 'integer', 'discovery', 'Results per search',
   'Shops returned in one discovery response.', NULL, 5, 200, false, false),

  -- Payouts.
  ('payouts.hold_hours_after_collection', '24', 'hours', 'payouts', 'Settlement hold',
   'How long after collection an order becomes eligible for payout.', 'h', 0, 336, true, false),
  ('payouts.min_paise', '10000', 'paise', 'payouts', 'Minimum payout',
   'Balance below which a payout is rolled into the next window.', '₹', 0, 1000000, true, false),
  ('payouts.new_shop_hold_days', '7', 'days', 'payouts', 'New shop hold',
   'Days a newly verified shop''s earnings are held before the first payout.', 'd', 0, 60, true, false),
  ('payouts.schedule', '"weekly"', 'string', 'payouts', 'Payout schedule',
   'How often settlement windows close: daily or weekly.', NULL, NULL, NULL, true, false),

  -- Notifications.
  ('notifications.quiet_hours_start_minute', '1320', 'minutes', 'notifications', 'Quiet hours start',
   'Minute of the day after which non-transactional messages are held. 1320 = 22:00 IST.', NULL, 0, 1439, false, false),
  ('notifications.quiet_hours_end_minute', '420', 'minutes', 'notifications', 'Quiet hours end',
   'Minute of the day after which messages resume. 420 = 07:00 IST.', NULL, 0, 1439, false, false),
  ('notifications.sms_fallback_after_seconds', '120', 'integer', 'notifications', 'SMS fallback delay',
   'How long to wait for a push delivery receipt before falling back to SMS on critical messages.', 's', 15, 1800, false, false),

  -- Ratings.
  ('ratings.window_days', '14', 'days', 'ratings', 'Rating window',
   'Days after collection during which a customer may rate the order.', 'd', 1, 90, false, true),
  ('ratings.editable_hours', '24', 'hours', 'ratings', 'Rating edit window',
   'Hours a customer may edit a submitted rating.', 'h', 0, 168, false, true),
  ('ratings.min_count_for_display', '3', 'integer', 'ratings', 'Ratings before display',
   'Ratings a shop needs before an average is shown, so one review cannot define a shop.', NULL, 1, 50, false, true),

  -- Security.
  ('security.otp_ttl_seconds', '300', 'integer', 'security', 'OTP lifetime',
   'How long a login OTP stays valid.', 's', 60, 900, true, false),
  ('security.otp_max_attempts', '5', 'integer', 'security', 'OTP attempts',
   'Wrong OTP entries before the challenge is burned.', NULL, 3, 10, true, false),
  ('security.otp_resend_seconds', '30', 'integer', 'security', 'OTP resend cooldown',
   'Minimum gap between OTP sends to one number.', 's', 15, 300, false, true),
  ('security.customer_session_days', '30', 'days', 'security', 'Customer session length',
   'Days a customer stays signed in on a device.', 'd', 1, 365, true, false),
  ('security.shop_session_hours', '12', 'hours', 'security', 'Shop session length',
   'Hours a shop dashboard session lasts. Short, because the device sits on a counter.', 'h', 1, 168, true, false),
  -- 30, not 60: this must agree with SESSION_POLICY.admin.idleSeconds in
  -- src/server/auth/policy.ts, which is what the session layer enforces.
  ('security.admin_session_minutes', '30', 'minutes', 'security', 'Admin session length',
   'Minutes an admin console session lasts before re-authentication.', 'min', 15, 480, true, false),

  -- Trust and risk.
  ('risk.max_orders_per_customer_per_hour', '10', 'integer', 'risk', 'Order rate limit',
   'Orders one customer may place per hour before the trust queue is notified.', NULL, 1, 100, false, false),
  ('risk.max_failed_pickups_before_flag', '3', 'integer', 'risk', 'Failed pickup threshold',
   'Failed pickup verifications at a shop in a day before a risk flag is raised.', NULL, 1, 50, false, false),
  ('risk.shop_cancel_rate_flag_bps', '1500', 'bps', 'risk', 'Shop cancellation rate flag',
   'Rolling cancellation rate at which a shop is flagged for review.', '%', 0, 10000, false, false),

  -- Privacy rights.
  ('privacy.export_ttl_hours', '48', 'hours', 'privacy', 'Data export lifetime',
   'Hours a generated data export stays downloadable before it is deleted.', 'h', 1, 168, true, false),
  ('privacy.erasure_grace_days', '7', 'days', 'privacy', 'Erasure grace period',
   'Days between a verified erasure request and execution, so a hijacked account cannot be erased to cover tracks.', 'd', 0, 30, true, false),
  ('privacy.financial_retention_years', '8', 'integer', 'privacy', 'Financial record retention',
   'Years invoices and ledger entries are retained regardless of erasure requests, as the law requires.', 'y', 5, 15, true, true),

  -- Service levels.
  ('sla.ready_estimate_buffer_minutes', '10', 'minutes', 'sla', 'Turnaround buffer',
   'Padding added to the estimated ready time shown to the customer.', 'min', 0, 120, false, false),
  ('sla.shop_first_response_minutes', '10', 'minutes', 'sla', 'Shop response target',
   'Target time for a shop to acknowledge a new order, used for shop scoring.', 'min', 1, 120, false, false),
  ('sla.dispute_first_response_hours', '24', 'hours', 'sla', 'Dispute response target',
   'Target time for the platform to respond to a dispute.', 'h', 1, 168, false, true)
) AS t(key, value, value_type, section, label, description, unit,
       min_value, max_value, requires_super_admin, is_public)
ON CONFLICT (key) DO NOTHING;


-- ── Feature flags ──────────────────────────────────────────────────────────
INSERT INTO feature_flags (key, label, description, is_enabled, rollout_bps)
VALUES
  ('quote_flow', 'Quote-required orders',
   'Jobs that cannot be auto-priced route to a shop quote instead of being refused.', true, 10000),
  ('whatsapp_notifications', 'WhatsApp notifications',
   'Send order updates over WhatsApp in addition to push and SMS.', false, 0),
  ('scan_at_counter', 'Counter scanning',
   'Shops offer scanning of physical documents brought to the counter.', false, 0),
  ('large_format_catalogue', 'Posters and large format',
   'Expose A2/A1/A0 items in the customer catalogue.', false, 0),
  ('scheduled_pickup', 'Scheduled pickup slots',
   'Customers choose a collection slot instead of collecting whenever ready.', false, 0),
  ('shop_counter_orders', 'Counter-created orders',
   'Shop staff create an order on the customer''s behalf at the counter.', false, 0),
  ('public_review_comments', 'Public review comments',
   'Show customer comments on a shop''s public profile, not just the star average.', true, 10000),
  ('admin_impersonation', 'Admin impersonation',
   'Support staff may view the app as a user. Off by default; every session is audited.', false, 0)
ON CONFLICT (key) DO NOTHING;


-- ── Message templates ──────────────────────────────────────────────────────
-- One row per (key, channel, locale, audience). Bodies use {{variable}} tokens that
-- must appear in `variables`, so a missing value is a caught render error rather
-- than a message reading "Your order  is ready".
--
-- Note what is absent: no pickup code, in any channel. The code is shown in the app
-- behind authentication, and messages link there instead. The CHECK constraint
-- added in 0010 makes that structural rather than a habit.
INSERT INTO notification_templates (
  id, key, channel, locale, audience, subject, title, body,
  action_path, action_label, variables, is_transactional, dedupe_window_seconds, priority
)
SELECT
  reference_uuid('notification_template:' || key || ':' || channel || ':' || audience),
  key, channel::notification_channel, 'en-IN', audience,
  subject, title, body, action_path, action_label, variables, true, dedupe_seconds, priority
FROM (VALUES
  -- Customer: the core loop.
  ('order.placed', 'in_app', 'customer', NULL, 'Order sent to {{shopName}}',
   'Your order {{orderNumber}} has been sent to {{shopName}}. They usually accept within a few minutes.',
   '/orders/{{orderNumber}}', 'Track order', ARRAY['orderNumber','shopName'], 0, 'normal'),
  ('order.placed', 'push', 'customer', NULL, 'Order sent',
   '{{shopName}} has your order {{orderNumber}}.',
   '/orders/{{orderNumber}}', 'Track order', ARRAY['orderNumber','shopName'], 0, 'normal'),

  ('order.accepted', 'in_app', 'customer', NULL, 'Accepted by {{shopName}}',
   '{{shopName}} accepted order {{orderNumber}}. Estimated ready by {{readyBy}}.',
   '/orders/{{orderNumber}}', 'Track order', ARRAY['orderNumber','shopName','readyBy'], 0, 'high'),
  ('order.accepted', 'push', 'customer', NULL, 'Order accepted',
   '{{shopName}} is on it. Ready by about {{readyBy}}.',
   '/orders/{{orderNumber}}', 'Track order', ARRAY['orderNumber','shopName','readyBy'], 0, 'high'),

  ('order.printing', 'in_app', 'customer', NULL, 'Printing now',
   'Order {{orderNumber}} is printing at {{shopName}}.',
   '/orders/{{orderNumber}}', 'Track order', ARRAY['orderNumber','shopName'], 0, 'normal'),
  ('order.printing', 'push', 'customer', NULL, 'Printing now',
   'Order {{orderNumber}} is on the machine.',
   '/orders/{{orderNumber}}', 'Track order', ARRAY['orderNumber','shopName'], 0, 'normal'),

  ('order.ready', 'in_app', 'customer', NULL, 'Ready for pickup',
   'Order {{orderNumber}} is ready at {{shopName}}, {{shopArea}}. Open the app at the counter to show your collection code.',
   '/orders/{{orderNumber}}', 'Show at counter', ARRAY['orderNumber','shopName','shopArea'], 0, 'critical'),
  ('order.ready', 'push', 'customer', NULL, 'Ready for pickup',
   '{{orderNumber}} is ready at {{shopName}}. Tap to collect.',
   '/orders/{{orderNumber}}', 'Show at counter', ARRAY['orderNumber','shopName'], 0, 'critical'),
  ('order.ready', 'sms', 'customer', NULL, NULL,
   'Chaapo: your order {{orderNumber}} is ready at {{shopName}}. Open the Chaapo app to collect. {{shortLink}}',
   '/orders/{{orderNumber}}', NULL, ARRAY['orderNumber','shopName','shortLink'], 0, 'critical'),

  ('order.on_hold', 'in_app', 'customer', NULL, 'Action needed on your order',
   '{{shopName}} found a problem with a file in order {{orderNumber}}: {{holdReason}}. Reply or replace the file to continue.',
   '/orders/{{orderNumber}}', 'Fix the file', ARRAY['orderNumber','shopName','holdReason'], 0, 'critical'),
  ('order.on_hold', 'push', 'customer', NULL, 'Action needed',
   '{{shopName}} needs something fixed on order {{orderNumber}}.',
   '/orders/{{orderNumber}}', 'Fix the file', ARRAY['orderNumber','shopName'], 0, 'critical'),

  ('order.collected', 'in_app', 'customer', NULL, 'Collected. Thanks!',
   'Order {{orderNumber}} was collected from {{shopName}}. How did it go?',
   '/orders/{{orderNumber}}/rate', 'Rate this shop', ARRAY['orderNumber','shopName'], 0, 'normal'),

  ('order.rejected', 'in_app', 'customer', NULL, 'Shop could not take this job',
   '{{shopName}} could not take order {{orderNumber}}: {{reason}}. Your payment of {{amount}} is being refunded in full.',
   '/orders/{{orderNumber}}', 'View details', ARRAY['orderNumber','shopName','reason','amount'], 0, 'critical'),
  ('order.rejected', 'push', 'customer', NULL, 'Order not accepted',
   '{{shopName}} could not take {{orderNumber}}. Full refund on the way.',
   '/orders/{{orderNumber}}', 'View details', ARRAY['orderNumber','shopName'], 0, 'critical'),

  ('order.cancelled', 'in_app', 'customer', NULL, 'Order cancelled',
   'Order {{orderNumber}} has been cancelled. {{refundNote}}',
   '/orders/{{orderNumber}}', 'View details', ARRAY['orderNumber','refundNote'], 0, 'high'),

  ('order.pickup_reminder', 'push', 'customer', NULL, 'Still waiting for you',
   '{{orderNumber}} is ready at {{shopName}}. Collect by {{expiresAt}}.',
   '/orders/{{orderNumber}}', 'Show at counter', ARRAY['orderNumber','shopName','expiresAt'], 21600, 'high'),

  ('order.expiring_soon', 'in_app', 'customer', NULL, 'Collect soon',
   'Order {{orderNumber}} at {{shopName}} will be closed on {{expiresAt}} if it is not collected.',
   '/orders/{{orderNumber}}', 'Show at counter', ARRAY['orderNumber','shopName','expiresAt'], 21600, 'high'),

  ('quote.received', 'in_app', 'customer', NULL, 'Your quote is ready',
   '{{shopName}} quoted {{amount}} for order {{orderNumber}}. Valid until {{validUntil}}.',
   '/orders/{{orderNumber}}/quote', 'Review quote', ARRAY['orderNumber','shopName','amount','validUntil'], 0, 'high'),
  ('quote.received', 'push', 'customer', NULL, 'Quote ready',
   '{{shopName}} quoted {{amount}}. Tap to review.',
   '/orders/{{orderNumber}}/quote', 'Review quote', ARRAY['orderNumber','shopName','amount'], 0, 'high'),

  ('payment.failed', 'in_app', 'customer', NULL, 'Payment did not go through',
   'We could not take payment for order {{orderNumber}}. Nothing has been charged. You can try again.',
   '/orders/{{orderNumber}}/pay', 'Try again', ARRAY['orderNumber'], 0, 'critical'),

  ('refund.completed', 'in_app', 'customer', NULL, 'Refund sent',
   '{{amount}} has been refunded for order {{orderNumber}}. Banks usually take 3 to 5 working days to show it.',
   '/orders/{{orderNumber}}', 'View details', ARRAY['orderNumber','amount'], 0, 'high'),
  ('refund.completed', 'email', 'customer', 'Refund of {{amount}} for order {{orderNumber}}', NULL,
   E'Hello,\n\n{{amount}} has been refunded for your Chaapo order {{orderNumber}}. It should appear on your original payment method within 3 to 5 working days.\n\n— Chaapo',
   '/orders/{{orderNumber}}', 'View order', ARRAY['orderNumber','amount'], 0, 'normal'),

  -- Shop: the counter's working messages.
  ('order.new', 'in_app', 'shop', NULL, 'New order {{orderNumber}}',
   '{{pageCount}} pages, {{amount}}. Accept within {{acceptWindow}} minutes.',
   '/dashboard/orders/{{orderNumber}}', 'Open order',
   ARRAY['orderNumber','pageCount','amount','acceptWindow'], 0, 'critical'),
  ('order.new', 'push', 'shop', NULL, 'New order',
   '{{orderNumber}} — {{pageCount}} pages, {{amount}}.',
   '/dashboard/orders/{{orderNumber}}', 'Open order',
   ARRAY['orderNumber','pageCount','amount'], 0, 'critical'),

  ('order.accept_expiring', 'push', 'shop', NULL, 'Order about to expire',
   '{{orderNumber}} will be auto-cancelled in {{minutesLeft}} minutes.',
   '/dashboard/orders/{{orderNumber}}', 'Open order', ARRAY['orderNumber','minutesLeft'], 0, 'critical'),

  ('order.cancelled_by_customer', 'in_app', 'shop', NULL, 'Customer cancelled {{orderNumber}}',
   'The customer cancelled order {{orderNumber}}. {{payoutNote}}',
   '/dashboard/orders/{{orderNumber}}', 'View order', ARRAY['orderNumber','payoutNote'], 0, 'high'),

  ('quote.requested', 'in_app', 'shop', NULL, 'Quote requested',
   'A customer needs a price for order {{orderNumber}}. Respond within {{responseHours}} hours.',
   '/dashboard/quotes/{{orderNumber}}', 'Send quote', ARRAY['orderNumber','responseHours'], 0, 'high'),

  ('payout.paid', 'in_app', 'shop', NULL, 'Payout sent',
   '{{amount}} for {{orderCount}} orders has been sent to your {{bankLast4}} account. UTR {{utr}}.',
   '/dashboard/payouts/{{payoutReference}}', 'View statement',
   ARRAY['amount','orderCount','bankLast4','utr','payoutReference'], 0, 'high'),
  ('payout.paid', 'email', 'shop', 'Chaapo payout {{payoutReference}} — {{amount}}', NULL,
   E'Hello {{shopName}},\n\nWe have sent {{amount}} covering {{orderCount}} collected orders to your account ending {{bankLast4}}.\nBank reference (UTR): {{utr}}\n\nThe full statement is attached to your dashboard.\n\n— Chaapo',
   '/dashboard/payouts/{{payoutReference}}', 'View statement',
   ARRAY['shopName','amount','orderCount','bankLast4','utr','payoutReference'], 0, 'normal'),
  ('payout.failed', 'in_app', 'shop', NULL, 'Payout could not be sent',
   'Payout {{payoutReference}} failed: {{reason}}. Please check your bank details.',
   '/dashboard/payouts/{{payoutReference}}', 'Check details',
   ARRAY['payoutReference','reason'], 0, 'critical'),

  ('verification.approved', 'in_app', 'shop', NULL, 'You are live on Chaapo',
   '{{shopName}} has been verified and is now visible to customers nearby.',
   '/dashboard', 'Open dashboard', ARRAY['shopName'], 0, 'critical'),
  ('verification.approved', 'email', 'shop', 'Your Chaapo shop is verified', NULL,
   E'Hello {{shopName}},\n\nYour shop has been verified and is now live on Chaapo. Customers nearby can find you and send print jobs ahead of arriving.\n\n— Chaapo',
   '/dashboard', 'Open dashboard', ARRAY['shopName'], 0, 'normal'),
  ('verification.changes_requested', 'in_app', 'shop', NULL, 'More information needed',
   'We need a few things before {{shopName}} can go live: {{notes}}',
   '/dashboard/verification', 'Update details', ARRAY['shopName','notes'], 0, 'critical'),
  ('verification.rejected', 'in_app', 'shop', NULL, 'Verification not approved',
   'We could not verify {{shopName}}: {{reason}}. You can respond from your dashboard.',
   '/dashboard/verification', 'Respond', ARRAY['shopName','reason'], 0, 'critical'),

  ('dispute.opened', 'in_app', 'shop', NULL, 'Dispute raised on {{orderNumber}}',
   'A customer raised a dispute on order {{orderNumber}}: {{category}}. Please respond by {{respondBy}}.',
   '/dashboard/disputes/{{disputeReference}}', 'Respond',
   ARRAY['orderNumber','category','respondBy','disputeReference'], 0, 'critical'),
  ('dispute.resolved', 'in_app', 'shop', NULL, 'Dispute resolved',
   'The dispute on order {{orderNumber}} has been resolved: {{resolution}}.',
   '/dashboard/disputes/{{disputeReference}}', 'View outcome',
   ARRAY['orderNumber','resolution','disputeReference'], 0, 'high'),
  ('dispute.resolved', 'in_app', 'customer', NULL, 'Dispute resolved',
   'Your dispute on order {{orderNumber}} has been resolved: {{resolution}}.',
   '/orders/{{orderNumber}}', 'View outcome', ARRAY['orderNumber','resolution'], 0, 'high'),

  ('staff.invited', 'in_app', 'shop', NULL, 'Staff invite accepted',
   '{{staffName}} joined {{shopName}} as {{roleLabel}}.',
   '/dashboard/staff', 'Manage staff', ARRAY['staffName','shopName','roleLabel'], 0, 'normal'),

  -- Admin: only what genuinely needs a person tonight.
  ('admin.risk_flag', 'in_app', 'admin', NULL, 'Risk flag: {{ruleCode}}',
   '{{severity}} flag raised on {{subjectLabel}}. {{summary}}',
   '/admin/trust/flags', 'Open trust queue',
   ARRAY['ruleCode','severity','subjectLabel','summary'], 0, 'high'),
  ('admin.payout_failed', 'in_app', 'admin', NULL, 'Payout failed',
   'Payout {{payoutReference}} to {{shopName}} failed: {{reason}}.',
   '/admin/payouts/{{payoutReference}}', 'Investigate',
   ARRAY['payoutReference','shopName','reason'], 0, 'critical'),
  ('admin.webhook_stalled', 'in_app', 'admin', NULL, 'Payment webhooks stalled',
   'No {{provider}} webhook has been processed for {{minutes}} minutes.',
   '/admin/system/webhooks', 'Investigate', ARRAY['provider','minutes'], 1800, 'critical'),
  ('admin.retention_overdue', 'in_app', 'admin', NULL, 'File retention overdue',
   '{{count}} files are past their deletion date. Retention has not run since {{lastRun}}.',
   '/admin/privacy/retention', 'Investigate', ARRAY['count','lastRun'], 3600, 'critical')
) AS t(key, channel, audience, subject, title, body, action_path, action_label,
       variables, dedupe_seconds, priority);


-- WhatsApp needs pre-registered templates at the provider, so these carry the
-- provider's own template name and are held behind the `whatsapp_notifications`
-- flag until that registration is approved.
INSERT INTO notification_templates (
  id, key, channel, locale, audience, title, body, action_path, action_label,
  provider_template_name, provider_template_lang, variables, is_transactional, priority
)
SELECT
  reference_uuid('notification_template:' || key || ':whatsapp:' || audience),
  key, 'whatsapp'::notification_channel, 'en-IN', audience, NULL, body, action_path, NULL,
  provider_template_name, 'en', variables, true, priority
FROM (VALUES
  ('order.ready', 'customer',
   'Your Chaapo order {{orderNumber}} is ready at {{shopName}}. Open the app to collect it.',
   '/orders/{{orderNumber}}', 'chaapo_order_ready_v1', ARRAY['orderNumber','shopName'], 'critical'),
  ('order.accepted', 'customer',
   '{{shopName}} accepted your order {{orderNumber}}. Estimated ready by {{readyBy}}.',
   '/orders/{{orderNumber}}', 'chaapo_order_accepted_v1', ARRAY['orderNumber','shopName','readyBy'], 'high'),
  ('order.new', 'shop',
   'New Chaapo order {{orderNumber}}: {{pageCount}} pages, {{amount}}. Accept it in the dashboard.',
   '/dashboard/orders/{{orderNumber}}', 'chaapo_shop_new_order_v1', ARRAY['orderNumber','pageCount','amount'], 'critical')
) AS t(key, audience, body, action_path, provider_template_name, variables, priority);
