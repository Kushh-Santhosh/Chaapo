/**
 * The object-storage seam.
 *
 * Customer files never pass through the application. The browser sends bytes straight to
 * storage using a short-lived credential minted here, and the server only ever holds
 * *keys* — which is why `files` has no `url` column and never will (NFR-13).
 *
 * That shape is the whole reason this port exists rather than a `writeFile` helper: an
 * upload of a 180 MB scanned thesis must not be buffered through a Next.js server action
 * (whose body limit is 2 MB), and a download must not be proxied through our bandwidth.
 * Every implementation therefore has to answer the same two questions — "where do I PUT
 * this?" and "what URL may this one person read it from, for the next few minutes?"
 *
 * Nothing here knows about `files` rows, orders or customers. Authorisation happens in
 * the domain *before* a presign is requested; this layer is a dumb bucket.
 */

/** A credential the browser can PUT one object to, once, soon. */
export interface PresignedUpload {
  /** Absolute URL the browser sends bytes to. */
  url: string
  /** Always `PUT` today. Named so a multipart implementation can say otherwise. */
  method: 'PUT'
  /**
   * Headers the browser must replay verbatim. A signature usually covers
   * `Content-Type` and length, so dropping one of these turns into a 403 at upload
   * time rather than a clear error here.
   */
  headers: Record<string, string>
  /** ISO 8601. After this the credential is refused and a new one must be minted. */
  expiresAt: string
  /** Bytes the credential permits. Enforced by storage, not just by the client. */
  maxBytes: number
}

/** A credential to read one object for a bounded window. */
export interface PresignedDownload {
  url: string
  expiresAt: string
}

/** What storage knows about an object, independent of what we recorded about it. */
export interface StoredObject {
  key: string
  byteSize: number
  contentType: string | null
}

export interface PresignUploadInput {
  key: string
  contentType: string
  /**
   * Upper bound the credential is signed for. The client's *declared* size, not a
   * trusted one: `head()` after the upload is what establishes the real size.
   */
  maxBytes: number
  ttlSeconds: number
}

export interface PresignDownloadInput {
  key: string
  ttlSeconds: number
  /**
   * Filename to suggest in `Content-Disposition`. The customer's own filename is
   * acceptable here and nowhere else — it is decrypted per request, for one reader.
   */
  downloadName?: string
}

export interface StoragePort {
  /** Short identifier that goes in logs and in `files.storage_bucket` provenance. */
  readonly name: string
  /** The bucket customer files live in. Recorded on the row so a later move is traceable. */
  readonly filesBucket: string
  /**
   * True when this implementation is a development stand-in. Read by the UI to say so
   * in words, so a dev environment can never be mistaken for real storage.
   */
  readonly isDevelopmentStore: boolean

  presignUpload(input: PresignUploadInput): Promise<PresignedUpload>
  presignDownload(input: PresignDownloadInput): Promise<PresignedDownload>

  /** `null` when the object is absent — the normal answer for an abandoned upload. */
  head(key: string): Promise<StoredObject | null>

  /**
   * The whole object.
   *
   * Only for inspection (sniffing a magic number, counting PDF pages). Callers are
   * expected to have checked `head()` first; there is no streaming variant because
   * nothing in the MVP streams file bytes through the server.
   */
  read(key: string): Promise<Buffer>

  /** Idempotent. Deleting an absent key is a success, because retention retries. */
  delete(key: string): Promise<void>
}
