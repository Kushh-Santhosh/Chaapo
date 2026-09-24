/**
 * Configuration and privacy — mirrors the second half of
 * `db/migrations/0009_trust_privacy_config.sql`.
 *
 * Every tunable business number in the PRD — commission, SLA defaults, refund
 * windows, retention days, upload caps — lives in `platformConfig` rather than in
 * code. The alternative means a commission change is a deploy and nobody can answer
 * "what was the refund window in March"; `platformConfigHistory` answers it (PRD §52).
 *
 * The DPDP rights are tracked jobs, not a support inbox someone forgets: an erasure
 * request has a scheduled execution, a grace period, an execution report, and an
 * explicit record of what was legally retained (FR-905, PRD §57.6).
 */

import { boolean, integer, jsonb, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core'

import { bigintCount, citext, createdAt, id, timestamps, tstz } from '../columns'
import { users } from './identity'

/**
 * Business policy as data. `valueType` lets the loader validate and coerce;
 * `minValue`/`maxValue` bound the numeric ones so a typo in the admin console cannot
 * set commission to 800 %.
 */
export const platformConfig = pgTable('platform_config', {
  key: citext('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  valueType: text('value_type')
    .$type<
      | 'integer'
      | 'bps'
      | 'paise'
      | 'boolean'
      | 'string'
      | 'string_array'
      | 'json'
      | 'minutes'
      | 'days'
      | 'hours'
    >()
    .notNull(),
  /** Grouping for the admin console's settings screens. */
  section: text('section').notNull(),
  label: text('label').notNull(),
  description: text('description').notNull(),
  unit: text('unit'),
  /** numeric, read as a string so no precision is lost on the way through. */
  minValue: numeric('min_value'),
  maxValue: numeric('max_value'),
  /** Whether changing this needs a Super Admin rather than admin_finance. */
  requiresSuperAdmin: boolean('requires_super_admin').notNull().default(false),
  /** Whether the value is safe to send to a browser. Most are; a few are not. */
  isPublic: boolean('is_public').notNull().default(false),
  /** Present for visibility but changed only by migration. */
  isReadonly: boolean('is_readonly').notNull().default(false),
  version: integer('version').notNull().default(1),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps,
})

/** Append-only. How a bad change is reverted with confidence. */
export const platformConfigHistory = pgTable('platform_config_history', {
  id: id(),
  key: citext('key').notNull(),
  version: integer('version').notNull(),
  oldValue: jsonb('old_value').$type<unknown>(),
  newValue: jsonb('new_value').$type<unknown>().notNull(),
  changedBy: uuid('changed_by').references(() => users.id, { onDelete: 'set null' }),
  reason: text('reason').notNull(),
  /** When the new value took effect, which may be later than when it was set. */
  effectiveFrom: tstz('effective_from').notNull().defaultNow(),
  ...createdAt,
})

export const featureFlags = pgTable('feature_flags', {
  key: citext('key').primaryKey(),
  label: text('label').notNull(),
  description: text('description').notNull(),
  isEnabled: boolean('is_enabled').notNull().default(false),
  /** Evaluated against a stable hash of the subject id, so nobody flips between variants. */
  rolloutBps: integer('rollout_bps').notNull().default(0),
  /** Explicit lists beat the percentage. */
  enabledUserIds: uuid('enabled_user_ids').array().notNull().default([]),
  enabledShopIds: uuid('enabled_shop_ids').array().notNull().default([]),
  enabledCityIds: uuid('enabled_city_ids').array().notNull().default([]),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps,
})

/**
 * Right to erasure. The grace period before `scheduledFor` matters: an account that
 * has been taken over cannot be erased to cover tracks, and a user can change their
 * mind. The worker deletes what it can and records what it retained and why.
 */
export const dataErasureRequests = pgTable('data_erasure_requests', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  requestedBy: text('requested_by')
    .$type<'user' | 'admin' | 'regulator'>()
    .notNull()
    .default('user'),
  requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  state: text('state')
    .$type<
      | 'pending'
      | 'awaiting_verification'
      | 'scheduled'
      | 'blocked'
      | 'running'
      | 'completed'
      | 'cancelled'
      | 'failed'
    >()
    .notNull()
    .default('pending'),
  verifiedAt: tstz('verified_at'),
  verificationMethod: text('verification_method'),
  scheduledFor: tstz('scheduled_for').notNull(),
  startedAt: tstz('started_at'),
  completedAt: tstz('completed_at'),
  cancelledAt: tstz('cancelled_at'),
  cancellationReason: text('cancellation_reason'),
  /** Counts per table, files deleted, what was retained and why. */
  executionReport: jsonb('execution_report').$type<Record<string, unknown>>(),
  /** Records we are legally required to keep, and the date they can go. */
  retainedUntil: tstz('retained_until'),
  retentionBasis: text('retention_basis'),
  failureReason: text('failure_reason'),
  ...timestamps,
})

/**
 * Right to access. The archive lands in a private bucket and is released through a
 * single-use hashed token to the requesting user only, then deleted.
 */
export const dataExportRequests = pgTable('data_export_requests', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  state: text('state')
    .$type<'pending' | 'running' | 'ready' | 'expired' | 'failed'>()
    .notNull()
    .default('pending'),
  storageBucket: text('storage_bucket'),
  storageKey: text('storage_key'),
  byteSize: bigintCount('byte_size'),
  downloadTokenHash: text('download_token_hash'),
  downloadCount: integer('download_count').notNull().default(0),
  maxDownloads: integer('max_downloads').notNull().default(3),
  startedAt: tstz('started_at'),
  completedAt: tstz('completed_at'),
  /** The archive is deleted after this. */
  expiresAt: tstz('expires_at').notNull(),
  bytesDeletedAt: tstz('bytes_deleted_at'),
  failureReason: text('failure_reason'),
  ...timestamps,
})

/**
 * Proof the retention policy actually runs. An empty table here means files are not
 * being deleted, which is a privacy incident rather than a quiet success (FR-903,
 * NFR-15) — the admin console surfaces the last run per job for exactly that reason.
 */
export const retentionRuns = pgTable('retention_runs', {
  id: id(),
  job: text('job')
    .$type<
      | 'file_expiry'
      | 'preview_expiry'
      | 'upload_session_sweep'
      | 'export_expiry'
      | 'otp_sweep'
      | 'session_sweep'
      | 'idempotency_sweep'
      | 'analytics_rollup'
      | 'user_erasure'
    >()
    .notNull(),
  startedAt: tstz('started_at').notNull().defaultNow(),
  finishedAt: tstz('finished_at'),
  candidates: integer('candidates').notNull().default(0),
  deleted: integer('deleted').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  bytesFreed: bigintCount('bytes_freed').notNull().default(0n),
  /** Aggregated skip reasons: {"dispute_hold": 3, "legal_hold": 1}. */
  skipReasons: jsonb('skip_reasons').$type<Record<string, number>>().notNull().default({}),
  error: text('error'),
})
