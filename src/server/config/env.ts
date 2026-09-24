import { z } from 'zod'

/**
 * Environment configuration — validated once, at boot, and never read raw again.
 *
 * Anything that must be changeable by an operator WITHOUT a deploy (commission
 * rate, SLA minutes, refund windows, retention days, upload caps, pricing bands)
 * lives in the `platform_config` table instead, behind `configStore` — see
 * `src/server/core/config-store.ts`. Only infrastructure wiring and secrets are
 * here.
 *
 * Callers: `src/server/config/index.ts` (server), `scripts/*.ts`. Client code
 * must use `src/lib/public-config.ts`.
 */

const bool = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : v === 'true' || v === '1'))

const int = (defaultValue: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : Number(v)))
    .pipe(z.number().int().min(min).max(max))

const nonEmpty = z.string().min(1)
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))

/** A 32-byte key, base64-encoded. Used for AES-256-GCM. */
const base64Key32 = z
  .string()
  .min(1, 'required')
  .refine(
    (v) => {
      try {
        return Buffer.from(v, 'base64').byteLength === 32
      } catch {
        return false
      }
    },
    'must be exactly 32 bytes, base64-encoded (openssl rand -base64 32)',
  )

const DEV_SECRET_MARKER = 'dev-only'

const envSchema = z
  .object({
    // ── App ────────────────────────────────────────────────────────────────
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    APP_URL: z.string().url().default('http://localhost:3000'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    // ── Database ───────────────────────────────────────────────────────────
    DATABASE_URL: nonEmpty.refine(
      (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
      'must be a postgres:// connection string',
    ),
    DATABASE_POOL_MAX: int(10, 1, 100),
    DATABASE_SSL: bool(false),

    // ── Redis ──────────────────────────────────────────────────────────────
    REDIS_URL: nonEmpty.refine((v) => v.startsWith('redis'), 'must be a redis:// URL'),

    // ── Secrets ────────────────────────────────────────────────────────────
    SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
    ENCRYPTION_KEY: base64Key32,
    PICKUP_TOKEN_SECRET: z.string().min(32, 'must be at least 32 characters'),

    // ── Object storage ─────────────────────────────────────────────────────
    STORAGE_PROVIDER: z.enum(['s3', 'memory']).default('s3'),
    S3_ENDPOINT: optionalString,
    S3_REGION: z.string().default('ap-south-1'),
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    S3_FILES_BUCKET: z.string().default('chaapo-files'),
    S3_ASSETS_BUCKET: z.string().default('chaapo-assets'),
    S3_FORCE_PATH_STYLE: bool(true),
    S3_SSE: z.enum(['none', 'AES256', 'aws:kms']).default('AES256'),
    S3_KMS_KEY_ID: optionalString,

    // ── Payments ───────────────────────────────────────────────────────────
    PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
    MOCK_PAYMENT_WEBHOOK_SECRET: z.string().min(16).default('dev-only-mock-webhook-secret-0000'),
    RAZORPAY_KEY_ID: optionalString,
    RAZORPAY_KEY_SECRET: optionalString,
    RAZORPAY_WEBHOOK_SECRET: optionalString,

    // ── Notifications ──────────────────────────────────────────────────────
    NOTIFY_TRANSPORT: z.enum(['dev', 'live']).default('dev'),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: int(1025, 1, 65535),
    SMTP_USER: optionalString,
    SMTP_PASSWORD: optionalString,
    SMTP_SECURE: bool(false),
    EMAIL_FROM: z.string().default('Chaapo <no-reply@chaapo.in>'),

    WHATSAPP_PROVIDER: z.enum(['none', 'meta_cloud']).default('none'),
    WHATSAPP_PHONE_NUMBER_ID: optionalString,
    WHATSAPP_ACCESS_TOKEN: optionalString,
    WHATSAPP_WABA_ID: optionalString,

    SMS_PROVIDER: z.enum(['none', 'generic_http']).default('none'),
    SMS_SENDER_ID: z.string().max(6).default('CHAAPO'),
    SMS_DLT_ENTITY_ID: optionalString,
    SMS_API_KEY: optionalString,

    VAPID_SUBJECT: z.string().default('mailto:ops@chaapo.in'),
    VAPID_PUBLIC_KEY: optionalString,
    VAPID_PRIVATE_KEY: optionalString,

    // ── Geo ────────────────────────────────────────────────────────────────
    GEO_PROVIDER: z.enum(['local', 'mapbox', 'google']).default('local'),
    MAPBOX_TOKEN: optionalString,
    GOOGLE_MAPS_API_KEY: optionalString,

    // ── Malware scanning ───────────────────────────────────────────────────
    MALWARE_SCANNER: z.enum(['clamav', 'noop']).default('clamav'),
    CLAMAV_HOST: z.string().default('localhost'),
    CLAMAV_PORT: int(3310, 1, 65535),

    // ── Workers ────────────────────────────────────────────────────────────
    WORKER_CONCURRENCY: int(4, 1, 64),
    WORKER_ENABLED: bool(true),

    // ── Dev conveniences ───────────────────────────────────────────────────
    OTP_DEV_ECHO: bool(false),
    RATE_LIMIT_DISABLED: bool(false),
  })
  .superRefine((env, ctx) => {
    const isProdLike = env.APP_ENV === 'production' || env.APP_ENV === 'staging'
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message })

    if (env.STORAGE_PROVIDER === 's3') {
      if (!env.S3_ACCESS_KEY_ID) fail('S3_ACCESS_KEY_ID', 'required when STORAGE_PROVIDER=s3')
      if (!env.S3_SECRET_ACCESS_KEY)
        fail('S3_SECRET_ACCESS_KEY', 'required when STORAGE_PROVIDER=s3')
    }
    if (env.S3_SSE === 'aws:kms' && !env.S3_KMS_KEY_ID) {
      fail('S3_KMS_KEY_ID', 'required when S3_SSE=aws:kms')
    }

    if (env.PAYMENT_PROVIDER === 'razorpay') {
      if (!env.RAZORPAY_KEY_ID) fail('RAZORPAY_KEY_ID', 'required when PAYMENT_PROVIDER=razorpay')
      if (!env.RAZORPAY_KEY_SECRET)
        fail('RAZORPAY_KEY_SECRET', 'required when PAYMENT_PROVIDER=razorpay')
      if (!env.RAZORPAY_WEBHOOK_SECRET)
        fail(
          'RAZORPAY_WEBHOOK_SECRET',
          'required when PAYMENT_PROVIDER=razorpay — webhooks are the source of truth for payment state and must be signature-verified',
        )
    }

    if (env.NOTIFY_TRANSPORT === 'live') {
      if (env.WHATSAPP_PROVIDER === 'meta_cloud') {
        if (!env.WHATSAPP_PHONE_NUMBER_ID) fail('WHATSAPP_PHONE_NUMBER_ID', 'required for live WhatsApp')
        if (!env.WHATSAPP_ACCESS_TOKEN) fail('WHATSAPP_ACCESS_TOKEN', 'required for live WhatsApp')
      }
      if (env.SMS_PROVIDER === 'generic_http') {
        if (!env.SMS_API_KEY) fail('SMS_API_KEY', 'required for live SMS')
        if (!env.SMS_DLT_ENTITY_ID)
          fail('SMS_DLT_ENTITY_ID', 'required for live SMS in India (TRAI DLT registration)')
      }
    }

    if (env.GEO_PROVIDER === 'mapbox' && !env.MAPBOX_TOKEN) {
      fail('MAPBOX_TOKEN', 'required when GEO_PROVIDER=mapbox')
    }
    if (env.GEO_PROVIDER === 'google' && !env.GOOGLE_MAPS_API_KEY) {
      fail('GOOGLE_MAPS_API_KEY', 'required when GEO_PROVIDER=google')
    }

    // ── Production guardrails ────────────────────────────────────────────
    // These exist so a placeholder value can never reach a real deployment.
    if (isProdLike) {
      if (env.SESSION_SECRET.includes(DEV_SECRET_MARKER))
        fail('SESSION_SECRET', 'placeholder secret cannot be used outside development')
      if (env.PICKUP_TOKEN_SECRET.includes(DEV_SECRET_MARKER))
        fail('PICKUP_TOKEN_SECRET', 'placeholder secret cannot be used outside development')
      if (Buffer.from(env.ENCRYPTION_KEY, 'base64').toString('utf8').includes(DEV_SECRET_MARKER))
        fail('ENCRYPTION_KEY', 'placeholder key cannot be used outside development')
      if (env.OTP_DEV_ECHO)
        fail('OTP_DEV_ECHO', 'must be false outside development — it would leak login codes')
      if (env.RATE_LIMIT_DISABLED)
        fail('RATE_LIMIT_DISABLED', 'must be false outside development')
      if (!env.APP_URL.startsWith('https://'))
        fail('APP_URL', 'must be https outside development')
      if (env.S3_SSE === 'none')
        fail('S3_SSE', 'server-side encryption is mandatory for customer files (NFR-12)')
      if (env.MALWARE_SCANNER === 'noop')
        fail('MALWARE_SCANNER', 'uploads must be scanned outside development (FR-205)')
      if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY)
        fail('VAPID_PUBLIC_KEY', 'web push keys are required outside development')
      if (env.STORAGE_PROVIDER === 'memory')
        fail('STORAGE_PROVIDER', 'the in-memory store is for tests only')
    }

    if (env.APP_ENV === 'production' && env.PAYMENT_PROVIDER === 'mock') {
      fail(
        'PAYMENT_PROVIDER',
        'the mock payment provider must never be enabled in production — real money requires a payment aggregator (PRD §38)',
      )
    }
  })

export type Env = z.infer<typeof envSchema>

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
}

let cached: Env | null = null

/**
 * Parse and cache the environment. Throws a single readable error listing every
 * problem, so a misconfigured deployment fails fast and loudly.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration:\n${formatIssues(parsed.error)}\n\n` +
        `Copy .env.example to .env.local and fill in the missing values.`,
    )
  }
  cached = parsed.data
  return cached
}

/** Test-only: forget the cached env so a fresh one can be parsed. */
export function resetEnvCache(): void {
  cached = null
}

/** Parse without caching — used by tests to assert validation rules. */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${formatIssues(parsed.error)}`)
  }
  return parsed.data
}
