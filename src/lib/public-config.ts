/**
 * Client-visible configuration.
 *
 * `NEXT_PUBLIC_*` values are inlined at build time, so they must be referenced
 * as static property accesses (not `process.env[key]`). Nothing secret may ever
 * appear here.
 */
export const publicConfig = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
  appEnv: (process.env.NEXT_PUBLIC_APP_ENV ?? 'development') as
    | 'development'
    | 'test'
    | 'staging'
    | 'production',
  supportPhone: process.env.NEXT_PUBLIC_SUPPORT_PHONE ?? '',
  vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '',
  mapProvider: (process.env.NEXT_PUBLIC_MAP_PROVIDER ?? 'osm') as 'none' | 'osm' | 'maptiler',
  mapToken: process.env.NEXT_PUBLIC_MAP_TOKEN ?? '',
} as const

export const isProductionClient = publicConfig.appEnv === 'production'
export const pushSupportedByConfig = publicConfig.vapidPublicKey.length > 0
