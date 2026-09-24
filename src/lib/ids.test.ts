import { describe, expect, it } from 'vitest'

import {
  ORDER_NUMBER_PREFIX,
  PICKUP_CODE_LENGTH,
  formatPickupCode,
  idTimestamp,
  isOrderNumber,
  isUuid,
  newCorrelationId,
  newId,
  newIdempotencyKey,
  newOrderNumber,
  newPickupCode,
  newQrSlug,
  normaliseHumanCode,
  randomCrockford,
  randomSlug,
  safeEqual,
  slugify,
} from './ids'

/**
 * Identifiers are where a small mistake becomes a security or support problem: a
 * pickup code that is guessable, an order number a customer cannot read out over
 * the counter, a comparison that leaks a code one character at a time.
 *
 * The property that gets the most attention here is the one that is easiest to
 * break by editing the alphabet: a generated code must be a fixed point of the
 * normaliser. If `randomCrockford` ever emits an `O`, a customer typing what they
 * see would be normalised to `0` and would never match.
 */

const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]+$/

describe('newId', () => {
  it('produces a well-formed UUID', () => {
    expect(isUuid(newId())).toBe(true)
  })

  it('sets the version and variant bits RFC 9562 requires', () => {
    for (let i = 0; i < 50; i += 1) {
      const hex = newId().replace(/-/g, '')
      expect(hex[12]).toBe('7')
      expect(['8', '9', 'a', 'b']).toContain(hex[16])
    }
  })

  it('embeds the millisecond it was minted at', () => {
    const at = 1_735_689_600_000 // 2025-01-01T00:00:00Z
    expect(idTimestamp(newId(at))?.getTime()).toBe(at)
  })

  it('defaults to now', () => {
    const drift = Math.abs((idTimestamp(newId())?.getTime() ?? 0) - Date.now())
    expect(drift).toBeLessThan(2000)
  })

  it('sorts in time order as a string', () => {
    // The whole reason for v7 over v4: primary keys that insert at the right-hand
    // edge of the index instead of scattering across it.
    const early = newId(1_700_000_000_000)
    const late = newId(1_800_000_000_000)
    expect([late, early].sort()).toEqual([early, late])
  })

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId()))
    expect(ids.size).toBe(2000)
  })
})

describe('idTimestamp', () => {
  it('returns null for a UUID of another version', () => {
    expect(idTimestamp('01890000-0000-4000-8000-000000000001')).toBeNull()
  })

  it('returns null for something that is not a UUID at all', () => {
    expect(idTimestamp('not-an-id')).toBeNull()
    expect(idTimestamp('')).toBeNull()
  })
})

describe('isUuid', () => {
  it('accepts either case', () => {
    const id = newId()
    expect(isUuid(id.toUpperCase())).toBe(true)
  })

  it('rejects near-misses and non-strings', () => {
    expect(isUuid('01890000-0000-7000-8000-00000000000')).toBe(false)
    expect(isUuid(undefined)).toBe(false)
    expect(isUuid(12)).toBe(false)
  })
})

describe('human codes', () => {
  it('draws only from the Crockford alphabet', () => {
    const sample = randomCrockford(400)
    expect(sample).toMatch(CROCKFORD_RE)
    expect(sample).not.toMatch(/[ILOU]/)
  })

  it('returns the length asked for, including zero', () => {
    expect(randomCrockford(6)).toHaveLength(6)
    expect(randomCrockford(0)).toBe('')
  })

  it('is not degenerate', () => {
    // A generator stuck on one character would pass every other test here.
    expect(new Set(randomCrockford(500)).size).toBeGreaterThan(20)
  })

  it('normalises the confusions a person makes reading a code aloud', () => {
    expect(normaliseHumanCode('oi l-u')).toBe('011V')
    expect(normaliseHumanCode('7k2 m9q')).toBe('7K2M9Q')
    expect(normaliseHumanCode('CHP-7K2M-9QD4')).toBe('CHP7K2M9QD4')
    expect(normaliseHumanCode(' 7k2_m9q. ')).toBe('7K2M9Q')
  })

  it('leaves a generated code unchanged', () => {
    // The load-bearing property. If the alphabet gained an O, an I or a U, a
    // customer typing exactly what they see would stop matching.
    for (let i = 0; i < 200; i += 1) {
      const code = newPickupCode()
      expect(normaliseHumanCode(code), code).toBe(code)
    }
    for (let i = 0; i < 200; i += 1) {
      const number = newOrderNumber()
      expect(normaliseHumanCode(number), number).toBe(number.replace(/-/g, ''))
    }
  })
})

describe('order numbers', () => {
  it('reads as CHP-XXXX-XXXX', () => {
    const number = newOrderNumber()
    expect(number).toMatch(/^CHP-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(number.startsWith(`${ORDER_NUMBER_PREFIX}-`)).toBe(true)
    expect(isOrderNumber(number)).toBe(true)
  })

  it('accepts a number a customer typed in lower case', () => {
    expect(isOrderNumber(newOrderNumber().toLowerCase())).toBe(true)
  })

  it('rejects the wrong shape or an excluded letter', () => {
    expect(isOrderNumber('CHP-7K2M-9QD')).toBe(false)
    expect(isOrderNumber('CHP-7K2M9QD4')).toBe(false)
    expect(isOrderNumber('XYZ-7K2M-9QD4')).toBe(false)
    expect(isOrderNumber('CHP-IK2M-9QD4')).toBe(false)
    expect(isOrderNumber('')).toBe(false)
  })

  it('does not repeat over a realistic day', () => {
    const numbers = new Set(Array.from({ length: 5000 }, () => newOrderNumber()))
    // ~1.1e12 combinations, so a collision in 5000 draws would mean the generator
    // is not drawing uniformly. The database's unique index is the real guarantee.
    expect(numbers.size).toBe(5000)
  })
})

describe('pickup codes', () => {
  it('is six characters a person can read across a counter', () => {
    const code = newPickupCode()
    expect(code).toHaveLength(PICKUP_CODE_LENGTH)
    expect(code).toMatch(CROCKFORD_RE)
  })

  it('groups for display without changing the value', () => {
    expect(formatPickupCode('7K2M9Q')).toBe('7K2 M9Q')
    expect(normaliseHumanCode(formatPickupCode('7K2M9Q'))).toBe('7K2M9Q')
  })

  it('leaves a code of another length alone rather than mangling it', () => {
    expect(formatPickupCode('7K2M')).toBe('7K2M')
    expect(formatPickupCode('')).toBe('')
  })

  it('uses the full alphabet, so the space is 32^6', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 400; i += 1) for (const char of newPickupCode()) seen.add(char)
    expect(seen.size).toBeGreaterThan(28)
  })
})

describe('slugs and keys', () => {
  it('mints a URL-safe QR slug with no padding', () => {
    const slug = newQrSlug()
    expect(slug).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(slug).not.toContain('=')
  })

  it('carries nothing that identifies the order', () => {
    // The QR encodes an opaque slug and nothing else: scanning it out of a bin
    // hands over no order number and no token (FR-506).
    const slug = newQrSlug()
    expect(isOrderNumber(slug)).toBe(false)
    expect(isUuid(slug)).toBe(false)
  })

  it('scales entropy with the byte count', () => {
    expect(randomSlug(9)).toHaveLength(12)
    expect(randomSlug(16)).toHaveLength(22)
    expect(new Set(Array.from({ length: 500 }, () => randomSlug(16))).size).toBe(500)
  })

  it('keeps the prefix on an idempotency key so a log line says where it came from', () => {
    const key = newIdempotencyKey('webhook')
    expect(key.startsWith('webhook_')).toBe(true)
    expect(key.slice('webhook_'.length)).toMatch(/^[A-Za-z0-9_-]{24}$/)
  })

  it('mints short correlation ids', () => {
    expect(newCorrelationId()).toHaveLength(12)
  })
})

describe('safeEqual', () => {
  it('matches identical strings', () => {
    expect(safeEqual('7K2M9Q', '7K2M9Q')).toBe(true)
  })

  it('rejects a different string of the same length', () => {
    expect(safeEqual('7K2M9Q', '7K2M9R')).toBe(false)
  })

  it('rejects a different length without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, which would turn a wrong
    // pickup code into a 500 — and tell an attacker the length was wrong.
    expect(safeEqual('7K2M9Q', '7K2M9')).toBe(false)
    expect(safeEqual('', 'x')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })
})

describe('slugify', () => {
  it('handles the shop name from the PRD', () => {
    expect(slugify('Sharma Xerox & Stationery, Kothrud')).toBe(
      'sharma-xerox-and-stationery-kothrud',
    )
  })

  it('strips diacritics rather than dropping the letter', () => {
    expect(slugify('Café Xerox')).toBe('cafe-xerox')
  })

  it('collapses punctuation and trims the edges', () => {
    expect(slugify('  ***A1  Prints!!  ')).toBe('a1-prints')
  })

  it('truncates without leaving a trailing dash', () => {
    const slug = slugify('Shree Ganesh Digital Colour Xerox and Print Centre', 20)
    expect(slug.length).toBeLessThanOrEqual(20)
    expect(slug.endsWith('-')).toBe(false)
  })

  it('returns empty for a name with no Latin characters', () => {
    // Devanagari shop names are common, and the caller must fall back to an id
    // rather than publishing an empty handle. Better that this is visible.
    expect(slugify('शर्मा जेरॉक्स')).toBe('')
  })
})
