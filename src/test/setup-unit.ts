import { beforeAll } from 'vitest'

/**
 * Unit-test bootstrap.
 *
 * Unit tests exercise pure domain logic — the pricing engine, the order state
 * machine, RBAC evaluation, money arithmetic, the refund matrix, token signing.
 * They must not touch Postgres, Redis or the network, so we install a fixed,
 * valid environment and nothing else.
 */
beforeAll(() => {
  const fixed: Record<string, string> = {
    NODE_ENV: 'test',
    APP_ENV: 'test',
    APP_URL: 'http://localhost:3000',
    LOG_LEVEL: 'error',
    DATABASE_URL: '',
    REDIS_URL: 'redis://localhost:6379/1',
    SESSION_SECRET: 'test-session-secret-must-be-at-least-32-chars',
    // 32 zero-bytes, base64 — deterministic so ciphertext fixtures are stable.
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    PICKUP_TOKEN_SECRET: 'test-pickup-secret-must-be-at-least-32-chars',
    STORAGE_PROVIDER: 'memory',
    S3_SSE: 'none',
    PAYMENT_PROVIDER: 'mock',
    MOCK_PAYMENT_WEBHOOK_SECRET: 'test-mock-webhook-secret',
    NOTIFY_TRANSPORT: 'dev',
    GEO_PROVIDER: 'local',
    MALWARE_SCANNER: 'noop',
    RATE_LIMIT_DISABLED: 'true',
    OTP_DEV_ECHO: 'true',
  }
  for (const [key, value] of Object.entries(fixed)) {
    process.env[key] = value
  }
})
