import { createHash } from 'node:crypto'

import { eq } from 'drizzle-orm'

import { getDb, withTransaction, type DbHandle } from '../db/client'
import { featureFlags, platformConfig, platformConfigHistory } from '../db/schema/config'
import { recordAudit } from './audit'
import { errors, type AppError } from './errors'
import { logger } from './logger'
import { err, ok, type Result } from './result'
import { requireCapability, type AuthContext, type Capability } from './rbac'
import { BPS_DENOMINATOR, type Bps, type Paise } from '../../lib/money'
import { newId } from '../../lib/ids'

/**
 * Platform configuration.
 *
 * Distinct from `src/server/config/index.ts`, and the distinction matters:
 *
 *   • **Infrastructure config** is environment: connection strings, bucket names,
 *     provider keys. Read from `process.env`, fixed for the life of the process,
 *     changed by a deploy.
 *
 *   • **Platform config** — this file — is *policy*: the commission rate, how long
 *     a shop has to accept an order, how many days a file survives after
 *     collection. Read from `platform_config`, changed by a Super Admin in the
 *     admin console, versioned and audited, and in force immediately.
 *
 * Putting policy in the environment would mean a deploy to change the commission
 * rate and no record of who changed it. Putting infrastructure in the database
 * would mean the database's own address lived in the database. Hence two.
 *
 * Reads go through a snapshot. A snapshot is the right shape because pricing needs
 * several values that must agree with each other — the commission rate, its
 * minimum, the tax on it — and reading them one at a time invites a change
 * landing halfway through an order. `loadSettings()` returns all of them, cached
 * for `CONFIG_CACHE_TTL_MS`.
 *
 * The cache has one honest limitation: a change made on one instance is not
 * visible to another until its TTL lapses, so the window is up to 30 seconds.
 * That is acceptable for policy values and it is deliberately not hidden — the
 * admin console tells the operator the change is live "within a minute", and the
 * pricing engine snapshots the values it used onto the order anyway, so an order
 * is never priced from two different configurations.
 */

/** Mirrors `platform_config.value_type`, which mirrors the CHECK in migration 0009. */
export const CONFIG_VALUE_TYPES = [
  'integer',
  'bps',
  'paise',
  'boolean',
  'string',
  'string_array',
  'json',
  'minutes',
  'days',
  'hours',
] as const

export type ConfigValueType = (typeof CONFIG_VALUE_TYPES)[number]

/**
 * The declared type and seeded value of every key, mirrored from migration 0011.
 *
 * Only those two facts live here. The label, description, section, unit and
 * bounds are the database's — they are editorial content for the admin console
 * and no code branches on them. What code needs is the key's name, so a typo is a
 * compile error; its type, so `settings.get('commission.rate_bps')` is a number
 * and `settings.get('commission.min_paise')` is a bigint; and its seed, so a unit
 * test can price an order without Postgres.
 *
 * `config-store.itest.ts` asserts this table and the live rows agree on both key
 * set and value type. That is the anti-drift mechanism; this is not a second
 * source of truth.
 */
export const CONFIG_SPECS = {
  // ── Commission and platform fees ──────────────────────────────────────────
  // Shop-side only: the customer pays the shop's price, and the commission comes
  // out of the shop's share (§17). `customer.platform_fee_paise` exists at zero
  // so the plumbing is real if that ever changes.
  'commission.rate_bps': { type: 'bps', seed: 800 },
  'commission.min_paise': { type: 'paise', seed: 200n },
  'commission.tax_rate_bps': { type: 'bps', seed: 1800 },
  'commission.tds_rate_bps': { type: 'bps', seed: 10 },
  'customer.platform_fee_paise': { type: 'paise', seed: 0n },

  // ── Order timers ──────────────────────────────────────────────────────────
  'orders.accept_window_minutes': { type: 'minutes', seed: 15 },
  'orders.payment_intent_ttl_minutes': { type: 'minutes', seed: 20 },
  'orders.draft_ttl_hours': { type: 'hours', seed: 24 },
  'orders.quote_response_hours': { type: 'hours', seed: 4 },
  'orders.quote_validity_hours': { type: 'hours', seed: 24 },
  'orders.hold_response_minutes': { type: 'minutes', seed: 120 },
  'orders.max_open_per_customer': { type: 'integer', seed: 5 },

  // ── Pickup ────────────────────────────────────────────────────────────────
  'pickup.grace_hours': { type: 'hours', seed: 48 },
  'pickup.reminder_hours': { type: 'hours', seed: 12 },
  'pickup.code_max_attempts': { type: 'integer', seed: 5 },
  'pickup.lock_minutes': { type: 'minutes', seed: 15 },

  // ── Refunds ───────────────────────────────────────────────────────────────
  'refunds.free_cancel_until_accepted': { type: 'boolean', seed: true },
  'refunds.accepted_pre_print_bps': { type: 'bps', seed: 10_000 },
  'refunds.during_printing_bps': { type: 'bps', seed: 0 },
  'refunds.expired_pickup_bps': { type: 'bps', seed: 0 },
  'refunds.auto_approve_below_paise': { type: 'paise', seed: 50_000n },

  // ── Files and retention ───────────────────────────────────────────────────
  'files.max_bytes': { type: 'integer', seed: 52_428_800 },
  'files.max_per_order': { type: 'integer', seed: 20 },
  'files.max_pages_per_file': { type: 'integer', seed: 1000 },
  'files.signed_url_ttl_seconds': { type: 'integer', seed: 300 },
  'files.retention_days_after_collection': { type: 'days', seed: 7 },
  'files.retention_days_unused': { type: 'days', seed: 2 },
  'files.retention_days_cancelled': { type: 'days', seed: 3 },

  // ── Discovery ─────────────────────────────────────────────────────────────
  'discovery.default_radius_m': { type: 'integer', seed: 3000 },
  'discovery.max_radius_m': { type: 'integer', seed: 15_000 },
  'discovery.max_results': { type: 'integer', seed: 50 },

  // ── Payouts ───────────────────────────────────────────────────────────────
  'payouts.hold_hours_after_collection': { type: 'hours', seed: 24 },
  'payouts.min_paise': { type: 'paise', seed: 10_000n },
  'payouts.new_shop_hold_days': { type: 'days', seed: 7 },
  'payouts.schedule': { type: 'string', seed: 'weekly' },

  // ── Notifications ─────────────────────────────────────────────────────────
  // Minutes from IST midnight: 1320 is 22:00, 420 is 07:00.
  'notifications.quiet_hours_start_minute': { type: 'minutes', seed: 1320 },
  'notifications.quiet_hours_end_minute': { type: 'minutes', seed: 420 },
  'notifications.sms_fallback_after_seconds': { type: 'integer', seed: 120 },

  // ── Ratings ───────────────────────────────────────────────────────────────
  'ratings.window_days': { type: 'days', seed: 14 },
  'ratings.editable_hours': { type: 'hours', seed: 24 },
  'ratings.min_count_for_display': { type: 'integer', seed: 3 },

  // ── Security ──────────────────────────────────────────────────────────────
  'security.otp_ttl_seconds': { type: 'integer', seed: 300 },
  'security.otp_max_attempts': { type: 'integer', seed: 5 },
  'security.otp_resend_seconds': { type: 'integer', seed: 30 },
  'security.customer_session_days': { type: 'days', seed: 30 },
  'security.shop_session_hours': { type: 'hours', seed: 12 },
  // These three seeds mirror `SESSION_POLICY` in `src/server/auth/policy.ts`, which is
  // the value the session layer actually enforces today. Nothing reads these keys yet;
  // they exist so an admin can shorten a surface's idle window without a deploy once
  // the session layer takes its window from here. Until then, changing a number in one
  // place and not the other is how the config screen starts lying, so they are kept
  // equal by hand and the comment says which one wins.
  'security.admin_session_minutes': { type: 'minutes', seed: 30 },

  // ── Risk ──────────────────────────────────────────────────────────────────
  'risk.max_orders_per_customer_per_hour': { type: 'integer', seed: 10 },
  'risk.max_failed_pickups_before_flag': { type: 'integer', seed: 3 },
  'risk.shop_cancel_rate_flag_bps': { type: 'bps', seed: 1500 },

  // ── Privacy ───────────────────────────────────────────────────────────────
  'privacy.export_ttl_hours': { type: 'hours', seed: 48 },
  'privacy.erasure_grace_days': { type: 'days', seed: 7 },
  'privacy.financial_retention_years': { type: 'integer', seed: 8 },

  // ── Service levels ────────────────────────────────────────────────────────
  'sla.ready_estimate_buffer_minutes': { type: 'minutes', seed: 10 },
  'sla.shop_first_response_minutes': { type: 'minutes', seed: 10 },
  'sla.dispute_first_response_hours': { type: 'hours', seed: 24 },
} as const satisfies Record<string, { type: ConfigValueType; seed: unknown }>

export type ConfigKey = keyof typeof CONFIG_SPECS

export const CONFIG_KEYS = Object.keys(CONFIG_SPECS) as ConfigKey[]

type ValueForType<T extends ConfigValueType> = T extends 'paise'
  ? Paise
  : T extends 'bps'
    ? Bps
    : T extends 'boolean'
      ? boolean
      : T extends 'string'
        ? string
        : T extends 'string_array'
          ? readonly string[]
          : T extends 'json'
            ? unknown
            : number

/** The TypeScript type a key reads back as. `minutes`, `days` and `hours` are numbers. */
export type ConfigValue<K extends ConfigKey> = ValueForType<(typeof CONFIG_SPECS)[K]['type']>

// ── Coercion ────────────────────────────────────────────────────────────────

/**
 * Turn a `jsonb` value into the type the key promises.
 *
 * Strict on purpose: `"800"` is not 800, and `1` is not `true`. A loose coercion
 * here would mean a mistyped commission rate silently became something plausible,
 * and the whole point of a typed config store is that it cannot.
 */
export function coerceConfigValue(
  key: string,
  type: ConfigValueType,
  raw: unknown,
): Result<unknown, AppError> {
  switch (type) {
    case 'integer':
    case 'minutes':
    case 'days':
    case 'hours':
      if (!Number.isInteger(raw)) return err(badValue(key, `a whole number, got ${describe(raw)}`))
      return ok(raw as number)

    case 'bps': {
      if (!Number.isInteger(raw)) return err(badValue(key, `a whole number, got ${describe(raw)}`))
      const bps = raw as number
      // Basis points have a fixed meaning; a value outside the scale is a bug
      // regardless of what the row's own min/max happen to say.
      if (bps < 0 || bps > Number(BPS_DENOMINATOR)) {
        return err(badValue(key, `basis points between 0 and ${BPS_DENOMINATOR}, got ${bps}`))
      }
      return ok(bps)
    }

    case 'paise': {
      if (!Number.isInteger(raw)) return err(badValue(key, `whole paise, got ${describe(raw)}`))
      const value = raw as number
      if (value < 0) return err(badValue(key, `a non-negative amount, got ${value}`))
      return ok(BigInt(value))
    }

    case 'boolean':
      if (typeof raw !== 'boolean') return err(badValue(key, `true or false, got ${describe(raw)}`))
      return ok(raw)

    case 'string':
      if (typeof raw !== 'string') return err(badValue(key, `a string, got ${describe(raw)}`))
      return ok(raw)

    case 'string_array':
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
        return err(badValue(key, `an array of strings, got ${describe(raw)}`))
      }
      return ok(Object.freeze([...(raw as string[])]))

    case 'json':
      if (raw === null || typeof raw !== 'object') {
        return err(badValue(key, `a JSON object, got ${describe(raw)}`))
      }
      return ok(raw)
  }
}

/**
 * Turn a coerced value back into something `jsonb` can hold.
 *
 * `bigint` is the only interesting case: `JSON.stringify` refuses it outright, so
 * paise are stored as JSON numbers. Every paise value in this store is far below
 * 2^53, and the guard means that if one ever is not, it fails loudly rather than
 * losing the low digits of an amount of money.
 */
export function serialiseConfigValue(key: string, value: unknown): unknown {
  if (typeof value !== 'bigint') return value
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Config "${key}" is too large to store as a JSON number: ${value}`)
  }
  return Number(value)
}

function badValue(key: string, expected: string): AppError {
  return errors.validation(
    [{ path: 'value', message: `${key} expects ${expected}.` }],
    `That value is not valid for ${key}.`,
  )
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value
}

// ── The snapshot ────────────────────────────────────────────────────────────

export interface PlatformSettings {
  /** Throws for an unknown key, which the type system already prevents. */
  get<K extends ConfigKey>(key: K): ConfigValue<K>
  has(key: string): boolean
  readonly loadedAt: Date
}

class Snapshot implements PlatformSettings {
  constructor(
    private readonly values: ReadonlyMap<string, unknown>,
    readonly loadedAt: Date,
  ) {}

  get<K extends ConfigKey>(key: K): ConfigValue<K> {
    if (!this.values.has(key)) {
      // A key in `CONFIG_SPECS` that is not in the database means migration 0011
      // did not run, or someone deleted a row. Both are broken deployments, and
      // guessing a default here would hide that behind a plausible number.
      throw new Error(
        `Platform config "${key}" is missing from the database. Has db:migrate run?`,
      )
    }
    return this.values.get(key) as ConfigValue<K>
  }

  has(key: string): boolean {
    return this.values.has(key)
  }
}

/**
 * A snapshot built from the seeded values in `CONFIG_SPECS`, with no database.
 *
 * For unit tests: the pricing engine, the state machine's timers and the refund
 * policy can all be tested against the values the platform actually ships with.
 * Never used in production — nothing calls it outside tests and `loadSettings`
 * does not fall back to it, because a silent fallback would let a broken
 * deployment price real orders from hard-coded defaults.
 */
export function settingsFromSpecs(overrides: Partial<Record<ConfigKey, unknown>> = {}): PlatformSettings {
  const values = new Map<string, unknown>()
  for (const key of CONFIG_KEYS) {
    values.set(key, CONFIG_SPECS[key].seed)
  }
  for (const [key, value] of Object.entries(overrides)) {
    values.set(key, value)
  }
  return new Snapshot(values, new Date(0))
}

/** How long a snapshot is reused. Also the worst-case staleness across instances. */
export const CONFIG_CACHE_TTL_MS = 30_000

let cached: { settings: PlatformSettings; expiresAt: number } | null = null
let injected: PlatformSettings | null = null

/**
 * Read every policy value in one query.
 *
 * Rows in the database that `CONFIG_SPECS` does not know about are skipped with a
 * warning rather than treated as fatal: a migration that adds a key ahead of the
 * code that reads it is a normal deploy ordering, and refusing to start would
 * turn it into an outage.
 */
export async function loadSettings(db: DbHandle = getDb()): Promise<PlatformSettings> {
  if (injected) return injected

  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.settings

  const rows = await db
    .select({
      key: platformConfig.key,
      value: platformConfig.value,
      valueType: platformConfig.valueType,
    })
    .from(platformConfig)

  const known = new Set<string>(CONFIG_KEYS)
  const values = new Map<string, unknown>()
  const unreadable: string[] = []

  for (const row of rows) {
    if (!known.has(row.key)) {
      logger.warn('Ignoring unknown platform config key', { key: row.key })
      continue
    }
    const coerced = coerceConfigValue(row.key, row.valueType, row.value)
    if (!coerced.ok) {
      unreadable.push(row.key)
      continue
    }
    values.set(row.key, coerced.value)
  }

  if (unreadable.length > 0) {
    // The stored value cannot be read as its own declared type. Refusing to
    // serve is correct: the alternative is pricing an order from a value nobody
    // can interpret.
    throw new Error(
      `Platform config values are unreadable as their declared types: ${unreadable.join(', ')}`,
    )
  }

  const settings = new Snapshot(values, new Date(now))
  cached = { settings, expiresAt: now + CONFIG_CACHE_TTL_MS }
  return settings
}

/** Read one value. Prefer `loadSettings` when several values must agree. */
export async function getConfigValue<K extends ConfigKey>(
  key: K,
  db?: DbHandle,
): Promise<ConfigValue<K>> {
  const settings = await loadSettings(db)
  return settings.get(key)
}

/** Called after every write, and by tests. */
export function invalidateConfigCache(): void {
  cached = null
  flagCache = null
}

/** Unit-test seam: pass a snapshot to use, or `null` to go back to the database. */
export function __setSettingsForTests(settings: PlatformSettings | null): void {
  injected = settings
  invalidateConfigCache()
}

// ── Writing ─────────────────────────────────────────────────────────────────

export interface ConfigRow {
  key: string
  value: unknown
  valueType: ConfigValueType
  section: string
  label: string
  description: string
  unit: string | null
  minValue: string | null
  maxValue: string | null
  requiresSuperAdmin: boolean
  isPublic: boolean
  isReadonly: boolean
  version: number
  updatedAt: Date
}

/** Everything the admin console's settings screens render. */
export async function listConfig(db: DbHandle = getDb()): Promise<ConfigRow[]> {
  const rows = await db.select().from(platformConfig).orderBy(platformConfig.key)
  return rows.map((row) => ({
    key: row.key,
    value: row.value,
    valueType: row.valueType,
    section: row.section,
    label: row.label,
    description: row.description,
    unit: row.unit,
    minValue: row.minValue,
    maxValue: row.maxValue,
    requiresSuperAdmin: row.requiresSuperAdmin,
    isPublic: row.isPublic,
    isReadonly: row.isReadonly,
    version: row.version,
    updatedAt: row.updatedAt,
  }))
}

/**
 * Which capability a key sits behind.
 *
 * Commission and the customer fee are the platform's revenue model, so they get
 * their own capability and their own audit action. Everything else is policy.
 */
export function capabilityForConfigKey(key: string): Capability {
  return key.startsWith('commission.') || key === 'customer.platform_fee_paise'
    ? 'platform.commission'
    : 'platform.config'
}

export interface SetConfigInput {
  readonly key: ConfigKey
  /** The new value as JSON, exactly as it will be stored. */
  readonly value: unknown
  readonly actor: AuthContext
  /** Mandatory, recorded on the history row and in the audit log. */
  readonly reason: string
  /** When the change takes effect. Defaults to now. */
  readonly effectiveFrom?: Date
}

export interface ConfigChange {
  readonly key: string
  readonly version: number
  readonly previous: unknown
  readonly current: unknown
  /** False when the value submitted was the one already stored. */
  readonly changed: boolean
}

/**
 * Change one policy value.
 *
 * Four things happen together, in one transaction, or none of them do: the row is
 * updated and its version bumped, a history row is written, an audit row is
 * written, and the cache is dropped. `platform_config_history` has no trigger
 * behind it — history is the application's responsibility, which is precisely why
 * it must not be a separate step that can be skipped.
 *
 * Two gates compose here, and both are load-bearing. The capability check asks
 * whether this role may change configuration at all; the row's own
 * `requires_super_admin` asks whether *this* value needs the highest authority.
 * A Finance Admin passes the first and fails the second on the commission rate,
 * which is the intended outcome of "🟡 (propose)" in §15.
 */
export async function setConfigValue(
  input: SetConfigInput,
  db?: DbHandle,
): Promise<Result<ConfigChange, AppError>> {
  if (db) return applyConfigChange(db, input)
  return withTransaction((tx) => applyConfigChange(tx, input))
}

async function applyConfigChange(
  db: DbHandle,
  input: SetConfigInput,
): Promise<Result<ConfigChange, AppError>> {
  const { key, actor, reason } = input

  const granted = requireCapability(actor, capabilityForConfigKey(key), { reason })
  if (!granted.ok) return granted

  const [row] = await db
    .select()
    .from(platformConfig)
    .where(eq(platformConfig.key, key))
    .for('update')

  if (!row) return err(errors.notFound('That setting'))

  if (row.isReadonly) {
    return err(
      errors.forbidden(
        `${key} is shown for reference only and is changed by a migration, not from here.`,
      ),
    )
  }

  if (row.requiresSuperAdmin && actor.role !== 'admin_super') {
    return err(errors.forbidden(`${key} can only be changed by a Super Admin.`))
  }

  const coerced = coerceConfigValue(key, row.valueType, input.value)
  if (!coerced.ok) return coerced

  const withinBounds = checkBounds(key, row.valueType, coerced.value, row.minValue, row.maxValue)
  if (!withinBounds.ok) return withinBounds

  const stored = serialiseConfigValue(key, coerced.value)

  // Idempotent: re-submitting the value already in force is not a change, and
  // does not deserve a history row, an audit entry or a version bump.
  if (JSON.stringify(stored) === JSON.stringify(row.value)) {
    return ok({
      key,
      version: row.version,
      previous: row.value,
      current: row.value,
      changed: false,
    })
  }

  const version = row.version + 1

  await db
    .update(platformConfig)
    .set({ value: stored, version, updatedBy: actor.userId, updatedAt: new Date() })
    .where(eq(platformConfig.key, key))

  await db.insert(platformConfigHistory).values({
    // No database default on `id` (migration 0009), so it is minted here.
    id: newId(),
    key: row.key,
    version,
    oldValue: row.value,
    newValue: stored,
    changedBy: actor.userId,
    reason,
    effectiveFrom: input.effectiveFrom ?? new Date(),
  })

  await recordAudit(
    {
      action:
        capabilityForConfigKey(key) === 'platform.commission'
          ? 'config.commission_changed'
          : 'config.changed',
      actor,
      // The action already declares its target type; naming it again here would
      // be a second place for it to drift.
      target: { label: key },
      before: { value: row.value, version: row.version },
      after: { value: stored, version },
      reason,
      grant: granted.value,
    },
    db,
  )

  invalidateConfigCache()

  return ok({ key, version, previous: row.value, current: stored, changed: true })
}

/**
 * Validate against the row's own bounds.
 *
 * The bounds are `numeric`, read as strings so no precision is lost between
 * Postgres and JavaScript. Comparison is numeric, which is safe for every bound
 * the platform declares — none of them approach the limits of a double.
 */
function checkBounds(
  key: string,
  type: ConfigValueType,
  value: unknown,
  minValue: string | null,
  maxValue: string | null,
): Result<true, AppError> {
  if (minValue === null && maxValue === null) return ok(true)
  if (typeof value !== 'number' && typeof value !== 'bigint') return ok(true)

  const numeric = Number(value)
  if (minValue !== null && numeric < Number(minValue)) {
    return err(badValue(key, `at least ${minValue}${unitHint(type)}, got ${numeric}`))
  }
  if (maxValue !== null && numeric > Number(maxValue)) {
    return err(badValue(key, `at most ${maxValue}${unitHint(type)}, got ${numeric}`))
  }
  return ok(true)
}

function unitHint(type: ConfigValueType): string {
  switch (type) {
    case 'paise':
      return ' paise'
    case 'bps':
      return ' basis points'
    case 'minutes':
      return ' minutes'
    case 'hours':
      return ' hours'
    case 'days':
      return ' days'
    default:
      return ''
  }
}

// ── Feature flags ───────────────────────────────────────────────────────────

/**
 * The flags seeded by migration 0011.
 *
 * As with `CONFIG_SPECS`, only the key and its seeded state live here; the label
 * and description belong to the database. Typed keys mean a flag check cannot be
 * misspelled into permanently returning false, which is the classic way a feature
 * ships behind a flag that never turns on.
 */
export const FEATURE_FLAGS = {
  quote_flow: { seedEnabled: true, seedRolloutBps: 10_000 },
  whatsapp_notifications: { seedEnabled: false, seedRolloutBps: 0 },
  scan_at_counter: { seedEnabled: false, seedRolloutBps: 0 },
  large_format_catalogue: { seedEnabled: false, seedRolloutBps: 0 },
  scheduled_pickup: { seedEnabled: false, seedRolloutBps: 0 },
  shop_counter_orders: { seedEnabled: false, seedRolloutBps: 0 },
  public_review_comments: { seedEnabled: true, seedRolloutBps: 10_000 },
  admin_impersonation: { seedEnabled: false, seedRolloutBps: 0 },
} as const satisfies Record<string, { seedEnabled: boolean; seedRolloutBps: number }>

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS

export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlagKey[]

export interface FlagState {
  readonly key: string
  readonly isEnabled: boolean
  readonly rolloutBps: number
  readonly enabledUserIds: readonly string[]
  readonly enabledShopIds: readonly string[]
  readonly enabledCityIds: readonly string[]
}

/** Who the flag is being evaluated for. All three are optional. */
export interface FlagSubject {
  readonly userId?: string | null
  readonly shopId?: string | null
  readonly cityId?: string | null
}

/**
 * Bucket a subject into 0..9999, stably.
 *
 * Keyed by the flag name as well as the subject, so a user who lands in the first
 * 10% of one rollout is not thereby in the first 10% of every rollout. Plain
 * SHA-256 rather than a keyed HMAC: the same subject must land in the same bucket
 * in every process and in any SQL that ever needs to reproduce the calculation,
 * and there is nothing here worth hiding.
 */
export function rolloutBucket(key: string, subjectId: string): number {
  const digest = createHash('sha256').update(`${key}:${subjectId}`).digest()
  return digest.readUInt32BE(0) % Number(BPS_DENOMINATOR)
}

/**
 * Decide whether a flag is on, given its state and a subject.
 *
 * Order of precedence, and the reasoning for each step:
 *
 *   1. `isEnabled` is the master switch. Off means off for everyone, including
 *      the explicit lists — otherwise turning a misbehaving feature off would
 *      leave it on for exactly the people who had been testing it.
 *   2. An explicit id wins over the percentage. That is what the lists are for.
 *   3. A full rollout is on; a zero rollout is off.
 *   4. A partial rollout needs someone to bucket. With no subject, the answer is
 *      **off**: a percentage rollout that silently reads as 100% for anonymous
 *      traffic is the failure that makes flags untrustworthy.
 */
export function evaluateFlag(flag: FlagState, subject: FlagSubject = {}): boolean {
  if (!flag.isEnabled) return false

  if (subject.userId && flag.enabledUserIds.includes(subject.userId)) return true
  if (subject.shopId && flag.enabledShopIds.includes(subject.shopId)) return true
  if (subject.cityId && flag.enabledCityIds.includes(subject.cityId)) return true

  if (flag.rolloutBps >= Number(BPS_DENOMINATOR)) return true
  if (flag.rolloutBps <= 0) return false

  const subjectId = subject.userId ?? subject.shopId ?? subject.cityId
  if (!subjectId) return false

  return rolloutBucket(flag.key, subjectId) < flag.rolloutBps
}

let flagCache: { flags: ReadonlyMap<string, FlagState>; expiresAt: number } | null = null
let injectedFlags: ReadonlyMap<string, FlagState> | null = null

export async function loadFeatureFlags(
  db?: DbHandle,
): Promise<ReadonlyMap<string, FlagState>> {
  if (injectedFlags) return injectedFlags

  const now = Date.now()
  if (flagCache && flagCache.expiresAt > now) return flagCache.flags

  const resolvedDb = db ?? getDb()
  const rows = await resolvedDb.select().from(featureFlags)
  const flags = new Map<string, FlagState>()
  for (const row of rows) {
    flags.set(row.key, {
      key: row.key,
      isEnabled: row.isEnabled,
      rolloutBps: row.rolloutBps,
      enabledUserIds: row.enabledUserIds,
      enabledShopIds: row.enabledShopIds,
      enabledCityIds: row.enabledCityIds,
    })
  }

  flagCache = { flags, expiresAt: now + CONFIG_CACHE_TTL_MS }
  return flags
}

/**
 * Is this feature on for this subject?
 *
 * A flag missing from the database reads as off, not as an error. A deploy that
 * references a flag before its migration lands should degrade to the old
 * behaviour, which is what "off" means for every flag in `FEATURE_FLAGS`.
 */
export async function isFeatureEnabled(
  key: FeatureFlagKey,
  subject: FlagSubject = {},
  db?: DbHandle,
): Promise<boolean> {
  const flags = await loadFeatureFlags(db)
  const flag = flags.get(key)
  if (!flag) {
    logger.warn('Feature flag is not in the database; treating it as off', { flag: key })
    return false
  }
  return evaluateFlag(flag, subject)
}

/** Test seam. Pass a partial map; anything absent reads as off. */
export function __setFeatureFlagsForTests(flags: Record<string, Partial<FlagState>> | null): void {
  if (!flags) {
    injectedFlags = null
    flagCache = null
    return
  }
  const map = new Map<string, FlagState>()
  for (const [key, state] of Object.entries(flags)) {
    map.set(key, {
      key,
      isEnabled: state.isEnabled ?? true,
      rolloutBps: state.rolloutBps ?? Number(BPS_DENOMINATOR),
      enabledUserIds: state.enabledUserIds ?? [],
      enabledShopIds: state.enabledShopIds ?? [],
      enabledCityIds: state.enabledCityIds ?? [],
    })
  }
  injectedFlags = map
}

export interface SetFeatureFlagInput {
  readonly key: FeatureFlagKey
  readonly actor: AuthContext
  readonly reason: string
  readonly isEnabled?: boolean
  readonly rolloutBps?: number
  readonly enabledUserIds?: readonly string[]
  readonly enabledShopIds?: readonly string[]
  readonly enabledCityIds?: readonly string[]
}

/**
 * Change a flag's state, its rollout, or its explicit lists.
 *
 * Fields left out are left alone, so turning a flag off and on again does not
 * silently reset its rollout to zero. One consequence worth knowing at the call
 * site: `isEnabled: true` with a zero rollout and nobody listed is a valid state
 * that is on for no one, which is the natural intermediate step when a flag is
 * enabled first and the pilot shops are added second. The admin console says so
 * rather than preventing it.
 */
export async function setFeatureFlag(
  input: SetFeatureFlagInput,
  db?: DbHandle,
): Promise<Result<FlagState, AppError>> {
  if (db) return applyFlagChange(db, input)
  return withTransaction((tx) => applyFlagChange(tx, input))
}

async function applyFlagChange(
  db: DbHandle,
  input: SetFeatureFlagInput,
): Promise<Result<FlagState, AppError>> {
  const { key, actor, reason } = input

  const granted = requireCapability(actor, 'feature_flag.manage', { reason })
  if (!granted.ok) return granted

  if (input.rolloutBps !== undefined) {
    if (!Number.isInteger(input.rolloutBps) || input.rolloutBps < 0) {
      return err(badValue(key, 'a whole number of basis points'))
    }
    if (input.rolloutBps > Number(BPS_DENOMINATOR)) {
      return err(badValue(key, `at most ${BPS_DENOMINATOR} basis points`))
    }
  }

  const [row] = await db.select().from(featureFlags).where(eq(featureFlags.key, key)).for('update')
  if (!row) return err(errors.notFound('That feature flag'))

  const next = {
    isEnabled: input.isEnabled ?? row.isEnabled,
    rolloutBps: input.rolloutBps ?? row.rolloutBps,
    enabledUserIds: [...(input.enabledUserIds ?? row.enabledUserIds)],
    enabledShopIds: [...(input.enabledShopIds ?? row.enabledShopIds)],
    enabledCityIds: [...(input.enabledCityIds ?? row.enabledCityIds)],
  }

  await db
    .update(featureFlags)
    .set({ ...next, updatedBy: actor.userId, updatedAt: new Date() })
    .where(eq(featureFlags.key, key))

  await recordAudit(
    {
      action: 'feature_flag.changed',
      actor,
      target: { label: key },
      before: {
        isEnabled: row.isEnabled,
        rolloutBps: row.rolloutBps,
        enabledUserIds: row.enabledUserIds.length,
        enabledShopIds: row.enabledShopIds.length,
        enabledCityIds: row.enabledCityIds.length,
      },
      after: {
        isEnabled: next.isEnabled,
        rolloutBps: next.rolloutBps,
        enabledUserIds: next.enabledUserIds.length,
        enabledShopIds: next.enabledShopIds.length,
        enabledCityIds: next.enabledCityIds.length,
      },
      reason,
      grant: granted.value,
    },
    db,
  )

  invalidateConfigCache()

  return ok({ key, ...next })
}
