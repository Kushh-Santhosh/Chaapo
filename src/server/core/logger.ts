import { AsyncLocalStorage } from 'node:async_hooks'
import { describeError, isAppError } from './errors'

/**
 * Logging.
 *
 * Structured JSON to stdout, one object per line, so the platform's log shipper
 * can index it without a parser. Two properties matter more than anything else:
 *
 * 1. **Correlation.** Every log line inside a request or job carries the same
 *    `correlationId`, plus `actorId` / `actorRole` / `orderId` when known. When a
 *    customer calls support with a failed payment, one grep reconstructs the
 *    whole path across the web process and the worker (NFR-18).
 *
 * 2. **Redaction.** Customer phone numbers, file names, pickup codes, PANs, bank
 *    accounts, OTPs and tokens must never be written to a log. The redactor is
 *    key-based and applied recursively before serialisation, so a careless
 *    `log.info('payload', body)` cannot leak (NFR-11, NFR-13).
 *
 * A print job's *file name* is customer content ("Aadhaar_scan.pdf",
 * "biopsy_report.pdf") and is treated as PII, not metadata.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LogContext {
  correlationId?: string
  actorId?: string
  actorRole?: string
  sessionId?: string
  requestId?: string
  route?: string
  method?: string
  orderId?: string
  shopId?: string
  jobName?: string
  jobId?: string
  [key: string]: unknown
}

const store = new AsyncLocalStorage<LogContext>()

/** Run `fn` with additional log context merged into the ambient context. */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  const merged = { ...(store.getStore() ?? {}), ...context }
  return store.run(merged, fn)
}

/** Read the ambient log context (correlation id, actor, order). */
export function currentLogContext(): LogContext {
  return store.getStore() ?? {}
}

/** Merge fields into the ambient context for the remainder of the current scope. */
export function addLogContext(context: LogContext): void {
  const existing = store.getStore()
  if (existing) Object.assign(existing, context)
}

// ── Redaction ───────────────────────────────────────────────────────────────

/**
 * Keys whose values are replaced with a redaction marker. Matched
 * case-insensitively against the whole key and against snake/camel variants.
 */
const REDACTED_KEYS = new Set(
  [
    'password',
    'passwordhash',
    'otp',
    'otpcode',
    'code',
    'pickupcode',
    'pickupcodehash',
    'token',
    'accesstoken',
    'refreshtoken',
    'sessiontoken',
    'csrftoken',
    'authorization',
    'cookie',
    'setcookie',
    'secret',
    'apikey',
    'privatekey',
    'signature',
    'phone',
    'phonenumber',
    'mobile',
    'email',
    'aadhaar',
    'aadhar',
    'pan',
    'gstin',
    'accountnumber',
    'bankaccount',
    'ifsc',
    'upiid',
    'vpa',
    'filename',
    'originalfilename',
    'displayname',
    'addressline1',
    'addressline2',
    'latitude',
    'longitude',
    'lat',
    'lng',
    'totpsecret',
    'vapidprivatekey',
  ].map((k) => k.toLowerCase()),
)

const REDACTION = '[redacted]'
const MAX_DEPTH = 6
const MAX_ARRAY = 50
const MAX_STRING = 512

function normaliseKey(key: string): string {
  return key.replace(/[_\-\s]/g, '').toLowerCase()
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (depth > MAX_DEPTH) return '[truncated]'

  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (Buffer.isBuffer(value)) return `[buffer ${value.byteLength}b]`

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => redact(item, depth + 1))
    if (value.length > MAX_ARRAY) items.push(`[+${value.length - MAX_ARRAY} more]`)
    return items
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(normaliseKey(key)) ? REDACTION : redact(child, depth + 1)
    }
    return out
  }

  return String(value)
}

// ── Logger ──────────────────────────────────────────────────────────────────

export interface LogFields {
  [key: string]: unknown
}

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, error?: unknown, fields?: LogFields): void
  child(fields: LogFields): Logger
}

interface LoggerOptions {
  level: LogLevel
  /** `pretty` in development, `json` everywhere else. */
  format: 'json' | 'pretty'
  base?: LogFields
  sink?: (line: string) => void
}

const LEVEL_COLOUR: Record<LogLevel, string> = {
  debug: '\u001b[38;5;244m',
  info: '\u001b[38;5;39m',
  warn: '\u001b[38;5;214m',
  error: '\u001b[38;5;203m',
}
const RESET = '\u001b[0m'
const DIM = '\u001b[2m'

function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[options.level]
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`))
  const base = options.base ?? {}

  function emit(level: LogLevel, message: string, fields?: LogFields, error?: unknown): void {
    if (LEVEL_ORDER[level] < threshold) return

    const context = currentLogContext()
    const payload: Record<string, unknown> = {
      t: new Date().toISOString(),
      level,
      msg: message,
      ...(redact({ ...base, ...context, ...(fields ?? {}) }) as Record<string, unknown>),
    }

    if (error !== undefined) {
      payload.err = describeError(error)
      if (isAppError(error)) {
        payload.errCode = error.code
        payload.errStatus = error.status
        if (error.cause) payload.errCause = describeError(error.cause)
      }
      if (error instanceof Error && error.stack && level === 'error') {
        payload.stack = error.stack.split('\n').slice(0, 12).join('\n')
      }
    }

    if (options.format === 'json') {
      sink(JSON.stringify(payload))
      return
    }

    // Pretty: one dense line, aligned, correlation id first.
    const { t, level: _l, msg, ...rest } = payload
    const time = String(t).slice(11, 23)
    const colour = LEVEL_COLOUR[level]
    const tail = Object.entries(rest)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${DIM}${k}${RESET}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ')
    sink(`${DIM}${time}${RESET} ${colour}${level.toUpperCase().padEnd(5)}${RESET} ${msg}${tail ? ` ${tail}` : ''}`)
  }

  const logger: Logger = {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, error, fields) => emit('error', message, fields, error),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  }
  return logger
}

let rootLogger: Logger | null = null

/** The process logger. Configured from env on first use. */
export function log(): Logger {
  if (!rootLogger) {
    const level = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info'
    const appEnv = process.env.APP_ENV ?? 'development'
    rootLogger = createLogger({
      level: LEVEL_ORDER[level] ? level : 'info',
      format: appEnv === 'development' ? 'pretty' : 'json',
      base: { env: appEnv },
    })
  }
  return rootLogger
}

/** Test/bootstrap hook. */
export function setRootLogger(logger: Logger | null): void {
  rootLogger = logger
}

/** Build an isolated logger — used by tests to assert on emitted lines. */
export function makeLogger(options: Partial<LoggerOptions> = {}): Logger {
  return createLogger({ level: 'debug', format: 'json', ...options })
}

export const logger = {
  debug: (message: string, fields?: LogFields) => log().debug(message, fields),
  info: (message: string, fields?: LogFields) => log().info(message, fields),
  warn: (message: string, fields?: LogFields) => log().warn(message, fields),
  error: (message: string, error?: unknown, fields?: LogFields) => log().error(message, error, fields),
  child: (fields: LogFields) => log().child(fields),
}
