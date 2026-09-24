/**
 * Which catalogue the pricing engine reads.
 *
 * The same two-source arrangement as discovery, and for the same reason: the app must
 * open on a laptop with no Postgres, and it must never *silently* serve invented prices
 * in an environment that looks like production. Prices are the one thing a fixture
 * fallback would be unforgivable for — a customer paying a made-up rate is worse than a
 * page that fails to load.
 *
 * Kept separate from `discovery/source.ts` rather than shared, so a future move of one
 * domain onto a read replica does not silently move the other.
 */

export type PricingSource = 'database' | 'dev-fixtures'

export class MissingCatalogueError extends Error {
  override readonly name = 'MissingCatalogueError'
  constructor() {
    super(
      'DATABASE_URL is not set. The development catalogue is only available when APP_ENV is development or test.',
    )
  }
}

/**
 * Read `process.env` directly, not `config/index.ts`, which validates every provider key
 * in the environment. The point of the dev source is that quoting works before any of
 * that is configured.
 */
export function pricingSource(env: NodeJS.ProcessEnv = process.env): PricingSource {
  if (env.DATABASE_URL) return 'database'

  const appEnv = env.APP_ENV ?? env.NODE_ENV ?? 'development'
  if (appEnv === 'development' || appEnv === 'test') return 'dev-fixtures'

  throw new MissingCatalogueError()
}

/** Whether a quote should be labelled, in words, as computed from local sample rates. */
export function usingDevCatalogue(env: NodeJS.ProcessEnv = process.env): boolean {
  return pricingSource(env) === 'dev-fixtures'
}
