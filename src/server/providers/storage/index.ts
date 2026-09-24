/**
 * Which object store this process uses.
 *
 * The same two-source arrangement as `pricing/source.ts`, and for the same reason: the
 * app must open with nothing configured, and it must never *silently* substitute a
 * development stand-in in an environment that looks like production. For prices that
 * would mean invented money; for files it would mean a customer's document sitting
 * unencrypted on a container's ephemeral disk, which is worse.
 *
 * So the rule is one-way: the local disk store is selected only when there is no S3
 * configuration *and* the app is development or test. A production-like environment with
 * no bucket configured fails loudly instead of degrading.
 *
 * The S3 implementation is not in this repository yet. That is deliberate rather than an
 * omission: the AWS SDK is not installed in this environment and no bucket exists, so an
 * adapter written here could not be run, and shipping unrunnable code that *looks* like
 * the production path is how "we support S3" becomes a claim nobody has tested. The
 * throw below names exactly what is missing, and `StoragePort` is the seam it slots into.
 */

import { errors } from '../../core/errors'

import { localStorageProvider } from './local'

import type { StoragePort } from './port'

export type StorageSource = 's3' | 'local-dev-disk'

export function storageSource(env: NodeJS.ProcessEnv = process.env): StorageSource {
  const appEnv = env.APP_ENV ?? env.NODE_ENV ?? 'development'
  const isDevLike = appEnv === 'development' || appEnv === 'test'

  // In development, always use the local disk store, even if S3 credentials are present.
  // This ensures a developer doesn't accidentally use MinIO from a docker-compose stack
  // or try to hit a real AWS bucket. In production-like environments, S3 is required.
  if (isDevLike) return 'local-dev-disk'

  // In production or staging, an explicit `s3` with credentials is the only option.
  if (env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) return 's3'
  
  return 's3' // will throw in getStorage() if the adapter doesn't exist
}

export function getStorage(env: NodeJS.ProcessEnv = process.env): StoragePort {
  if (storageSource(env) === 'local-dev-disk') return localStorageProvider

  // `notImplemented` renders as "<what> is not available yet.", so this reads as a
  // sentence in a log line and in the error boundary's detail.
  throw errors.notImplemented(
    'S3 object storage (set APP_ENV=development to use the local development store, or add an S3 adapter behind StoragePort)',
  )
}

export type {
  PresignDownloadInput,
  PresignUploadInput,
  PresignedDownload,
  PresignedUpload,
  StoragePort,
  StoredObject,
} from './port'
