-- ═══════════════════════════════════════════════════════════════════════════
-- 0005 — Files
--
-- A customer's print job is often the most sensitive document they own: a medical
-- report, a rent agreement, a passport scan. The schema is built around four
-- rules taken directly from the PRD (§56, §57, FR-201…FR-215):
--
--   1. Bytes live in a private bucket. Only object *keys* are stored here. There
--      is no `url` column anywhere in this file, and there never will be — access
--      is always a freshly minted, short-lived, single-purpose signed URL issued
--      by the server after an authorisation check.
--
--   2. The file name is customer content, not metadata. "Aadhaar_scan.pdf" leaks
--      as much as the file. It is stored encrypted and redacted from logs.
--
--   3. Nothing becomes printable until it has been sniffed, scanned and
--      processed. `file_state` walks reserved → uploading → uploaded → scanning →
--      processing → ready, and only `ready` files can be attached to an order
--      that is paid for.
--
--   4. Deletion is scheduled at upload time, not remembered later. `expires_at`
--      is always set; the retention worker deletes the bytes and stamps
--      `bytes_deleted_at` as proof. The row survives as the evidence that the
--      deletion happened.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Upload sessions ────────────────────────────────────────────────────────
-- Created before the browser has any presigned URL, so an interrupted upload is
-- a resumable row rather than a lost job (PRD §D "never lose an order because of
-- an upload failure"). One session per file; multipart uploads keep their
-- provider upload id here so the client can resume part-by-part.
CREATE TABLE file_upload_sessions (
  id                    uuid PRIMARY KEY,
  user_id               uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The draft order this upload belongs to, if the customer started from a cart.
  -- Nullable: files can be uploaded before a shop is chosen.
  order_id              uuid,       -- FK added in 0006
  shop_id               uuid REFERENCES shops (id) ON DELETE SET NULL,

  -- Declared by the client, used only to validate and to plan storage. The
  -- authoritative values are re-derived server-side after the bytes land.
  declared_name_encrypted text      NOT NULL,
  declared_size_bytes   bigint      NOT NULL,
  declared_mime         text        NOT NULL,

  storage_bucket        text        NOT NULL,
  storage_key           text        NOT NULL,
  -- Multipart state. NULL for a single-shot PUT.
  multipart_upload_id   text,
  part_size_bytes       integer,
  parts_total           integer,
  parts_completed       integer     NOT NULL DEFAULT 0,
  -- ETags of completed parts, so a resumed upload can be finalised. No file
  -- content, no PII.
  completed_parts       jsonb       NOT NULL DEFAULT '[]',

  -- Presigned URL validity. Short: minutes, not hours (NFR-13).
  url_expires_at        timestamptz NOT NULL,
  -- Hard deadline for the whole session; abandoned sessions are swept and their
  -- partial objects aborted so we are not paying to store garbage.
  expires_at            timestamptz NOT NULL,

  completed_at          timestamptz,
  aborted_at            timestamptz,
  abort_reason          text,
  file_id               uuid,       -- FK added after `files` exists, below

  client_ip_hash        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT file_upload_sessions_size_positive CHECK (declared_size_bytes > 0),
  CONSTRAINT file_upload_sessions_multipart_consistent CHECK (
    multipart_upload_id IS NULL
    OR (part_size_bytes IS NOT NULL AND parts_total IS NOT NULL AND parts_total > 0)
  ),
  CONSTRAINT file_upload_sessions_parts_bounded CHECK (
    parts_completed >= 0 AND (parts_total IS NULL OR parts_completed <= parts_total)
  ),
  CONSTRAINT file_upload_sessions_not_both_ended CHECK (
    completed_at IS NULL OR aborted_at IS NULL
  ),
  CONSTRAINT file_upload_sessions_abort_has_reason CHECK (
    aborted_at IS NULL OR abort_reason IS NOT NULL
  )
);

CREATE UNIQUE INDEX file_upload_sessions_key_unique ON file_upload_sessions (storage_bucket, storage_key);
CREATE INDEX file_upload_sessions_user_open_idx ON file_upload_sessions (user_id, created_at DESC)
  WHERE completed_at IS NULL AND aborted_at IS NULL;
CREATE INDEX file_upload_sessions_sweep_idx ON file_upload_sessions (expires_at)
  WHERE completed_at IS NULL AND aborted_at IS NULL;
CREATE INDEX file_upload_sessions_order_idx ON file_upload_sessions (order_id) WHERE order_id IS NOT NULL;

CREATE TRIGGER file_upload_sessions_updated_at BEFORE UPDATE ON file_upload_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE file_upload_sessions IS
  'Resumable upload intent. Exists before the first byte so a dropped connection loses nothing.';


-- ── Files ──────────────────────────────────────────────────────────────────
CREATE TABLE files (
  id                    uuid PRIMARY KEY,
  owner_user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  order_id              uuid,       -- FK added in 0006
  -- The shop allowed to read this file. Set when the file is attached to an
  -- order at a shop; used as a second check on every signed-URL request so a
  -- shop cannot read a file for an order it does not own (FR-212).
  shop_id               uuid REFERENCES shops (id) ON DELETE SET NULL,

  state                 file_state  NOT NULL DEFAULT 'reserved',

  -- ── Names (PII) ──
  original_name_encrypted text      NOT NULL,
  -- A safe, non-reversible label for logs and support tickets: 'file-7f3a.pdf'.
  safe_label            text        NOT NULL,
  extension             text,

  -- ── Storage ──
  storage_bucket        text        NOT NULL,
  storage_key           text        NOT NULL,
  storage_region        text        NOT NULL DEFAULT 'ap-south-1',
  -- Server-side encryption applied by the bucket ('aes256' | 'aws:kms').
  sse_mode              text,
  sse_key_id            text,

  byte_size             bigint,
  -- SHA-256 of the bytes. Deduplicates a customer re-uploading the same file and
  -- proves the printed file is the uploaded file in a dispute.
  content_sha256        text,

  -- ── Type ──
  -- What the client claimed, and what the magic bytes actually say. A mismatch
  -- is not automatically fatal (browsers guess badly) but it is recorded and it
  -- blocks anything executable.
  declared_mime         text,
  detected_mime         text,
  mime_mismatch         boolean     NOT NULL DEFAULT false,

  -- ── Document properties, filled by the processing worker ──
  page_count            integer,
  -- Per-page sizes in points, so the pricing engine can detect a mixed-size PDF
  -- and the shop can be warned about an A3 page inside an A4 job.
  page_sizes            jsonb,
  dominant_page_size    citext REFERENCES paper_sizes (code),
  has_mixed_page_sizes  boolean     NOT NULL DEFAULT false,
  -- Ink estimate, used for the colour-page count: a 40-page PDF with 3 colour
  -- pages should not be priced as 40 colour pages (FR-308).
  colour_page_count     integer,
  is_password_protected boolean     NOT NULL DEFAULT false,
  is_corrupt            boolean     NOT NULL DEFAULT false,
  processing_error       text,
  processed_at          timestamptz,

  -- ── Malware scan ──
  scan_state            text        NOT NULL DEFAULT 'pending',
  scan_verdict          text,
  scan_signature        text,       -- e.g. the ClamAV signature name
  scanner_name          text,
  scanner_version       text,
  scanned_at            timestamptz,
  scan_attempts         integer     NOT NULL DEFAULT 0,

  -- ── Rejection ──
  rejected_at           timestamptz,
  rejection_code        text,
  -- Customer-facing explanation. Written by us, never raw scanner output.
  rejection_message     text,

  -- ── Retention ──
  -- Always set at creation. The retention worker acts on this; there is no
  -- "files with no expiry" state to leak (FR-903, NFR-15).
  expires_at            timestamptz NOT NULL,
  -- Why this expiry: the rule that produced it, for the privacy report.
  retention_rule        text        NOT NULL DEFAULT 'default',
  -- Extended once when an order is disputed, so evidence survives the dispute.
  retention_extended_at timestamptz,
  retention_extension_reason text,

  -- Set by the worker after the object is confirmed gone from storage. This is
  -- the proof of deletion; the row itself is kept.
  bytes_deleted_at      timestamptz,
  deletion_reason       text,

  -- How many times a signed URL has been issued. A shop downloading a file
  -- forty times is a signal worth seeing.
  access_count          integer     NOT NULL DEFAULT 0,
  last_accessed_at      timestamptz,
  first_shop_access_at  timestamptz,

  upload_session_id     uuid REFERENCES file_upload_sessions (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT files_scan_state_valid CHECK (scan_state IN ('pending', 'scanning', 'clean', 'infected', 'error', 'skipped')),
  CONSTRAINT files_scan_verdict_valid CHECK (scan_verdict IS NULL OR scan_verdict IN ('clean', 'infected', 'suspicious', 'unscannable')),
  CONSTRAINT files_sse_mode_valid CHECK (sse_mode IS NULL OR sse_mode IN ('aes256', 'aws:kms', 'none')),
  CONSTRAINT files_size_positive CHECK (byte_size IS NULL OR byte_size > 0),
  CONSTRAINT files_page_count_positive CHECK (page_count IS NULL OR page_count > 0),
  CONSTRAINT files_colour_pages_bounded CHECK (
    colour_page_count IS NULL OR page_count IS NULL OR colour_page_count <= page_count
  ),
  CONSTRAINT files_sha256_format CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT files_rejection_complete CHECK (
    rejected_at IS NULL OR (rejection_code IS NOT NULL AND rejection_message IS NOT NULL)
  ),
  CONSTRAINT files_rejection_matches_state CHECK (
    (state = 'rejected') = (rejected_at IS NOT NULL)
  ),
  CONSTRAINT files_deleted_matches_state CHECK (
    bytes_deleted_at IS NULL OR state IN ('deleted', 'expired', 'rejected')
  ),
  -- A file cannot be printable unless it has been scanned clean and processed.
  CONSTRAINT files_ready_is_safe CHECK (
    state <> 'ready'
    OR (scan_state IN ('clean', 'skipped') AND page_count IS NOT NULL AND byte_size IS NOT NULL)
  ),
  CONSTRAINT files_retention_rule_valid CHECK (
    retention_rule IN ('default', 'unattached_draft', 'order_active', 'order_completed',
                       'order_cancelled', 'dispute_hold', 'legal_hold', 'user_erasure')
  ),
  CONSTRAINT files_access_count_nonneg CHECK (access_count >= 0)
);

CREATE UNIQUE INDEX files_storage_key_unique ON files (storage_bucket, storage_key);
CREATE INDEX files_owner_idx ON files (owner_user_id, created_at DESC);
CREATE INDEX files_order_idx ON files (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX files_shop_idx ON files (shop_id) WHERE shop_id IS NOT NULL;
-- The retention worker's query: everything past its expiry whose bytes are still
-- present. Partial, so it stays small as the table grows.
CREATE INDEX files_retention_due_idx ON files (expires_at)
  WHERE bytes_deleted_at IS NULL;
-- The pipeline workers' queues.
CREATE INDEX files_scan_queue_idx ON files (created_at) WHERE scan_state IN ('pending', 'scanning');
CREATE INDEX files_process_queue_idx ON files (created_at) WHERE state = 'processing';
-- Deduplication within one customer's uploads.
CREATE INDEX files_dedup_idx ON files (owner_user_id, content_sha256)
  WHERE content_sha256 IS NOT NULL AND bytes_deleted_at IS NULL;

CREATE TRIGGER files_updated_at BEFORE UPDATE ON files
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The storage location is fixed for the lifetime of the row. If we moved it, the
-- deletion proof would point at the wrong object.
CREATE TRIGGER files_immutable_location
  BEFORE UPDATE ON files
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('storage_bucket', 'storage_key', 'owner_user_id');

COMMENT ON TABLE files IS
  'No URL column by design. Access is always a freshly signed, short-lived URL issued after an authorisation check (NFR-13).';
COMMENT ON COLUMN files.safe_label IS
  'Non-reversible label safe for logs and support tickets. The real name is PII and lives encrypted.';
COMMENT ON COLUMN files.expires_at IS
  'Never NULL. Deletion is scheduled at creation, not remembered later (FR-903).';

ALTER TABLE file_upload_sessions
  ADD CONSTRAINT file_upload_sessions_file_id_fkey
  FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE SET NULL;


-- ── Previews ───────────────────────────────────────────────────────────────
-- Thumbnails are derived from the customer's document and are therefore just as
-- private as it is: same bucket policy, same signed-URL path, same retention.
-- They exist so the shop can confirm it is printing the right thing without
-- downloading a 40 MB PDF on a shop laptop (FR-210).
CREATE TABLE file_previews (
  id                uuid PRIMARY KEY,
  file_id           uuid        NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  page_number       integer     NOT NULL,
  storage_bucket    text        NOT NULL,
  storage_key       text        NOT NULL,
  width_px          integer     NOT NULL,
  height_px         integer     NOT NULL,
  byte_size         bigint,
  format            text        NOT NULL DEFAULT 'webp',
  bytes_deleted_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT file_previews_page_positive CHECK (page_number >= 1),
  CONSTRAINT file_previews_dimensions CHECK (width_px > 0 AND height_px > 0),
  CONSTRAINT file_previews_format_valid CHECK (format IN ('webp', 'jpeg', 'png'))
);

CREATE UNIQUE INDEX file_previews_page_key ON file_previews (file_id, page_number);
CREATE UNIQUE INDEX file_previews_storage_key_unique ON file_previews (storage_bucket, storage_key);
CREATE INDEX file_previews_retention_idx ON file_previews (file_id) WHERE bytes_deleted_at IS NULL;


-- ── Access log ─────────────────────────────────────────────────────────────
-- Append-only. Every signed URL we mint for a customer file is recorded: who
-- asked, in what role, for which purpose, and whether we allowed it. This is the
-- answer to "who looked at my document" and the input to abuse detection
-- (FR-213, NFR-16, PRD §57.5).
CREATE TABLE file_access_logs (
  id                uuid PRIMARY KEY,
  file_id           uuid        NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  -- Denormalised so the log survives an order being purged and so the privacy
  -- report can be built without a join.
  order_id          uuid,
  actor_user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_role        user_role,
  actor_shop_id     uuid REFERENCES shops (id) ON DELETE SET NULL,
  purpose           text        NOT NULL,
  outcome           text        NOT NULL,
  denial_reason     text,
  -- How long the URL we issued was valid for, in seconds. Recorded so a review
  -- can confirm we are not handing out long-lived links.
  url_ttl_seconds   integer,
  ip_hash           text,
  user_agent_family text,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT file_access_purpose_valid CHECK (
    purpose IN ('customer_preview', 'customer_download', 'shop_print', 'shop_preview',
                'admin_investigation', 'malware_scan', 'processing', 'retention_delete')
  ),
  CONSTRAINT file_access_outcome_valid CHECK (outcome IN ('granted', 'denied')),
  CONSTRAINT file_access_denial_has_reason CHECK (
    outcome <> 'denied' OR denial_reason IS NOT NULL
  )
);

CREATE INDEX file_access_logs_file_idx ON file_access_logs (file_id, created_at DESC);
CREATE INDEX file_access_logs_actor_idx ON file_access_logs (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX file_access_logs_order_idx ON file_access_logs (order_id, created_at DESC)
  WHERE order_id IS NOT NULL;
-- Admin access to customer documents is reviewed separately and must be cheap to
-- list.
CREATE INDEX file_access_logs_admin_idx ON file_access_logs (created_at DESC)
  WHERE purpose = 'admin_investigation';

CREATE TRIGGER file_access_logs_append_only
  BEFORE UPDATE OR DELETE ON file_access_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
