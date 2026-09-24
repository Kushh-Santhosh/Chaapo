import { afterEach, describe, expect, it } from 'vitest'

import { errors } from './errors'
import {
  addLogContext,
  currentLogContext,
  logger,
  makeLogger,
  redact,
  setRootLogger,
  withLogContext,
  type LogFields,
  type Logger,
} from './logger'

/**
 * The logger is a privacy control, so it is tested like one.
 *
 * The rule from the PRD is that a print job's *file name* is customer content —
 * "Aadhaar_scan.pdf", "biopsy_report.pdf" — and so are phone numbers, pickup
 * codes, OTPs, PANs, bank details and coordinates. None of it may reach a log
 * line, and the guarantee has to hold for the careless call as much as the
 * careful one: `logger.info('placing order', body)` must be safe, because that
 * call will be written.
 *
 * The second thing tested is correlation. One `correlationId` has to travel from
 * the request through the domain into the worker, or a customer's failed payment
 * cannot be reconstructed from the logs at all (NFR-18).
 */

/** A logger writing to an array, plus the parsed lines it produced. */
function capture(options: Partial<Parameters<typeof makeLogger>[0]> = {}) {
  const lines: string[] = []
  const log = makeLogger({ sink: (line) => lines.push(line), ...options })
  return {
    log,
    lines,
    json: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    last: () => JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>,
  }
}

afterEach(() => {
  setRootLogger(null)
})

describe('redact', () => {
  it('replaces a phone number, whatever the key is called', () => {
    for (const key of ['phone', 'Phone', 'phoneNumber', 'phone_number', 'phone-number', 'mobile']) {
      expect(redact({ [key]: '+919876543210' }), key).toEqual({ [key]: '[redacted]' })
    }
  })

  it('treats a file name as customer content', () => {
    // The name of the file *is* the sensitive part. "Aadhaar_scan.pdf" in a log
    // line is a privacy incident on its own, before anyone opens anything.
    expect(redact({ fileName: 'Aadhaar_scan.pdf', originalFilename: 'biopsy_report.pdf' })).toEqual({
      fileName: '[redacted]',
      originalFilename: '[redacted]',
    })
  })

  it('redacts every category the PRD names', () => {
    const payload = {
      password: 'hunter2',
      otp: '448211',
      code: '7K2M9Q',
      pickupCode: '7K2M9Q',
      token: 'eyJhbGciOi',
      authorization: 'Bearer eyJhbGciOi',
      cookie: 'chaapo_session=abc',
      apiKey: 'rzp_test_abc',
      signature: 'deadbeef',
      email: 'priya@example.com',
      aadhaar: '1234 5678 9012',
      pan: 'ABCDE1234F',
      gstin: '27ABCDE1234F1Z5',
      accountNumber: '000123456789',
      ifsc: 'HDFC0001234',
      upiId: 'priya@okhdfcbank',
      addressLine1: '12 Karve Road',
      latitude: 18.5074,
      longitude: 73.8077,
      lat: 18.5074,
      lng: 73.8077,
      totpSecret: 'JBSWY3DPEHPK3PXP',
    }
    const out = redact(payload) as Record<string, unknown>
    for (const key of Object.keys(payload)) {
      expect(out[key], key).toBe('[redacted]')
    }
  })

  it('keeps the fields that make a log line useful', () => {
    expect(
      redact({
        orderId: '01890000-0000-7000-8000-000000000101',
        orderNumber: 'CHP-7K2M-9QD4',
        shopId: 'shop-1',
        status: 'printing',
        pages: 24,
        amountPaise: 4800n,
        isColour: false,
      }),
    ).toEqual({
      orderId: '01890000-0000-7000-8000-000000000101',
      orderNumber: 'CHP-7K2M-9QD4',
      shopId: 'shop-1',
      status: 'printing',
      pages: 24,
      amountPaise: '4800',
      isColour: false,
    })
  })

  it('redacts inside nested objects and arrays', () => {
    // The realistic leak: the whole request body handed to a log call.
    const out = redact({
      customer: { id: 'cust-1', phone: '+919876543210' },
      files: [
        { id: 'f1', fileName: 'passport.pdf', pages: 2 },
        { id: 'f2', fileName: 'resume.pdf', pages: 1 },
      ],
    })
    expect(out).toEqual({
      customer: { id: 'cust-1', phone: '[redacted]' },
      files: [
        { id: 'f1', fileName: '[redacted]', pages: 2 },
        { id: 'f2', fileName: '[redacted]', pages: 1 },
      ],
    })
  })

  it('keeps a person’s name, because the same redactor writes audit diffs', () => {
    // Deliberate, and the one judgement call in the list: an audit entry for
    // "customer changed their name" is worthless if both sides are `[redacted]`,
    // and support reading a log line needs to know which Priya. Contact details,
    // documents and file names are what must never appear — those are redacted.
    expect(redact({ fullName: 'Priya S', phone: '+919876543210' })).toEqual({
      fullName: 'Priya S',
      phone: '[redacted]',
    })
  })

  it('renders a bigint as a string, because JSON cannot hold one', () => {
    // Money is bigint paise everywhere. Without this, `JSON.stringify` throws
    // inside the logger and the line is lost.
    expect(redact(4800n)).toBe('4800')
    expect(() => JSON.stringify(redact({ totalPaise: 2n ** 70n }))).not.toThrow()
  })

  it('renders a Date as ISO and an Error as its parts', () => {
    expect(redact(new Date('2026-08-27T04:30:00.000Z'))).toBe('2026-08-27T04:30:00.000Z')

    const out = redact(new Error('boom')) as Record<string, unknown>
    expect(out.name).toBe('Error')
    expect(out.message).toBe('boom')
    expect(typeof out.stack).toBe('string')
  })

  it('summarises a buffer instead of printing it', () => {
    expect(redact(Buffer.alloc(2048))).toBe('[buffer 2048b]')
  })

  it('truncates a long string', () => {
    const out = redact('x'.repeat(600)) as string
    expect(out).toHaveLength(513)
    expect(out.endsWith('…')).toBe(true)
  })

  it('caps a long array with a count of what it dropped', () => {
    const out = redact(Array.from({ length: 60 }, (_, i) => i)) as unknown[]
    expect(out).toHaveLength(51)
    expect(out[50]).toBe('[+10 more]')
  })

  it('stops descending rather than following a deep structure forever', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } }
    const out = redact(deep) as { a: { b: { c: { d: { e: { f: { g: string } } } } } } }
    expect(out.a.b.c.d.e.f.g).toBe('[truncated]')
  })

  it('leaves null and undefined alone', () => {
    expect(redact(null)).toBeNull()
    expect(redact(undefined)).toBeUndefined()
    expect(redact({ shopId: null })).toEqual({ shopId: null })
  })
})

describe('log context', () => {
  it('is empty outside a scope', () => {
    expect(currentLogContext()).toEqual({})
  })

  it('makes the correlation id available to anything called inside', () => {
    const seen = withLogContext({ correlationId: 'corr-1', orderId: 'order-1' }, () =>
      currentLogContext(),
    )
    expect(seen).toEqual({ correlationId: 'corr-1', orderId: 'order-1' })
    expect(currentLogContext()).toEqual({})
  })

  it('merges rather than replaces when scopes nest', () => {
    withLogContext({ correlationId: 'corr-1' }, () => {
      withLogContext({ orderId: 'order-1' }, () => {
        expect(currentLogContext()).toEqual({ correlationId: 'corr-1', orderId: 'order-1' })
      })
      // The inner scope does not leak back out.
      expect(currentLogContext()).toEqual({ correlationId: 'corr-1' })
    })
  })

  it('lets a handler add what it learns partway through', () => {
    // A route knows the correlation id before it knows the order id.
    withLogContext({ correlationId: 'corr-1' }, () => {
      addLogContext({ orderId: 'order-1' })
      expect(currentLogContext()).toEqual({ correlationId: 'corr-1', orderId: 'order-1' })
    })
  })

  it('survives an await, which is the only reason it is worth having', async () => {
    await withLogContext({ correlationId: 'corr-async' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      expect(currentLogContext().correlationId).toBe('corr-async')
    })
  })

  it('ignores addLogContext outside a scope instead of throwing', () => {
    expect(() => addLogContext({ orderId: 'order-1' })).not.toThrow()
  })
})

describe('emitted lines', () => {
  it('writes one JSON object per line with a timestamp, level and message', () => {
    const { log, lines, last } = capture()
    log.info('order placed', { orderId: 'order-1' })

    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('\n')
    expect(last()).toMatchObject({ level: 'info', msg: 'order placed', orderId: 'order-1' })
    expect(String(last().t)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('redacts the fields it was handed', () => {
    // The careless call this whole module exists for.
    const { log, lines } = capture()
    log.info('placing order', {
      phone: '+919876543210',
      fileName: 'Aadhaar_scan.pdf',
      pickupCode: '7K2M9Q',
    })

    expect(lines[0]).not.toContain('9876543210')
    expect(lines[0]).not.toContain('Aadhaar')
    expect(lines[0]).not.toContain('7K2M9Q')
    expect(lines[0]).toContain('[redacted]')
  })

  it('redacts the ambient context too', () => {
    const { log, lines } = capture()
    withLogContext({ correlationId: 'corr-1', phone: '+919876543210' }, () => {
      log.warn('retrying notification')
    })
    expect(lines[0]).toContain('corr-1')
    expect(lines[0]).not.toContain('9876543210')
  })

  it('carries the correlation id onto every line without the call site passing it', () => {
    const { log, json } = capture()
    withLogContext({ correlationId: 'corr-7', actorRole: 'shop_owner' }, () => {
      log.info('accepting order')
      log.info('starting print')
    })

    const emitted = json()
    expect(emitted).toHaveLength(2)
    for (const line of emitted) {
      expect(line.correlationId).toBe('corr-7')
      expect(line.actorRole).toBe('shop_owner')
    }
  })

  it('honours the level threshold', () => {
    const { log, lines } = capture({ level: 'warn' })
    log.debug('noise')
    log.info('noise')
    log.warn('worth knowing')
    log.error('broken')
    expect(lines).toHaveLength(2)
  })

  it('merges child fields into every line', () => {
    const { log, last } = capture()
    const jobLog = log.child({ jobName: 'file.process', jobId: 'job-1' })
    jobLog.info('scanning upload')
    expect(last()).toMatchObject({ jobName: 'file.process', jobId: 'job-1' })
  })

  it('redacts child fields as well', () => {
    const { log, lines } = capture()
    log.child({ fileName: 'passport.pdf' }).info('scanning upload')
    expect(lines[0]).not.toContain('passport')
  })

  it('lets an explicit field win over the ambient context', () => {
    const { log, last } = capture()
    withLogContext({ orderId: 'from-context' }, () => {
      log.info('x', { orderId: 'from-call-site' })
    })
    expect(last().orderId).toBe('from-call-site')
  })

  it('records an AppError with its code and status', () => {
    const { log, last } = capture()
    log.error('could not start payment', errors.paymentFailed())

    const line = last()
    expect(line.errCode).toBe('payment_failed')
    expect(line.errStatus).toBe(402)
    expect(line.err).toContain('payment_failed')
  })

  it('records the cause of an AppError, which is the part clients never see', () => {
    const { log, last } = capture()
    log.error(
      'provider rejected the capture',
      errors.providerError('razorpay', 'That payment could not be completed.', new Error('401 key_id invalid')),
    )
    expect(String(last().errCause)).toContain('401 key_id invalid')
  })

  it('includes a bounded stack at error level only', () => {
    const { log, json } = capture()
    const thrown = new Error('socket hang up')
    log.warn('retrying', { err: thrown })
    log.error('gave up', thrown)

    const [warned, errored] = json()
    expect(warned?.stack).toBeUndefined()
    expect(String(errored?.stack).split('\n').length).toBeLessThanOrEqual(12)
  })

  it('handles a thrown non-Error without losing the line', () => {
    const { log, last } = capture()
    log.error('worker crashed', 'razorpay said no')
    expect(last().err).toBe('razorpay said no')
  })

  it('serialises the values a domain log line actually carries', () => {
    const { log, lines } = capture()
    expect(() =>
      log.info('order priced', { totalPaise: 100n, at: new Date(), buf: Buffer.alloc(4) }),
    ).not.toThrow()
    expect(lines).toHaveLength(1)
  })

  it('survives a circular reference, because the depth cap doubles as cycle protection', () => {
    // A cycle in a log payload is a call-site bug, but losing the line — or
    // taking the process down with a `TypeError` from `JSON.stringify` — would
    // make the bug much more expensive than it needs to be.
    const { log, lines } = capture()
    const circular: LogFields = { name: 'loop' }
    circular.self = circular

    expect(() => log.info('circular', circular)).not.toThrow()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[truncated]')
  })

  it('redacts in the pretty format development uses as well', () => {
    const { log, lines } = capture({ format: 'pretty' })
    log.info('placing order', { phone: '+919876543210', orderId: 'order-1' })

    expect(lines[0]).toContain('placing order')
    expect(lines[0]).toContain('INFO')
    expect(lines[0]).toContain('[redacted]')
    expect(lines[0]).not.toContain('9876543210')
  })
})

describe('the process logger', () => {
  it('delegates to whatever root logger is installed', () => {
    const calls: Array<[string, string]> = []
    const fake: Logger = {
      debug: (message) => calls.push(['debug', message]),
      info: (message) => calls.push(['info', message]),
      warn: (message) => calls.push(['warn', message]),
      error: (message) => calls.push(['error', message]),
      child: () => fake,
    }
    setRootLogger(fake)

    logger.debug('a')
    logger.info('b')
    logger.warn('c')
    logger.error('d', new Error('x'))
    logger.child({ shopId: 'shop-1' }).info('e')

    expect(calls).toEqual([
      ['debug', 'a'],
      ['info', 'b'],
      ['warn', 'c'],
      ['error', 'd'],
      ['info', 'e'],
    ])
  })
})
