/**
 * The migration engine.
 *
 * The SQL files in `db/migrations` are the source of truth for the schema; the
 * drizzle definitions in `./schema` mirror them, and `schema-parity.itest.ts`
 * asserts the two agree. Nothing here generates SQL — the migrations are written by
 * hand because the interesting parts of this schema (the generated `discoverable`
 * column, the deferred ledger-balance constraint trigger, partial unique indexes,
 * the append-only guards) are not things a generator gets right.
 *
 * This module is the logic; `scripts/migrate.ts` is the command-line face of it and
 * `src/test/setup-integration.ts` calls it directly so integration tests can never
 * run against a stale schema. It reports progress through `onEvent` and throws typed
 * errors rather than printing or exiting, so both callers can present failures in
 * their own way.
 *
 * Guarantees:
 *
 *   • Ordered. Files are applied in filename order, which is why they are numbered.
 *   • Exactly once. Applied migrations are recorded in `_migrations`.
 *   • Atomic per migration. Each file runs inside one transaction, so a failure
 *     leaves the database on the previous migration rather than halfway through this
 *     one. Postgres does transactional DDL; we rely on it.
 *   • Tamper-evident. Each file's SHA-256 is stored. Editing a migration that has
 *     already been applied is refused, because the file and the database would then
 *     disagree and no amount of re-running could reconcile them.
 *   • Single-writer. A session advisory lock means two deploys landing together
 *     serialise instead of racing.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { Client } from 'pg'

/** Arbitrary but fixed: two runners must choose the same number to exclude each other. */
const MIGRATION_LOCK_ID = 947_216_301

const DEFAULT_MIGRATIONS_DIR = resolve(process.cwd(), 'db/migrations')

// ── Types ───────────────────────────────────────────────────────────────────

export interface MigrationFile {
  /** '0003' — the ordering key. */
  version: string
  /** '0003_geography_and_shops.sql' */
  filename: string
  /** 'geography_and_shops' */
  name: string
  sql: string
  /** SHA-256 of the file with line endings normalised. */
  checksum: string
}

export interface AppliedMigration {
  version: string
  filename: string
  checksum: string
  appliedAt: Date
  durationMs: number
}

export type MigratorEvent =
  | { type: 'database-created'; database: string }
  | { type: 'reset'; database: string }
  | { type: 'applying'; migration: MigrationFile }
  | { type: 'applied'; migration: MigrationFile; durationMs: number }
  | { type: 'failed'; migration: MigrationFile }

export interface MigrateOptions {
  /** Postgres connection string. Required; there is no implicit default. */
  url: string
  ssl?: boolean
  /** Drop and recreate the `public` schema first. Development and test only. */
  reset?: boolean
  /** Apply up to and including this version, e.g. '0005'. */
  to?: string | null
  /** Validate and report, change nothing. */
  dryRun?: boolean
  /**
   * Gates `reset` and database auto-creation. Defaults to `APP_ENV`, then
   * `NODE_ENV`, then 'development' — the same precedence the app uses.
   */
  appEnv?: string
  migrationsDir?: string
  onEvent?: (event: MigratorEvent) => void
}

export interface MigrateResult {
  /** Applied by this run, in order. Empty when there was nothing to do. */
  applied: MigrationFile[]
  /** Already applied before this run started. */
  alreadyApplied: number
  /** Deferred because of `to`. */
  deferred: MigrationFile[]
  totalMs: number
  /** The version the database is on now, or 'an empty schema'. */
  at: string
  databaseCreated: boolean
}

/** A migration file failed to apply. Carries the driver's diagnostics. */
export class MigrationFailedError extends Error {
  readonly filename: string
  readonly sql: string
  readonly sqlState: string | undefined
  readonly detail: string | undefined
  readonly hint: string | undefined
  readonly where: string | undefined
  readonly position: string | undefined
  /** The version the database is on after the rollback. */
  readonly at: string

  constructor(migration: MigrationFile, at: string, cause: unknown) {
    const pg = asPgError(cause)
    super(`${migration.filename} failed: ${pg?.message ?? String(cause)}`, { cause })
    this.name = 'MigrationFailedError'
    this.filename = migration.filename
    this.sql = migration.sql
    this.sqlState = pg?.code
    this.detail = pg?.detail
    this.hint = pg?.hint
    this.where = pg?.where
    this.position = pg?.position
    this.at = at
  }
}

/**
 * An already-applied migration no longer matches the database.
 *
 * This is unrecoverable by re-running, which is exactly why it is a distinct error:
 * the fix is to restore the file or write a new migration, never to try again.
 */
export class MigrationDriftError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(`Migration drift detected:\n  ${problems.join('\n  ')}`)
    this.name = 'MigrationDriftError'
    this.problems = problems
  }
}

// ── Discovery ───────────────────────────────────────────────────────────────

/** Read and validate every migration file, in application order. */
export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  if (!existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`)
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  if (files.length === 0) {
    throw new Error(`No .sql files found in ${dir}`)
  }

  const seen = new Set<string>()
  return files.map((filename) => {
    const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(filename)
    if (!match) {
      throw new Error(`Migration filename must be NNNN_snake_case_name.sql — got '${filename}'`)
    }
    const [, version = '', name = ''] = match
    if (seen.has(version)) {
      throw new Error(`Duplicate migration version ${version} (${filename})`)
    }
    seen.add(version)

    const sql = readFileSync(join(dir, filename), 'utf8')
    if (sql.trim().length === 0) {
      throw new Error(`Migration ${filename} is empty`)
    }

    return {
      version,
      filename,
      name,
      sql,
      // Line endings are normalised so a checkout on Windows does not read as drift.
      checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'),
    }
  })
}

// ── Bookkeeping ─────────────────────────────────────────────────────────────

/**
 * `_migrations` is created by the runner, not by a migration, because it has to
 * exist before the first migration can be recorded. The leading underscore keeps it
 * visibly apart from the application's 68 tables.
 */
const CREATE_LEDGER = `
  CREATE TABLE IF NOT EXISTS _migrations (
    version     text        PRIMARY KEY,
    filename    text        NOT NULL,
    checksum    text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer     NOT NULL,
    applied_by  text
  )
`

interface LedgerRow {
  version: string
  filename: string
  checksum: string
  applied_at: Date
  duration_ms: number
}

async function readApplied(client: Client): Promise<Map<string, AppliedMigration>> {
  await client.query(CREATE_LEDGER)
  const { rows } = await client.query<LedgerRow>(
    'SELECT version, filename, checksum, applied_at, duration_ms FROM _migrations ORDER BY version',
  )
  return new Map(
    rows.map((row) => [
      row.version,
      {
        version: row.version,
        filename: row.filename,
        checksum: row.checksum,
        appliedAt: row.applied_at,
        durationMs: row.duration_ms,
      },
    ]),
  )
}

/**
 * Compare the files on disk against what the database says was applied.
 * Returns human-readable problems; an empty array means the history is intact.
 */
export function findDrift(
  files: MigrationFile[],
  applied: Map<string, AppliedMigration>,
): string[] {
  const problems: string[] = []

  for (const file of files) {
    const record = applied.get(file.version)
    if (!record) continue
    if (record.checksum !== file.checksum) {
      problems.push(`${file.filename} — contents changed since it was applied`)
    } else if (record.filename !== file.filename) {
      problems.push(`${file.filename} — was applied as ${record.filename}`)
    }
  }

  for (const [version, record] of applied) {
    if (!files.some((f) => f.version === version)) {
      problems.push(`${record.filename} — applied, but the file is gone`)
    }
  }

  return problems
}

// ── Connection ──────────────────────────────────────────────────────────────

function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '') || 'postgres'
}

function resolveAppEnv(explicit: string | undefined): string {
  return explicit ?? process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development'
}

function isDisposable(appEnv: string): boolean {
  return appEnv === 'development' || appEnv === 'test'
}

function connect(url: string, ssl: boolean | undefined): Client {
  return new Client({
    connectionString: url,
    ssl: ssl ? { rejectUnauthorized: true } : undefined,
    application_name: 'chaapo-migrate',
    // DDL on a large table legitimately runs for minutes. The app pool's 15 s
    // statement_timeout would abort it, which is why migrations never use that pool.
    statement_timeout: 0,
  })
}

/**
 * Create the target database when it does not exist yet.
 *
 * `docker compose up` only creates `chaapo`, so `chaapo_test` would otherwise have
 * to be created by hand before the first integration run. Restricted to development
 * and test: in staging or production a missing database means the connection string
 * is wrong, and quietly creating an empty one would hide that.
 */
async function ensureDatabase(
  url: string,
  ssl: boolean | undefined,
  appEnv: string,
): Promise<boolean> {
  const target = databaseNameOf(url)
  if (!isDisposable(appEnv)) {
    throw new Error(
      `Database '${target}' does not exist. Refusing to create it when APP_ENV is '${appEnv}'.`,
    )
  }

  const maintenanceUrl = new URL(url)
  maintenanceUrl.pathname = '/postgres'
  const admin = connect(maintenanceUrl.toString(), ssl)
  await admin.connect()
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [target])
    if (existing.rowCount === 0) {
      // Identifier, so it cannot be a bind parameter. The name comes from our own
      // connection string and is quoted; there is no user input on this path.
      await admin.query(`CREATE DATABASE "${target.replace(/"/g, '""')}"`)
      return true
    }
    return false
  } finally {
    await admin.end()
  }
}

/** Connect, creating the database first if that is why the connection failed. */
async function connectOrCreate(
  url: string,
  ssl: boolean | undefined,
  appEnv: string,
): Promise<{ client: Client; created: boolean }> {
  try {
    const client = connect(url, ssl)
    await client.connect()
    return { client, created: false }
  } catch (error) {
    // 3D000 invalid_catalog_name — the server is up, the database is not there.
    if (asPgError(error)?.code !== '3D000') throw error
    const created = await ensureDatabase(url, ssl, appEnv)
    const client = connect(url, ssl)
    await client.connect()
    return { client, created }
  }
}

/**
 * Drop everything this application owns and start from empty.
 *
 * Dropping `public` takes the tables, types, functions, triggers and views with it,
 * which is the point — a partial reset that leaves a stale enum behind is worse than
 * no reset at all. The extensions are recreated by migration 0001.
 */
async function resetSchema(client: Client, appEnv: string): Promise<void> {
  if (!isDisposable(appEnv)) {
    throw new Error(`--reset is refused when APP_ENV is '${appEnv}'`)
  }
  await client.query('DROP SCHEMA IF EXISTS public CASCADE')
  await client.query('CREATE SCHEMA public')
  // PostGIS installs into public; the migrations expect to find it on the search path.
  await client.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
  await client.query('GRANT ALL ON SCHEMA public TO public')
}

// ── Apply ───────────────────────────────────────────────────────────────────

async function applyOne(client: Client, migration: MigrationFile): Promise<number> {
  const started = Date.now()
  await client.query('BEGIN')
  try {
    // The whole file, as written. Function bodies and DO blocks contain semicolons,
    // so it must not be split into statements — Postgres accepts a multi-statement
    // string, and a naive splitter would corrupt every trigger function in 0010.
    await client.query(migration.sql)
    const durationMs = Date.now() - started
    await client.query(
      `INSERT INTO _migrations (version, filename, checksum, duration_ms, applied_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        migration.version,
        migration.filename,
        migration.checksum,
        durationMs,
        process.env.USER ?? 'unknown',
      ],
    )
    await client.query('COMMIT')
    return durationMs
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

/** Apply every pending migration. Throws `MigrationDriftError` or `MigrationFailedError`. */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const appEnv = resolveAppEnv(options.appEnv)
  const files = loadMigrations(options.migrationsDir)
  const emit = options.onEvent ?? (() => undefined)

  const { client, created } = await connectOrCreate(options.url, options.ssl, appEnv)
  if (created) emit({ type: 'database-created', database: databaseNameOf(options.url) })

  try {
    // Session-scoped, so it is held for the whole run and released on disconnect —
    // including the disconnect caused by this process being killed.
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [MIGRATION_LOCK_ID],
    )
    if (lock.rows[0]?.locked !== true) {
      throw new Error('Another migration run holds the lock. Wait for it to finish.')
    }

    if (options.reset) {
      await resetSchema(client, appEnv)
      emit({ type: 'reset', database: databaseNameOf(options.url) })
    }

    const applied = await readApplied(client)

    // Before touching anything, prove the past has not been rewritten.
    const drift = findDrift(files, applied)
    if (drift.length > 0) throw new MigrationDriftError(drift)

    const notApplied = files.filter((f) => !applied.has(f.version))
    const limit = options.to ?? null
    const pending = limit === null ? notApplied : notApplied.filter((f) => f.version <= limit)
    const deferred = limit === null ? [] : notApplied.filter((f) => f.version > limit)

    // Where the database stands. It advances as each migration commits, so a partial
    // run reports the version it reached rather than the one it started from.
    let at = [...applied.keys()].pop() ?? 'an empty schema'

    if (options.dryRun) {
      return {
        applied: [],
        alreadyApplied: applied.size,
        deferred: [...pending, ...deferred],
        totalMs: 0,
        at,
        databaseCreated: created,
      }
    }

    const done: MigrationFile[] = []
    let totalMs = 0

    for (const migration of pending) {
      emit({ type: 'applying', migration })
      try {
        const durationMs = await applyOne(client, migration)
        totalMs += durationMs
        at = migration.version
        done.push(migration)
        emit({ type: 'applied', migration, durationMs })
      } catch (error) {
        emit({ type: 'failed', migration })
        throw new MigrationFailedError(migration, at, error)
      }
    }

    return {
      applied: done,
      alreadyApplied: applied.size,
      deferred,
      totalMs,
      at,
      databaseCreated: created,
    }
  } finally {
    await client.end()
  }
}

/** Read the state of the world without changing it. */
export async function migrationStatus(options: {
  url: string
  ssl?: boolean
  migrationsDir?: string
}): Promise<{
  files: MigrationFile[]
  applied: Map<string, AppliedMigration>
  drift: string[]
  database: string
}> {
  const files = loadMigrations(options.migrationsDir)
  const client = connect(options.url, options.ssl)
  await client.connect()
  try {
    const applied = await readApplied(client)
    return {
      files,
      applied,
      drift: findDrift(files, applied),
      database: databaseNameOf(options.url),
    }
  } finally {
    await client.end()
  }
}

// ── Driver error shape ──────────────────────────────────────────────────────

interface PgErrorShape {
  message?: string
  detail?: string
  hint?: string
  position?: string
  where?: string
  code?: string
}

function asPgError(error: unknown): PgErrorShape | null {
  return typeof error === 'object' && error !== null ? (error as PgErrorShape) : null
}

/**
 * Turn the driver's character offset into 'line:column' plus the offending line.
 * Without it, a syntax error in a 700-line migration reports only 'position: 18422'.
 */
export function locateInSql(
  sql: string,
  position: string | undefined,
): { line: number; column: number; text: string } | null {
  if (!position) return null
  const offset = Number(position)
  if (!Number.isFinite(offset) || offset <= 0) return null
  const before = sql.slice(0, offset - 1)
  const line = before.split('\n').length
  return {
    line,
    column: offset - before.lastIndexOf('\n') - 1,
    text: (sql.split('\n')[line - 1] ?? '').trim(),
  }
}
