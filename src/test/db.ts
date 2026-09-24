/**
 * Database helpers for integration tests.
 *
 * Tests use the application's own pool and drizzle instance — `getDb()`, not a
 * parallel connection — so they exercise the real client: its `date` type parser,
 * its IST session timezone, its transaction retry. A test that passes against a
 * hand-rolled connection and fails against the app's is worse than no test.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { getDb, getPool, type Database } from '@/server/db/client'

/** The application's drizzle instance, pointed at the test database. */
export function testDb(): Database {
  return getDb()
}

/** Escape an identifier for interpolation. Table names come from `pg_class`, not input. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

let tableCache: string[] | null = null

/**
 * Every table the application owns, in name order.
 *
 * Extension-owned tables are excluded by their `pg_depend` entry, which is how
 * PostGIS's `spatial_ref_sys` stays out of the truncate list without being named.
 * `_migrations` is the runner's bookkeeping and is not ours to clear.
 */
export async function listAppTables(): Promise<string[]> {
  if (tableCache) return tableCache
  const { rows } = await getPool().query<{ table_name: string }>(`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname <> '_migrations'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e'
      )
    ORDER BY c.relname
  `)
  tableCache = rows.map((row) => row.table_name)
  return tableCache
}

/**
 * Empty every application table.
 *
 * One statement listing all of them, which is both fast and the only way Postgres
 * will truncate tables that reference each other. `CASCADE` is belt and braces for
 * anything a future migration adds outside the list.
 *
 * TRUNCATE does not fire the row-level `forbid_mutation()` triggers, so the
 * append-only tables — `audit_logs`, `order_events`, `ledger_entries` — are cleared
 * without having to disable the guards that protect them in production.
 */
export async function truncateAll(): Promise<void> {
  const tables = await listAppTables()
  if (tables.length === 0) return
  await getPool().query(
    `TRUNCATE ${tables.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`,
  )
}

let referenceSql: string | null = null

/** Migration 0011 verbatim: paper sizes, the catalogue, cities, config, templates. */
function referenceDataSql(): string {
  referenceSql ??= readFileSync(
    resolve(process.cwd(), 'db/migrations/0011_reference_data.sql'),
    'utf8',
  )
  return referenceSql
}

/**
 * Empty every table, then restore platform reference data.
 *
 * The reference tables cannot simply be left alone: `platform_config` and
 * `feature_flags` both carry a `updated_by` foreign key to `users`, so a
 * `TRUNCATE users CASCADE` would take them with it. Re-applying migration 0011 is
 * simpler than working around that, and it has the better property — reference data
 * in a test is byte-identical to reference data in production, because it is the
 * same statements.
 */
export async function truncateToReferenceData(): Promise<void> {
  await truncateAll()
  await getPool().query(referenceDataSql())
}

/** Row count for a single table. For assertions like "nothing else was written". */
export async function countRows(table: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${quoteIdent(table)}`,
  )
  return Number(rows[0]?.count ?? '0')
}

/**
 * Escape hatch for schema introspection and for asserting on columns the domain
 * layer deliberately does not expose (encrypted PII, `geography` points).
 */
export async function raw<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const { rows } = await getPool().query<T>(text, params)
  return rows
}
