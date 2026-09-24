/**
 * The database connection.
 *
 * One pool per process, one drizzle instance over it. Every repository takes a
 * `DbHandle` rather than reaching for the singleton, so the same function works
 * inside a transaction and outside one — which is what lets an order transition, its
 * audit row and its outbox event be written atomically (PRD §F).
 *
 * Two deliberate choices:
 *
 *   • `int8` stays a string in the driver and is converted by drizzle to `bigint`.
 *     Money is paise as `bigint` end to end; a silent `Number()` here would
 *     reintroduce the float rounding this codebase exists to avoid.
 *   • `date` is read as a plain 'YYYY-MM-DD' string. IST calendar dates
 *     (`shop_daily_stats.stat_date`) are not instants, and letting the driver turn
 *     them into midnight-UTC `Date` objects shifts every Indian day backwards by
 *     five and a half hours.
 */

import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool, types as pgTypes, type PoolClient } from 'pg'

import { getConfig } from '../config'
import { errors } from '../core/errors'
import { logger } from '../core/logger'
import * as schema from './schema'

// ── Driver type parsers ─────────────────────────────────────────────────────
// Set once, before any pool exists, so every connection in the process agrees.

const OID_DATE = 1082

let parsersConfigured = false

function configureTypeParsers(): void {
  if (parsersConfigured) return
  // 'YYYY-MM-DD' in, 'YYYY-MM-DD' out. No timezone is implied and none is applied.
  pgTypes.setTypeParser(OID_DATE, (value: string) => value)
  parsersConfigured = true
}

// ── Types ───────────────────────────────────────────────────────────────────

export type Schema = typeof schema
export type Database = NodePgDatabase<Schema>

/**
 * The transaction-scoped handle drizzle passes to a `transaction` callback. Derived
 * from `Database` rather than imported, so it cannot drift from the driver in use.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * What repositories accept. A repository must never care whether it is inside a
 * transaction; the caller decides that.
 */
export type DbHandle = Database | Transaction

// ── Pool ────────────────────────────────────────────────────────────────────

let pool: Pool | null = null
let database: Database | null = null

function createPool(): Pool {
  configureTypeParsers()
  const { db, app } = getConfig()

  const created = new Pool({
    connectionString: db.url,
    max: db.poolMax,
    ssl: db.ssl ? { rejectUnauthorized: true } : undefined,
    // A connection that has been idle this long is not worth keeping warm.
    idleTimeoutMillis: 30_000,
    // Fail fast if the pool is exhausted rather than queueing behind a stuck query.
    connectionTimeoutMillis: 10_000,
    // Every session speaks IST, so `now()::date` and any date_trunc in a report
    // land on the Indian calendar day the shop actually worked.
    options: '-c timezone=Asia/Kolkata',
    statement_timeout: 15_000,
    query_timeout: 20_000,
    // Long enough for a payment webhook's transaction, short enough to notice a leak.
    idle_in_transaction_session_timeout: 30_000,
    application_name: `chaapo-${app.env}`,
  })

  // An idle-client error is a lost connection, not a failed query: it arrives with
  // no caller to reject, so it must be logged or the process dies silently.
  created.on('error', (error) => {
    logger.error('database idle client error', error)
  })

  return created
}

/** The process pool. Created on first use. */
export function getPool(): Pool {
  if (!pool) pool = createPool()
  return pool
}

/** The process drizzle instance. */
export function getDb(): Database {
  if (!database) {
    database = drizzle(getPool(), {
      schema,
      logger: getConfig().app.isDev ? { logQuery } : false,
    })
  }
  return database
}

function logQuery(query: string, params: unknown[]): void {
  // Parameters are not logged: they carry encrypted PII, blind indexes and pickup
  // code hashes. The count is enough to correlate with the SQL.
  logger.debug('sql', { sql: query.replace(/\s+/g, ' ').trim().slice(0, 500), params: params.length })
}

/**
 * Close the pool. Called by the worker's shutdown handler and by the integration
 * test teardown; Next.js processes are torn down by the platform.
 */
export async function closeDb(): Promise<void> {
  const existing = pool
  pool = null
  database = null
  if (existing) await existing.end()
}

/** Test-only: inject a database built over a caller-managed pool. */
export function __setDbForTests(next: { pool: Pool; db: Database } | null): void {
  pool = next?.pool ?? null
  database = next?.db ?? null
}

// ── Transactions ────────────────────────────────────────────────────────────

export interface TransactionOptions {
  /**
   * `read committed` is the default and is correct wherever a uniqueness or check
   * constraint carries the invariant. Use `repeatable read` when the transaction
   * *reads* a value and then writes a decision based on it — a payout window
   * totalling its items, for instance — and be ready to retry.
   */
  isolation?: 'read committed' | 'repeatable read' | 'serializable'
  readOnly?: boolean
  /** How many times to retry a serialization failure or deadlock. */
  retries?: number
}

const RETRYABLE_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
])

/**
 * Run `fn` in a transaction, retrying the retryable failures.
 *
 * A serialization failure is not an error the user caused and not one they can act
 * on, so it is retried here rather than surfaced. Anything else propagates: the
 * transaction is rolled back and the caller decides.
 */
export async function withTransaction<T>(
  fn: (tx: Transaction) => Promise<T>,
  options: TransactionOptions = {},
  db: Database = getDb(),
): Promise<T> {
  const retries = options.retries ?? (options.isolation === 'read committed' ? 0 : 2)
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await db.transaction(fn, {
        isolationLevel: options.isolation,
        accessMode: options.readOnly ? 'read only' : undefined,
      })
    } catch (error) {
      lastError = error
      const state = sqlState(error)
      if (state && RETRYABLE_SQLSTATES.has(state) && attempt < retries) {
        logger.warn('retrying transaction', { sqlState: state, attempt: attempt + 1 })
        // A short, growing pause: two writers colliding immediately will collide again.
        await sleep(10 * 2 ** attempt)
        continue
      }
      throw error
    }
  }

  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Advisory locks ──────────────────────────────────────────────────────────

/**
 * Run `fn` while holding a transaction-scoped advisory lock, so exactly one process
 * can be doing this thing at a time. Used where a database constraint cannot express
 * the invariant: opening a payout window for a shop, allocating an invoice number,
 * running a retention sweep.
 *
 * The lock is transaction-scoped, so it is released on COMMIT or ROLLBACK — there is
 * no path where a crash leaves it held.
 */
export async function withAdvisoryLock<T>(
  tx: Transaction,
  namespace: number,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  // hashtext is stable within a major Postgres version, which is all a lock key needs.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${namespace}, hashtext(${key}))`)
  return fn()
}

/** Namespaces, so two unrelated locks cannot collide on the same hashed key. */
export const LOCK_NAMESPACE = {
  payoutWindow: 1,
  invoiceNumber: 2,
  retentionJob: 3,
  orderTransition: 4,
  shopSlug: 5,
} as const

// ── Error translation ───────────────────────────────────────────────────────

interface PgError {
  code?: string
  constraint?: string
  detail?: string
  table?: string
  column?: string
  message?: string
}

function asPgError(error: unknown): PgError | null {
  if (typeof error !== 'object' || error === null) return null
  const candidate = error as PgError
  return typeof candidate.code === 'string' ? candidate : null
}

/** The SQLSTATE of a driver error, if it is one. */
export function sqlState(error: unknown): string | undefined {
  return asPgError(error)?.code
}

/** True when the error is a unique-constraint violation on the named constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = asPgError(error)
  if (pg?.code !== '23505') return false
  return constraint === undefined || pg.constraint === constraint
}

export function isForeignKeyViolation(error: unknown, constraint?: string): boolean {
  const pg = asPgError(error)
  if (pg?.code !== '23503') return false
  return constraint === undefined || pg.constraint === constraint
}

/**
 * True when a guard in the database refused the write.
 *
 * The triggers in migration 0010 raise `check_violation`, `restrict_violation` or
 * `insufficient_privilege`; a bare `RAISE EXCEPTION` arrives as `P0001`. All of them
 * mean the same thing to the application: the invariant held and we were wrong.
 */
export function isGuardViolation(error: unknown): boolean {
  const state = sqlState(error)
  return state === '23514' || state === '23001' || state === '42501' || state === 'P0001'
}

/**
 * Translate a driver error into an `AppError` with a message a person can act on.
 *
 * Deliberately conservative: only the classes we can describe honestly are
 * translated, and the driver message is attached as `cause` for the log but never
 * as the user-facing text (NFR-13). Everything else becomes `internal`, which is
 * the right answer for "the database refused and we do not know why".
 */
export function translateDbError(error: unknown, context?: { what?: string }): unknown {
  const pg = asPgError(error)
  if (!pg) return error
  const what = context?.what ?? 'That'

  switch (pg.code) {
    case '23505':
      return errors.conflict(`${what} already exists.`, { constraint: pg.constraint })
    case '23503':
      return errors.conflict(
        `${what} refers to something that no longer exists.`,
        { constraint: pg.constraint },
      )
    case '23502':
      return errors.malformed(`${what} is missing a required value.`)
    case '23514':
    case '23001':
    case 'P0001':
      // A guard fired. The domain layer should have caught this first; that it did
      // not is a bug worth seeing, so this is logged as unexpected.
      logger.error('database guard refused a write', error, {
        constraint: pg.constraint,
        table: pg.table,
      })
      return errors.conflict(`${what} cannot be changed like that.`, {
        constraint: pg.constraint,
      })
    case '42501':
      return errors.forbidden('That record cannot be modified.')
    case '57014':
      return errors.upstreamTimeout('database', error)
    case '53300':
    case '08006':
    case '08003':
    case '08001':
      return errors.upstreamUnavailable('database', error)
    default:
      return error
  }
}

/**
 * Health check for the readiness probe and the admin console's system page.
 * Reports latency because a database that answers in 900 ms is a problem the
 * dashboard should show before customers feel it.
 */
export async function checkDbHealth(): Promise<{
  ok: boolean
  latencyMs: number
  poolTotal: number
  poolIdle: number
  poolWaiting: number
  error?: string
}> {
  const started = process.hrtime.bigint()
  const currentPool = getPool()
  let client: PoolClient | null = null
  try {
    client = await currentPool.connect()
    await client.query('SELECT 1')
    return {
      ok: true,
      latencyMs: Number(process.hrtime.bigint() - started) / 1e6,
      poolTotal: currentPool.totalCount,
      poolIdle: currentPool.idleCount,
      poolWaiting: currentPool.waitingCount,
    }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Number(process.hrtime.bigint() - started) / 1e6,
      poolTotal: currentPool.totalCount,
      poolIdle: currentPool.idleCount,
      poolWaiting: currentPool.waitingCount,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    client?.release()
  }
}

export { schema }
