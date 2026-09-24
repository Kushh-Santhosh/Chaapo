/**
 * Schema parity.
 *
 * The SQL files in `db/migrations` are the source of truth; the drizzle definitions
 * in `./schema` are a mirror kept by hand. This test is what makes that arrangement
 * safe — it compares the mirror against the live database column by column, in both
 * directions, and fails with the full list of differences rather than the first one.
 *
 * Drift here is not cosmetic. A `notNull` column that TypeScript thinks is nullable
 * produces runtime nulls the domain layer never checks; a `.default()` declared in TS
 * that the database does not have makes drizzle omit the column from the INSERT and
 * Postgres reject the row; a column missing from TS is invisible to every query
 * builder in the codebase.
 *
 * Scope, as documented in every schema module: SQL owns indexes, CHECK constraints
 * and triggers; TypeScript owns tables, columns, types, nullability and defaults.
 * This test asserts the TypeScript half. The SQL half is asserted by the behavioural
 * tests that try to violate each guard.
 */

import { is } from 'drizzle-orm'
import { getTableConfig, PgTable, type PgColumn } from 'drizzle-orm/pg-core'
import { beforeAll, describe, expect, it } from 'vitest'

import { raw } from '@/test/db'

import * as schema from './schema'

// ── What the database says ──────────────────────────────────────────────────

interface DbColumn {
  table: string
  column: string
  /** `format_type()`, e.g. 'timestamp with time zone', 'geography(Point,4326)'. */
  type: string
  notNull: boolean
  hasDefault: boolean
  isGenerated: boolean
}

const dbColumns = new Map<string, Map<string, DbColumn>>()
const dbPrimaryKeys = new Map<string, Set<string>>()
let dbTables = new Set<string>()
let dbViews = new Set<string>()
let dbEnums = new Map<string, string[]>()
let dbExtensions = new Set<string>()

beforeAll(async () => {
  // Extension-owned relations are excluded by their pg_depend entry, which keeps
  // PostGIS's spatial_ref_sys out without naming it.
  const columns = await raw<{
    table_name: string
    column_name: string
    type: string
    not_null: boolean
    has_default: boolean
    is_generated: boolean
  }>(`
    SELECT c.relname                            AS table_name,
           a.attname                            AS column_name,
           format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull                         AS not_null,
           a.atthasdef                          AS has_default,
           a.attgenerated <> ''                 AS is_generated
    FROM pg_attribute a
    JOIN pg_class c     ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname <> '_migrations'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e'
      )
    ORDER BY c.relname, a.attnum
  `)

  for (const row of columns) {
    let table = dbColumns.get(row.table_name)
    if (!table) {
      table = new Map()
      dbColumns.set(row.table_name, table)
    }
    table.set(row.column_name, {
      table: row.table_name,
      column: row.column_name,
      type: row.type,
      notNull: row.not_null,
      // A generated column reports a default it does not have in the ordinary sense.
      hasDefault: row.has_default && !row.is_generated,
      isGenerated: row.is_generated,
    })
  }
  dbTables = new Set(dbColumns.keys())

  const pks = await raw<{ table_name: string; column_name: string }>(`
    SELECT c.relname AS table_name, a.attname AS column_name
    FROM pg_index i
    JOIN pg_class c     ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
    WHERE i.indisprimary AND n.nspname = 'public'
  `)
  for (const row of pks) {
    const set = dbPrimaryKeys.get(row.table_name) ?? new Set<string>()
    set.add(row.column_name)
    dbPrimaryKeys.set(row.table_name, set)
  }

  const views = await raw<{ relname: string }>(`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e'
      )
  `)
  dbViews = new Set(views.map((v) => v.relname))

  const enums = await raw<{ typname: string; values: string[] }>(`
    SELECT t.typname,
           array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
    FROM pg_type t
    JOIN pg_enum e      ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname
  `)
  dbEnums = new Map(enums.map((e) => [e.typname, e.values]))

  const extensions = await raw<{ extname: string }>('SELECT extname FROM pg_extension')
  dbExtensions = new Set(extensions.map((e) => e.extname))
})

// ── What TypeScript says ────────────────────────────────────────────────────

interface TsTable {
  name: string
  columns: PgColumn[]
  primaryKey: Set<string>
}

function tsTables(): TsTable[] {
  // `Object.values(schema)` is a union of every table and enum in the barrel, and a type
  // predicate cannot narrow to `PgTable` from inside it — the union's members are each a
  // *more specific* table type than `PgTable<TableConfig>`. Widening to `unknown` first
  // lets drizzle's own `is()` do the narrowing at runtime, which is the check that counts.
  return (Object.values(schema) as unknown[])
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => {
      const config = getTableConfig(table)
      const primaryKey = new Set<string>(
        config.columns.filter((column) => column.primary).map((column) => column.name),
      )
      for (const composite of config.primaryKeys) {
        for (const column of composite.columns) primaryKey.add(column.name)
      }
      return { name: config.name, columns: [...config.columns], primaryKey }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

interface TsEnum {
  name: string
  values: string[]
}

/**
 * `pgEnum` objects are recognised by shape rather than by an `instanceof`: the two
 * properties below are drizzle's public surface for an enum and are stable across
 * versions, whereas the class that carries them is not.
 */
function tsEnums(): TsEnum[] {
  const found: TsEnum[] = []
  for (const value of Object.values(schema)) {
    if (typeof value !== 'object' && typeof value !== 'function') continue
    if (value === null) continue
    const candidate = value as { enumName?: unknown; enumValues?: unknown }
    if (typeof candidate.enumName === 'string' && Array.isArray(candidate.enumValues)) {
      found.push({ name: candidate.enumName, values: candidate.enumValues as string[] })
    }
  }
  return found
}

// ── Type comparison ─────────────────────────────────────────────────────────

/**
 * Reduce both sides to the same spelling.
 *
 * drizzle prints `varchar(20)` where Postgres prints `character varying(20)`, and
 * PostGIS prints `geography(Point,4326)` with a capital P. Everything else in this
 * schema — uuid, text, citext, boolean, smallint, integer, bigint, numeric, jsonb,
 * date, timestamp with time zone, the enums and their arrays — already agrees.
 */
function normaliseType(type: string): string {
  const lower = type.trim().toLowerCase().replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ')
  const aliases: Record<string, string> = {
    varchar: 'character varying',
    char: 'character',
    timestamptz: 'timestamp with time zone',
    timestamp: 'timestamp without time zone',
    int2: 'smallint',
    int4: 'integer',
    int8: 'bigint',
    bool: 'boolean',
    float4: 'real',
    float8: 'double precision',
    'double precision': 'double precision',
  }

  const array = lower.endsWith('[]')
  const base = array ? lower.slice(0, -2) : lower
  const match = /^([a-z_ ]+)(\(.*\))?$/.exec(base)
  if (!match) return lower
  const [, head = base, args = ''] = match
  const canonical = aliases[head.trim()] ?? head.trim()
  return `${canonical}${args}${array ? '[]' : ''}`
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('database preconditions', () => {
  it('has the three extensions the schema depends on', () => {
    // postgis for discovery, pg_trgm for shop search, citext for case-insensitive
    // keys. Deliberately no uuid-ossp: ids come from the application (newId()).
    expect([...dbExtensions].sort()).toEqual(
      expect.arrayContaining(['citext', 'pg_trgm', 'postgis']),
    )
  })

  it('declares every enum type the TypeScript schema references', () => {
    const problems: string[] = []
    for (const { name, values } of tsEnums()) {
      const actual = dbEnums.get(name)
      if (!actual) {
        problems.push(`enum ${name} is missing from the database`)
        continue
      }
      if (actual.join(',') !== values.join(',')) {
        problems.push(
          `enum ${name} differs\n    SQL: ${actual.join(', ')}\n    TS:  ${values.join(', ')}`,
        )
      }
    }
    expect(problems, problems.join('\n  ')).toEqual([])
  })
})

describe('schema parity', () => {
  it('defines every table that exists in the database', () => {
    const declared = new Set(tsTables().map((t) => t.name))
    const missing = [...dbTables].filter((name) => !declared.has(name)).sort()
    expect(
      missing,
      `These tables exist in db/migrations but not in src/server/db/schema:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  it('declares no table the database does not have', () => {
    const extra = tsTables()
      .map((t) => t.name)
      .filter((name) => !dbTables.has(name))
    expect(
      extra,
      `These tables are declared in TypeScript but do not exist:\n  ${extra.join('\n  ')}`,
    ).toEqual([])
  })

  it('matches every column: name, type, nullability and default', () => {
    const problems: string[] = []

    for (const table of tsTables()) {
      const actual = dbColumns.get(table.name)
      if (!actual) continue // reported by the table-level test

      for (const column of table.columns) {
        const where = `${table.name}.${column.name}`
        const dbColumn = actual.get(column.name)

        if (!dbColumn) {
          problems.push(`${where} — declared in TS, absent from the database`)
          continue
        }

        const tsType = normaliseType(column.getSQLType())
        const sqlType = normaliseType(dbColumn.type)
        if (tsType !== sqlType) {
          problems.push(`${where} — type: SQL is ${sqlType}, TS says ${tsType}`)
        }

        if (dbColumn.notNull !== column.notNull) {
          problems.push(
            `${where} — nullability: SQL is ${dbColumn.notNull ? 'NOT NULL' : 'nullable'}, ` +
              `TS says ${column.notNull ? 'notNull()' : 'nullable'}`,
          )
        }

        // Generated columns are excluded: `generatedAlwaysAs()` sets hasDefault in
        // drizzle, and the database reports a default expression, but neither is a
        // default in the sense that matters to an INSERT.
        if (!dbColumn.isGenerated && dbColumn.hasDefault !== column.hasDefault) {
          problems.push(
            dbColumn.hasDefault
              ? `${where} — SQL has a DEFAULT, TS does not declare .default(); ` +
                'drizzle will make the column required on insert'
              : `${where} — TS declares .default() but SQL has none; ` +
                'drizzle will omit the column and Postgres will reject the row',
          )
        }
      }

      for (const name of actual.keys()) {
        if (!table.columns.some((column) => column.name === name)) {
          problems.push(`${table.name}.${name} — exists in SQL, missing from TS`)
        }
      }
    }

    expect(problems, `\n  ${problems.join('\n  ')}\n`).toEqual([])
  })

  it('agrees on every primary key', () => {
    const problems: string[] = []
    for (const table of tsTables()) {
      if (!dbTables.has(table.name)) continue
      const actual = [...(dbPrimaryKeys.get(table.name) ?? [])].sort()
      const declared = [...table.primaryKey].sort()
      if (actual.join(',') !== declared.join(',')) {
        problems.push(
          `${table.name} — SQL: (${actual.join(', ') || 'none'}), TS: (${declared.join(', ') || 'none'})`,
        )
      }
    }
    expect(problems, `\n  ${problems.join('\n  ')}\n`).toEqual([])
  })

  it('marks the one generated column as generated', () => {
    // `shops.discoverable` is the verification gate expressed in the schema, so no
    // query can compute discoverability differently (NFR-10). If this list grows, the
    // new column belongs in the same conversation as the migration that added it.
    const generated = [...dbColumns].flatMap(([table, columns]) =>
      [...columns.values()].filter((c) => c.isGenerated).map((c) => `${table}.${c.column}`),
    )
    expect(generated.sort()).toEqual(['shops.discoverable'])
  })
})

describe('shop_balances view', () => {
  it('exists', () => {
    // Declared with `.existing()` in money.ts: owned by 0007_money.sql, mirrored in
    // TypeScript only so it can be selected from.
    expect(dbViews.has('shop_balances')).toBe(true)
  })

  it('exposes the columns money.ts declares', async () => {
    const columns = await raw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'shop_balances'
       ORDER BY ordinal_position`,
    )
    expect(columns.map((c) => c.column_name)).toEqual([
      'shop_id',
      'payable_paise',
      'settled_paise',
      'last_movement_at',
    ])
  })
})
