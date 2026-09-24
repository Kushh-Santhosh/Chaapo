/**
 * Which data source discovery reads from.
 *
 * There are two, and the choice is made once, here, so that no screen and no route
 * ever has to think about it:
 *
 *   • **`database`** — the real thing. Postgres + PostGIS, `shops.discoverable`.
 *   • **`dev-fixtures`** — the local set in `fixtures.ts`, for running the app on a
 *     laptop with no database.
 *
 * The fixture source is refused whenever `DATABASE_URL` is set (if there is a database,
 * use it) and it **throws** rather than falling back when the app is production-like.
 * A silent fallback is the dangerous shape of this pattern: it turns a misconfigured
 * production deploy into a site that looks fine and shows six shops in Pune that do
 * not exist.
 */

export type DiscoverySource = 'database' | 'dev-fixtures'

export class MissingDatabaseError extends Error {
  override readonly name = 'MissingDatabaseError'
  constructor() {
    super(
      'DATABASE_URL is not set. The development fixture source is only available when APP_ENV is development or test.',
    )
  }
}

/**
 * Read straight from `process.env` rather than through `config/index.ts`, because that
 * module validates the *whole* environment — every secret, every provider key — and
 * the point of the dev source is that the app opens before any of that is configured.
 */
export function discoverySource(env: NodeJS.ProcessEnv = process.env): DiscoverySource {
  if (env.DATABASE_URL) return 'database'

  const appEnv = env.APP_ENV ?? env.NODE_ENV ?? 'development'
  if (appEnv === 'development' || appEnv === 'test') return 'dev-fixtures'

  throw new MissingDatabaseError()
}

/** Whether the UI should say, in words, that it is showing local sample data. */
export function usingDevFixtures(env: NodeJS.ProcessEnv = process.env): boolean {
  return discoverySource(env) === 'dev-fixtures'
}
