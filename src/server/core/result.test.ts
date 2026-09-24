import { describe, expect, it } from 'vitest'

import { AppError, errors, isAppError } from './errors'
import {
  allResults,
  attempt,
  err,
  isErr,
  isOk,
  mapErr,
  mapResult,
  ok,
  unwrap,
  unwrapOr,
  type Result,
} from './result'

/**
 * The point of `Result` in this codebase is the line it draws: an `err` is a
 * product outcome the HTTP layer turns into a normal response, a throw is an
 * incident. So the tests that matter are the ones about that boundary —
 * `attempt` catching a throw into an `err`, and `unwrap` turning an `err` back
 * into a throw without losing the code the client needs.
 */

const CLOSED = errors.conflict('This shop has stopped taking orders for today.')

describe('ok and err', () => {
  it('carries a value', () => {
    const result = ok(42)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe(42)
  })

  it('carries a void success without pretending there is a value', () => {
    const result = ok()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBeUndefined()
  })

  it('keeps falsy values intact', () => {
    // `ok(0)` and `ok(false)` are successes. A truthiness check anywhere in the
    // combinators would break refund maths and feature flags respectively.
    for (const value of [0, false, '', null, 0n]) {
      const result = ok(value)
      expect(result.ok, String(value)).toBe(true)
      if (!result.ok) continue
      expect(result.value).toBe(value)
    }
  })

  it('carries an error', () => {
    const result = err(CLOSED)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe(CLOSED)
  })

  it('narrows through the guards', () => {
    const success: Result<number> = ok(1)
    const failure: Result<number> = err(CLOSED)

    expect(isOk(success)).toBe(true)
    expect(isErr(success)).toBe(false)
    expect(isOk(failure)).toBe(false)
    expect(isErr(failure)).toBe(true)
  })
})

describe('unwrap', () => {
  it('returns the value', () => {
    expect(unwrap(ok('CHP-7K2M-9QD4'))).toBe('CHP-7K2M-9QD4')
  })

  it('throws the AppError itself, so the code survives to the route handler', () => {
    try {
      unwrap(err(CLOSED))
      expect.unreachable('unwrap should have thrown')
    } catch (thrown) {
      expect(thrown).toBe(CLOSED)
      expect(isAppError(thrown)).toBe(true)
    }
  })

  it('throws a plain Error as-is rather than double-wrapping it', () => {
    const cause = new TypeError('not a function')
    expect(() => unwrap(err(cause))).toThrow(cause)
  })

  it('wraps a non-Error error value so a catch always sees an Error', () => {
    // A `Result<T, string>` is legal, and code that catches must not have to
    // handle a thrown string.
    try {
      unwrap(err('shop closed'))
      expect.unreachable('unwrap should have thrown')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(AppError)
      expect((thrown as AppError).code).toBe('internal')
    }
  })
})

describe('unwrapOr', () => {
  it('prefers the value', () => {
    expect(unwrapOr(ok(5), 0)).toBe(5)
  })

  it('falls back on an error', () => {
    expect(unwrapOr(err(CLOSED) as Result<number>, 0)).toBe(0)
  })

  it('falls back to a falsy fallback too', () => {
    expect(unwrapOr(err(CLOSED) as Result<boolean>, false)).toBe(false)
  })
})

describe('mapResult', () => {
  it('transforms a value', () => {
    const result = mapResult(ok(200n), (paise) => Number(paise) / 100)
    expect(result).toEqual({ ok: true, value: 2 })
  })

  it('passes an error through untouched, without calling the function', () => {
    let called = false
    const result = mapResult(err(CLOSED) as Result<number>, () => {
      called = true
      return 1
    })
    expect(called).toBe(false)
    if (result.ok) return
    expect(result.error).toBe(CLOSED)
  })
})

describe('mapErr', () => {
  it('rewrites an error, which is how a domain error becomes a product message', () => {
    const result = mapErr(err('shop_closed') as Result<number, string>, (code) =>
      errors.conflict(`Rejected: ${code}.`),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe('Rejected: shop_closed.')
  })

  it('leaves a success alone, without calling the function', () => {
    let called = false
    const result = mapErr(ok(1), () => {
      called = true
      return CLOSED
    })
    expect(called).toBe(false)
    expect(result).toEqual({ ok: true, value: 1 })
  })
})

describe('allResults', () => {
  it('collects values in order', () => {
    const result = allResults([ok(1), ok(2), ok(3)])
    expect(result).toEqual({ ok: true, value: [1, 2, 3] })
  })

  it('returns the first error and stops', () => {
    // Validating a basket of order items: the customer gets the first problem,
    // and nothing further is evaluated.
    const second = errors.validation([{ path: 'items.1.copies', message: 'Enter at least 1 copy.' }])
    const third = errors.validation([{ path: 'items.2.copies', message: 'Too many copies.' }])

    const result = allResults([ok(1), err(second), err(third)] as Result<number>[])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe(second)
  })

  it('treats an empty batch as an empty success', () => {
    expect(allResults([])).toEqual({ ok: true, value: [] })
  })
})

describe('attempt', () => {
  it('wraps a synchronous return', async () => {
    await expect(attempt(() => 7)).resolves.toEqual({ ok: true, value: 7 })
  })

  it('wraps an awaited return', async () => {
    await expect(attempt(async () => 'done')).resolves.toEqual({ ok: true, value: 'done' })
  })

  it('captures a thrown AppError with its code intact', async () => {
    const result = await attempt(() => {
      throw CLOSED
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe(CLOSED)
    expect(result.error.code).toBe('conflict')
  })

  it('captures a rejected promise as an internal error', async () => {
    // The shape a provider SDK failure arrives in. It becomes an `err` the caller
    // can decide about, not an unhandled rejection.
    const result = await attempt(async () => {
      throw new Error('socket hang up')
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('internal')
    expect(result.error.expected).toBe(false)
    expect((result.error.cause as Error).message).toBe('socket hang up')
  })

  it('captures a thrown non-Error', async () => {
    const result = await attempt(() => {
      throw 'razorpay said no'
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBeInstanceOf(AppError)
    expect(result.error.code).toBe('internal')
  })
})
