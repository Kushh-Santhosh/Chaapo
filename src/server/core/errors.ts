/**
 * Errors.
 *
 * One error type crosses every boundary. It carries:
 *   • `code`     — a stable, machine-readable string the client switches on.
 *                  Never renamed, because mobile clients and the shop dashboard
 *                  branch on it.
 *   • `status`   — the HTTP status the route layer will use.
 *   • `message`  — safe to show a user. Written in product voice, not in
 *                  exception voice: "This shop has stopped taking orders for
 *                  today", not "shop_state_invalid".
 *   • `details`  — optional structured payload (field errors, retry-after,
 *                  the current order state) that the UI needs to render a
 *                  useful state.
 *   • `cause`    — the internal error. Logged, never serialised to a client.
 *
 * Anything not an `AppError` reaching the HTTP layer is logged with a stack and
 * reported to the client as a generic `internal` error, so we cannot leak a
 * driver message or a file path by accident (NFR-13).
 */

export const errorCodes = {
  // Client input
  validation_failed: 422,
  unsupported_media_type: 415,
  payload_too_large: 413,
  malformed_request: 400,

  // Identity
  unauthenticated: 401,
  session_expired: 401,
  forbidden: 403,
  mfa_required: 403,
  account_suspended: 403,

  // Resources
  not_found: 404,
  gone: 410,

  // State
  conflict: 409,
  invalid_transition: 409,
  precondition_failed: 412,
  idempotency_key_reused: 409,
  stale_write: 409,

  // Money
  payment_required: 402,
  payment_failed: 402,
  refund_not_permitted: 409,
  payout_blocked: 409,

  // Throughput
  rate_limited: 429,
  too_many_requests: 429,

  // Downstream
  upstream_unavailable: 502,
  upstream_timeout: 504,
  provider_error: 502,

  // Us
  internal: 500,
  not_implemented: 501,
} as const

export type ErrorCode = keyof typeof errorCodes

export interface FieldError {
  path: string
  message: string
}

export interface AppErrorOptions {
  details?: Record<string, unknown>
  fields?: FieldError[]
  cause?: unknown
  /** Seconds the client should wait before retrying. Sets Retry-After. */
  retryAfterSeconds?: number
  /** When false, the HTTP layer will not log this at error level. */
  expected?: boolean
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details?: Record<string, unknown>
  readonly fields?: FieldError[]
  readonly retryAfterSeconds?: number
  readonly expected: boolean

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'AppError'
    this.code = code
    this.status = errorCodes[code]
    this.details = options.details
    this.fields = options.fields
    this.retryAfterSeconds = options.retryAfterSeconds
    this.expected = options.expected ?? this.status < 500
  }

  /** The shape sent to clients. Deliberately narrow. */
  toPublic(): PublicError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.fields ? { fields: this.fields } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    }
  }
}

export interface PublicError {
  error: {
    code: ErrorCode
    message: string
    fields?: FieldError[]
    details?: Record<string, unknown>
    /** Attached by the HTTP layer so a user can quote it to support. */
    correlationId?: string
  }
}

// ── Constructors ────────────────────────────────────────────────────────────
// Named for the situation, not the status code, so call sites read as prose.

export const errors = {
  validation(fields: FieldError[], message = 'Please check the highlighted fields.'): AppError {
    return new AppError('validation_failed', message, { fields })
  },

  malformed(message = 'That request could not be read.'): AppError {
    return new AppError('malformed_request', message)
  },

  unauthenticated(message = 'Please sign in to continue.'): AppError {
    return new AppError('unauthenticated', message)
  },

  sessionExpired(message = 'Your session has expired. Please sign in again.'): AppError {
    return new AppError('session_expired', message)
  },

  forbidden(message = 'You do not have access to this.'): AppError {
    return new AppError('forbidden', message)
  },

  mfaRequired(message = 'Two-factor authentication is required for this action.'): AppError {
    return new AppError('mfa_required', message)
  },

  suspended(message = 'This account is suspended. Contact support.'): AppError {
    return new AppError('account_suspended', message)
  },

  notFound(what = 'That', message?: string): AppError {
    return new AppError('not_found', message ?? `${what} could not be found.`)
  },

  gone(message = 'This is no longer available.'): AppError {
    return new AppError('gone', message)
  },

  conflict(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('conflict', message, details ? { details } : {})
  },

  /**
   * The order is not in a state where this action is legal. The current state is
   * always returned so the client can re-render rather than guess.
   *
   * The default message deliberately names no verb. Conjugating a state-machine
   * event here is how "This order can no longer be cancel." ends up in front of a
   * customer; the orders domain owns that vocabulary and passes `message` for the
   * transitions it knows about.
   */
  invalidTransition(params: {
    from: string
    event: string
    message?: string
    reason?: string
  }): AppError {
    return new AppError(
      'invalid_transition',
      params.message ?? 'This order has already moved on. Reload to see where it is now.',
      { details: { from: params.from, event: params.event, reason: params.reason } },
    )
  },

  preconditionFailed(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('precondition_failed', message, details ? { details } : {})
  },

  staleWrite(message = 'Someone else updated this a moment ago. Reload and try again.'): AppError {
    return new AppError('stale_write', message)
  },

  idempotencyKeyReused(
    message = 'This request was already submitted with different data.',
  ): AppError {
    return new AppError('idempotency_key_reused', message)
  },

  paymentRequired(message = 'Payment is required to place this order.'): AppError {
    return new AppError('payment_required', message)
  },

  paymentFailed(message = 'That payment did not go through. No money was taken.'): AppError {
    return new AppError('payment_failed', message)
  },

  refundNotPermitted(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('refund_not_permitted', message, details ? { details } : {})
  },

  payoutBlocked(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('payout_blocked', message, details ? { details } : {})
  },

  rateLimited(retryAfterSeconds: number, message = 'Too many attempts. Please wait a moment.'): AppError {
    return new AppError('rate_limited', message, { retryAfterSeconds, details: { retryAfterSeconds } })
  },

  unsupportedMedia(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('unsupported_media_type', message, details ? { details } : {})
  },

  payloadTooLarge(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('payload_too_large', message, details ? { details } : {})
  },

  upstreamUnavailable(provider: string, cause?: unknown): AppError {
    return new AppError('upstream_unavailable', 'A service we depend on is not responding. Please try again.', {
      details: { provider },
      cause,
    })
  },

  upstreamTimeout(provider: string, cause?: unknown): AppError {
    return new AppError('upstream_timeout', 'That took too long. Please try again.', {
      details: { provider },
      cause,
    })
  },

  providerError(provider: string, message: string, cause?: unknown): AppError {
    return new AppError('provider_error', message, { details: { provider }, cause })
  },

  internal(message = 'Something went wrong on our side.', cause?: unknown): AppError {
    return new AppError('internal', message, { cause, expected: false })
  },

  notImplemented(what: string): AppError {
    return new AppError('not_implemented', `${what} is not available yet.`)
  },
} as const

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}

/** Narrow an unknown thrown value into an AppError without leaking internals. */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error
  if (error instanceof Error) return errors.internal(undefined, error)
  return errors.internal(undefined, new Error(String(error)))
}

/** A short, loggable description of any thrown value. */
export function describeError(error: unknown): string {
  if (isAppError(error)) return `${error.code}: ${error.message}`
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
