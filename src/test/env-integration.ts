/**
 * The environment integration tests run in.
 *
 * A separate module from `setup-integration.ts` for one reason: ES modules are
 * evaluated in import order, so importing this first guarantees the environment is
 * in place before anything that reads config — the database client, the storage
 * provider, the logger — is even evaluated. Inlining it in the setup file would make
 * that ordering depend on where the assignment happened to sit relative to the
 * imports, which is not a property worth relying on.
 */

import { __setConfigForTests } from '@/server/config'
import { resetEnvCache } from '@/server/config/env'

const DEFAULT_TEST_DATABASE_URL = 'postgresql://chaapo:chaapo@localhost:5432/chaapo_test'

/**
 * Where the tests write.
 *
 * `TEST_DATABASE_URL` is the only override, and it is deliberately not
 * `DATABASE_URL`: exporting that for a local `npm run dev` session must never
 * redirect the test suite onto the development database.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL

export const TEST_DATABASE_NAME = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '')

// The only thing between a mistyped connection string and a truncated development
// database. Unconditional, with no flag to turn it off.
if (!TEST_DATABASE_NAME.endsWith('_test')) {
  throw new Error(
    `Refusing to run integration tests against '${TEST_DATABASE_NAME}': the database ` +
      'name must end in _test. These tests truncate tables.',
  )
}

const fixed: Record<string, string> = {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  APP_URL: 'http://localhost:3000',
  LOG_LEVEL: 'error',

  DATABASE_URL: TEST_DATABASE_URL,
  // A small pool: the suite is serial, so a connection leak shows up as a timeout
  // rather than as a slow crawl through ten connections.
  DATABASE_POOL_MAX: '5',
  DATABASE_SSL: 'false',
  // Database 15, so a test run cannot flush the development cache or queues.
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',

  SESSION_SECRET: 'test-session-secret-must-be-at-least-32-chars',
  // Fixed key bytes, so ciphertext and blind-index fixtures are reproducible.
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PICKUP_TOKEN_SECRET: 'test-pickup-secret-must-be-at-least-32-chars',

  // MinIO with real presigned URLs. The point of these tests is that file privacy is
  // enforced by the storage layer, not by a mock that always says yes.
  STORAGE_PROVIDER: process.env.TEST_STORAGE_PROVIDER ?? 's3',
  S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000',
  S3_REGION: 'ap-south-1',
  S3_ACCESS_KEY_ID: 'chaapo',
  S3_SECRET_ACCESS_KEY: 'chaapo-dev-secret',
  S3_FILES_BUCKET: 'chaapo-files',
  S3_ASSETS_BUCKET: 'chaapo-assets',
  S3_FORCE_PATH_STYLE: 'true',
  S3_SSE: 'AES256',

  PAYMENT_PROVIDER: 'mock',
  MOCK_PAYMENT_WEBHOOK_SECRET: 'test-mock-webhook-secret',

  NOTIFY_TRANSPORT: 'dev',
  EMAIL_FROM: 'Chaapo Test <no-reply@chaapo.test>',
  GEO_PROVIDER: 'local',
  // ClamAV takes three minutes to warm up and has its own adapter test; the scanner
  // seam is exercised there rather than in every test that happens to upload a file.
  MALWARE_SCANNER: 'noop',

  WORKER_ENABLED: 'false',
  // Rate limiting is asserted by the tests that care, which re-enable it. Leaving it
  // on globally would make every other test order-dependent.
  RATE_LIMIT_DISABLED: 'true',
  OTP_DEV_ECHO: 'true',
}

for (const [key, value] of Object.entries(fixed)) {
  process.env[key] = value
}

// Anything cached from the ambient environment is now wrong.
resetEnvCache()
__setConfigForTests(null)
