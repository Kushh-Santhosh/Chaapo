/**
 * DEVELOPMENT-ONLY object storage, backed by the local filesystem.
 *
 * This is NOT production storage and does not pretend to be. It exists for one reason:
 * the upload flow must be genuinely exercisable on a laptop with no S3 credentials and
 * no bucket, and a "just POST it to a server action" shortcut would have been a different
 * flow from the real one — different size limits, different failure modes, bytes through
 * our process. Faking a successful upload would be worse still.
 *
 * What it does keep faithful to S3:
 *
 * - the browser PUTs bytes to a URL it was handed, not to the app's own actions;
 * - that URL carries a signed, expiring, single-key, size-capped credential;
 * - the credential is refused after `expiresAt`, and refused for any other key;
 * - the server learns the real byte size from `head()` afterwards, never from the client.
 *
 * What it deliberately does NOT do: server-side encryption, versioning, replication,
 * lifecycle rules, or multipart. Those are properties of the real provider, and claiming
 * them here is exactly the sort of pretending the brief forbids. `isDevelopmentStore` is
 * `true` so the UI can say, in words, that files are on this machine's disk.
 *
 * Objects live under `.chaapo-storage/` in the project root, which is gitignored.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

import { hmacSha256Base64Url, verifySignature } from '../../core/crypto'

import type {
  PresignDownloadInput,
  PresignUploadInput,
  PresignedDownload,
  PresignedUpload,
  StoragePort,
  StoredObject,
} from './port'

/** Where the bytes go. Relative to `process.cwd()`, i.e. the project root under `next dev`. */
const ROOT = resolve(process.cwd(), '.chaapo-storage')

/** The route handler that plays the part of the bucket endpoint. */
const MOUNT = '/api/storage/local'

const BUCKET = 'chaapo-files-dev'

/**
 * A key is a server-generated path (`u/<user>/<id>.pdf`), never customer input, but this
 * is the boundary where a traversal would land so it is checked anyway. Anything that
 * escapes `ROOT` after resolution is rejected rather than clamped, because a key that
 * needed clamping is a bug upstream and hiding it loses the file.
 */
function pathFor(key: string): string {
  if (!key || key.startsWith('/') || key.includes('\0')) {
    throw new Error('Invalid storage key')
  }
  const full = resolve(ROOT, key)
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    throw new Error('Invalid storage key')
  }
  return full
}

interface TokenClaims {
  key: string
  method: 'PUT' | 'GET'
  /** Epoch seconds. */
  exp: number
  /** Signed for PUT so the size cap cannot be raised by editing the query string. */
  maxBytes: number
}

/**
 * The dev credential.
 *
 * Read from `process.env` rather than `config/index.ts` on purpose: the whole point of
 * this store is that uploads work before any provider key is configured, and
 * `getConfig()` validates the lot. The fallback is a fixed, obviously-fake string — it
 * is only ever reachable in development, where the same guard that selects this store
 * has already refused to run production-like.
 */
function secret(): string {
  return process.env.SESSION_SECRET ?? 'dev-only-local-storage-secret'
}

function sign(claims: TokenClaims): string {
  const payload = `${claims.method}\n${claims.key}\n${claims.exp}\n${claims.maxBytes}`
  return hmacSha256Base64Url(secret(), payload)
}

/**
 * Verify a credential presented by the browser.
 *
 * Returns the reason for refusal rather than a boolean so the route handler can answer
 * 403-expired distinctly from 403-bad-signature, which is the difference between "take a
 * fresh URL and retry" and "something is wrong".
 */
export function verifyObjectToken(
  claims: TokenClaims,
  provided: string,
  now: Date = new Date(),
): 'ok' | 'expired' | 'bad_signature' {
  if (!verifySignature(sign(claims), provided)) return 'bad_signature'
  if (claims.exp * 1000 <= now.getTime()) return 'expired'
  return 'ok'
}

function urlFor(claims: TokenClaims): string {
  const query = new URLSearchParams({
    exp: String(claims.exp),
    max: String(claims.maxBytes),
    sig: sign(claims),
  })
  // Use a same-origin relative URL so browser uploads work regardless of which port the app
  // is bound to. A hardcoded APP_URL here breaks the real upload flow on dev sandboxes like
  // localhost:3100, and the route is already the same origin as the page that asked for it.
  const path = claims.key.split('/').map(encodeURIComponent).join('/')
  return `${MOUNT}/${path}?${query.toString()}`
}

export const localStorageProvider: StoragePort = {
  name: 'local-dev-disk',
  filesBucket: BUCKET,
  isDevelopmentStore: true,

  async presignUpload(input: PresignUploadInput): Promise<PresignedUpload> {
    const exp = Math.floor(Date.now() / 1000) + input.ttlSeconds
    const claims: TokenClaims = {
      key: input.key,
      method: 'PUT',
      exp,
      maxBytes: input.maxBytes,
    }
    return {
      url: urlFor(claims),
      method: 'PUT',
      // Sent by the client and checked by the handler, the same pair S3 signs over.
      headers: { 'content-type': input.contentType },
      expiresAt: new Date(exp * 1000).toISOString(),
      maxBytes: input.maxBytes,
    }
  },

  async presignDownload(input: PresignDownloadInput): Promise<PresignedDownload> {
    const exp = Math.floor(Date.now() / 1000) + input.ttlSeconds
    const claims: TokenClaims = { key: input.key, method: 'GET', exp, maxBytes: 0 }
    const url = input.downloadName
      ? `${urlFor(claims)}&name=${encodeURIComponent(input.downloadName)}`
      : urlFor(claims)
    return { url, expiresAt: new Date(exp * 1000).toISOString() }
  },

  async head(key: string): Promise<StoredObject | null> {
    try {
      const info = await stat(pathFor(key))
      if (!info.isFile()) return null
      return { key, byteSize: info.size, contentType: null }
    } catch {
      return null
    }
  },

  async read(key: string): Promise<Buffer> {
    return readFile(pathFor(key))
  },

  async delete(key: string): Promise<void> {
    // `force` makes an absent key a success, which is what retention retries need.
    await rm(pathFor(key), { force: true })
  },
}

/**
 * Write bytes for a verified PUT.
 *
 * Exported for the dev route handler only; it is not on `StoragePort` because in every
 * real provider this step happens inside the provider, not in our process. Returns the
 * sha-256 so the handler can hand storage's own view of the content back, the way S3
 * returns an ETag.
 */
export async function writeLocalObject(
  key: string,
  bytes: Buffer,
): Promise<{ byteSize: number; sha256: string }> {
  const full = pathFor(key)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, bytes)
  return { byteSize: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** Absolute path of an object, for the dev handler's `GET`. */
export function localObjectPath(key: string): string {
  return pathFor(key)
}

export const LOCAL_STORAGE_ROOT = ROOT
export const LOCAL_STORAGE_MOUNT = MOUNT
