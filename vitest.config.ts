import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Unit tests — pure domain logic. No database, no Redis, no network.
 * Files: `src/**\/*.test.ts`
 *
 * Integration tests live in `*.itest.ts` and run against real Postgres/Redis/MinIO
 * from docker-compose via `vitest.integration.config.ts`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/.next/**'],
    globals: false,
    restoreMocks: true,
    clearMocks: true,
    setupFiles: ['./src/test/setup-unit.ts'],
    reporters: ['default'],
  },
})
