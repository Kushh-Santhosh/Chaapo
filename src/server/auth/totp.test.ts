import { describe, expect, it } from 'vitest'

import {
  base32Decode,
  base32Encode,
  formatTotpSecret,
  generateTotpSecret,
  hotp,
  totpCode,
  totpCounter,
  totpProvisioningUri,
  verifyTotp,
  TOTP_STEP_SECONDS,
} from './totp'

/**
 * A wrong TOTP implementation still produces six plausible digits. It does not
 * throw, it does not look broken in review, and it fails as "my authenticator app
 * doesn't work" from a finance admin who is now locked out of the payouts screen.
 *
 * So the only test worth much is the RFC's own: the published HOTP vectors from
 * RFC 4226 Appendix D and the TOTP vectors from RFC 6238 Appendix B, byte for byte.
 * Everything after that covers the two rules the RFC does not specify and which are
 * what actually make this a second factor — a bounded acceptance window, and a code
 * that cannot be used twice.
 */

/** The secret both RFCs use: ASCII "12345678901234567890". */
const RFC_SECRET_ASCII = '12345678901234567890'
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('base32', () => {
  it('matches the RFC 4648 vectors', () => {
    const vectors: Array<[string, string]> = [
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ]
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain, 'utf8')), plain).toBe(encoded)
      expect(base32Decode(encoded)?.toString('utf8'), encoded).toBe(plain)
    }
  })

  it('encodes the RFC secret the way an authenticator app expects it', () => {
    expect(base32Encode(Buffer.from(RFC_SECRET_ASCII, 'utf8'))).toBe(RFC_SECRET_BASE32)
  })

  it('round-trips arbitrary bytes', () => {
    for (const length of [1, 2, 5, 10, 16, 20, 32, 64]) {
      const bytes = Buffer.alloc(length, length)
      expect(base32Decode(base32Encode(bytes))?.equals(bytes), String(length)).toBe(true)
    }
  })

  it('accepts a secret the way a person retypes one', () => {
    // Lower case, grouped in fours, with the padding some exporters add.
    const expected = base32Decode(RFC_SECRET_BASE32)
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')?.equals(expected as Buffer)).toBe(true)
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ======')?.equals(expected as Buffer)).toBe(true)
    expect(base32Decode('GEZD-GNBV-GY3T-QOJQ-GEZD-GNBV-GY3T-QOJQ')?.equals(expected as Buffer)).toBe(true)
  })

  it('returns null rather than a wrong secret', () => {
    // 0, 1, 8 and 9 are not in the alphabet — mistaking them for O, I, B and G is
    // exactly the transcription error a hand-typed secret produces, and silently
    // decoding it would give a secret that never generates a working code.
    for (const bad of ['', '   ', 'GEZD0NBV', 'GEZD1NBV', 'GEZD8NBV', 'hello!', 'GEZD GNBV?']) {
      expect(base32Decode(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('hotp', () => {
  it('matches the RFC 4226 Appendix D vectors', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ]
    const secret = Buffer.from(RFC_SECRET_ASCII, 'utf8')
    expected.forEach((code, counter) => {
      expect(hotp(secret, counter), `counter ${counter}`).toBe(code)
    })
  })
})

describe('totpCode', () => {
  it('matches the RFC 6238 Appendix B vectors', () => {
    // The RFC states eight-digit values; six digits is the same truncation mod
    // 10^6, i.e. the last six of each.
    const vectors: Array<[number, string, string]> = [
      [59, '94287082', '287082'],
      [1111111109, '07081804', '081804'],
      [1111111111, '14050471', '050471'],
      [1234567890, '89005924', '005924'],
      [2000000000, '69279037', '279037'],
      [20000000000, '65353130', '353130'],
    ]
    for (const [seconds, eightDigits, sixDigits] of vectors) {
      const at = new Date(seconds * 1000)
      expect(totpCode(RFC_SECRET_BASE32, at), `T=${seconds} (6)`).toBe(sixDigits)
      expect(totpCode(RFC_SECRET_BASE32, at, 8), `T=${seconds} (8)`).toBe(eightDigits)
    }
  })

  it('returns null for a secret it could not read', () => {
    expect(totpCode('not base32!', new Date())).toBeNull()
  })
})

describe('totpCounter', () => {
  it('advances once every thirty seconds', () => {
    expect(totpCounter(new Date(0))).toBe(0)
    expect(totpCounter(new Date(29_999))).toBe(0)
    expect(totpCounter(new Date(30_000))).toBe(1)
    expect(totpCounter(new Date(59_000))).toBe(1)
  })
})

describe('verifyTotp', () => {
  const at = new Date(1111111111 * 1000)
  const step = TOTP_STEP_SECONDS * 1000

  it('accepts the current code and reports the step it accepted', () => {
    const verdict = verifyTotp({ secretBase32: RFC_SECRET_BASE32, code: '050471', at })
    expect(verdict).toEqual({ ok: true, counter: totpCounter(at) })
  })

  it('accepts a code that is one step stale, because phone clocks drift', () => {
    const previous = totpCode(RFC_SECRET_BASE32, new Date(at.getTime() - step)) as string
    const next = totpCode(RFC_SECRET_BASE32, new Date(at.getTime() + step)) as string

    expect(verifyTotp({ secretBase32: RFC_SECRET_BASE32, code: previous, at })).toEqual({
      ok: true,
      counter: totpCounter(at) - 1,
    })
    expect(verifyTotp({ secretBase32: RFC_SECRET_BASE32, code: next, at })).toEqual({
      ok: true,
      counter: totpCounter(at) + 1,
    })
  })

  it('does not accept a code two steps away', () => {
    // Each additional step is another 30 seconds in which a captured code stays
    // live. The window is a security parameter, not a comfort setting.
    const stale = totpCode(RFC_SECRET_BASE32, new Date(at.getTime() - 2 * step)) as string
    expect(verifyTotp({ secretBase32: RFC_SECRET_BASE32, code: stale, at })).toEqual({
      ok: false,
      reason: 'incorrect',
    })
  })

  it('refuses a code from a step already spent', () => {
    // The rule the RFC leaves to the implementer, and the one that matters most:
    // inside a 30-second step the same digits stay valid, so a code read over a
    // shoulder or replayed through a proxied form works twice unless the accepted
    // step is remembered.
    const counter = totpCounter(at)
    expect(
      verifyTotp({ secretBase32: RFC_SECRET_BASE32, code: '050471', at, lastUsedCounter: counter }),
    ).toEqual({ ok: false, reason: 'replayed' })
  })

  it('distinguishes a replay from a typo', () => {
    // Different things are happening to the account, and the audit log should not
    // say the same thing about both.
    const counter = totpCounter(at)
    expect(
      verifyTotp({ secretBase32: RFC_SECRET_BASE32, code: '050471', at, lastUsedCounter: counter }).ok,
    ).toBe(false)
    expect(
      verifyTotp({ secretBase32: RFC_SECRET_BASE32, code: '000000', at, lastUsedCounter: counter }),
    ).toEqual({ ok: false, reason: 'incorrect' })
  })

  it('refuses an earlier step in the window once a later one has been used', () => {
    // Otherwise the ±1 window quietly re-opens a code that was already spent.
    const counter = totpCounter(at)
    const previous = totpCode(RFC_SECRET_BASE32, new Date(at.getTime() - step)) as string
    expect(
      verifyTotp({ secretBase32: RFC_SECRET_BASE32, code: previous, at, lastUsedCounter: counter }),
    ).toEqual({ ok: false, reason: 'replayed' })
  })

  it('still accepts the next step after the current one was used', () => {
    // A person who enrols and then immediately authenticates must not be blocked
    // for 30 seconds.
    const counter = totpCounter(at)
    const next = totpCode(RFC_SECRET_BASE32, new Date(at.getTime() + step)) as string
    expect(
      verifyTotp({ secretBase32: RFC_SECRET_BASE32, code: next, at, lastUsedCounter: counter }),
    ).toEqual({ ok: true, counter: counter + 1 })
  })

  it('accepts a bigint counter, which is what the column returns', () => {
    // `user_totp.last_used_counter` is a bigint column, so the value arrives as a
    // BigInt and a `<=` against a Number would be a type error at runtime.
    const counter = totpCounter(at)
    expect(
      verifyTotp({ secretBase32: RFC_SECRET_BASE32, code: '050471', at, lastUsedCounter: BigInt(counter) }),
    ).toEqual({ ok: false, reason: 'replayed' })
  })

  it('treats a never-used secret as having no spent steps', () => {
    for (const lastUsed of [null, undefined]) {
      expect(
        verifyTotp({ secretBase32: RFC_SECRET_BASE32, code: '050471', at, lastUsedCounter: lastUsed }).ok,
        String(lastUsed),
      ).toBe(true)
    }
  })

  it('accepts the code however it was typed', () => {
    for (const input of ['050471', ' 050471 ', '050 471', '०५०४७१']) {
      expect(verifyTotp({ secretBase32: RFC_SECRET_BASE32, code: input, at }).ok, input).toBe(true)
    }
  })

  it('separates a malformed code from a wrong one', () => {
    // A half-typed code should not be logged as a failed second factor.
    for (const input of ['', '05047', '0504712', 'abcdef']) {
      expect(verifyTotp({ secretBase32: RFC_SECRET_BASE32, code: input, at }), input).toEqual({
        ok: false,
        reason: 'malformed',
      })
    }
  })

  it('reports an unreadable secret rather than an incorrect code', () => {
    // This means our stored secret is corrupt, not that the user is wrong, and the
    // two need different handling: one is an incident, the other is a retry.
    expect(verifyTotp({ secretBase32: 'not base32!', code: '050471', at })).toEqual({
      ok: false,
      reason: 'bad_secret',
    })
    expect(verifyTotp({ secretBase32: '', code: '050471', at })).toEqual({
      ok: false,
      reason: 'bad_secret',
    })
  })

  it('does not walk into negative counters near the epoch', () => {
    expect(() => verifyTotp({ secretBase32: RFC_SECRET_BASE32, code: '000000', at: new Date(0) })).not.toThrow()
  })
})

describe('generateTotpSecret', () => {
  it('is 160 bits, the length authenticator apps expect', () => {
    const secret = generateTotpSecret()
    expect(base32Decode(secret)?.byteLength).toBe(20)
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
  })

  it('is different every time', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateTotpSecret()))
    expect(seen.size).toBe(100)
  })

  it('produces a secret that verifies against its own code', () => {
    const secret = generateTotpSecret()
    const at = new Date('2026-08-27T10:00:00.000Z')
    const code = totpCode(secret, at) as string
    expect(verifyTotp({ secretBase32: secret, code, at }).ok).toBe(true)
  })
})

describe('totpProvisioningUri', () => {
  it('names the issuer in both places apps look for it', () => {
    const uri = totpProvisioningUri({ secretBase32: RFC_SECRET_BASE32, account: 'priya@chaapo.in' })
    expect(uri.startsWith('otpauth://totp/Chaapo:priya%40chaapo.in?')).toBe(true)
    expect(uri).toContain('issuer=Chaapo')
    expect(uri).toContain(`secret=${RFC_SECRET_BASE32}`)
    expect(uri).toContain('algorithm=SHA1')
    expect(uri).toContain('digits=6')
    expect(uri).toContain('period=30')
  })

  it('escapes an account label that would break the URI', () => {
    const uri = totpProvisioningUri({ secretBase32: RFC_SECRET_BASE32, account: 'a b/c?d', issuer: 'Chaapo Admin' })
    expect(uri).toContain('Chaapo%20Admin:a%20b%2Fc%3Fd')
    expect(new URL(uri).searchParams.get('secret')).toBe(RFC_SECRET_BASE32)
  })
})

describe('formatTotpSecret', () => {
  it('groups in fours for the manual-entry path', () => {
    // The QR code fails often enough — cracked screen, shared shop tablet, desktop
    // with no camera — that typing the secret has to be usable.
    expect(formatTotpSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP')
    expect(formatTotpSecret('')).toBe('')
  })
})
