import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Integration tests — run against the real stack from `docker compose up -d`
 * (Postgres + PostGIS, Redis, MinIO). They exercise the order state machine,
 * payment idempotency, PostGIS discovery and signed-URL issuance end to end.
 *
 *   npm run infra:up && npm run test:integration
 *
 * The setup file creates `chaapo_test` if it is missing and applies migrations
 * itself, so there is no separate prepare step and no way to test against a stale
 * schema. It refuses to run against a database whose name does not end in `_test`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.itest.ts'],
    exclude: ['**/node_modules/**', '**/.next/**'],
    globals: false,
    // Integration tests share one Postgres schema; run them serially so
    // advisory locks and FOR UPDATE assertions stay deterministic.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    setupFiles: ['./src/test/setup-integration.ts'],
    reporters: ['default'],
  },
})
