import { describe, expect, it } from 'vitest'
import {
  createEncryptor,
  hashOpaqueToken,
  hashPassword,
  hmacSha256Hex,
  maskAccountNumber,
  maskEmail,
  maskPan,
  maskPhone,
  needsRehash,
  newOpaqueToken,
  verifyPassword,
  verifySignature,
} from './crypto'

const key = Buffer.alloc(32, 7)
const otherKey = Buffer.alloc(32, 9)

describe('envelope encryption', () => {
  const enc = createEncryptor(key)

  it('round-trips a value', () => {
    const envelope = enc.encrypt('+919876543210', 'user.phone')
    expect(enc.decrypt(envelope, 'user.phone')).toBe('+919876543210')
  })

  it('produces a self-describing versioned envelope', () => {
    const envelope = enc.encrypt('ABCDE1234F', 'kyc.pan')
    const parts = envelope.split('.')
    expect(parts).toHaveLength(5)
    expect(parts[0]).toBe('v1')
    expect(parts[1]).toBe('1')
    expect(envelope).not.toContain('ABCDE1234F')
  })

  it('is non-deterministic — the same plaintext encrypts differently each time', () => {
    const a = enc.encrypt('+919876543210', 'user.phone')
    const b = enc.encrypt('+919876543210', 'user.phone')
    expect(a).not.toBe(b)
    expect(enc.decrypt(a, 'user.phone')).toBe(enc.decrypt(b, 'user.phone'))
  })

  it('refuses a ciphertext moved to a different column', () => {
    // A PAN ciphertext lifted into the phone column must not decrypt.
    const envelope = enc.encrypt('ABCDE1234F', 'kyc.pan')
    expect(() => enc.decrypt(envelope, 'user.phone')).toThrow()
  })

  it('refuses a tampered ciphertext', () => {
    const envelope = enc.encrypt('+919876543210', 'user.phone')
    const parts = envelope.split('.')
    const flipped = Buffer.from(parts[4]!, 'base64url')
    flipped[0] = flipped[0]! ^ 0xff
    const tampered = [...parts.slice(0, 4), flipped.toString('base64url')].join('.')
    expect(() => enc.decrypt(tampered, 'user.phone')).toThrow()
  })

  it('refuses a ciphertext from a different key', () => {
    const envelope = createEncryptor(otherKey).encrypt('+919876543210', 'user.phone')
    expect(() => enc.decrypt(envelope, 'user.phone')).toThrow()
  })

  it('rejects a malformed envelope instead of returning garbage', () => {
    expect(() => enc.decrypt('not-an-envelope', 'user.phone')).toThrow(
      /Malformed ciphertext envelope/,
    )
    expect(() => enc.decrypt('v9.1.a.b.c', 'user.phone')).toThrow(/Unsupported ciphertext version/)
  })

  it('requires a 32-byte key', () => {
    expect(() => createEncryptor(Buffer.alloc(16))).toThrow(/32 bytes/)
  })
})

describe('blind index', () => {
  const enc = createEncryptor(key)

  it('is deterministic so it can carry a unique index', () => {
    expect(enc.blindIndex('+919876543210', 'user.phone')).toBe(
      enc.blindIndex('+919876543210', 'user.phone'),
    )
  })

  it('is domain-separated by purpose', () => {
    expect(enc.blindIndex('same-value', 'user.phone')).not.toBe(
      enc.blindIndex('same-value', 'user.email'),
    )
  })

  it('does not reveal the input', () => {
    const index = enc.blindIndex('+919876543210', 'user.phone')
    expect(index).not.toContain('9876543210')
    expect(index.length).toBeGreaterThan(20)
  })

  it('differs across keys, so one tenant cannot correlate another', () => {
    expect(enc.blindIndex('+919876543210', 'user.phone')).not.toBe(
      createEncryptor(otherKey).blindIndex('+919876543210', 'user.phone'),
    )
  })
})

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct-horse-battery')
    expect(await verifyPassword('correct-horse-battery', stored)).toBe(true)
    expect(await verifyPassword('correct-horse-batteries', stored)).toBe(false)
  })

  it('salts, so identical passwords hash differently', async () => {
    const a = await hashPassword('correct-horse-battery')
    const b = await hashPassword('correct-horse-battery')
    expect(a).not.toBe(b)
  })

  it('stores its own parameters so they can be raised later', async () => {
    const stored = await hashPassword('correct-horse-battery')
    expect(stored.split('$')[0]).toBe('scrypt')
    expect(stored.split('$')).toHaveLength(6)
    expect(needsRehash(stored)).toBe(false)
    expect(needsRehash('scrypt$1024$8$1$c2FsdA==$aGFzaA==')).toBe(true)
    expect(needsRehash('bcrypt$something')).toBe(true)
  })

  it('normalises unicode so a differently-composed password still matches', async () => {
    const stored = await hashPassword('passéword-long')
    expect(await verifyPassword('passéword-long', stored)).toBe(true)
  })

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    expect(await verifyPassword('anything', 'garbage')).toBe(false)
    expect(await verifyPassword('anything', 'scrypt$x$y$z$q$w')).toBe(false)
  })

  it('refuses to hash a password below the policy minimum', async () => {
    await expect(hashPassword('short')).rejects.toThrow()
  })
})

describe('signatures', () => {
  it('verifies a matching HMAC', () => {
    const body = '{"event":"payment.captured"}'
    const signature = hmacSha256Hex('shh', body)
    expect(verifySignature(signature, hmacSha256Hex('shh', body))).toBe(true)
  })

  it('rejects a signature made with a different secret', () => {
    const body = '{"event":"payment.captured"}'
    expect(verifySignature(hmacSha256Hex('shh', body), hmacSha256Hex('other', body))).toBe(false)
  })

  it('rejects a signature of a different body — no replay onto new payloads', () => {
    expect(
      verifySignature(hmacSha256Hex('shh', '{"a":1}'), hmacSha256Hex('shh', '{"a":2}')),
    ).toBe(false)
  })

  it('rejects mismatched lengths without throwing', () => {
    expect(verifySignature('abcdef', 'abc')).toBe(false)
    expect(verifySignature('', '')).toBe(true)
  })
})

describe('opaque tokens', () => {
  it('generates high-entropy url-safe tokens', () => {
    const token = newOpaqueToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token.length).toBeGreaterThanOrEqual(43)
    expect(newOpaqueToken()).not.toBe(token)
  })

  it('hashes deterministically so the database never holds a live token', () => {
    const token = newOpaqueToken()
    expect(hashOpaqueToken(token)).toBe(hashOpaqueToken(token))
    expect(hashOpaqueToken(token)).not.toBe(token)
  })
})

describe('masking for display', () => {
  it('masks phone numbers, keeping enough for recognition', () => {
    expect(maskPhone('+919876543210')).toBe('+91 98••• •3210')
    expect(maskPhone('9876543210')).toBe('98••• •3210')
    expect(maskPhone('12')).toBe('••••')
  })

  it('masks emails', () => {
    expect(maskEmail('divya@example.com')).toBe('d•••a@example.com')
    expect(maskEmail('ab@example.com')).toBe('a•••@example.com')
    expect(maskEmail('not-an-email')).toBe('•••')
  })

  it('masks PAN and bank accounts to the legally displayable tail', () => {
    expect(maskPan('ABCDE1234F')).toBe('ABC•••••4F')
    expect(maskPan('short')).toBe('••••••••••')
    expect(maskAccountNumber('123456789012')).toBe('••••••••9012')
    expect(maskAccountNumber('12')).toBe('••••')
  })
})
