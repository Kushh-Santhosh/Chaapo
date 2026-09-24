# CHAAPO — Handoff

Chaapo is an India-first marketplace for local print shops: send the print job before you
reach the shop, skip the queue. This file is how to run the repository and the handful of
conventions you cannot infer from a single file. `CHAAPO_STATUS.md` is what is true today;
`CHAAPO_TODO.md` is what is next. The PRD is the source of truth for behaviour.

## Running it

```bash
npm install
CHAAPO_OFFLINE_FONTS=1 npm run dev     # drop the flag if fonts.googleapis.com is reachable
```

No database is required to start. Discovery, pricing and files each detect an absent
`DATABASE_URL` and fall back to a development implementation — see "Source seams".

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # eslint .
npm test                 # vitest run
npm run build            # needs CHAAPO_OFFLINE_FONTS=1 without network egress
npm run verify           # all four
npm run test:integration # needs Postgres; never yet run here
```

With Postgres:

```bash
docker compose up -d
npm run db:migrate       # hand-written SQL in db/migrations, 0001 … 0011
npm run db:status
```

## Shape

One Next.js deployable serves the customer PWA, the shop dashboard, the admin console and
`/api/v1`. One worker process shares the same domain code. That is the whole topology; there
are no services.

```
src/lib/          framework-free helpers (money, ids, phone, time, cn)
src/components/   design system + surface components
src/app/          routes, grouped by surface: (customer), later (shop), (admin)
src/server/
  core/           result, errors, logger, rbac, audit, rate-limit, crypto, config-store
  auth/           password, otp, totp, tokens, sessions, repo
  db/             schema (drizzle, mirrors db/migrations), client, columns
  domains/        discovery, pricing, files — one folder per bounded piece
  providers/      storage (and later payments, notifications, maps)
  http/           the only place allowed to know about Next.js — does not exist yet
db/migrations/    hand-written SQL. The schema source of truth.
```

## Conventions that will bite you

**The domain layer must not import Next.js or React.** `eslint.config.mjs` enforces this on
`src/server/domains/**`, `src/server/core/**` and `src/server/providers/**` — the worker
imports these modules and must not drag a framework in. `src/server/http/**` is deliberately
exempt: that is where cookies and `NextRequest` live.

**Relative imports inside `src/server`, `@/` only in `src/app` and `src/components`.** The
worker runs without the path alias.

**Money is integer paise as `bigint`**, never a float and never rupees. It crosses the
RSC→client and JSON boundaries as a decimal string of paise. Percentages are basis points.
See `src/lib/money.ts`.

**`Result<T, AppError>` for anything a user can cause; `throw` for anything only a
programmer or the infrastructure can cause.** `errors.validation` takes `FieldError[]`, not
a string.

**Source seams.** `discovery/source.ts`, `pricing/source.ts` and `files/source.ts` are the
same twelve lines: use the database when `DATABASE_URL` is set, use a development
implementation when the environment is development or test, and *throw* otherwise. A
production-like process can never silently serve invented data. `service.ts` imports `repo.ts`
lazily so the development path never loads drizzle or `pg`.

**Files never pass through the application.** The browser PUTs bytes straight to storage with
a short-lived credential; the server holds keys only. There is no `url` column on `files` and
there must never be one. `completeUpload` asks storage what actually arrived and never
believes the client. The customer's filename is encrypted at rest; every file is exposed to
the UI as "File 3.pdf".

**Ownership is a query parameter, not a check.** Every `FileStore` method takes
`ownerUserId`, so a lookup that forgets whose file it is does not compile.

**Reference data lives in migration 0011,** including `paper_sizes.code`, which is
uppercase (`A4`, `A3`, `LEGAL`, …) and is a foreign key from `files.dominant_page_size`.

## Environment limitations on this machine

- `fonts.googleapis.com` is unreachable. `CHAAPO_OFFLINE_FONTS=1` aliases `src/app/fonts.ts`
  to `src/app/fonts.offline.ts`, which defines the same CSS variables as system stacks.
  **Never set this flag in production** — it silently downgrades the typography.
- Postgres has not been verified. Nothing may claim it has.
- No S3 bucket exists, so `getStorage()` throws `not_implemented` outside development
  rather than shipping an untested production path.
- `timeout(1)` is not installed; `$TMPDIR` is the only writable scratch directory.
- Not a git repository, so there is no history to read.
