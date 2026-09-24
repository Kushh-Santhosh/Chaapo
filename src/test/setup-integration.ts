/**
 * Integration-test bootstrap.
 *
 * Integration tests run against the real stack from `docker compose up -d`:
 * Postgres 16 + PostGIS, Redis, MinIO. They exist to prove the things a unit test
 * cannot — that the order state machine is enforced by the database, that the ledger
 * balances, that PostGIS discovery excludes unverified shops, that a signed URL is
 * short-lived and scoped to one file.
 *
 *   npm run infra:up && npm run test:integration
 *
 * Three things happen here, in this order:
 *
 *   1. The environment is fixed, before anything that reads config is evaluated.
 *   2. `chaapo_test` is created if absent and migrations are applied, once per
 *      worker process, so a test can never run against yesterday's schema.
 *   3. Every test file starts from reference data only — the rows seeded by
 *      migration 0011 are present, and nothing else is.
 */

// Must be first: it installs the environment the imports below read. Not sortable.
import { TEST_DATABASE_NAME, TEST_DATABASE_URL } from './env-integration'

import { afterAll, beforeAll } from 'vitest'

import { closeDb } from '@/server/db/client'
import { migrate } from '@/server/db/migrator'

import { truncateToReferenceData } from './db'

/**
 * Migrate once per worker process, not once per test file.
 *
 * `setupFiles` is evaluated for every test file, but they share a process because
 * `fileParallelism` is off, so the memo lives on `globalThis`.
 */
const MIGRATED = Symbol.for('chaapo.test.migrated')
type MigrationHolder = { [MIGRATED]?: Promise<void> }

function migrateOnce(): Promise<void> {
  const holder = globalThis as unknown as MigrationHolder
  holder[MIGRATED] ??= migrate({ url: TEST_DATABASE_URL, appEnv: 'test' })
    .then(() => undefined)
    .catch((error: unknown) => {
      // Clear the memo, so the next test file gets the same clear failure rather
      // than a rejection from an already-settled promise.
      delete holder[MIGRATED]
      throw new Error(
        `Could not prepare ${TEST_DATABASE_NAME}. Is the stack up? Try: npm run infra:up\n` +
          `  ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    })
  return holder[MIGRATED]
}

beforeAll(async () => {
  await migrateOnce()
  await truncateToReferenceData()
})

afterAll(async () => {
  await closeDb()
})
