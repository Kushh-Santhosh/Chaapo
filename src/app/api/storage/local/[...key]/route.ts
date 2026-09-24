/**
 * DEVELOPMENT-ONLY object storage endpoint.
 *
 * This route plays the part the bucket plays in production: it accepts the browser's PUT
 * against a signed, expiring, size-capped credential for one specific key, and serves the
 * bytes back on a separately signed GET. It exists so the upload flow on a laptop is the
 * *same* flow as the deployed one — the client island PUTs to a URL it was handed either
 * way, and knows nothing about which store answered.
 *
 * It refuses to exist outside development. `usingDevFileStore()` is the same guard that
 * selects the development file store, so a production-like process gets a 404 here rather
 * than a filesystem write. That matters more than it looks: this handler writes whatever it
 * is given, and its only protection is the signature.
 *
 * No authentication, deliberately — and that is not a gap. The credential *is* the
 * authority, exactly as with S3: it names one key, expires, caps the size, and cannot be
 * edited without invalidating the signature. Adding a session check here would make the dev
 * path stricter than the production path it stands in for, which would hide bugs.
 */

import { NextResponse, type NextRequest } from 'next/server'

import { usingDevFileStore } from '@/server/domains/files'
import {
  localStorageProvider,
  verifyObjectToken,
  writeLocalObject,
} from '@/server/providers/storage/local'

/** The credential is per-key and short-lived; nothing here may be cached or reused. */
const NO_STORE = { 'cache-control': 'no-store' } as const

interface Params {
  params: Promise<{ key: string[] }>
}

function refuse(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { message } }, { status, headers: NO_STORE })
}

/**
 * Read the signed parts of the URL.
 *
 * The caps come from the query string and the key from the path, so a client that edits
 * either produces a different payload and fails the check in the caller. Nothing from the
 * request body or headers is signed over, which is why the size is enforced against the
 * actual bytes below rather than against `content-length`.
 */
function claimsFrom(
  request: NextRequest,
  method: 'PUT' | 'GET',
): { exp: number; maxBytes: number; sig: string } | null {
  const exp = Number(request.nextUrl.searchParams.get('exp'))
  const sig = request.nextUrl.searchParams.get('sig')
  const maxBytes = method === 'PUT' ? Number(request.nextUrl.searchParams.get('max')) : 0

  if (!sig || !Number.isInteger(exp) || !Number.isInteger(maxBytes)) return null
  return { exp, maxBytes, sig }
}

export async function PUT(request: NextRequest, { params }: Params): Promise<NextResponse> {
  if (!usingDevFileStore()) return refuse(404, 'Not found.')

  const key = (await params).key.map(decodeURIComponent).join('/')
  const claims = claimsFrom(request, 'PUT')
  if (!claims) return refuse(400, 'Malformed upload URL.')

  const verdict = verifyObjectToken(
    { key, method: 'PUT', exp: claims.exp, maxBytes: claims.maxBytes },
    claims.sig,
  )
  // Distinguished on purpose: "expired" means take a fresh URL and retry, "bad signature"
  // means something is wrong and retrying will not help.
  if (verdict === 'expired') return refuse(403, 'This upload link has expired.')
  if (verdict === 'bad_signature') return refuse(403, 'This upload link is not valid.')

  const body = await request.arrayBuffer()
  const bytes = Buffer.from(body)

  if (bytes.byteLength === 0) return refuse(400, 'No bytes were sent.')
  // The cap is checked against what arrived, not against Content-Length, which the client
  // controls independently of the body.
  if (bytes.byteLength > claims.maxBytes) {
    return refuse(413, 'That file is larger than the upload link allows.')
  }

  const stored = await writeLocalObject(key, bytes)

  // `etag` because that is what the real provider returns and what a client that wants to
  // verify its own upload would look for.
  return NextResponse.json(
    { key, byteSize: stored.byteSize },
    { status: 200, headers: { ...NO_STORE, etag: `"${stored.sha256}"` } },
  )
}

export async function GET(request: NextRequest, { params }: Params): Promise<NextResponse> {
  if (!usingDevFileStore()) return refuse(404, 'Not found.')

  const key = (await params).key.map(decodeURIComponent).join('/')
  const claims = claimsFrom(request, 'GET')
  if (!claims) return refuse(400, 'Malformed download URL.')

  const verdict = verifyObjectToken({ key, method: 'GET', exp: claims.exp, maxBytes: 0 }, claims.sig)
  if (verdict === 'expired') return refuse(403, 'This link has expired.')
  if (verdict === 'bad_signature') return refuse(403, 'This link is not valid.')

  const object = await localStorageProvider.head(key)
  if (!object) return refuse(404, 'Not found.')

  const bytes = await localStorageProvider.read(key)
  const downloadName = request.nextUrl.searchParams.get('name')

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...NO_STORE,
      // Always `octet-stream` and always an attachment: a customer's document must never
      // be rendered inline by the browser on our own origin, where a crafted file would
      // run against our cookies.
      'content-type': 'application/octet-stream',
      'content-length': String(object.byteSize),
      'content-disposition': downloadName
        ? `attachment; filename="${downloadName.replaceAll('"', '')}"`
        : 'attachment',
      'x-content-type-options': 'nosniff',
    },
  })
}
