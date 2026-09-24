import { loadEnv, type Env } from './env'

/**
 * Structured, typed infrastructure configuration.
 *
 * Grouped by concern so that call sites depend on a narrow slice (e.g. the
 * storage provider takes `config.storage`, not the whole env). This keeps the
 * provider adapters testable with plain objects.
 */

export interface AppConfig {
  env: Env['APP_ENV']
  nodeEnv: Env['NODE_ENV']
  url: string
  logLevel: Env['LOG_LEVEL']
  isDev: boolean
  isTest: boolean
  isProdLike: boolean
  /** All business timestamps are rendered in IST regardless of server locale. */
  timezone: 'Asia/Kolkata'
}

export interface DatabaseConfig {
  url: string
  poolMax: number
  ssl: boolean
}

export interface RedisConfig {
  url: string
}

export interface SecretsConfig {
  sessionSecret: string
  encryptionKey: Buffer
  pickupTokenSecret: string
}

export interface StorageConfig {
  provider: Env['STORAGE_PROVIDER']
  endpoint: string | undefined
  region: string
  accessKeyId: string | undefined
  secretAccessKey: string | undefined
  filesBucket: string
  assetsBucket: string
  forcePathStyle: boolean
  sse: Env['S3_SSE']
  kmsKeyId: string | undefined
}

export interface PaymentsConfig {
  provider: Env['PAYMENT_PROVIDER']
  mockWebhookSecret: string
  razorpay: {
    keyId: string | undefined
    keySecret: string | undefined
    webhookSecret: string | undefined
  }
}

export interface NotificationsConfig {
  transport: Env['NOTIFY_TRANSPORT']
  smtp: {
    host: string
    port: number
    user: string | undefined
    password: string | undefined
    secure: boolean
    from: string
  }
  whatsapp: {
    provider: Env['WHATSAPP_PROVIDER']
    phoneNumberId: string | undefined
    accessToken: string | undefined
    wabaId: string | undefined
  }
  sms: {
    provider: Env['SMS_PROVIDER']
    senderId: string
    dltEntityId: string | undefined
    apiKey: string | undefined
  }
  push: {
    subject: string
    publicKey: string | undefined
    privateKey: string | undefined
    enabled: boolean
  }
}

export interface GeoConfig {
  provider: Env['GEO_PROVIDER']
  mapboxToken: string | undefined
  googleMapsApiKey: string | undefined
}

export interface ScanningConfig {
  scanner: Env['MALWARE_SCANNER']
  clamavHost: string
  clamavPort: number
}

export interface WorkerConfig {
  concurrency: number
  enabled: boolean
}

export interface DevConfig {
  /** Echo OTPs in API responses. Hard-blocked outside development by env.ts. */
  otpEcho: boolean
  rateLimitDisabled: boolean
}

export interface Config {
  app: AppConfig
  db: DatabaseConfig
  redis: RedisConfig
  secrets: SecretsConfig
  storage: StorageConfig
  payments: PaymentsConfig
  notifications: NotificationsConfig
  geo: GeoConfig
  scanning: ScanningConfig
  worker: WorkerConfig
  dev: DevConfig
}

export function buildConfig(env: Env): Config {
  return {
    app: {
      env: env.APP_ENV,
      nodeEnv: env.NODE_ENV,
      url: env.APP_URL.replace(/\/$/, ''),
      logLevel: env.LOG_LEVEL,
      isDev: env.APP_ENV === 'development',
      isTest: env.APP_ENV === 'test' || env.NODE_ENV === 'test',
      isProdLike: env.APP_ENV === 'production' || env.APP_ENV === 'staging',
      timezone: 'Asia/Kolkata',
    },
    db: {
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      ssl: env.DATABASE_SSL,
    },
    redis: { url: env.REDIS_URL },
    secrets: {
      sessionSecret: env.SESSION_SECRET,
      encryptionKey: Buffer.from(env.ENCRYPTION_KEY, 'base64'),
      pickupTokenSecret: env.PICKUP_TOKEN_SECRET,
    },
    storage: {
      provider: env.STORAGE_PROVIDER,
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      filesBucket: env.S3_FILES_BUCKET,
      assetsBucket: env.S3_ASSETS_BUCKET,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      sse: env.S3_SSE,
      kmsKeyId: env.S3_KMS_KEY_ID,
    },
    payments: {
      provider: env.PAYMENT_PROVIDER,
      mockWebhookSecret: env.MOCK_PAYMENT_WEBHOOK_SECRET,
      razorpay: {
        keyId: env.RAZORPAY_KEY_ID,
        keySecret: env.RAZORPAY_KEY_SECRET,
        webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
      },
    },
    notifications: {
      transport: env.NOTIFY_TRANSPORT,
      smtp: {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        secure: env.SMTP_SECURE,
        from: env.EMAIL_FROM,
      },
      whatsapp: {
        provider: env.WHATSAPP_PROVIDER,
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
        accessToken: env.WHATSAPP_ACCESS_TOKEN,
        wabaId: env.WHATSAPP_WABA_ID,
      },
      sms: {
        provider: env.SMS_PROVIDER,
        senderId: env.SMS_SENDER_ID,
        dltEntityId: env.SMS_DLT_ENTITY_ID,
        apiKey: env.SMS_API_KEY,
      },
      push: {
        subject: env.VAPID_SUBJECT,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        enabled: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
      },
    },
    geo: {
      provider: env.GEO_PROVIDER,
      mapboxToken: env.MAPBOX_TOKEN,
      googleMapsApiKey: env.GOOGLE_MAPS_API_KEY,
    },
    scanning: {
      scanner: env.MALWARE_SCANNER,
      clamavHost: env.CLAMAV_HOST,
      clamavPort: env.CLAMAV_PORT,
    },
    worker: {
      concurrency: env.WORKER_CONCURRENCY,
      enabled: env.WORKER_ENABLED,
    },
    dev: {
      otpEcho: env.OTP_DEV_ECHO,
      rateLimitDisabled: env.RATE_LIMIT_DISABLED,
    },
  }
}

let cached: Config | null = null

/** The process-wide configuration. Parsed and validated on first access. */
export function getConfig(): Config {
  if (!cached) cached = buildConfig(loadEnv())
  return cached
}

/** Test-only. */
export function __setConfigForTests(config: Config | null): void {
  cached = config
}
