import { afterEach, describe, expect, it } from 'vitest'

import { createEncryptor } from './crypto'
import {
  __setEncryptorForTests,
  hashEmail,
  hashIdentifier,
  hashIp,
  hashPhone,
  normaliseEmail,
  protectEmail,
  protectPhone,
  revealEmail,
  revealPhone,
  userAgentFamily,
} from './pii'

/**
 * The privacy commitments in PRD §57 are only as good as this module, so what is
 * tested here is the shape of the guarantee rather than the shape of the code:
 *
 *   • the blind index is **stable**, or the same person gets two accounts;
 *   • the blind index is **the same across purposes**, or a shop owner cannot
 *     also be a customer;
 *   • nothing derived is **reversible**, so a database dump is not a map of who
 *     our customers are and where they live;
 *   • an un-normalised phone number is a **loud failure**, because it is the one
 *     mistake here that has no symptom until it has already corrupted data.
 */

__setEncryptorForTests(createEncryptor(Buffer.alloc(32, 7)))

afterEach(() => {
  __setEncryptorForTests(createEncryptor(Buffer.alloc(32, 7)))
})

const PHONE = '+919876543210'

describe('protectPhone', () => {
  it('expands one number into the three columns the schema has', () => {
    const protected_ = protectPhone(PHONE)
    expect(Object.keys(protected_).sort()).toEqual(['encrypted', 'hash', 'masked'])
    expect(revealPhone(protected_.encrypted)).toBe(PHONE)
    expect(protected_.masked).toBe('+91 98••• •3210')
  })

  it('gives a different ciphertext every time and the same hash every time', () => {
    // Both halves matter. A deterministic ciphertext would let anyone with read
    // access confirm a guess; a non-deterministic hash could not carry the unique
    // index that stops duplicate accounts.
    const a = protectPhone(PHONE)
    const b = protectPhone(PHONE)
    expect(a.encrypted).not.toBe(b.encrypted)
    expect(a.hash).toBe(b.hash)
    expect(a.hash).toBe(hashPhone(PHONE))
  })

  it('hashes the same number identically whichever column it is stored in', () => {
    // A shop owner signing in as a customer is one person. If the owner-phone
    // blind index were purpose-bound, `users_phone_hash_key` would not find them
    // and they would end up with two accounts and two order histories.
    expect(protectPhone(PHONE, 'shop.owner_phone').hash).toBe(protectPhone(PHONE, 'user.phone').hash)
    expect(protectPhone(PHONE, 'shop.contact_phone').hash).toBe(hashPhone(PHONE))
  })

  it('still binds the ciphertext to its column', () => {
    // The hash is shared; the ciphertext is not. A value lifted out of
    // `shop_kyc` cannot be decrypted as a user's phone number.
    const asOwner = protectPhone(PHONE, 'shop.owner_phone')
    expect(() => revealPhone(asOwner.encrypted, 'user.phone')).toThrow()
    expect(revealPhone(asOwner.encrypted, 'shop.owner_phone')).toBe(PHONE)
  })

  it('never leaks the number into anything derived', () => {
    const { hash, masked } = protectPhone(PHONE)
    expect(hash).not.toContain('9876543210')
    expect(masked).not.toContain('9876543210')
    expect(masked).not.toContain('98765')
  })

  it('refuses an un-normalised number instead of hashing it', () => {
    // This is the one mistake in this module with no symptom: a hash over
    // "98765 43210" simply never matches the hash over "+919876543210", so the
    // lookup misses and a second account is created. Failing loudly keeps
    // normalisation in the layer that parsed the input.
    for (const bad of ['9876543210', '98765 43210', '+91 98765 43210', '0919876543210', '']) {
      expect(() => protectPhone(bad), JSON.stringify(bad)).toThrow(/normalised to E\.164/)
      expect(() => hashPhone(bad), JSON.stringify(bad)).toThrow(/normalised to E\.164/)
    }
  })
})

describe('normaliseEmail', () => {
  it('folds case and trims', () => {
    expect(normaliseEmail('  Priya.Sharma@Example.COM ')).toBe('priya.sharma@example.com')
  })

  it('does not collapse dots or plus-tags into one address', () => {
    // They are distinct mailboxes at most providers. Treating them as one would
    // let someone claim an account belonging to a real person.
    expect(normaliseEmail('a.b@example.com')).not.toBe(normaliseEmail('ab@example.com'))
    expect(normaliseEmail('priya+chaapo@example.com')).toBe('priya+chaapo@example.com')
  })

  it('rejects what is obviously not an address', () => {
    for (const bad of ['', '   ', 'priya', 'priya@', '@example.com', 'priya@example', 'a b@example.com', 'priya@@example.com', `${'x'.repeat(250)}@example.com`]) {
      expect(normaliseEmail(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('accepts the addresses shop owners actually have', () => {
    for (const good of ['owner@shop.co.in', 'a@b.io', 'first.last+tag@sub.domain.example.com']) {
      expect(normaliseEmail(good), good).toBe(good)
    }
  })
})

describe('protectEmail', () => {
  it('round-trips and masks', () => {
    const normalised = normaliseEmail('Divya@Example.com') as string
    const protected_ = protectEmail(normalised)
    expect(revealEmail(protected_.encrypted)).toBe('divya@example.com')
    expect(protected_.masked).toBe('d•••a@example.com')
    expect(protected_.hash).toBe(hashEmail('divya@example.com'))
  })

  it('hashes two different addresses differently', () => {
    expect(hashEmail('a@example.com')).not.toBe(hashEmail('b@example.com'))
  })
})

describe('hashIp', () => {
  it('is stable for one address and different for another', () => {
    expect(hashIp('203.0.113.4')).toBe(hashIp('203.0.113.4'))
    expect(hashIp('203.0.113.4')).not.toBe(hashIp('203.0.113.5'))
  })

  it('does not carry the address', () => {
    expect(hashIp('203.0.113.4')).not.toContain('203')
    expect(hashIp('2001:db8::1')).not.toContain('2001')
  })

  it('treats an IPv4-mapped IPv6 address as the IPv4 address it is', () => {
    // Behind a proxy the same client shows up both ways. Without this, one
    // person looks like two origins and the per-IP OTP limit is halved.
    expect(hashIp('::ffff:203.0.113.4')).toBe(hashIp('203.0.113.4'))
  })

  it('collapses an IPv6 address to its /64', () => {
    // The low 64 bits are frequently a rotating privacy address. Hashing them
    // whole would make every request from one phone look like a new origin, which
    // is exactly the property a rate limit must not have.
    expect(hashIp('2001:db8:85a3:1::8a2e:370:7334')).toBe(hashIp('2001:db8:85a3:1::1'))
    expect(hashIp('2001:db8:85a3:1::1')).not.toBe(hashIp('2001:db8:85a3:2::1'))
  })

  it('is insensitive to IPv6 spelling', () => {
    expect(hashIp('2001:0DB8:85A3:0001::1')).toBe(hashIp('2001:db8:85a3:1::1'))
  })

  it('does not throw on something that is not an address', () => {
    // The value arrives from a header. A malformed one must not take down a
    // sign-in; it just becomes its own opaque bucket.
    expect(() => hashIp('unknown')).not.toThrow()
    expect(() => hashIp('1:2:3:4:5:6:7:8:9:10')).not.toThrow()
  })
})

describe('hashIdentifier', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(hashIdentifier(' Priya@Example.com ')).toBe(hashIdentifier('priya@example.com'))
  })

  it('separates different identifiers', () => {
    expect(hashIdentifier('+919876543210')).not.toBe(hashIdentifier('+919876543211'))
  })

  it('reveals nothing about a number that may not even be ours', () => {
    // `login_attempts` records failures by design, so it holds numbers belonging
    // to people who never signed up.
    expect(hashIdentifier('+919876543210')).not.toContain('9876')
  })
})

describe('userAgentFamily', () => {
  it('names the browser and the platform, and nothing more specific', () => {
    const cases: Array<[string, string]> = [
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        'Safari on iOS',
      ],
      [
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
        'Chrome on Android',
      ],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
        'Edge on Windows',
      ],
      [
        'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
        'Samsung Internet on Android',
      ],
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
        'Safari on macOS',
      ],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
        'Firefox on Windows',
      ],
      [
        'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
        'Chrome on iOS',
      ],
    ]
    for (const [ua, expected] of cases) {
      expect(userAgentFamily(ua), expected).toBe(expected)
    }
  })

  it('does not mistake Edge or Samsung Internet for Chrome', () => {
    // Both impersonate Chrome, which impersonates Safari. Order of checks is the
    // whole implementation, so it is pinned.
    expect(userAgentFamily('… Chrome/126 Safari/537.36 Edg/126')).toBe('Edge')
    expect(userAgentFamily('… SamsungBrowser/23.0 Chrome/115 Mobile Safari/537.36')).toBe('Samsung Internet')
    expect(userAgentFamily('… OPR/110.0 Chrome/124 Safari/537.36')).toBe('Opera')
  })

  it('flags a script, which is how support tells a bot from a browser', () => {
    expect(userAgentFamily('curl/8.6.0')).toBe('Script')
    expect(userAgentFamily('python-requests/2.32.3')).toBe('Script')
  })

  it('returns null when there is no user agent at all', () => {
    expect(userAgentFamily(null)).toBeNull()
    expect(userAgentFamily(undefined)).toBeNull()
    expect(userAgentFamily('')).toBeNull()
  })

  it('says Unknown rather than storing something it did not understand', () => {
    expect(userAgentFamily('MyCustomClient/1.0')).toBe('Unknown')
  })
})
