/**
 * Node loader hooks that let plain `node --test` run this project's TypeScript tests
 * with no dependencies installed.
 *
 * Three gaps to bridge between the project's bundler-oriented module resolution and
 * Node's:
 *
 * 1. Extensionless relative specifiers (`'../../../lib/money'`) — Node wants the real
 *    filename, so we append `.ts` / `/index.ts` / `.tsx`.
 * 2. The `@/*` path alias from `tsconfig.json`, which Node knows nothing about.
 * 3. The bare specifier `'vitest'`, which is not installed; it maps to the sibling
 *    `vitest.mjs` shim.
 *
 * Type *stripping* itself needs no help: Node 22.6+ executes `.ts` directly. Note that
 * stripping is not checking — this runs the code, it does not typecheck it.
 *
 * Usage:
 *   node --import ./scripts/node-test-shim/register.mjs --test 'src/**\/*.test.ts'
 */

import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolvePath(here, '..', '..')
const srcRoot = resolvePath(repoRoot, 'src')
const shim = pathToFileURL(resolvePath(here, 'vitest.mjs')).href

/** The candidate filenames a bundler would have tried, in the same order. */
const CANDIDATE_SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx', '.mts', '.js']

function firstExisting(basePath) {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = `${basePath}${suffix}`
    if (existsSync(candidate)) return pathToFileURL(candidate).href
  }
  return null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vitest') return { url: shim, shortCircuit: true }

    // `@/foo/bar` → `<repo>/src/foo/bar`, matching tsconfig `paths`.
    if (specifier.startsWith('@/')) {
      const url = firstExisting(resolvePath(srcRoot, specifier.slice(2)))
      if (url) return { url, shortCircuit: true }
    }

    // Let Node try first; only rescue specifiers it genuinely cannot place. This keeps
    // node: builtins and any real package on their normal path.
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw error
      const parent = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : repoRoot
      const url = firstExisting(resolvePath(parent, specifier))
      if (!url) throw error
      return { url, shortCircuit: true }
    }
  },
})
