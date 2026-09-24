/**
 * Who owns a draft before anyone has signed in.
 *
 * A customer picks a shop and starts uploading before they have an account — that is the
 * point of the product, and C-07 comes before any sign-in screen. But every file row needs
 * an owner, because ownership is a parameter of every query in `FileStore` rather than a
 * check someone remembered to write. So this mints one signed, http-only cookie holding a
 * random uuid and nothing else.
 *
 * What this identity is **not**: it is not authentication. It proves only "the browser that
 * uploaded these files is the browser asking about them". It grants no capability, names no
 * user row, and must never be accepted anywhere a `session` is expected. When the draft
 * becomes an order the files are re-owned by the real user id, and this cookie stops
 * mattering.
 *
 * It is signed rather than a bare uuid so that a customer cannot type someone else's draft
 * id into their own cookie jar and read a stranger's upload list. A bare random uuid would
 * be unguessable in practice, but "unguessable" is a property of the generator and
 * "unforgeable" is a property of the signature, and only the second one is checkable.
 *
 * Lives in `src/server/http/` because it touches `next/headers`, which the domain layer is
 * forbidden to import (see `eslint.config.mjs`).
 */

import { cookies } from 'next/headers'

import { newId } from '../../lib/ids'
import { createTokenSigner, type TokenSigner } from '../auth/tokens'

const COOKIE_NAME = 'chaapo_draft'

/** As long as a draft's files live (24 h retention), plus enough slack to finish paying. */
const TTL_SECONDS = 36 * 3600

/**
 * The signer.
 *
 * `process.env` directly rather than `getConfig()`, which validates every provider key in
 * the environment — the upload flow has to work on a laptop with nothing configured. With
 * no `SESSION_SECRET` a per-process random secret is used, so drafts do not survive a dev
 * server restart. That is the right outcome: the development file store does not survive one
 * either, and a fixed fallback secret is exactly the kind of thing that ends up in
 * production signing real cookies.
 */
let signer: TokenSigner | null = null

function draftSigner(): TokenSigner {
  if (!signer) {
    signer = createTokenSigner(process.env.SESSION_SECRET ?? newId() + newId())
  }
  return signer
}

/**
 * The current draft owner, or `null` when this browser has never uploaded anything.
 *
 * Safe to call while rendering. A tampered, expired or wrong-purpose cookie reads as `null`
 * rather than as an error: the honest response to "I cannot tell whose draft this is" is an
 * empty draft, not a failure.
 */
export async function readDraftOwnerId(): Promise<string | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value
  if (!token) return null

  const verdict = draftSigner().verify(token, { purpose: 'draft_owner' })
  return verdict.ok ? verdict.claims.subject : null
}

/**
 * The current draft owner, minting one if there is none.
 *
 * Only callable from a Server Action or Route Handler — Next forbids setting a cookie during
 * render, which is why reading and creating are two functions instead of one. Every caller
 * that writes files goes through here; every caller that only reads uses `readDraftOwnerId`.
 */
export async function requireDraftOwnerId(): Promise<string> {
  const existing = await readDraftOwnerId()
  if (existing) return existing

  const ownerId = newId()
  const token = draftSigner().sign({
    purpose: 'draft_owner',
    subject: ownerId,
    ttlSeconds: TTL_SECONDS,
  })

  ;(await cookies()).set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Not `secure` in development, where localhost is http and the cookie would be dropped.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: TTL_SECONDS,
  })

  return ownerId
}
