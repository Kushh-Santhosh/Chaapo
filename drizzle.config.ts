import { defineConfig } from 'drizzle-kit'

/**
 * Drizzle config.
 *
 * Note: migrations are hand-written SQL under `db/migrations/` and applied by
 * `scripts/migrate.ts`. We do not use `drizzle-kit generate`, because the schema
 * relies on PostGIS geography columns, GiST indexes, immutability triggers,
 * partial unique indexes and CHECK constraints that the generator cannot express
 * (see IMPLEMENTATION_PLAN.md §5). The TypeScript schema in `src/server/db/schema`
 * is the typed query surface and is kept in lockstep with the SQL by
 * `src/server/db/schema-parity.itest.ts`.
 *
 * This config exists for `drizzle-kit studio` / `drizzle-kit check`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema/index.ts',
  out: './db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://chaapo:chaapo@localhost:5432/chaapo',
  },
  verbose: true,
  strict: true,
})
