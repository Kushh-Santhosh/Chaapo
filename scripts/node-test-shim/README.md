# `node:test` shim

Runs the project's real `*.test.ts` files under plain `node --test`, with **zero
dependencies installed**.

```bash
npm run test:nodeps -- src/server/domains/pricing/engine.test.ts
```

## Why

`npm install` needs the npm registry. In sandboxed environments where the registry is
unreachable, `vitest` cannot be installed and the suite cannot run at all — which is the
worst possible time to have no feedback. This shim closes that gap using only what ships
with Node.

`vitest` remains the real test runner. `npm test` is unchanged, CI is unchanged, and no
file under `src/` knows this directory exists.

## How

- `register.mjs` installs `module.registerHooks` resolvers for the three things Node
  cannot resolve on its own: extensionless relative specifiers, the `@/*` tsconfig
  alias, and the bare specifier `vitest` (mapped to `vitest.mjs`).
- `vitest.mjs` implements `describe` / `it` / `expect` and the matchers the suite
  actually uses, on top of `node:test` and `node:assert/strict`.
- TypeScript needs no transform: Node 22.6+ executes `.ts` by stripping types.

## What it cannot do

Read this list before trusting a green run.

- **No typechecking.** Type stripping erases annotations without verifying them. Only
  `npm run typecheck` does that.
- **No mocking, timers, snapshots or coverage.** There is no `vi`. A test needing any of
  them fails here and must be run under real vitest.
- **No third-party imports.** A test whose module graph reaches `zod`, `drizzle-orm`,
  `date-fns-tz` or any other package fails with `ERR_MODULE_NOT_FOUND` — the package
  genuinely is not on disk. Pure domain and `src/lib` tests are unaffected.
- **No TypeScript syntax that needs code generation.** Constructor parameter properties
  (`constructor(private x: T) {}`), `enum` and namespaces are rejected by strip-only
  mode.

A failure from this runner is worth investigating; a pass is weaker evidence than a
vitest pass. It is a smoke test for logic, not a substitute for `npm run verify`.
