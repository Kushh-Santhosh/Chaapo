import { describe, expect, it } from 'vitest'

import {
  AppError,
  describeError,
  errorCodes,
  errors,
  isAppError,
  toAppError,
  type ErrorCode,
} from './errors'

/**
 * Two promises are kept here.
 *
 * The first is the **wire contract**: the code strings are what the customer PWA,
 * the shop dashboard and the admin console branch on. Renaming one is a breaking
 * change for a mobile client that is already installed, so the list is written out
 * in full below and any edit to it has to be a deliberate edit to this test.
 *
 * The second is **NFR-13**: nothing internal reaches a client. `toPublic()` is the
 * only serialiser, and it must never carry a cause, a stack, or the `expected`
 * flag — a driver message quoting a connection string is exactly the sort of thing
 * that ends up in a screenshot in a support ticket.
 */

/** Every code the clients are allowed to see. Add deliberately; never rename. */
const PUBLISHED_CODES: ErrorCode[] = [
  'validation_failed',
  'unsupported_media_type',
  'payload_too_large',
  'malformed_request',
  'unauthenticated',
  'session_expired',
  'forbidden',
  'mfa_required',
  'account_suspended',
  'not_found',
  'gone',
  'conflict',
  'invalid_transition',
  'precondition_failed',
  'idempotency_key_reused',
  'stale_write',
  'payment_required',
  'payment_failed',
  'refund_not_permitted',
  'payout_blocked',
  'rate_limited',
  'too_many_requests',
  'upstream_unavailable',
  'upstream_timeout',
  'provider_error',
  'internal',
  'not_implemented',
]

describe('the code table', () => {
  it('publishes exactly the codes clients branch on', () => {
    expect(Object.keys(errorCodes).sort()).toEqual([...PUBLISHED_CODES].sort())
  })

  it('maps every code to an HTTP error status', () => {
    for (const [code, status] of Object.entries(errorCodes)) {
      expect(status, code).toBeGreaterThanOrEqual(400)
      expect(status, code).toBeLessThan(600)
    }
  })

  it('keeps the statuses the API documents', () => {
    // Spot-checks of the ones the clients special-case.
    expect(errorCodes.validation_failed).toBe(422)
    expect(errorCodes.unauthenticated).toBe(401)
    expect(errorCodes.forbidden).toBe(403)
    expect(errorCodes.mfa_required).toBe(403)
    expect(errorCodes.not_found).toBe(404)
    expect(errorCodes.invalid_transition).toBe(409)
    expect(errorCodes.idempotency_key_reused).toBe(409)
    expect(errorCodes.stale_write).toBe(409)
    expect(errorCodes.precondition_failed).toBe(412)
    expect(errorCodes.payment_failed).toBe(402)
    expect(errorCodes.rate_limited).toBe(429)
    expect(errorCodes.upstream_timeout).toBe(504)
    expect(errorCodes.internal).toBe(500)
  })
})

describe('AppError', () => {
  it('is a real Error, so a stack survives to the log', () => {
    const error = new AppError('conflict', 'Two shops claim the same GST number.')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('AppError')
    expect(error.stack).toContain('errors.test.ts')
    expect(isAppError(error)).toBe(true)
  })

  it('takes its status from its code', () => {
    expect(new AppError('gone', 'That file has been deleted.').status).toBe(410)
  })

  it('treats a 4xx as expected and a 5xx as not', () => {
    // This is what decides whether the HTTP layer pages someone. A customer
    // typing a wrong pickup code is not an incident.
    expect(new AppError('not_found', 'x').expected).toBe(true)
    expect(new AppError('internal', 'x').expected).toBe(false)
    expect(new AppError('upstream_unavailable', 'x').expected).toBe(false)
  })

  it('lets an unexpected 4xx be marked as such', () => {
    // e.g. a 409 from our own webhook handler, which means our state is wrong.
    expect(new AppError('conflict', 'x', { expected: false }).expected).toBe(false)
  })

  it('keeps the cause reachable for logging', () => {
    const cause = new Error('connect ECONNREFUSED 10.0.0.4:5432')
    expect(new AppError('internal', 'x', { cause }).cause).toBe(cause)
  })
})

describe('toPublic', () => {
  it('sends only the code and the message when there is nothing else', () => {
    const body = errors.forbidden().toPublic()
    expect(Object.keys(body)).toEqual(['error'])
    expect(Object.keys(body.error)).toEqual(['code', 'message'])
  })

  it('omits fields and details rather than sending them as null', () => {
    // `"details": null` makes every client write a null check for nothing.
    const body = errors.conflict('That slot is taken.').toPublic()
    expect('details' in body.error).toBe(false)
    expect('fields' in body.error).toBe(false)
  })

  it('never carries the cause, the stack or the expected flag', () => {
    const error = errors.providerError(
      'razorpay',
      'That payment could not be started. Please try again.',
      new Error('401 Unauthorized: key_id rzp_test_SECRETVALUE is invalid'),
    )
    const serialised = JSON.stringify(error.toPublic())

    expect(serialised).not.toContain('rzp_test_SECRETVALUE')
    expect(serialised).not.toContain('Unauthorized')
    expect(serialised).not.toContain('stack')
    expect(serialised).not.toContain('expected')
    // The provider name is deliberate: support needs to know which one failed.
    expect(JSON.parse(serialised).error.details).toEqual({ provider: 'razorpay' })
  })

  it('never carries an internal message even when one was set', () => {
    const body = errors.internal('Something went wrong on our side.', new Error('pg: relation "orders" does not exist')).toPublic()
    expect(JSON.stringify(body)).not.toContain('relation')
  })

  it('passes field errors through for the form to render', () => {
    const body = errors
      .validation([{ path: 'copies', message: 'Enter at least 1 copy.' }])
      .toPublic()
    expect(body.error.fields).toEqual([{ path: 'copies', message: 'Enter at least 1 copy.' }])
    expect(body.error.code).toBe('validation_failed')
  })

  it('survives a round trip through JSON, which is how it is actually sent', () => {
    const error = errors.rateLimited(30)
    expect(JSON.parse(JSON.stringify(error.toPublic()))).toEqual({
      error: {
        code: 'rate_limited',
        message: 'Too many attempts. Please wait a moment.',
        details: { retryAfterSeconds: 30 },
      },
    })
  })
})

describe('the constructors', () => {
  it('sets the status matching the code every time', () => {
    const all: AppError[] = [
      errors.validation([]),
      errors.malformed(),
      errors.unauthenticated(),
      errors.sessionExpired(),
      errors.forbidden(),
      errors.mfaRequired(),
      errors.suspended(),
      errors.notFound(),
      errors.gone(),
      errors.conflict('x.'),
      errors.invalidTransition({ from: 'printing', event: 'cancel' }),
      errors.preconditionFailed('x.'),
      errors.staleWrite(),
      errors.idempotencyKeyReused(),
      errors.paymentRequired(),
      errors.paymentFailed(),
      errors.refundNotPermitted('x.'),
      errors.payoutBlocked('x.'),
      errors.rateLimited(1),
      errors.unsupportedMedia('x.'),
      errors.payloadTooLarge('x.'),
      errors.upstreamUnavailable('razorpay'),
      errors.upstreamTimeout('razorpay'),
      errors.providerError('razorpay', 'x.'),
      errors.internal(),
      errors.notImplemented('Scheduled pickup'),
    ]
    for (const error of all) {
      expect(error.status, error.code).toBe(errorCodes[error.code])
    }
  })

  it('writes messages in product voice, not exception voice', () => {
    // A message that reads like `shop_state_invalid` is a message that will be
    // shown to a customer standing at a counter.
    const messages = [
      errors.unauthenticated(),
      errors.sessionExpired(),
      errors.forbidden(),
      errors.mfaRequired(),
      errors.suspended(),
      errors.notFound(),
      errors.gone(),
      errors.staleWrite(),
      errors.idempotencyKeyReused(),
      errors.paymentRequired(),
      errors.paymentFailed(),
      errors.rateLimited(30),
      errors.upstreamUnavailable('razorpay'),
      errors.upstreamTimeout('razorpay'),
      errors.internal(),
      errors.notImplemented('Scheduled pickup'),
      errors.invalidTransition({ from: 'printing', event: 'mark_ready' }),
    ].map((error) => error.message)

    for (const message of messages) {
      expect(message, message).toMatch(/^[A-Z]/)
      expect(message, message).toMatch(/[.!?]$/)
      expect(message, message).not.toMatch(/_/)
      expect(message.length, message).toBeGreaterThan(12)
    }
  })

  it('names the thing that was not found', () => {
    expect(errors.notFound('That shop').message).toBe('That shop could not be found.')
    expect(errors.notFound('x', 'This link has expired.').message).toBe('This link has expired.')
  })

  it('tells the client what the order state actually is', () => {
    // Without the current state the client has to guess, and guessing is how a
    // customer ends up staring at a Cancel button that will never work.
    const error = errors.invalidTransition({
      from: 'printing',
      event: 'cancel',
      reason: 'printing has already started',
    })
    expect(error.code).toBe('invalid_transition')
    expect(error.status).toBe(409)
    expect(error.details).toEqual({
      from: 'printing',
      event: 'cancel',
      reason: 'printing has already started',
    })
  })

  it('does not conjugate the event name into the message', () => {
    // "This order can no longer be cancel." is what happens when a core module
    // tries to inflect the orders domain's vocabulary. The default says something
    // true and grammatical for any event; the state machine passes better prose.
    const generic = errors.invalidTransition({ from: 'printing', event: 'cancel' })
    expect(generic.message).toBe('This order has already moved on. Reload to see where it is now.')
    expect(generic.message).not.toContain('cancel')

    const specific = errors.invalidTransition({
      from: 'printing',
      event: 'cancel',
      message: 'Printing has already started, so this order can no longer be cancelled.',
    })
    expect(specific.message).toBe(
      'Printing has already started, so this order can no longer be cancelled.',
    )
    expect(specific.details).toMatchObject({ from: 'printing', event: 'cancel' })
  })

  it('reassures the customer that a failed payment took no money', () => {
    expect(errors.paymentFailed().message).toContain('No money was taken')
  })

  it('puts retry-after where both the header and the body can find it', () => {
    const error = errors.rateLimited(45)
    expect(error.retryAfterSeconds).toBe(45)
    expect(error.details).toEqual({ retryAfterSeconds: 45 })
  })

  it('marks an internal error as unexpected so it is logged loudly', () => {
    expect(errors.internal().expected).toBe(false)
  })
})

describe('toAppError', () => {
  it('returns an AppError unchanged, keeping its code', () => {
    const original = errors.paymentFailed()
    expect(toAppError(original)).toBe(original)
  })

  it('turns a raw Error into a generic internal error, keeping the cause', () => {
    const thrown = new Error('ENOENT: /var/secrets/razorpay.key')
    const error = toAppError(thrown)

    expect(error.code).toBe('internal')
    expect(error.status).toBe(500)
    expect(error.expected).toBe(false)
    expect(error.cause).toBe(thrown)
    expect(error.message).toBe('Something went wrong on our side.')
    expect(JSON.stringify(error.toPublic())).not.toContain('razorpay.key')
  })

  it('handles a thrown non-Error, which is what a library will do to you', () => {
    for (const thrown of ['boom', 42, null, undefined, { code: 'ETIMEDOUT' }]) {
      const error = toAppError(thrown)
      expect(error.code, String(thrown)).toBe('internal')
      expect(error.cause, String(thrown)).toBeInstanceOf(Error)
    }
  })

  it('keeps the original text of a thrown string in the cause for the log', () => {
    const { cause } = toAppError('kafkaesque')
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe('kafkaesque')
  })
})

describe('describeError', () => {
  it('leads with the code for an AppError', () => {
    expect(describeError(errors.forbidden())).toBe('forbidden: You do not have access to this.')
  })

  it('leads with the name for anything else', () => {
    expect(describeError(new TypeError('x is not a function'))).toBe(
      'TypeError: x is not a function',
    )
  })

  it('stringifies whatever it is given', () => {
    expect(describeError('just a string')).toBe('just a string')
    expect(describeError(undefined)).toBe('undefined')
  })
})

describe('isAppError', () => {
  it('rejects an object that merely looks like one', () => {
    expect(isAppError({ code: 'forbidden', status: 403, message: 'nope' })).toBe(false)
    expect(isAppError(new Error('nope'))).toBe(false)
    expect(isAppError(null)).toBe(false)
  })
})
