/**
 * Environment bootstrap for standalone scripts.
 *
 * Next.js loads `.env.local` and friends itself; `tsx scripts/*.ts` does not. This
 * module reproduces Next's precedence so `npm run db:migrate` and `npm run worker`
 * see the same configuration the app does:
 *
 *   .env.<APP_ENV>.local  →  .env.local  →  .env.<APP_ENV>  →  .env
 *
 * Earlier files win; nothing already present in `process.env` is overwritten, so an
 * explicit `DATABASE_URL=... npm run db:migrate` still takes precedence over all of
 * them.
 *
 * Import this first, before anything that reads config:
 *
 *   import './_bootstrap'
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { config as loadDotenv } from 'dotenv'

const root = process.cwd()
const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development'

const candidates = [
  `.env.${appEnv}.local`,
  '.env.local',
  `.env.${appEnv}`,
  '.env',
]

for (const name of candidates) {
  const path = resolve(root, name)
  if (existsSync(path)) loadDotenv({ path, override: false })
}
