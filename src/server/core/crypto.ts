import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

/**
 * Cryptography.
 *
 * Four distinct jobs, deliberately not mixed:
 *
 * 1. **Reversible PII at rest** — phone numbers, email addresses, PAN, bank
 *    account numbers, pickup codes. AES-256-GCM with a versioned data key and
 *    the record's purpose bound in as additional authenticated data, so a
 *    ciphertext lifted from `shop_kyc.pan_encrypted` cannot be replayed into
 *    `users.phone_encrypted`. Envelope format is self-describing and versioned so
 *    the key can be rotated without a big-bang migration (NFR-11).
 *
 * 2. **Blind indexes** — we still have to *find* a user by phone number without
 *    storing it in the clear. A keyed HMAC of the normalised value gives a
 *    deterministic, unique-indexable, non-reversible lookup column.
 *
 * 3. **Passwords** — scrypt with per-password salt and versioned parameters.
 *    Memory-hard, in the Node standard library, and therefore no native build
 *    step in the deployment image. The stored string carries its own parameters
 *    so they can be raised later and old hashes upgraded on next login.
 *
 * 4. **Message authentication** — webhook signature verification and pickup
 *    token signing. Always constant-time compared.
 *
 * Aadhaar is never persisted in any form, encrypted or not (PRD §57.2): the KYC
 * flow captures the last four digits for display and a verification reference
 * only.
 */

// ── Envelope encryption ─────────────────────────────────────────────────────

/** Bumped when the algorithm or key derivation changes. */
const ENVELOPE_VERSION = 'v1'
const GCM_IV_BYTES = 12
const GCM_TAG_BYTES = 16

/**
 * A purpose label bound into the ciphertext as AAD. Adding a value here is a
 * schema decision: it must match the column the ciphertext lives in.
 */
export type CryptoPurpose =
  | 'user.phone'
  | 'user.email'
  | 'shop.contact_phone'
  | 'shop.owner_phone'
  | 'kyc.pan'
  | 'kyc.gstin'
  | 'kyc.bank_account'
  | 'kyc.aadhaar_ref'
  | 'order.pickup_code'
  | 'order.customer_note'
  /** `files.original_name_encrypted` — the customer's own filename, never logged. */
  | 'file.original_name'
  | 'payout.beneficiary'
  | 'session.device'

export interface Encryptor {
  encrypt(plaintext: string, purpose: CryptoPurpose): string
  decrypt(envelope: string, purpose: CryptoPurpose): string
  blindIndex(value: string, purpose: CryptoPurpose): string
  hmac(value: string, label: string): string
}

/**
 * Create an encryptor bound to a data key.
 *
 * `key` must be exactly 32 bytes. In production it is delivered by the platform
 * secret store; a KMS-backed key-encrypting key wraps it at rest, which is why
 * the envelope carries a key version.
 */
export function createEncryptor(key: Buffer, keyVersion = 1): Encryptor {
  if (key.byteLength !== 32) {
    throw new Error(`Encryption key must be 32 bytes, received ${key.byteLength}`)
  }

  const aadFor = (purpose: CryptoPurpose) => Buffer.from(`chaapo:${ENVELOPE_VERSION}:${purpose}`, 'utf8')

  return {
    /**
     * Returns `v1.<keyVersion>.<iv>.<tag>.<ciphertext>`, all base64url. Safe to
     * store in a text column and safe to log-redact by key name.
     */
    encrypt(plaintext, purpose) {
      const iv = randomBytes(GCM_IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES })
      cipher.setAAD(aadFor(purpose))
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return [
        ENVELOPE_VERSION,
        String(keyVersion),
        iv.toString('base64url'),
        tag.toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.')
    },

    decrypt(envelope, purpose) {
      const parts = envelope.split('.')
      if (parts.length !== 5) throw new Error('Malformed ciphertext envelope')
      const [version, , ivPart, tagPart, ctPart] = parts as [string, string, string, string, string]
      if (version !== ENVELOPE_VERSION) {
        throw new Error(`Unsupported ciphertext version "${version}"`)
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(ivPart, 'base64url'),
        { authTagLength: GCM_TAG_BYTES },
      )
      decipher.setAAD(aadFor(purpose))
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
      // Throws on tag mismatch — which is exactly what we want if a ciphertext
      // was moved between columns or tampered with.
      return Buffer.concat([
        decipher.update(Buffer.from(ctPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8')
    },

    /**
     * Deterministic, non-reversible lookup value. Same input + purpose always
     * yields the same 32-byte digest, so it can carry a unique index.
     */
    blindIndex(value, purpose) {
      return createHmac('sha256', key).update(`bi:${purpose}:${value}`).digest('base64url')
    },

    hmac(value, label) {
      return createHmac('sha256', key).update(`${label}:${value}`).digest('base64url')
    },
  }
}

// ── Password hashing ────────────────────────────────────────────────────────

/**
 * scrypt parameters. `N` is the cost; raising it invalidates nothing because the
 * parameters live in the stored hash and old hashes are re-hashed on next
 * successful login (see `needsRehash`).
 */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keylen: 64 } as const
const SCRYPT_MAXMEM = 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2

/** `scrypt$N$r$p$saltB64$hashB64` */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) {
    throw new Error('hashPassword called with a password shorter than the policy minimum')
  }
  const salt = randomBytes(16)
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_MAXMEM,
  })
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts as [string, string, string, string, string, string]
  const N = Number(nRaw)
  const r = Number(rRaw)
  const p = Number(pRaw)
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  const expected = Buffer.from(hashB64, 'base64')
  let derived: Buffer
  try {
    derived = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.byteLength, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    })
  } catch {
    return false
  }
  if (derived.byteLength !== expected.byteLength) return false
  return timingSafeEqual(derived, expected)
}

/** True when a stored hash used weaker parameters than the current policy. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true
  return Number(parts[1]) < SCRYPT_PARAMS.N
}

// ── Keyed hashing / MAC ─────────────────────────────────────────────────────

export function hmacSha256(secret: string | Buffer, payload: string | Buffer): Buffer {
  return createHmac('sha256', secret).update(payload).digest()
}

export function hmacSha256Hex(secret: string | Buffer, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export function hmacSha256Base64Url(secret: string | Buffer, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

/**
 * Constant-time comparison of two hex/base64 signatures of possibly different
 * lengths. Used for webhook verification, where the remote controls the input.
 */
export function verifySignature(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.byteLength !== b.byteLength) {
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

// ── Opaque tokens ───────────────────────────────────────────────────────────

/**
 * Session and refresh tokens are random, opaque and stored **hashed**, so a
 * database dump cannot be replayed as a live session (NFR-13). 32 bytes.
 */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Digest a 256-bit random token for storage. A domain-separated HMAC with a
 * fixed label is enough here — the token itself is full-entropy random, so there
 * is no dictionary to attack and no per-token salt to manage.
 */
export function hashOpaqueToken(token: string): string {
  return createHmac('sha256', 'chaapo.token.v1').update(token).digest('base64url')
}

// ── Masking for display ─────────────────────────────────────────────────────

/** `+91 98765 43210` → `+91 98••• •3210` */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 6) return '••••'
  const last4 = digits.slice(-4)
  const cc = digits.length > 10 ? `+${digits.slice(0, digits.length - 10)} ` : ''
  const firstTwo = digits.slice(-10, -8)
  return `${cc}${firstTwo}••• •${last4}`
}

/** `divya@example.com` → `d•••a@example.com` */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  if (!domain) return '•••'
  if (local.length <= 2) return `${local[0] ?? '•'}•••@${domain}`
  return `${local[0]}•••${local[local.length - 1]}@${domain}`
}

/** `ABCDE1234F` → `ABC•••••4F` */
export function maskPan(pan: string): string {
  const clean = pan.toUpperCase().replace(/\s/g, '')
  if (clean.length !== 10) return '••••••••••'
  return `${clean.slice(0, 3)}•••••${clean.slice(-2)}`
}

/** `123456789012` → `••••••9012` */
export function maskAccountNumber(account: string): string {
  const clean = account.replace(/\s/g, '')
  if (clean.length < 4) return '••••'
  return `${'•'.repeat(Math.max(clean.length - 4, 4))}${clean.slice(-4)}`
}
