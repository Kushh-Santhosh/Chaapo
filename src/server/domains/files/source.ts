/**
 * Where file records live.
 *
 * The same shape as `pricing/source.ts`: Postgres when `DATABASE_URL` is set, a
 * process-local store when it is not and the app is development or test, and a loud
 * failure otherwise. A production-like process must never keep a customer's file record
 * in memory — the row is the only thing that proves the bytes exist and must be deleted.
 */

export type FilesSource = 'database' | 'dev-store'

export class MissingFileStoreError extends Error {
  override readonly name = 'MissingFileStoreError'
  constructor() {
    super(
      'DATABASE_URL is not set. The in-process file store is only available when APP_ENV is development or test.',
    )
  }
}

export function filesSource(env: NodeJS.ProcessEnv = process.env): FilesSource {
  const appEnv = env.APP_ENV ?? env.NODE_ENV ?? 'development'
  if (appEnv === 'test') return 'dev-store'
  if (env.DATABASE_URL) return 'database'

  if (appEnv === 'development') return 'dev-store'

  throw new MissingFileStoreError()
}

/** Whether the upload panel should say, in words, that files are held locally. */
export function usingDevFileStore(env: NodeJS.ProcessEnv = process.env): boolean {
  return filesSource(env) === 'dev-store'
}
