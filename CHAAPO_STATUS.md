# CHAAPO — Status

Last updated: 2026-09-01. Every number here was produced by running the command named, in
this repository, on this machine. Nothing is inferred from file existence.

## Verified baseline (all four gates pass)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | **exit 0**, 0 errors |
| Lint | `npm run lint` | **exit 0**, 0 errors, 0 warnings |
| Unit tests | `npm test` | **exit 0** — 22 files, **684 tests, 684 passed** |
| Build | `CHAAPO_OFFLINE_FONTS=1 npm run build` | **exit 0**, 4 routes emitted |

Integration tests (`npm run test:integration`) have **never been run** — they need Postgres,
which is not verified in this environment. See Blocked.

## Size

22,534 production lines · 8,021 test lines · 5,486 lines of SQL migrations. Line count is
not progress; it is here only to make the next number honest.

## What actually works end to end

Four routes exist and build: `/`, `/shops/[id]`, `/offline`, `/_not-found`. A visitor can
browse a shop list and open a shop profile, served from dev fixtures. That is the whole
reachable product today.

**MVP completion: ~25% of the domain layer, ~5% of the user journey.** The customer cannot
yet upload a file, configure a job, see a price, place an order or pay.

## Completed

- **Core primitives** — money (integer paise, bigint), `Result`/`AppError`, logger with
  PII redaction, rate limiting, RBAC capability matrix, audit log writer, platform config
  store, crypto (AES-256-GCM envelopes, blind indexes, scrypt, HMAC), ids, phone, time.
  All unit-tested.
- **Database schema** — 11 hand-written migrations, 68 tables, 68 matching drizzle tables,
  reference data seeded in migration 0011. Schema parity test exists but is integration-only.
- **Auth primitives** — password policy, OTP, TOTP, signed tokens, session/refresh repo.
  Tested. **Not reachable from any route** — there is no HTTP layer yet.
- **Pricing domain** — engine, model, repo, dev fixtures, source seam. 85 tests.
- **Discovery domain** — service, repo, dev fixtures. Consumed by `/` and `/shops/[id]`.
  **No tests.**
- **Files domain** — model, limits, byte-level inspection, store contract, dev store,
  drizzle repo, service (`beginUpload` / `completeUpload` / `listDraft` / `removeFile`),
  `fileFacts` port for pricing. 43 tests. **No UI and no route reaches it yet.**
- **Storage provider seam** — `StoragePort` plus a development disk store that mints
  signed, expiring, size-capped, single-key upload credentials the way S3 does.
- **Design system** — tokens and ~UI primitives in `src/components/ui`, shell components.

## In progress

- **PHASE 2 — files/upload.** Domain and storage are done and tested. Remaining: the local
  storage route handler, draft identity, `/order/new`, and the client upload island.

## Blocked / unverified

- **Postgres is not verified.** `docker-compose.yml` exists; the database has never been
  migrated or queried here. Every `source.ts` seam therefore runs on dev fixtures. No claim
  of "database verified" can be made yet.
- **Google Fonts is unreachable from this sandbox.** `next/font/google` fetches at build
  time, which failed the build outright. Fixed by `CHAAPO_OFFLINE_FONTS=1`, which aliases
  `src/app/fonts.ts` to `src/app/fonts.offline.ts` (system stacks, same CSS variables).
  Production builds must **not** set the flag. Fonts render as `system-ui` in this
  environment, so any visual check here is not a check of the real typography.
- **No S3 adapter.** `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` *are*
  installed, so one can now be written; there is no bucket to test it against.
  `getStorage()` throws `not_implemented` outside development rather than pretending.
- **`pdf-lib` is installed** but `files/inspect.ts` still uses a byte scan. The scan is
  honest about not knowing (`pageCountReliable: false`), which routes to quote-required, but
  pdf-lib would make many of those counts exact.

## Fixed in this pass (PHASE 1)

Thirteen typecheck errors, all real:

- `auth/repo.ts` called an undefined `at()` inside a raw SQL fragment — it meant
  `asTimestamp()`. This would have thrown at runtime on every wrong-OTP attempt.
- `core/audit.ts` and `core/config-store.ts` both inserted rows without `id`, and neither
  `audit_logs.id` nor `platform_config_history.id` has a database default (migration 0009).
  **Every audit write would have failed at runtime** — the audit trail did not work.
- `auth/tokens.ts` validated attacker-controlled JSON through `Partial<SignedPayload>`,
  which made the empty-purpose check dead code.
- `components/ui/card.tsx` spread div props onto `<li>`; `card.tsx`, `field.tsx` and
  `states.tsx` each redeclared a native attribute (`title`, `prefix`) as `ReactNode`.
- `rbac.test.ts`, `password.test.ts`, `schema-parity.itest.ts` — type-level test defects.

Two more found by actually running the build:

- **ESLint could not run at all.** `consistent-type-imports` needs type information and
  `next/core-web-vitals` installs a parser that does not forward `projectService`, so
  `eslint .` crashed on its own config file. Now scoped to TypeScript with the correct parser.
- **`Button asChild` was broken.** Radix `Slot` was handed two children (label wrapper +
  spinner slot), so it threw "Slot failed to slot onto its children" and **failed the
  prerender of `/_not-found`**. Every `asChild` button in the app was affected — six call
  sites, including the only link into the order flow.
