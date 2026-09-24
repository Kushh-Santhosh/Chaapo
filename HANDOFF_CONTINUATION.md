# Chaapo — Handoff / Implementation Continuation Document

**Generated:** 2026-09-01 (Asia/Kolkata)
**Audience:** the next coding agent (GitHub Copilot in VS Code) and the human driving it
**Method:** read-only forensic audit of the working tree at `/Users/kushal/Desktop/chaapo`. The
filesystem is the source of truth. Where `IMPLEMENTATION_PLAN.md`, `CHAAPO_STATUS.md` or
`CHAAPO_TODO.md` disagree with the code, **the code wins and the document is flagged as wrong.**
**Nothing in the repository was modified to produce this report.** No migrations were run, no
dependencies installed, no builds executed, no bugs fixed.

---

## READ THIS FIRST — the three facts that matter most

1. **The app compiles, lints and passes 684 unit tests — and has zero working screens.**
   Verified by execution today: `tsc --noEmit` exit 0, `eslint .` exit 0 (no output),
   `vitest run` exit 0 with 22 files / 684 tests / 684 passed. Also verified by execution
   today: **all three customer content routes render the error boundary in a real browser.**
   Not one of the 684 tests renders a React component, so none of them could catch this.

2. **Two root causes, both one-line-class bugs, account for all three broken routes.**
   An RSC boundary violation (`describeAvailability` exported from a `'use client'` module and
   called from server components) breaks `/` and `/shops/[id]`. A storage-seam
   mis-selection (S3 credentials present in `.env.local`, no S3 adapter in the repo) breaks
   `/order/new`. **Both are left unfixed by instruction.** Details in §4 and §11.

3. **`IMPLEMENTATION_PLAN.md` (52 KB, 660 lines, dated 2026-08-26 20:04) is fiction.**
   It is written in the past tense and asserts a complete MVP: 13 domains, `/api/v1/**`,
   a 30-transition order state machine, payment providers, an SSE hub, a worker, seed data.
   **None of it exists on disk.** Do not use it as a status report. It is usable only as a
   design sketch of intent. `CHAAPO_STATUS.md` and `CHAAPO_HANDOFF.md` are broadly accurate;
   `CHAAPO_TODO.md` is stale in the opposite direction (it lists work as pending that is done).

---

## Table of contents

1. [Current project state](#1-current-project-state)
2. [Exactly what has been implemented](#2-exactly-what-has-been-implemented)
3. [What the current product can actually do](#3-what-the-current-product-can-actually-do)
4. [Current stopping point](#4-current-stopping-point)
5. [PRD / requirements audit](#5-prd--requirements-audit)
6. [Screen / route audit](#6-screen--route-audit)
7. [Backend domain audit](#7-backend-domain-audit)
8. [Database audit](#8-database-audit)
9. [API audit](#9-api-audit)
10. [Test audit](#10-test-audit)
11. [Code quality / technical debt](#11-code-quality--technical-debt)
12. [Implementation status](#12-implementation-status)
13. [What is left to build](#13-what-is-left-to-build)
14. [START HERE IN VS CODE](#14-start-here-in-vs-code)
15. [Final handoff](#15-final-handoff)

---

# 1. CURRENT PROJECT STATE

## 1.1 Identity

| Field | Value |
|---|---|
| Product | **Chaapo** — India-first marketplace for local print shops |
| Pitch | "Send your print job before you reach the shop. Skip the queue." |
| Repo path | `/Users/kushal/Desktop/chaapo` |
| Version control | **None.** There is no `.git` directory. No history, no diff, no branches. |
| Package name / version | `chaapo` / `0.1.0`, `private: true` |
| Node requirement | `>=20.11.0` (`engines` in `package.json`) |
| Framework | **Next.js 15.2+** App Router, React 19, React Server Components |
| Language | **TypeScript 5.7**, `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes: false`, `incremental: true` |
| Package manager | **npm** (`package-lock.json`, 431 KB, lockfileVersion present; no pnpm/yarn/bun lockfile) |
| Styling | **Tailwind CSS v4** (CSS-first: `@theme` / `@utility` in `src/app/globals.css`, 447 lines) via `@tailwindcss/postcss` |
| UI primitives | Radix UI (16 packages declared, **1 actually imported**), `lucide-react` icons |
| Database | **PostgreSQL 16 + PostGIS 3.4** (per `docker-compose.yml`) — *not running on this machine* |
| ORM | **Drizzle ORM 0.39** for reads/writes; **hand-written SQL migrations** are the schema source of truth (drizzle-kit is present but not used to generate) |
| Driver | `pg` 8.13 with a pool |
| Cache / queue / pubsub | Redis via `ioredis`; **BullMQ declared but never imported** |
| Object storage | S3-compatible, private buckets, `@aws-sdk/client-s3` + `s3-request-presigner` **declared but never imported** |
| Validation | `zod` 3.24 (used in `src/server/config/env.ts` only) |
| Testing | **Vitest 3.0** — `vitest.config.ts` (unit, `*.test.ts(x)`) and `vitest.integration.config.ts` (`*.itest.ts`) |
| Test count today | 22 unit files / **684 tests, all passing**; 2 integration files, **never executed** (no Postgres) |

## 1.2 Architecture in one paragraph, for a new agent

Chaapo is a **modular monolith**: a single Next.js deployable serves three surfaces (customer
mobile-first PWA, shop-owner desktop dashboard, super-admin console) plus a versioned HTTP API
at `/api/v1`, and a separate worker process shares the same domain code. Business logic lives
in `src/server/domains/<domain>/` as pure-ish modules split into `model.ts` (types),
`service.ts` (logic, returns `Result`), `repo.ts` (SQL via Drizzle), `source.ts` (a seam that
picks database vs development implementation), and `fixtures.ts` (the development data).
Cross-cutting machinery lives in `src/server/core/` (errors, result, logger, audit, rbac,
rate-limit, crypto, pii, config-store) and `src/server/auth/`. External systems are reached only
through **ports** in `src/server/providers/<capability>/port.ts`. Next-aware glue (cookies,
headers, request plumbing) is confined to `src/server/http/`. The `src/app/` tree renders and
must not contain business rules. **Two of the three surfaces (`shop`, `admin`) and eleven of the
thirteen planned domains do not exist yet.**

## 1.3 Layering rules that are mechanically enforced

`eslint.config.mjs` uses `no-restricted-imports` to ban, inside
`src/server/domains/**`, `src/server/core/**` and `src/server/providers/**`:
`next`, `next/headers`, `next/navigation`, `next/server`, `next/*`, `react`, `server-only`,
`@/app/*`, `@/components/*`.

- **`src/server/http/**` is deliberately exempt.** It is the sanctioned home for Next-aware code.
  Today it contains exactly one file (`draft-identity.ts`).
- **Import convention:** inside `src/server` use **relative** imports; the `@/*` alias is only for
  `src/app` and `src/components`, because the worker will run without the alias resolver.
- Typed linting requires the rules block to name `tseslint.parser` with `projectService: true`,
  scoped to `['**/*.ts','**/*.tsx','**/*.mts']`, or ESLint crashes while type-checking its own
  config. Do not "simplify" that block.

## 1.4 Non-negotiable conventions already baked into the code

Break any of these and the codebase becomes inconsistent with 38k lines of existing work.

1. **Money is integer paise held as `bigint`** (`src/lib/money.ts`, 295 lines). Percentages are
   **basis points** (`Bps`). Money crosses RSC→client and JSON as a **decimal string of paise**
   (`serializePaise` / `parsePaise`). Never use `number` for money. Never use floats.
2. **`Result<T, AppError>`** (`src/server/core/result.ts`) for anything a *user* can cause;
   `throw` only for programmer or infrastructure faults. `errors.validation` takes
   **`FieldError[]`, not a string**. `errors.notImplemented(what)` renders
   `` `${what} is not available yet.` ``
3. **Source seams.** `discovery/source.ts`, `pricing/source.ts`, `files/source.ts` each choose:
   database when `DATABASE_URL` is set → a development implementation when `APP_ENV` is
   `development`/`test` → otherwise **throw** a named error (`MissingDatabaseError`,
   `MissingCatalogueError`, `MissingFileStoreError`). `service.ts` imports `repo.ts` **lazily**
   (dynamic `import()`) so the development path never loads Drizzle or `pg`.
4. **Files never pass through the application.** The browser PUTs bytes straight to storage using
   a short-lived credential. There is **no `url` column on `files` and there must never be one.**
   `completeUpload` asks storage what actually arrived and never believes the client.
5. **Ownership is a query parameter, not a check.** Every `FileStore` method takes
   `ownerUserId`, so a wrong owner returns nothing rather than being rejected after the fact.
6. **Tokens are not JWTs** (`src/server/auth/tokens.ts`). Two shapes: composite `<id>.<secret>`
   for row-backed credentials (sessions, refresh), and signed `<payload>.<signature>` for
   row-less ones. `SignedTokenPurpose` = `'mfa' | 'csrf' | 'email_verify' | 'password_reset' |
   'privacy_export' | 'unsubscribe' | 'draft_owner'`. **The signature is verified before the
   payload is read.**
7. **Audit rows must supply their own `id`.** Neither `audit_logs.id` nor
   `platform_config_history.id` has a database default (migration 0009) — the application calls
   `newId()`. This was a real bug once (see `CHAAPO_STATUS.md`): every audit write failed at
   runtime until it was fixed.
8. **Business settings are not environment variables.** Commission %, refund windows, SLA
   minutes, retention days, page/size caps and pricing bands live in the `platform_config`
   table, edited by Super Admin, and every change is audited
   (`src/server/core/config-store.ts`, 891 lines).

## 1.5 Folder structure (actual, as of today)

```
chaapo/
├── db/migrations/            0001…0011, hand-written SQL, 5,493 lines — SCHEMA SOURCE OF TRUTH
├── docker-compose.yml        postgres+postgis, redis, minio, mailpit, clamav (NOT RUNNING HERE)
├── infra/                    one subdirectory (compose support files)
├── public/                   manifest.webmanifest, sw.js (87 lines), brand/ (5 icons)
├── scripts/
│   ├── _bootstrap.ts         env loading for CLI scripts
│   ├── migrate.ts            db:migrate / db:status / db:reset entry point
│   ├── gen-icons.mjs
│   └── node-test-shim/       register.mjs + vitest.mjs — a node:test shim, see §10
├── src/
│   ├── middleware.ts         86 lines — per-request CSP with nonce
│   ├── app/                  11 route/render files + globals.css + 2 font modules
│   ├── components/           discovery(7) pwa(1) shell(3) ui(7)
│   ├── lib/                  brand cn digits ids money order-status phone public-config time
│   ├── server/
│   │   ├── auth/             otp password policy repo(1204) tokens totp
│   │   ├── config/           env(252) index(234)
│   │   ├── core/             audit config-store crypto errors logger pii rate-limit rbac redis result
│   │   ├── db/               client migrator columns + schema/×14
│   │   ├── domains/          discovery/  files/  pricing/     ← THREE domains only
│   │   ├── http/             draft-identity.ts                ← ONE file only
│   │   └── providers/        storage/{index,local,port}       ← ONE provider only
│   └── test/                 db, env-integration, setup-integration, setup-unit
├── IMPLEMENTATION_PLAN.md    660 lines — INACCURATE, see §11.7
├── CHAAPO_STATUS.md          97 lines  — broadly accurate
├── CHAAPO_TODO.md            73 lines  — stale checkboxes, accurate 404 list
└── CHAAPO_HANDOFF.md         100 lines — accurate run instructions
```

**Totals:** 148 source files (`.ts/.tsx/.css/.sql/.mjs` under `src`, `db`, `scripts`),
**38,122 lines**, of which `src` alone is 132 files / ~31,842 lines and migrations are 5,493.

## 1.6 npm scripts (all of them, and which ones actually work here)

| Script | Command | Works on this machine? |
|---|---|---|
| `dev` | `next dev` | Yes, but Google Fonts are blocked → use `dev:offline` |
| `dev:offline` | `CHAAPO_OFFLINE_FONTS=1 next dev` | **Yes** |
| `dev:sandbox` | `CHAAPO_OFFLINE_FONTS=1 APP_URL=…:3100 NEXT_PUBLIC_APP_URL=…:3100 next dev --port 3100` | **Yes — this is what was used** |
| `build` | `next build` | **Not executed during this audit** (would write `.next/`) |
| `start` | `next start` | Untested |
| `typecheck` | `tsc --noEmit` | **Yes — exit 0** |
| `lint` | `eslint .` | **Yes — exit 0, no output** |
| `test` | `vitest run` | **Yes — 684/684 pass** |
| `test:watch` | `vitest` | — |
| `test:integration` | `vitest run --config vitest.integration.config.ts` | **No — needs Postgres** |
| `test:nodeps` | `node --import ./scripts/node-test-shim/register.mjs --test` | Untested |
| `db:migrate` / `db:status` / `db:reset` | `tsx scripts/migrate.ts [--status\|--reset]` | **No — no Postgres, and `npx tsx` fails with `EPERM` in this sandbox** |
| `gen:icons` | `node scripts/gen-icons.mjs` | Untested (would write to `public/`) |
| `infra:up` / `infra:down` | `docker compose up -d` / `down` | **No — Docker is not installed here** |
| `verify` | `typecheck && lint && test && build` | Partially (build not run) |

## 1.7 Environment and configuration

`src/server/config/env.ts` (252 lines) validates the entire environment with zod and is designed
to refuse to boot on bad config. `src/server/config/index.ts` (234 lines) shapes it into a typed
`Config` object exposed by `getConfig()`.

**Two configuration contradictions exist today. Both are documented, neither is fixed.**

**(a) `DATABASE_URL` is required by the schema but commented out in `.env.local`.**
```ts
DATABASE_URL: nonEmpty.refine(
  (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), …)
```
There is no `.optional()` and no `.default()`. So `loadEnv()` throws with the current
`.env.local`, where `DATABASE_URL` is commented out (deliberately — see the 5-line comment at
`.env.local:22-27` — so the source seams choose their development implementations).
*Established by schema inspection, not by execution:* the attempt to prove it by running
`npx tsx` failed with `Error: listen EPERM … tsx-501/68215.pipe` in this sandbox.
**Why the app boots anyway:** `getConfig()` is reached from only four places —
`core/pii.ts:40`, `core/redis.ts:52`, `core/redis.ts:76`, `db/client.ts:67`, `db/client.ts:107` —
and none of them is on the reachable render path. The first feature that needs PII encryption,
Redis or the database will hit this.

**(b) There is no environment in which both `getConfig()` and `getStorage()` succeed.**
- `env.ts` has a `.superRefine` that **fails when `STORAGE_PROVIDER === 's3'` and either S3 key is
  missing.** `STORAGE_PROVIDER=s3` is what `.env.local` sets.
- `providers/storage/index.ts` returns `'s3'` **whenever both S3 keys are present**, and
  `getStorage()` then **throws**, because no S3 adapter exists in the repo.
- So: keep the keys → `getStorage()` throws. Remove the keys → `env.ts` rejects
  `STORAGE_PROVIDER=s3`. Set `STORAGE_PROVIDER` to anything else → `storageSource()` ignores
  `STORAGE_PROVIDER` entirely and still returns `'local-dev-disk'` only if the keys are absent.
  The two modules disagree about what selects storage. **This is the `/order/new` bug** (§4.2).

**Environment facts verified on this machine (all by execution):**

| Fact | Evidence |
|---|---|
| `fonts.googleapis.com` blocked | fetch fails; hence `CHAAPO_OFFLINE_FONTS=1` |
| **PostgreSQL absent** | nothing listening on 5432 |
| **Docker unavailable** | `docker` not installed → `infra:up` impossible |
| Redis absent | nothing on 6379 (untested code path) |
| `npx tsx` fails | `EPERM` creating its IPC pipe under the sandbox |
| `timeout(1)` absent, `ps` blocked | shell limitations |
| localhost HTTP egress from shell blocked | `curl localhost:3100` → `000`; worked around by running `fetch` **inside the browser page** |
| `$TMPDIR` is the only writable scratch dir | all audit scratch files went there |
| Not a git repository | no `.git` |
| All 406 declared packages installed | `node_modules` present and complete |

## 1.8 Entry points

| Entry point | File | Notes |
|---|---|---|
| Root layout | `src/app/layout.tsx` (66) | fonts, `<html data-fonts>`, viewport, service-worker registration |
| Customer layout | `src/app/(customer)/layout.tsx` (80) | top nav + persistent tab bar |
| Middleware | `src/middleware.ts` (86) | per-request CSP nonce, echoed on `x-chaapo-nonce`, `'strict-dynamic'`, dev `'unsafe-eval'`, `connect-src 'self' https:` (+ dev `ws:` / `http://localhost:*`), `frame-src` allows Razorpay |
| Migration CLI | `scripts/migrate.ts` → `src/server/db/migrator.ts` (536) | never run here |
| Worker | **does not exist** (`scripts/worker.ts` is absent despite being described in `IMPLEMENTATION_PLAN.md`) |
| Service worker | `public/sw.js` (87) | registered by `src/components/pwa/register-service-worker.tsx` |

---

# 2. EXACTLY WHAT HAS BEEN IMPLEMENTED

**Status legend, used consistently in this document:**

| Tag | Meaning |
|---|---|
| **WRITTEN** | The code exists and type-checks. Nothing calls it, or its caller is unreachable. |
| **CONNECTED** | Something reachable calls it, but the path has never been observed to work. |
| **WORKING** | Observed to work end-to-end by execution (browser render or a passing test that exercises it). |
| **BROKEN** | Reachable and observed to fail. |

**Per the instruction, merely-written code is not counted as functionality.** Very little here is
`WORKING`, and that is the honest reading, not pessimism: 38k lines exist, 684 unit tests pass,
and no customer screen renders.

## A. Frontend / UI

| Item | Path | What it does | Connected? | Tested? | Prod-ready? | Status |
|---|---|---|---|---|---|---|
| Design tokens & utilities | `src/app/globals.css` (447) | Tailwind v4 `@theme`/`@utility`: paper/ink/chaap palette, glass/clay/bento surface utilities, `animate-spin-slow`, `html.fonts-offline` system stacks | Yes | No | Likely | **WORKING** (styles apply on `/offline`) |
| Fonts | `src/app/fonts.ts` (49), `fonts.offline.ts` (23) | Instrument Serif + Inter + IBM Plex Mono; `CHAAPO_OFFLINE_FONTS=1` swaps modules via a webpack alias in `next.config.ts`; `fontsAreReal` → `data-fonts` on `<html>` | Yes | No | **Never set `CHAAPO_OFFLINE_FONTS` in production** | **WORKING** |
| Button | `src/components/ui/button.tsx` (166) | `Button` + `IconButton`, variants, sizes, `loading`, `block`, `asChild` via Radix Slot (the only Radix package actually imported) | Yes | No | Likely | **CONNECTED** |
| Card / Bento | `card.tsx` (175) | `Card` (`plain`/`sunk`/`outline`), `CardHeader/Body/Footer`, `BentoCell`, `BentoGrid` | Yes | No | Likely | **CONNECTED** |
| Form field kit | `field.tsx` (356) | `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `OptionCard`, `Segmented`, `SegmentedItem` | **No — no form exists yet** | No | Unknown | **WRITTEN** |
| Badges | `badge.tsx` (123) | `Badge`, `CountBadge`, `Stamp` | Yes | No | Likely | **CONNECTED** |
| Money display | `money.tsx` (165) | `Money`, `AmountRow`, `FromPrice` — renders paise strings | Partly | No | Likely | **CONNECTED** |
| Skeletons | `skeleton.tsx` (134) | 9 skeletons incl. `ShopListSkeleton`, `OrderListSkeleton`, `TableSkeleton`, `BentoSkeleton` | Partly (loading.tsx) | No | Likely | **CONNECTED** |
| States | `states.tsx` (232) | `EmptyState`, `ErrorState`, `LoadingState`, `Notice` | Yes | No | Likely | **WORKING** (the error boundary you see today is `ErrorState`) |
| Sticky action bar | `shell/sticky-action-bar.tsx` (57) | `StickyActionBar` + `StickyActionBarSpacer` | Yes | No | Likely | **CONNECTED** |
| Logo | `shell/logo.tsx` (46) | wordmark | Yes | No | Yes | **WORKING** |
| Tab bar / top nav | `shell/customer-tab-bar.tsx` (122) `[CLIENT]` | 4 persistent tabs | Yes | No | **No — 3 of 4 destinations are 404s** | **BROKEN (navigation)** |
| Error boundary | `(customer)/error.tsx` (38) `[CLIENT]` | catches render throws, shows reference digest | Yes | No | Yes | **WORKING — and it is what every customer route shows** |
| Loading UI | `(customer)/loading.tsx` (33), `shops/[id]/loading.tsx` (42) | route-level skeletons | Yes | No | Yes | **WORKING** |
| 404 page | `src/app/not-found.tsx` (43) | branded not-found | Yes | No | Yes | **WORKING** (verified: `/nope` → 404) |

**Tab bar detail** — `customer-tab-bar.tsx:31-34`:
```ts
{ href: '/',        label: 'Shops',   icon: Store,      owns: ['/shops', '/order'] },
{ href: '/map',     label: 'Map',     icon: Map },      // 404
{ href: '/orders',  label: 'Orders',  icon: Receipt },  // 404
{ href: '/account', label: 'Account', icon: CircleUser },// 404
```

## B. Customer flows

| Flow | Path | Status | Reality |
|---|---|---|---|
| Discovery / home | `src/app/(customer)/page.tsx` (258) | **BROKEN** | Renders the error boundary, digest **2044459844**. See §4.1. |
| Discovery controls (search/sort/filter) | `components/discovery/discovery-controls.tsx` (274) `[CLIENT]` | **WRITTEN** | Never rendered, because its parent page throws first. |
| Shop profile | `(customer)/shops/[id]/page.tsx` (468) | **BROKEN** | Error boundary, digest **2791453749**. See §4.1. Consequence: **the only link into the order flow is never rendered.** |
| Add files (C-07) | `(customer)/order/new/page.tsx` (145) + `upload-panel.tsx` (549) + `actions.ts` (170) | **BROKEN** | Error boundary, digest **139087369**. See §4.2. |
| Choose print options (C-08) | — | **MISSING** | The "Choose print options" button in `upload-panel.tsx:334` is **deliberately `disabled`** with the comment "C-08 does not exist yet, and a button that navigates to a 404 would be worse". |
| Checkout / payment | — | **MISSING** | No route, no domain, no provider. |
| Order tracking | — | **MISSING** | `/orders` is a 404. |
| Pickup / QR | — | **MISSING** | `pickup_verifications` table exists; no code. |
| Account | — | **MISSING** | `/account` is a 404. |
| Map | — | **MISSING** | `/map` is a 404. |
| Offline page | `src/app/offline/page.tsx` (43) | **WORKING** | Verified: HTTP 200 with correct content. **The only content route in the app that renders.** |

## C. Shop flows

**Nothing exists.** Verified by `find`: there is no `src/app/shop/`, no `src/app/(shop)/`, no
`src/server/domains/shops/`. The database has the tables (`shops`, `shop_hours`, `shop_closures`,
`shop_staff`, `staff_invites`, `shop_capabilities`, `shop_kyc`, `shop_bank_accounts`,
`shop_verification_events`, `shop_service_items`, `shop_price_modifiers`,
`shop_price_history`, `shop_finishing_compatibility`, `shop_balances`, `shop_daily_stats`) and the
Drizzle schema mirrors them, but **no shop-owner UI, service, repo or API exists.**
`/shop/onboarding` is listed as a known 404 in `CHAAPO_TODO.md`.

## D. Admin flows

**Nothing exists.** No `src/app/admin/`, no `src/server/domains/admin/`. What *does* exist and was
built for admin use:
- `src/server/core/rbac.ts` (952) — the full capability catalogue including admin roles.
- `src/server/core/audit.ts` (651) — the audit action catalogue.
- `src/server/core/config-store.ts` (891) — `platform_config` read/write with history and
  feature flags, i.e. the engine behind a Super Admin settings screen that has no UI.
All three are **WRITTEN**, unit-tested, and called by nothing outside their own tests.

## E. Backend / core infrastructure

| Module | Path (lines) | What it does | Called by reachable code? | Tests | Status |
|---|---|---|---|---|---|
| Errors | `core/errors.ts` (278) | `AppError`, `errorCodes`, `errors.*` factories, `PublicError` shaping, `toAppError`, `describeError`. `errors.validation` takes `FieldError[]`. | **Yes** | 30 | **WORKING** |
| Result | `core/result.ts` (85) | `ok`/`err`/`isOk`/`isErr`/`unwrap`/`mapResult`/`allResults`/`attempt` | **Yes** | 24 | **WORKING** |
| Logger | `core/logger.ts` (274) | structured logging, `AsyncLocalStorage` context, `redact()` | Partly | 35 | **CONNECTED** |
| Audit | `core/audit.ts` (651) | `AUDIT_ACTIONS` catalogue, `buildAuditRow` (supplies `newId()`), `recordAudit`, `recordGrantedAction` | **No** | 29 | **WRITTEN** |
| RBAC | `core/rbac.ts` (952) | `CAPABILITIES` catalogue, `Surface`/`Access`/`Ownership`, `mayAttempt`, `requireCapability`, `capabilitiesForRole`, `MIN_REASON_LENGTH` for reason-required actions | **No** | 37 | **WRITTEN** |
| Rate limit | `core/rate-limit.ts` (496) | `RATE_LIMIT_RULES`, memory + Redis + noop limiters, `enforceRateLimit(s)` | **No** | 26 | **WRITTEN** |
| Crypto | `core/crypto.ts` (295) | AES-256-GCM envelope encryptor, scrypt password hashing, HMAC helpers, opaque tokens, masking helpers | Via `pii` | 27 | **WRITTEN** |
| PII | `core/pii.ts` (223) | `protectPhone`/`revealPhone`/`hashPhone`, email equivalents, `hashIp`, `userAgentFamily`. **Calls `getConfig()`** | **No** | 26 | **WRITTEN** — will hit the `DATABASE_URL` contradiction (§1.7a) the first time it is reached |
| Redis | `core/redis.ts` (133) | `getRedis`, health check, test injection. **Calls `getConfig()`** | **No** | — | **WRITTEN, untested, no Redis here** |
| Config store | `core/config-store.ts` (891) | `CONFIG_SPECS`, typed get/set with audit + history, 60 s TTL cache, feature flags with `rolloutBucket`/`evaluateFlag` | **No** | 42 unit + 31 integration (unrun) | **WRITTEN** |
| Env | `config/env.ts` (252) | zod validation + production guardrails (no `dev-only` secrets, `OTP_DEV_ECHO` false, https `APP_URL`, `S3_SSE ≠ none`, `MALWARE_SCANNER ≠ noop`, VAPID present, no `mock` payments) | **No** | — | **WRITTEN — and currently unsatisfiable, see §1.7** |
| Config shaping | `config/index.ts` (234) | `buildConfig`, `getConfig`, `__setConfigForTests` | **No** | — | **WRITTEN** |
| Draft identity | `http/draft-identity.ts` (97) | one signed http-only cookie `chaapo_draft`, TTL 36 h, purpose `'draft_owner'`; `readDraftOwnerId()` (nullable) and `requireDraftOwnerId()` (mints + sets). Explicitly **not** authentication. Reads `process.env.SESSION_SECRET` directly with a per-process random fallback, bypassing `getConfig()` on purpose | **Yes** | **No** | **CONNECTED** (never exercised — the page it serves throws first) |

## F. Authentication

Substantial, high-quality, **completely disconnected**. There is no login screen, no session
middleware, no `/api/v1/auth/*`, and no code outside tests calls any of it.

| Module | Path (lines) | Contents | Tests | Status |
|---|---|---|---|---|
| Auth repo | `auth/repo.ts` (**1204**) | 50+ functions: users, roles, sessions, OTP challenges, TOTP, login attempts. Includes `rotateSessionTokens`, `switchActiveShop`, `revokeSessionsForUser`, `consumeRecoveryCode`, `failuresSinceLastSuccess`, `deleteExpiredSessions` | **0** | **WRITTEN** |
| Tokens | `auth/tokens.ts` (316) | composite + signed tokens, `createTokenSigner`, `mintCsrfToken`/`verifyCsrfToken`, `MFA_TOKEN_TTL_SECONDS`, `CSRF_TOKEN_TTL_SECONDS` | 26 | **CONNECTED** (only via `draft-identity.ts`) |
| Session policy | `auth/policy.ts` (373) | per-surface `SESSION_POLICY`, sliding expiry, rotation, MFA freshness, cookie builders (`sessionCookie`, `refreshCookie`, `csrfCookie`, `clearedCookies`, `serialiseCookie`) | 36 | **WRITTEN** |
| OTP | `auth/otp.ts` (206) | code generation, HMAC hashing, `evaluateOtp` verdicts, resend limits (`MAX_RESENDS`), expiry | 27 | **WRITTEN** |
| Password | `auth/password.ts` (341) | `PASSWORD_POLICY`, `validatePassword` with context, strength scoring | 28 | **WRITTEN** |
| TOTP | `auth/totp.ts` (228) | base32, HOTP/TOTP, window verification, provisioning URI | 28 | **WRITTEN** |

**No OTP/SMS provider exists**, so even wired up, phone login could not deliver a code except via
`OTP_DEV_ECHO=true`.

## G. Database / schema / migrations

**The most complete part of the project — and entirely unverified against a real server.**

| Artefact | Measured value |
|---|---|
| Migration files | `db/migrations/0001…0011`, hand-written SQL, **5,493 lines** |
| `CREATE TABLE` | **68** |
| Drizzle `pgTable` | **68** (exact parity in count) |
| `CREATE TYPE` enums | **14** — matched by **14** `pgEnum` in `schema/enums.ts` |
| Indexes | **240** (`CREATE INDEX` / `CREATE UNIQUE INDEX`) |
| Triggers | **75** |
| Functions | **21** |
| `CHECK` constraints | **267** |
| `REFERENCES` (FKs) | **157** |
| Seed `INSERT` statements | **14** (all in `0011_reference_data.sql`) |
| PostGIS usage | `geography(Point, 4326)` ×5, `ST_SetSRID`, `ST_MakePoint`, `ST_DWithin`; 3 `CREATE EXTENSION` |

Per-migration table counts: `0001` extensions+types (0 tables), `0002` identity (9),
`0003` geography+shops (12), `0004` catalogue (8), `0005` files (4), `0006` orders (8),
`0007` money (9), `0008` notifications (4), `0009` trust/privacy/config (13),
`0010` immutability+guards (1), `0011` reference data (0).

**Applied?** **No.** Postgres is not running on this machine and Docker is not installed.
`npm run db:migrate` has never been executed. **The schema has never been parsed by PostgreSQL.**
The 5,493 lines of SQL are unverified: a syntax error, a bad trigger body or a wrong FK order
would not have been caught by anything done so far.

**Drizzle schema modules** (`src/server/db/schema/`, 14 files, ~3,000 lines):
`enums.ts` (207), `identity.ts` (226), `geo.ts` (42), `shops.ts` (398), `catalogue.ts` (254),
`files.ts` (229), `orders.ts` (483), `money.ts` (453), `notifications.ts` (174), `trust.ts` (212),
`config.ts` (194), `analytics.ts` (88), `index.ts` (31), plus `columns.ts` (74) with the shared
column helpers (`citext`, `geographyPoint`, `paise`, `bigintCount`, `tstz`, `id`, `timestamps`,
`createdAt`, `softDelete`).

**Database client** `db/client.ts` (364): pool, `getDb`, `withTransaction`, `withAdvisoryLock`,
`LOCK_NAMESPACE`, and error translation (`isUniqueViolation`, `isForeignKeyViolation`,
`isGuardViolation`, `translateDbError`). **WRITTEN, never connected to a server.**

**Migrator** `db/migrator.ts` (536): checksum drift detection (`MigrationDriftError`),
`loadMigrations`, `findDrift`, `migrate`, `migrationStatus`, `locateInSql` for error reporting.
**WRITTEN, never executed.**

Known schema facts to respect: `paper_sizes.code` is **UPPERCASE** and is an FK target from
`files.dominant_page_size`; `audit_logs.id` and `platform_config_history.id` have **no DB default**
(the app must pass `newId()`).

## H. Discovery

| Piece | Path (lines) | Status |
|---|---|---|
| Model | `domains/discovery/model.ts` (243) | `ShopSummary`, `ShopDetail`, `DiscoveryQuery/Result/Filters/Origin`, `DEFAULT_RADIUS_METRES`, `MAX_RADIUS_METRES`, `MIN_RATINGS_TO_DISPLAY`, `formatRating/Distance/Turnaround` — **WRITTEN** |
| Service | `service.ts` (251) | `searchShops`, `getShop`, `applyFilters`, `sortShops`, `availabilityOf`, `isPaused`, `effectiveTurnaroundMinutes`, cursor encode/decode — **CONNECTED** (called by the broken pages and by `order/new/actions.ts`) |
| Repo | `repo.ts` (592) | `searchShopsInDatabase`, `getShopFromDatabase` — PostGIS radius search — **WRITTEN, never run** |
| Source seam | `source.ts` (46) | `discoverySource()`, `MissingDatabaseError`, `usingDevFixtures()` — **CONNECTED** |
| Dev fixtures | `fixtures.ts` (608) | `DEV_SHOPS` (~18 shops), `summaryOf`, `detailOf`, `findDevShop`, `haversineMetres` — **CONNECTED** |
| Tests | — | **ZERO.** ~1,740 lines of discovery code with no test at all. |

`getShop(slug)` returns `null` for a shop that is unverified, not live or suspended — this is the
mechanism enforcing "verified shops only appear in discovery", and `order/new/actions.ts` relies on
it so an unverified shop cannot receive uploads even if its slug is known.

## I. Pricing

| Piece | Path (lines) | Status |
|---|---|---|
| Engine | `domains/pricing/engine.ts` (**694**) | `computeQuote`, `countSelectedPages`, `countSheets`, `bandFor`, `billingQuantity`, `roundToRupee`, `totalsFor`, `isPayable`, `LARGE_JOB_PAGE_THRESHOLD`, `INSPECTION_FINISHINGS`, `QUOTE_VALIDITY_MINUTES` — **WRITTEN, heavily unit-tested (73 tests)** |
| Model | `model.ts` (242) | `Quote`, `QuoteLine`, `QuoteTotals`, `QuoteBlock` + `QuoteBlockReason` (the quote-required path), `ColourMode`, `Sides`, `PriceUnit`, `CataloguePriceBand` |
| Service | `service.ts` (252) | `quoteForShop`, `isQuoteFresh`, `chargeableTotal`, `FileFactsPort` |
| Repo | `repo.ts` (231) | `loadShopCatalogue` |
| Source seam | `source.ts` (42) | `pricingSource()`, `MissingCatalogueError` |
| Dev fixtures | `fixtures.ts` (391) | `DEV_CATALOGUES`, `findDevCatalogue` (12 tests) |
| **Reachability** | — | **Nothing in `src/app` imports pricing.** The engine has never priced a real draft. |

Notable: the quote-required mechanism (`QuoteBlock` / `QuoteBlockReason`) that the PRD demands
**does exist in the engine**, and `INSPECTION_FINISHINGS` marks finishings that force manual
inspection. This is real logic, not a stub — it is simply not wired to any screen.

## J. Files / uploads — the feature that was in flight when work stopped

Architecturally the strongest slice in the repo, and **the one that has never once succeeded.**

| Piece | Path (lines) | What it does | Status |
|---|---|---|---|
| Limits | `domains/files/limits.ts` (207) | `MAX_FILE_BYTES`, `MAX_ORDER_BYTES`, `MAX_FILES_PER_ORDER`, `MAX_PAGES_PER_ORDER`, `ACCEPTED_TYPES`, `ACCEPT_ATTRIBUTE`, `formatBytes`, `safeLabelFor`, `refuseIntent` (writes the customer-facing refusal sentences), `pageLimitFor`. **Documented as dependency-free so the client may import it directly.** | **CONNECTED**, 22 tests |
| Model | `model.ts` (98) | `DraftFile`, `UploadTicket`, `UploadIntent`, `UploadRefusal`, `FileRejectionCode` | **CONNECTED** |
| Store port | `store.ts` (150) | `FileStore` interface; **every method takes `ownerUserId`**; `draftFileOf` | **CONNECTED** |
| Inspect | `inspect.ts` (266) | `sniff` (magic bytes), `inspectPdf` (page count, page sizes), `classifySize`, `inspectFile` → `FileInspection` | **CONNECTED**, 21 tests |
| Service | `service.ts` (333) | `beginUpload`, `completeUpload`, `listDraft`, `totalsOf`, `removeFile`, `fileFacts` | **BROKEN at runtime** — see below |
| Dev store | `dev-store.ts` (147) | in-memory `FileStore` for development | **CONNECTED** |
| DB store | `repo.ts` (316) | `databaseFileStore()` | **WRITTEN, never run** |
| Source seam | `source.ts` (33) | `filesSource()`, `MissingFileStoreError`, `usingDevFileStore()` | **CONNECTED** |
| Server actions | `app/(customer)/order/new/actions.ts` (170) | `beginUploadAction`, `completeUploadAction`, `removeFileAction`, `readDraftAction`; resolves `shopSlug → shopId` + caps **server-side** so a customer cannot raise their own page limit | **CONNECTED, never successfully invoked** |
| Client panel | `upload-panel.tsx` (549) `[CLIENT]` | three-step upload with `XMLHttpRequest` progress, `alive` ref guard, sequential uploads, honest `Checking` state, `putBytes` distinguishing 403/413/other/`onerror` | **CONNECTED, never rendered** |
| Local dev object store | `providers/storage/local.ts` (198) | `ROOT = .chaapo-storage`, `MOUNT = /api/storage/local`, `BUCKET = chaapo-files-dev`; `TokenClaims {key, method:'PUT'\|'GET', exp, maxBytes}`; signs `` `${method}\n${key}\n${exp}\n${maxBytes}` ``; `verifyObjectToken → 'ok'\|'expired'\|'bad_signature'`; secret `process.env.SESSION_SECRET ?? 'dev-only-local-storage-secret'`; `urlFor` from `APP_URL ?? NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'` | **WRITTEN — unreachable (see §4.2), 0 tests** |
| Storage route handler | `app/api/storage/local/[...key]/route.ts` (129) | `PUT` and `GET` for the dev store, token-verified | **WRITTEN — no byte has ever passed through it** |
| Storage port | `providers/storage/port.ts` (98) | `StoragePort`, `PresignedUpload/Download`, `StoredObject`, `PresignUploadInput/DownloadInput` | **WRITTEN** |
| Storage seam | `providers/storage/index.ts` (58) | `storageSource()`, `getStorage()` | **BROKEN — the cause of the `/order/new` failure** |

**The three-step design (preserve it):**
1. `beginUploadAction` → the server decides whether the file is allowed and returns a short-lived
   credential for exactly one key. A refusal is a sentence shown against the file. Nothing uploaded.
2. `XMLHttpRequest.send(file)` **straight to storage** (XHR, not `fetch`, for `upload.onprogress`).
3. `completeUploadAction` → the server reads what actually arrived, sniffs it, counts pages.
   **This is the only step permitted to say a file is ready.** A `rejected` verdict returns
   `ok: true` with a `rejectionMessage`, because the upload succeeded and the file is simply not
   printable.

**A subtle inconsistency to be aware of:** `page.tsx` documents that "a visitor who only looks at
this page is never given [a cookie]", but the panel calls `readDraftAction` on mount, which calls
`requireDraftOwnerId()` — which **mints and sets** the cookie. So a mere page view will in fact set
`chaapo_draft` once the page renders. Not fixed; noted.

**Another latent bug:** `getStorage()` **throws** and is called at `service.ts:127` (`beginUpload`),
`:187` (`completeUpload`) and `:303` (`removeFile`) **without a `try`/`catch`**. So a storage-seam
failure escapes the `Result` contract and surfaces as an unhandled server-action error rather than
a message the panel can show.

**`fileStateEnum`:** `reserved`, `uploading`, `uploaded`, `scanning`, `processing`, `ready`,
`rejected`, `expired`, `deleted`. The UI collapses `reserved`/`uploading`/`scanning`/`processing`
into one honest "Checking" badge.

**Retention / auto-deletion:** the *policy* is stated in the UI ("deleted automatically 24 hours
after upload"), and a `retention_runs` table exists, but **no retention job exists** — there is no
worker and no scheduler. This is a PRD requirement that is currently a promise the code does not
keep.

**Malware scanning:** `MALWARE_SCANNER=clamav` is configured and `env.ts` guards against `noop` in
production, but **there is no malware provider in the repo** and nothing scans anything. The
`scanning` file state is never entered.

## K. Orders

**No code exists.** No `src/server/domains/orders/`. Verified by `find`.

What exists is **schema only** (`0006_orders.sql`, 8 tables; `schema/orders.ts`, 483 lines):
`orders`, `order_items`, `order_events`, `order_state_transitions`, `quotes`,
`pickup_verifications`, `order_holds`, `order_cancellations`, `order_ratings`.
`schema/enums.ts` defines `orderStateEnum` plus the derived sets `ORDER_STATES`,
`PAID_ORDER_STATES`, `ACTIVE_SHOP_ORDER_STATES`, `TERMINAL_ORDER_STATES`.

There is also `src/lib/order-status.ts` (245 lines) — **presentation only**: `CUSTOMER_STATE` and
`SHOP_STATE` label maps, `CUSTOMER_TRACK`, `trackIndex`, `isAwaitingShop`, `showsPickupCode`,
`customerMayCancel`, `mayRate`. It is a view model for a state machine that does not exist.

> `IMPLEMENTATION_PLAN.md` claims a 30-transition state machine at
> `src/server/domains/orders/state-machine.ts`. **That file does not exist.** The
> `order_state_transitions` table is the closest thing to a declared machine, and it has never
> been created in a real database.

## L. Payments

**No code exists.** No `src/server/domains/payments/`, no `src/server/providers/payments/`.
No `MockPaymentProvider`, no `RazorpayRouteProvider`, no webhook route — despite
`.env.local` setting `PAYMENT_PROVIDER=mock` and `MOCK_PAYMENT_WEBHOOK_SECRET`, and despite
`middleware.ts` already allowing Razorpay in `frame-src`.

Schema only (`0007_money.sql`, 9 tables; `schema/money.ts`, 453 lines): `payments`,
`payment_webhook_events`, `refunds`, `ledger_entries`, `payouts`, `payout_items`,
`idempotency_keys`, `invoice_series`, `invoices`, `shop_balances`, with
`paymentStateEnum`, `payoutStateEnum`, `refundStateEnum`, `ledgerAccountEnum`,
`ledgerDirectionEnum`.

The marketplace architecture the PRD demands (funds held at the aggregator against the shop's
sub-merchant account, released only after verified collection, never pooled in Chaapo's own
account) is **expressed in the schema** (`shop_balances`, `payouts`, `ledger_entries`,
`order_holds`) and **implemented nowhere**.

## M. Notifications

**No code exists.** No `src/server/domains/notifications/`, no
`src/server/providers/notifications/`. `web-push` is declared and never imported. VAPID keys in
`.env.local` are empty.

Schema only (`0008_notifications.sql`, 4 tables; `schema/notifications.ts`, 174 lines):
`notification_templates`, `notifications`, `notification_deliveries`,
`notification_provider_calls`, plus `push_subscriptions` and `notification_preferences` in
`identity.ts` and `notificationChannelEnum` / `notificationStateEnum`.

> `IMPLEMENTATION_PLAN.md` claims four notification adapters and a `notification_outbox`.
> Neither the adapters nor a table by that name exist.

## N. Reviews

**No code exists.** `order_ratings` (in `0006`) is the table; `ShopReview` is a type in
`discovery/model.ts` and reviews are rendered from **development fixtures** by
`components/discovery/review-list.tsx` (67 lines). `MIN_RATINGS_TO_DISPLAY` exists in the
discovery model. No submission path, no moderation, no aggregation job.

## O. Privacy

**No code exists.** Schema only (`0009`): `data_erasure_requests`, `data_export_requests`,
`retention_runs`, `consents`. `SignedTokenPurpose` already includes `'privacy_export'` and
`'unsubscribe'`, so the token layer anticipates the feature. `core/pii.ts` provides the
encryption and hashing primitives for PII at rest. Nothing orchestrates export, erasure or
retention.

## P. Analytics

**No code exists.** Schema only (`0009`/`schema/analytics.ts`, 88 lines): `analytics_events`,
`shop_daily_stats`, `platform_daily_stats`. No event emitter, no rollup job, no dashboard.

## Q. APIs

**There is no `/api/v1` at all.** Verified by `find`: `src/app/api/` contains exactly one route
handler, `api/storage/local/[...key]/route.ts` (129 lines, `PUT` + `GET`), which is the
development object store's mount point — not a product API.

The only other server-side entry points are the **four server actions** in
`app/(customer)/order/new/actions.ts`. See §9 for the full API audit.

## R. Realtime

**No code exists.** No `src/server/realtime/`, no SSE route, no pub/sub wiring. `middleware.ts`
already permits `connect-src 'self' https:` (plus `ws:` in dev), so the CSP is ready for a
transport that does not exist.

## S. Background jobs / workers

**No code exists.** There is **no `scripts/worker.ts`**, no `src/server/queue/`, and **BullMQ is
declared in `package.json` but never imported anywhere.** `WORKER_CONCURRENCY` and
`WORKER_ENABLED` are configured in `.env.local` and read by `config/index.ts`, controlling nothing.

Consequences: no file retention/deletion job, no notification dispatch, no payout runs, no
analytics rollups, no OTP/session cleanup (`deleteExpiredSessions` and
`deleteExpiredOtpChallenges` exist in `auth/repo.ts` with no caller).

## T. Testing

See §10 for the full audit. Summary: **22 unit files / 684 tests / 684 passing** (executed today,
exit 0, 1.04 s). **2 integration files / 40 tests, never executed** (no Postgres). **No component
test, no render test, no route test, no end-to-end test anywhere in the repo** — which is precisely
why three broken pages sat behind a green test suite.

## U. PWA / offline

| Item | Path | Status |
|---|---|---|
| Manifest | `public/manifest.webmanifest` | **WORKING** — name, `start_url: /?source=pwa`, `display: standalone`, `orientation: portrait`, `theme_color #fbf8f3`, `lang en-IN`, icon set |
| Service worker | `public/sw.js` (87) | **CONNECTED** — registered client-side; caching strategy not verified by execution |
| Registration | `components/pwa/register-service-worker.tsx` (32) `[CLIENT]` | **CONNECTED** |
| Offline fallback page | `src/app/offline/page.tsx` (43) | **WORKING** (HTTP 200, correct content) |
| Icons | `public/brand/` — `icon.svg`, `icon-192.png`, `icon-512.png`, `maskable-512.png`, `apple-touch-icon.png` | **WORKING** |
| Push | — | **MISSING** — `web-push` never imported, VAPID keys empty |

## V. Other infrastructure

| Item | Path | Status |
|---|---|---|
| CSP middleware | `src/middleware.ts` (86) | **WORKING** — per-request nonce, echoed on `x-chaapo-nonce`, `'strict-dynamic'`, dev `'unsafe-eval'`, `frame-src` allows Razorpay |
| Docker compose | `docker-compose.yml` (3,972 B) | **WRITTEN** — postgres+postgis, redis, minio, mailpit, clamav. **Never started; Docker is not installed here.** |
| Drizzle config | `drizzle.config.ts` | **WRITTEN** — present but migrations are hand-written, not generated |
| Icon generator | `scripts/gen-icons.mjs` | **WRITTEN**, not run |
| Migration CLI | `scripts/migrate.ts` + `scripts/_bootstrap.ts` | **WRITTEN**, never run |
| node:test shim | `scripts/node-test-shim/` (`register.mjs`, `vitest.mjs`, `README.md`) | **WRITTEN** — an escape hatch to run the suite without Vitest; untested |
| Test harness | `src/test/{db,env-integration,setup-integration,setup-unit}.ts` | unit setup **WORKING**; integration setup **never used** |
| `.env.example` | 6,539 B | **WRITTEN** and reasonably complete |
| README | — | **MISSING.** There is no `README.md` in the repo. |

---

# 3. WHAT THE CURRENT PRODUCT CAN ACTUALLY DO

**Brutally accurate answer: essentially nothing. There is no working customer screen.**

Verified today by real browser navigation against `npm run dev:sandbox` on port 3100, reading
`document.body.innerText` and accessibility snapshots (not by inspecting HTML strings — an earlier
substring check gave a false negative because streaming flushes the page header before the error
boundary swaps in):

| Route | HTTP | What the user sees | Verdict |
|---|---|---|---|
| `/` | 200 | "This screen did not load … Reference **2044459844**". `headings: []`, `cardLinks: []` | **BROKEN** |
| `/shops/[id]` | 200 | "This screen did not load … Reference **2791453749**". `orderLink: []` | **BROKEN** |
| `/order/new?shop=…` | 200 | "This screen did not load … Reference **139087369**" | **BROKEN** |
| `/offline` | 200 | Correct branded offline page | **WORKS** |
| `/nope` | 404 | Correct branded 404 | **WORKS** |
| `/map`, `/orders`, `/account` | 404 | Branded 404 — **and these are 3 of the 4 persistent tabs** | **DEAD LINKS** |
| `/api/storage/local/*` | — | Exists, token-gated. **Never exercised; no byte has passed through it.** | **UNVERIFIED** |

The HTTP status is 200 on the three broken routes because Next streams the shell, then swaps in the
client error boundary. **A status-code smoke test would report the app as healthy.**

### Answering the specific questions

- **Can a customer discover shops?** No. The home page throws before rendering a single card.
- **Can a customer open a shop profile?** No.
- **Can a customer reach the order flow?** Not by navigation — the only link to
  `/order/new?shop=…` lives on the shop profile, which never renders. Typing the URL by hand also
  fails.
- **Can a customer upload a file?** **No.** The page throws at render. Even if it rendered,
  `beginUpload` calls the same throwing `getStorage()`, so step 1 would fail. **No file has ever
  been uploaded through this application.**
- **Can a customer get a price?** No. The pricing engine is not imported by any UI file. C-08 does
  not exist and its button is deliberately disabled.
- **Can a customer pay?** No. No payment code of any kind exists.
- **Can a shop receive an order?** No. There is no shop surface and no orders domain.
- **Can an admin manage anything?** No. There is no admin surface.
- **Can an order progress through states?** No. There is no order, no state machine, no transition
  code — only tables that have never been created and label maps for a UI that does not exist.
- **Does anything at all work?** Yes: the design system renders, the 404 page, the offline page, the
  service worker registers, the CSP is applied with a nonce, and 684 unit tests of pure logic pass.

### The one honest positive

The **foundations are genuinely good**: money-as-paise, `Result`, the seam pattern, the port
pattern, the audit and RBAC catalogues, the 68-table schema, the never-proxy-bytes upload design,
and 684 tests over the pure logic. This is not a fake prototype — the PRD's DO-NOT list has been
respected. It is a **deep foundation with almost no product on top of it, plus two small bugs that
currently hide even the product that is there.**

---

# 4. CURRENT STOPPING POINT

## 4.0 What was being worked on

**The C-07 "Add your files" upload slice.** Ten source files were touched in the final working
session, and `order/new/page.tsx` is the most recently modified source file in the repository.

Most recently modified source files (`stat` mtimes, newest first):

| mtime | File | Note |
|---|---|---|
| 2026-09-01 20:40 | `src/app/(customer)/order/new/page.tsx` | **the file in flight** |
| 2026-09-01 19:56 | `src/app/api/storage/local/[...key]/route.ts` | **new** |
| 2026-09-01 19:56 | `src/app/(customer)/order/new/upload-panel.tsx` | **new** |
| 2026-09-01 19:49 | `src/app/(customer)/order/new/actions.ts` | **new** |
| 2026-09-01 19:40 | `src/server/http/draft-identity.ts` | **new** |
| 2026-09-01 19:40 | `src/server/auth/tokens.ts` | **modified** (to add the `'draft_owner'` purpose) |
| 2026-09-01 19:37 | `src/components/ui/button.tsx` | earlier fix (`asChild`/Slot) |
| 2026-09-01 19:35 | `src/app/layout.tsx`, `src/app/globals.css` | fonts/offline work |
| 2026-09-01 19:34 | `src/app/fonts.ts`, `src/app/fonts.offline.ts` | offline-fonts seam |

**Five new source files** in the last session (`draft-identity.ts`, `page.tsx`, `upload-panel.tsx`,
`actions.ts`, the storage route handler) **plus one modification** (`auth/tokens.ts`).
`providers/storage/{index,local,port}.ts` and the whole `domains/files/` tree were written in the
same push.

**Last completed step:** the C-07 slice was written end to end — page, client panel, four server
actions, draft-identity cookie, files domain, storage port, dev object store and its route handler
— and `typecheck`, `lint` and `test` were all green.

**Next intended step (per `CHAAPO_TODO.md`):** C-08 "Choose print options", which would wire the
pricing engine to the draft. **This was not started.** The button that would lead there is
explicitly disabled.

**What was never done:** *the slice was never opened in a browser.* That is the whole story of the
stopping point. Everything below was discovered during this audit, after work had already stopped.

## 4.1 Root cause #1 — RSC boundary violation (breaks `/` and `/shops/[id]`)

**The rule:** every export of a `'use client'` module becomes a **client reference**. A plain helper
function exported from a `'use client'` file **cannot be called from a server component** — it
throws at render, **in development and in production alike.** This is not a dev-only warning.

**The violation:**

`src/components/discovery/open-state-badge.tsx`
- line 1: `'use client'`
- line 31: `export function describeAvailability(hours, pausedUntil, pauseReason, now)`
- documented as *"Shared by the server render and the client tick, so the two cannot disagree"* —
  which is exactly the thing RSC forbids. The intent was right; the mechanism is illegal.

Two server components import and call it:

| Caller | Import | Call site | Effect |
|---|---|---|---|
| `src/components/discovery/shop-card.tsx` (159, server component) | line 16 | **line 56** | throws **once per card** — ~18 throws per home-page render |
| `src/app/(customer)/shops/[id]/page.tsx` (468, `ShopProfilePage`) | line 30 | **line 124** | throws once |

**Digests:** `/` → **2044459844** (attributed to `shop-card.tsx:56:44`); `/shops/[id]` →
**2791453749** (attributed to `shops/[id]/page.tsx:124`). Attribution was done by parsing the
persisted 80.2 KB dev-server error log, stripping ANSI and mapping each `digest:` to the nearest
preceding stack frame.

**Knock-on effect:** because `ShopProfilePage` throws, the `/order/new?shop=…` link it renders never
reaches the DOM. **The order flow has no reachable entrance.**

**Not fixed.** The shape of the fix (for the next agent to decide, not to inherit): move
`describeAvailability` into a server-safe module — `src/lib/` or `src/server/domains/discovery/` —
and have both `open-state-badge.tsx` and the two server components import it from there. Note
`discovery/service.ts` already exports `availabilityOf`, which may be the intended home.

## 4.2 Root cause #2 — storage seam mis-selection (breaks `/order/new`)

`src/server/providers/storage/index.ts` (58 lines), verbatim:

```ts
export function storageSource(env: NodeJS.ProcessEnv = process.env): StorageSource {
  const appEnv = env.APP_ENV ?? env.NODE_ENV ?? 'development'
  const isDevLike = appEnv === 'development' || appEnv === 'test'
  if (env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) return 's3'   // ← line 36, fires
  if (isDevLike) return 'local-dev-disk'
  return 's3'
}

export function getStorage(env: NodeJS.ProcessEnv = process.env): StoragePort {
  if (storageSource(env) === 'local-dev-disk') return localStorageProvider
  throw errors.notImplemented(
    'S3 object storage (set APP_ENV=development to use the local development store, or add an S3 adapter behind StoragePort)',
  )
}
```

`.env.local` lines 47–48 **do** set `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (MinIO
placeholders for the compose stack). *(Only the credential **names** were read during this audit;
the values were not echoed.)* So:

1. line 36 short-circuits to `'s3'`,
2. `getStorage()` reaches the `throw`, because **no S3 adapter exists anywhere in the repo**
   (`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` are installed and never imported),
3. `src/app/(customer)/order/new/page.tsx:110` — `developmentStorage={getStorage().isDevelopmentStore}`
   — throws during render,
4. digest **139087369**.

**Two aggravating details:**

- **The error message's own remedy is wrong.** It says "set `APP_ENV=development`". `APP_ENV` is
  *already* `development` (`.env.local:17`). The condition that fires is the S3-credential check,
  which runs *before* the dev-like check. Anyone following the message will be misled.
- **The upload flow could never have worked either.** The same `getStorage()` sits inside
  `beginUpload` (`files/service.ts:127`), `completeUpload` (`:187`) and `removeFile` (`:303`), all
  **uncaught**, so even a rendering page would fail at step 1 with an unhandled server-action error
  rather than a message the panel could display.

**Not fixed.** Note that simply deleting the two S3 keys from `.env.local` trades this bug for the
`env.ts` `superRefine` failure described in §1.7(b) — the real fix is to reconcile the two modules
on what selects storage (probably: make `storageSource()` honour `STORAGE_PROVIDER`).

## 4.3 Half-implemented work, dead links and gaps as they stand

| Item | Where | Nature |
|---|---|---|
| C-08 print options | `upload-panel.tsx:334` | Button rendered **`disabled`** on purpose. The flow has no continuation. |
| Retention/deletion promise | `order/new/page.tsx:135-136` | UI states files are "deleted automatically 24 hours after upload". **No job exists to do it.** |
| Malware scanning | `.env.local:111` | Configured (`clamav`), no provider, nothing scans. `scanning` state unreachable. |
| Database file store | `files/repo.ts` | Fully written, selected only when `DATABASE_URL` is set — which currently makes `loadEnv()` the next thing to fail. |
| Discovery DB repo | `discovery/repo.ts` (592) | PostGIS radius search, never run against PostGIS. |
| Pricing DB repo | `pricing/repo.ts` (231) | Never run. |
| Auth (entire) | `src/server/auth/**` (2,668 lines) | No caller. No login screen. |
| RBAC / audit / rate-limit / config-store | `src/server/core/**` (~2,990 lines) | No caller outside tests. |
| Dead tab-bar links | `customer-tab-bar.tsx:32-34` | `/map`, `/orders`, `/account` → 404 |
| Other known 404s | `CHAAPO_TODO.md:66-69` | `/shop/onboarding`, `/legal/terms`, `/legal/privacy`, `/legal/refunds`, `/support` |
| **Broken imports** | — | **None.** Every import in the repo resolves; `tsc --noEmit` exits 0. The failures are runtime/architectural, not missing modules. |

---

# 5. PRD / REQUIREMENTS AUDIT

Measured against the PRD's **IMPORTANT PRODUCT RULES** and its feature areas.
Status is judged from the filesystem, never from a planning document.

## 5.1 The non-negotiable product rules

| # | Requirement | Intended behaviour | Existing implementation | Files | Status | Notes |
|---|---|---|---|---|---|---|
| R1 | Verified shops only appear in discovery | Unverified / non-live / suspended shops are invisible and cannot receive orders | `getShop()` returns `null` unless verified+live; `searchShops` filters; `actions.ts` relies on it so uploads to unverified shops are refused | `discovery/service.ts`, `discovery/repo.ts`, `order/new/actions.ts:60-61` | **PARTIAL** | Logic exists and is correct in shape. Never verified against a database; discovery has **zero tests**; the pages that would show it don't render. |
| R2 | Customer files are private | No public URL, ever | No `url` column on `files`; bytes go browser→storage; every `FileStore` method takes `ownerUserId`; download requires a presigned GET | `files/store.ts`, `files/repo.ts`, `providers/storage/port.ts` | **PARTIAL** | Design is right and the invariant is documented. Never exercised — no file has been uploaded. |
| R3 | Use secure signed URLs | Short-lived, per-key, method-bound credentials | Dev store signs `` `${method}\n${key}\n${exp}\n${maxBytes}` `` with HMAC; `verifyObjectToken → ok/expired/bad_signature`; route handler verifies before writing | `providers/storage/local.ts`, `api/storage/local/[...key]/route.ts` | **PARTIAL / UNVERIFIED** | Dev implementation only. **No S3 presigner exists.** The signing code has **zero tests** — for security-critical code this is the single most alarming test gap in the repo. |
| R4 | Files auto-deleted per retention rules | 24 h for abandoned drafts; longer, configurable retention for placed orders | **Nothing.** `retention_runs` table + `expired`/`deleted` file states only | `schema/config.ts`, `schema/enums.ts` | **MISSING** | The UI already **promises** this to the customer. No worker exists to keep the promise. |
| R5 | **Never expose public file URLs** | — | Honoured. No public bucket, no `url` column, no static file route | — | **COMPLETE (as an invariant)** | Nothing in the codebase violates it. |
| R6 | Proper marketplace/aggregator payments; **never pooled money** | Funds held at the aggregator against the shop's sub-merchant account | **No payment code at all** | `schema/money.ts` only | **MISSING** | The schema models it correctly (`shop_balances`, `payouts`, `ledger_entries`). No unsafe workaround exists — the rule is not *violated*, it is simply unimplemented. |
| R7 | Funds held until successful collection | Release on verified pickup | `order_holds`, `payout_state` enum | schema only | **MISSING** | — |
| R8 | Pickup verified with secure code/QR | Signed token bound to `{order_id, shop_id, jti, exp}` | `PICKUP_TOKEN_SECRET` in env; `newPickupCode`, `formatPickupCode`, `PICKUP_CODE_LENGTH`, `normaliseHumanCode`, `newQrSlug` in `src/lib/ids.ts`; `pickup_verifications` table; `showsPickupCode` in `order-status.ts` | `src/lib/ids.ts`, `schema/orders.ts` | **PARTIAL (primitives only)** | The code-generation primitives exist and are tested (36 tests in `ids.test.ts`). No verification flow, no QR rendering (`qrcode` declared, never imported). |
| R9 | Price snapshotted at order placement | The quote is frozen onto the order | `quotes` table, `QUOTE_VALIDITY_MINUTES`, `isQuoteFresh()`, `shop_price_history` | `pricing/engine.ts`, `pricing/service.ts`, `schema/orders.ts` | **PARTIAL** | Freshness logic exists; there is no order to snapshot onto. |
| R10 | Quote-required path for non-auto-priceable jobs | Block payment, route to manual quote | **Implemented in the engine:** `QuoteBlock`, `QuoteBlockReason`, `INSPECTION_FINISHINGS`, `LARGE_JOB_PAGE_THRESHOLD`, `isPayable()` | `pricing/engine.ts`, `pricing/model.ts` | **PARTIAL (logic COMPLETE, unreachable)** | Genuinely implemented and covered by 73 tests. No UI consumes it. |
| R11 | Explicit, server-enforced order state machine | Declared transitions, refused illegal moves | **No code.** `order_state_transitions` table + `orderStateEnum` + presentation maps | `schema/orders.ts`, `src/lib/order-status.ts` | **MISSING** | `IMPLEMENTATION_PLAN.md`'s claimed `state-machine.ts` does not exist. |
| R12 | Every important state transition auditable | Append-only audit trail | `core/audit.ts` (651) with a full action catalogue, `audit_logs` table, immutability guards in migration `0010` | `core/audit.ts`, `db/migrations/0010_immutability_and_guards.sql` | **PARTIAL** | Engine is written and tested (29 tests). **Nothing calls it** — there are no transitions to audit yet. |
| R13 | Idempotency around payments and transitions | Dedup keys, exactly-once webhooks | `idempotency_keys` + `payment_webhook_events` tables; `newIdempotencyKey()` in `src/lib/ids.ts` | schema + `src/lib/ids.ts` | **MISSING (mechanism)** | Primitives only. |
| R14 | Never lose an order to upload/payment/network failure | Resumable, recoverable | Upload side: three-step protocol, `reserved` state, server-side verification of what arrived, honest error messages, per-file retry | `files/service.ts`, `upload-panel.tsx` | **PARTIAL (upload only, unverified)** | The protocol is designed for this and has never run. Payment/order recovery does not exist. |
| R15 | Fast, mobile-first customer experience | — | Mobile-first layout, skeletons, tab bar, PWA, `XMLHttpRequest` progress for slow connections, sequential uploads to avoid four crawling bars | `src/app/(customer)/**`, `src/components/**` | **BROKEN** | The intent is visible throughout the code and **no customer page currently renders.** |
| R16 | Glanceable, practical shop dashboard | — | Nothing | — | **MISSING** | `BentoGrid`/`BentoCell`/`StatSkeleton`/`TableSkeleton` exist, unused. |
| R17 | Admin money/verification/privacy/override actions audited | Reason-required, audited overrides | `MIN_REASON_LENGTH` + reason-required capabilities in `core/rbac.ts`; `AUDIT_ACTIONS`; `platform_config_history` | `core/rbac.ts`, `core/audit.ts`, `core/config-store.ts` | **PARTIAL** | Fully modelled, zero callers, no admin UI. |

## 5.2 Feature areas

| Area | Status | Evidence |
|---|---|---|
| Design system / theming | **COMPLETE (as a kit)** | 7 UI modules + 447-line token layer; renders correctly where a page renders |
| Discovery (search, filter, sort, distance) | **BROKEN** | Logic written, page throws |
| Shop profile + price list + reviews | **BROKEN** | 468-line page throws |
| File upload | **BROKEN** | Written end to end, never executed |
| Print configuration (C-08) | **MISSING** | Not started; button disabled |
| Pricing / quote | **PARTIAL** | 694-line engine + 73 tests, no consumer |
| Cart / checkout | **MISSING** | — |
| Payments / refunds / payouts / ledger / invoices | **MISSING** | Schema only |
| Order lifecycle + state machine | **MISSING** | Schema only |
| Pickup verification / QR | **PARTIAL (primitives)** | `ids.ts` |
| Notifications (WhatsApp/SMS/email/push) | **MISSING** | Schema only |
| Reviews & ratings | **MISSING** | Fixture rendering only |
| Shop onboarding / KYC / verification | **MISSING** | Schema only |
| Shop dashboard / job queue | **MISSING** | — |
| Shop catalogue & pricing management | **MISSING** | Schema + engine only |
| Admin console (all of it) | **MISSING** | Core engines only |
| Platform config / feature flags | **PARTIAL** | 891-line store, 42 tests, no UI, no caller |
| Auth / sessions / MFA / RBAC | **PARTIAL** | 3,620 lines, no caller, no screen |
| Audit trail | **PARTIAL** | 651 lines, no caller |
| Privacy (export/erasure/consent) | **MISSING** | Schema only |
| Analytics | **MISSING** | Schema only |
| Realtime (SSE) | **MISSING** | — |
| Background jobs | **MISSING** | — |
| PWA / offline | **PARTIAL** | Manifest + SW + offline page work; push missing |
| Observability (structured logs) | **PARTIAL** | `core/logger.ts`, 35 tests, partly wired |
| Rate limiting | **PARTIAL** | 496 lines, 26 tests, no caller |
| Security headers / CSP | **COMPLETE** | `src/middleware.ts`, verified applied |
| CI | **MISSING** | No workflow file, and no git repository to run one in |

**Deferred by the PRD (correctly absent — do not build these):** anything the PRD marks as
post-MVP. Nothing in the repo shows scope creep *into* deferred features; the scope problem here is
the opposite (depth without reachability).

---

# 6. SCREEN / ROUTE AUDIT

## 6.1 Customer surface

| ID | Screen | Route | Exists? | Reachable? | UI complete? | Backend connected? | Status | Missing pieces |
|---|---|---|---|---|---|---|---|---|
| C-01 | Discovery / home | `/` | **Yes** (`(customer)/page.tsx`, 258) | Yes | Yes | Yes (dev fixtures) | **BROKEN** (digest 2044459844) | Fix RSC violation §4.1 |
| C-02 | Discovery controls | in-page | Yes (`discovery-controls.tsx`, 274) | No | Yes | Partly | **UNREACHABLE** | Parent must render first |
| C-03 | Map view | `/map` | **No** | — | — | — | **MISSING (404, in tab bar)** | Whole screen; `NEXT_PUBLIC_MAP_PROVIDER=none` |
| C-04 | Shop profile | `/shops/[id]` | **Yes** (468) | Yes | Yes | Yes (fixtures) | **BROKEN** (digest 2791453749) | Fix RSC violation §4.1 |
| C-05 | Shop hours / price list / reviews | in-page | Yes (3 components) | No | Yes | Fixtures | **UNREACHABLE** | — |
| C-06 | Short-link redirect | `/s/[slug]` | **No** | — | — | — | **MISSING** | Route handler (`newQrSlug` exists in `ids.ts`) |
| C-07 | Add your files | `/order/new?shop=…` | **Yes** (145 + 549 + 170) | **No** — no link renders | Yes | Yes | **BROKEN** (digest 139087369) | Fix storage seam §4.2, then verify a real upload |
| C-08 | Choose print options | — | **No** | — | — | — | **MISSING — next intended step** | Everything; wire `pricing/engine.ts` |
| C-09 | Review & price summary | — | **No** | — | — | — | **MISSING** | — |
| C-10 | Checkout / pay | — | **No** | — | — | — | **MISSING** | Payments domain + provider |
| C-11 | Order confirmation | — | **No** | — | — | — | **MISSING** | Orders domain |
| C-12 | Order tracking | `/orders/[id]` | **No** | — | — | — | **MISSING** | `order-status.ts` view model exists |
| C-13 | Order list | `/orders` | **No** | — | — | — | **MISSING (404, in tab bar)** | `OrderListSkeleton` exists, unused |
| C-14 | Pickup code / QR | — | **No** | — | — | — | **MISSING** | `showsPickupCode` exists |
| C-15 | Rate the shop | — | **No** | — | — | — | **MISSING** | `mayRate` exists |
| C-16 | Account | `/account` | **No** | — | — | — | **MISSING (404, in tab bar)** | — |
| C-17 | Login / OTP | — | **No** | — | — | — | **MISSING** | 2,668 lines of auth logic wait for it |
| C-18 | Offline fallback | `/offline` | **Yes** (43) | Yes | Yes | n/a | **WORKING** | — |
| C-19 | 404 | any | **Yes** (43) | Yes | Yes | n/a | **WORKING** | — |
| C-20 | Legal (terms/privacy/refunds) | `/legal/*` | **No** | — | — | — | **MISSING (404s)** | Listed in `CHAAPO_TODO.md` |
| C-21 | Support | `/support` | **No** | — | — | — | **MISSING (404)** | — |

## 6.2 Shop surface — **0 of ~14 screens exist**

`/shop/onboarding`, `/shop/kyc`, `/shop/dashboard`, `/shop/jobs`, `/shop/jobs/[id]`,
`/shop/pickup` (code/QR verification), `/shop/catalogue`, `/shop/pricing`, `/shop/hours`,
`/shop/staff`, `/shop/payouts`, `/shop/settings`, `/shop/reviews`, `/shop/login` — **none exist.**
No `src/app/shop/` directory of any kind. The `shops` schema (15 tables) and the bento/table
components are the only groundwork.

## 6.3 Admin surface — **0 of ~12 screens exist**

`/admin/login`, `/admin` (overview), `/admin/shops` + verification queue, `/admin/orders`,
`/admin/payments`, `/admin/payouts`, `/admin/refunds`, `/admin/disputes`, `/admin/users`,
`/admin/config` (platform settings + feature flags), `/admin/notifications`, `/admin/audit`,
`/admin/privacy` — **none exist.** `core/rbac.ts`, `core/audit.ts` and `core/config-store.ts` are
the engines built for them.

---

# 7. BACKEND DOMAIN AUDIT

**The distinction the instruction asks for, applied strictly:**

- **WRITTEN CODE** — exists, type-checks, nothing reachable calls it.
- **CONNECTED CODE** — a reachable caller exists.
- **FUNCTIONING END-TO-END** — observed to work by execution.

**Result: 3 domains of 13 exist. 0 domains function end to end.**

## 7.1 Existing domains

### `discovery` — ~1,740 lines

| Layer | File | Present | Notes |
|---|---|---|---|
| Model | `model.ts` (243) | ✅ | Types + formatters |
| Service | `service.ts` (251) | ✅ | `searchShops`, `getShop`, filters, sort, cursor |
| Repo | `repo.ts` (592) | ✅ | PostGIS `ST_DWithin` radius search |
| Source seam | `source.ts` (46) | ✅ | db → fixtures → throw |
| Fixtures | `fixtures.ts` (608) | ✅ | ~18 dev shops, `haversineMetres` |
| Barrel | `index.ts` (46) | ✅ | Public surface |
| Business logic | availability, pause, turnaround, radius, sort, verified-only | ✅ | |
| API | — | ❌ | No `/api/v1/shops` |
| **Tests** | — | ❌ | **ZERO** |
| Callers | `(customer)/page.tsx`, `shops/[id]/page.tsx`, `order/new/{page,actions}` | ✅ | All broken or unreachable |
| **Verdict** | **CONNECTED, not functioning.** Highest-risk untested domain: 1,740 lines, 0 tests, and it gates the "verified shops only" rule. |

### `pricing` — ~1,850 lines

| Layer | File | Present | Notes |
|---|---|---|---|
| Model | `model.ts` (242) | ✅ | Includes `QuoteBlock` (quote-required) |
| Engine | `engine.ts` (694) | ✅ | Bands, sheets, sides, finishings, GST, rounding |
| Service | `service.ts` (252) | ✅ | `quoteForShop`, `isQuoteFresh`, `FileFactsPort` |
| Repo | `repo.ts` (231) | ✅ | `loadShopCatalogue` |
| Source seam | `source.ts` (42) | ✅ | |
| Fixtures | `fixtures.ts` (391) | ✅ | 12 tests |
| **Tests** | `engine.test.ts` (73), `fixtures.test.ts` (12) | ✅ | **85 tests — the best-tested domain** |
| API | — | ❌ | |
| Callers | **none in `src/app`** | ❌ | |
| **Verdict** | **WRITTEN, well tested in isolation, zero reachability.** |

### `files` — ~1,550 lines + 227 lines of route/actions glue

| Layer | File | Present | Notes |
|---|---|---|---|
| Model | `model.ts` (98) | ✅ | |
| Limits | `limits.ts` (207) | ✅ | Dependency-free by design; shared with the client |
| Store port | `store.ts` (150) | ✅ | `ownerUserId` on every method |
| Inspect | `inspect.ts` (266) | ✅ | Magic-byte sniff + PDF page/size analysis |
| Service | `service.ts` (333) | ✅ | Three-step protocol; **`getStorage()` uncaught at 127/187/303** |
| Dev store | `dev-store.ts` (147) | ✅ | In-memory |
| DB store | `repo.ts` (316) | ✅ | Never run |
| Source seam | `source.ts` (33) | ✅ | |
| **Tests** | `inspect.test.ts` (21), `limits.test.ts` (22) | ⚠️ | **43 tests — but `service.ts` itself has none** |
| API | 4 server actions + 1 storage route handler | ✅ | Never successfully invoked |
| **Verdict** | **CONNECTED and BROKEN.** The only domain wired to a UI, and the wire is cut at `getStorage()`. |

## 7.2 Missing domains (10 of 13)

| Domain | Directory | Schema exists? | Any code? |
|---|---|---|---|
| `orders` | `src/server/domains/orders/` | ✅ 9 tables | **None** |
| `payments` | `…/payments/` | ✅ 11 tables | **None** |
| `payouts` | `…/payouts/` | ✅ (in money) | **None** |
| `notifications` | `…/notifications/` | ✅ 6 tables | **None** |
| `reviews` | `…/reviews/` | ✅ `order_ratings` | **None** |
| `privacy` | `…/privacy/` | ✅ 4 tables | **None** |
| `analytics` | `…/analytics/` | ✅ 3 tables | **None** |
| `shops` (owner-side) | `…/shops/` | ✅ 15 tables | **None** |
| `catalogue` (owner-side) | `…/catalogue/` | ✅ 8 tables | **None** (pricing reads it) |
| `identity` | `…/identity/` | ✅ 9 tables | `src/server/auth/**` is the de-facto identity layer, but there is no domain service composing it |
| `admin` | `…/admin/` | ✅ config/trust tables | **None** |

## 7.3 Providers

| Capability | Port | Adapters present | Adapters missing | Status |
|---|---|---|---|---|
| Storage | `providers/storage/port.ts` (98) | `local.ts` (198) dev-disk | **S3** | **BROKEN seam** (§4.2) |
| Payments | — | — | mock + Razorpay Route | **MISSING (no port either)** |
| Notifications | — | — | WhatsApp, SMS, SMTP, web-push | **MISSING** |
| Geo / reverse geocoding | — | — | local PostGIS, Mapbox/Google | **MISSING** (`GEO_PROVIDER=local` configured) |
| Malware scanning | — | — | ClamAV, noop | **MISSING** (`MALWARE_SCANNER=clamav` configured) |
| Document processing | — | — | PDF page count/preview (`pdf-lib`, `sharp` installed, unused) | **MISSING** (partially covered by `files/inspect.ts`) |

`src/server/providers/` contains **exactly one subdirectory**: `storage/`.

---

# 8. DATABASE AUDIT

**No migration was run and nothing was modified during this audit.** All numbers below come from
reading the SQL files.

## 8.1 Headline

| Metric | Value |
|---|---|
| Migration files | 11 (`0001`…`0011`) |
| Total SQL | **5,493 lines** |
| Tables | **68** |
| Drizzle `pgTable` | **68** (count parity) |
| Enum types | **14** (matched by 14 `pgEnum`) |
| Indexes | **240** |
| Triggers | **75** |
| Functions | **21** |
| CHECK constraints | **267** |
| Foreign keys | **157** |
| Seed inserts | **14** (migration `0011` only) |
| **Applied to a real database?** | **NO — never, not once** |
| **Tested against PostgreSQL?** | **NO** |

## 8.2 Migration-by-migration

| File | Tables | Purpose |
|---|---|---|
| `0001_extensions_and_types.sql` | 0 | 3 `CREATE EXTENSION` (incl. PostGIS, citext), 14 `CREATE TYPE` enums |
| `0002_identity.sql` | 9 | `users`, `user_roles`, `sessions`, `otp_challenges`, `user_totp`, `login_attempts`, `push_subscriptions`, `notification_preferences`, `consents` |
| `0003_geography_and_shops.sql` | 12 | `cities`, `localities`, `shops` (+ `geography(Point,4326)`), hours, closures, staff, invites, capabilities, KYC, bank accounts, verification events, favourites |
| `0004_catalogue.sql` | 8 | `paper_sizes`, `service_categories`, `service_items`, `shop_service_items`, `price_bands`, `shop_finishing_compatibility`, `shop_price_modifiers`, `shop_price_history` |
| `0005_files.sql` | 4 | `file_upload_sessions`, `files`, `file_previews`, `file_access_logs` |
| `0006_orders.sql` | 8 | `orders`, `order_items`, `order_events`, `order_state_transitions`, `quotes`, `pickup_verifications`, `order_holds`, `order_cancellations`, `order_ratings` |
| `0007_money.sql` | 9 | `idempotency_keys`, `payments`, `payment_webhook_events`, `refunds`, `ledger_entries`, `payouts`, `payout_items`, `invoice_series`, `invoices`, `shop_balances` |
| `0008_notifications.sql` | 4 | templates, notifications, deliveries, provider calls |
| `0009_trust_privacy_config.sql` | 13 | `audit_logs`, `disputes`, `dispute_messages`, `risk_flags`, `platform_config`, `platform_config_history`, `feature_flags`, `data_erasure_requests`, `data_export_requests`, `retention_runs`, analytics tables |
| `0010_immutability_and_guards.sql` | 1 | append-only / immutability triggers and guard functions |
| `0011_reference_data.sql` | 0 | 14 seed `INSERT`s — paper sizes, service categories, service items, config defaults |

## 8.3 PostGIS

`geography(Point, 4326)` appears 5 times (shops and localities). `ST_SetSRID`, `ST_MakePoint` and
`ST_DWithin` are used. **Note:** there are **no `USING GIST` index declarations** in the migrations,
so the geography columns appear to be unindexed for spatial search. On a real dataset the radius
query in `discovery/repo.ts` will do a sequential scan. **Flagged, not fixed** — verify against a
live database before treating this as a defect (a GiST index may be created implicitly elsewhere, or
intentionally deferred).

## 8.4 Facts to respect

- `paper_sizes.code` is **UPPERCASE** and is the FK target of `files.dominant_page_size`.
- `audit_logs.id` and `platform_config_history.id` have **no DB default** — the application must
  supply `newId()`. `buildAuditRow()` does this; new writers must too.
- Migration `0010` installs immutability guards; `db/client.ts` has `isGuardViolation()` to
  translate the resulting error.
- The migrator (`db/migrator.ts`, 536) does **checksum drift detection** and will refuse to run if a
  previously applied migration file has been edited. **Never edit an applied migration** — add a new
  one. (Nothing is applied yet, so today the slate is clean.)
- Seed data: **reference data only.** There are **no demo shops, orders or users in SQL.** The
  ~18 dev shops and 12 catalogues live in TypeScript fixtures
  (`discovery/fixtures.ts`, `pricing/fixtures.ts`) and are **not** loaded into Postgres.
  `IMPLEMENTATION_PLAN.md`'s claim of "12 shops and ~24 orders" of seed data is false; there is
  **no `scripts/seed.ts`**.
- `IMPLEMENTATION_PLAN.md` says "37 tables". The migrations create **68**.

## 8.5 Schema parity

`src/server/db/schema-parity.itest.ts` (371 lines, 9 tests) exists specifically to compare the
Drizzle schema against the live database. **It has never run.** Table and enum *counts* match
(68/68, 14/14) by static inspection, but column-level parity is unverified.

---

# 9. API AUDIT

## 9.1 What exists

| Endpoint | File | Methods | Auth | Validation | Rate limit | Idempotency | Status |
|---|---|---|---|---|---|---|---|
| `/api/storage/local/[...key]` | `src/app/api/storage/local/[...key]/route.ts` (129) | `PUT`, `GET` | **Signed object token** (HMAC over method+key+exp+maxBytes) | key shape + token verdict | **None** | n/a | **WRITTEN — never exercised.** Development-only mount for the local disk store. |

**That is the entire HTTP API surface.** There is no `/api/v1` directory.

## 9.2 Server actions (the de-facto API)

| Action | File | Input validation | Identity | Authorization | Rate limit | CSRF |
|---|---|---|---|---|---|---|
| `beginUploadAction` | `order/new/actions.ts:83` | manual: `typeof filename === 'string'`, `Number.isFinite(byteSize)`, `Math.floor` on size; domain `refuseIntent` does the rest | `requireDraftOwnerId()` mints/reads the signed cookie | shop resolved from **slug server-side**; caps re-derived from the shop row so a client cannot raise its own limits | **None** | Next's built-in action protection only |
| `completeUploadAction` | `:125` | shop + fileId | same | ownership passed as a query parameter to the store | **None** | same |
| `removeFileAction` | `:139` | same | same | same | **None** | same |
| `readDraftAction` | `:159` | shopSlug | same — **and this mints the cookie on mere page view** | same | **None** | same |

**Good properties already in place:** no `Result` or `AppError` class instance crosses to the
client (a discriminated `ActionResult<T>` is returned instead); the client sends `shopSlug`, never
`shopId` and never caps; refusal sentences come from `limits.ts` which exists to phrase them; a
`rejected` file is `ok: true` so the row survives for the customer to see and remove.

**Gaps:** **zero rate limiting anywhere** (`core/rate-limit.ts`, 496 lines, has no callers);
`getStorage()` throws through the `Result` contract uncaught; no `zod` schema on action inputs
(hand-rolled checks only) while `zod` is already a dependency.

## 9.3 Planned vs existing

| Planned API area | Exists? |
|---|---|
| `/api/v1/auth/*` (OTP request/verify, session, refresh, logout, MFA) | ❌ |
| `/api/v1/shops` (search, detail, catalogue) | ❌ |
| `/api/v1/files` (begin/complete/remove/download) | ❌ (server actions instead) |
| `/api/v1/quotes` | ❌ |
| `/api/v1/orders` (create, list, detail, transition, cancel) | ❌ |
| `/api/v1/payments` (intent, status) | ❌ |
| `/api/v1/webhooks/payments` | ❌ — **but `MOCK_PAYMENT_WEBHOOK_SECRET` is configured and `middleware.ts` already allows Razorpay in `frame-src`** |
| `/api/v1/pickup/verify` | ❌ |
| `/api/v1/notifications/*`, push subscribe | ❌ |
| `/api/v1/admin/*` | ❌ |
| SSE stream (`/api/v1/events` or similar) | ❌ |
| Health / readiness probe | ❌ — `checkDbHealth()` and `checkRedisHealth()` exist with no endpoint |
| `withRoute()` route wrapper (`src/server/http/route.ts`) | ❌ — **claimed by `IMPLEMENTATION_PLAN.md`, does not exist** |

**Referenced-but-nonexistent endpoints:** none in code (nothing fetches a missing URL).
The nonexistence is in the *plan document*, not in the source.

---

# 10. TEST AUDIT

## 10.1 Executed today

```
npx vitest run
→ exit 0 · 22 files · 684 tests · 684 passed · 0 failed · 1.04s
```

```
npx tsc --noEmit --incremental false   → exit 0
npx eslint .                            → exit 0, no output
```

*(`--incremental false` was used deliberately so no `tsconfig.tsbuildinfo` write would count as
modifying the repository.)*

## 10.2 Unit tests — written AND executed AND passing

| File | Cases |
|---|---|
| `src/server/domains/pricing/engine.test.ts` | 73 |
| `src/server/core/config-store.test.ts` | 42 |
| `src/server/core/rbac.test.ts` | 37 |
| `src/lib/ids.test.ts` | 36 |
| `src/lib/time.test.ts` | 36 |
| `src/server/auth/policy.test.ts` | 36 |
| `src/server/core/logger.test.ts` | 35 |
| `src/lib/money.test.ts` | 33 |
| `src/server/core/errors.test.ts` | 30 |
| `src/server/core/audit.test.ts` | 29 |
| `src/server/auth/password.test.ts` | 28 |
| `src/server/auth/totp.test.ts` | 28 |
| `src/server/auth/otp.test.ts` | 27 |
| `src/server/core/crypto.test.ts` | 27 |
| `src/server/auth/tokens.test.ts` | 26 |
| `src/server/core/pii.test.ts` | 26 |
| `src/server/core/rate-limit.test.ts` | 26 |
| `src/server/core/result.test.ts` | 24 |
| `src/server/domains/files/limits.test.ts` | 22 |
| `src/lib/phone.test.ts` | 21 |
| `src/server/domains/files/inspect.test.ts` | 21 |
| `src/server/domains/pricing/fixtures.test.ts` | 12 |
| **Static `it(`/`test(` total** | **675** |

Vitest reports **684** because some cases are `it.each` expansions. Both numbers are accurate;
684 is what actually executes.

## 10.3 Written but NOT EXECUTABLE here

| File | Cases | Why blocked |
|---|---|---|
| `src/server/core/config-store.itest.ts` | 31 | Needs PostgreSQL — **absent** |
| `src/server/db/schema-parity.itest.ts` | 9 | Needs PostgreSQL — **absent** |

`npm run test:integration` **has never been run.** Docker is not installed, so
`npm run infra:up` cannot provide the database either.

## 10.4 Coverage gaps, ranked by risk

| Rank | Untested code | Lines | Why it matters |
|---|---|---|---|
| 1 | `providers/storage/local.ts` — **token signing / verification** | 198 | **Security-critical.** `verifyObjectToken` is the only thing standing between a URL and someone else's file. Zero tests. |
| 2 | `src/server/auth/repo.ts` | **1,204** | Sessions, OTP consumption, role grants, TOTP recovery codes. Zero tests. The largest untested file in the repo. |
| 3 | `domains/discovery/**` | ~1,740 | Zero tests. Enforces "verified shops only". |
| 4 | `domains/files/service.ts` | 333 | The three-step upload protocol itself. Zero tests. |
| 5 | `db/migrator.ts` | 536 | Drift detection, transactional apply. Zero tests, never executed. |
| 6 | `db/client.ts` | 364 | Pool, transactions, advisory locks, error translation. Zero tests. |
| 7 | `config/env.ts` + `config/index.ts` | 486 | Zero tests — and §1.7 shows it is currently unsatisfiable. |
| 8 | `domains/*/repo.ts` (all three) | 1,139 | All SQL. Zero tests, never run. |
| 9 | **Every React component** | ~3,400 | **No component test, render test, route test or E2E test exists anywhere.** |

## 10.5 The structural finding

> **The test suite cannot fail for any of the three bugs that make the product unusable.**

684 tests exercise pure functions. Nothing renders a component, nothing boots the app, nothing
issues an HTTP request, nothing touches a database. Green CI on this repository means "the pure
logic is self-consistent" — it does not mean the product works. **The first thing the next agent
should add, before any feature, is one smoke test that renders each route and asserts the error
boundary did not appear.** That single test would have caught all three failures.

## 10.6 Known failures

**None in the executable suite** (684/684 pass). The failures are runtime-only and invisible to
the suite: three error-boundary routes (§4). The two integration files have **unknown** status —
they have never been given a chance to pass or fail.

---

# 11. CODE QUALITY / TECHNICAL DEBT

**Nothing in this section was fixed.** It is a list, in rough severity order.

## 11.1 Production blockers

| # | Issue | Location | Severity |
|---|---|---|---|
| B1 | RSC boundary violation breaks 2 routes **in production too** | `open-state-badge.tsx:31` ← `shop-card.tsx:56`, `shops/[id]/page.tsx:124` | **CRITICAL** |
| B2 | `getStorage()` throws with the current env; **no S3 adapter exists at all** | `providers/storage/index.ts:36-52`, `order/new/page.tsx:110` | **CRITICAL** (also blocks any production deploy — production *requires* S3) |
| B3 | `env.ts` requires `DATABASE_URL`; the seams are designed to run without it | `config/env.ts` vs `*/source.ts` | **HIGH** |
| B4 | `env.ts` demands S3 keys when `STORAGE_PROVIDER=s3` while `storage/index.ts` treats their presence as "use S3" → **no env satisfies both** | `config/env.ts` `.superRefine` vs `providers/storage/index.ts` | **HIGH** |
| B5 | **No rate limiting on any entry point** | 496 lines of limiter with zero callers | **HIGH** |
| B6 | **No malware scanning** despite accepting arbitrary uploads | no provider exists | **HIGH** |
| B7 | **No retention/deletion job** while the UI promises 24-hour deletion | `order/new/page.tsx:135`, no worker | **HIGH** (privacy commitment unmet) |
| B8 | `getStorage()` throws **uncaught** inside `Result`-returning services | `files/service.ts:127,187,303` | **MEDIUM** |
| B9 | 3 of 4 persistent tabs are 404s | `customer-tab-bar.tsx:32-34` | **MEDIUM** (ships a broken navbar) |
| B10 | Geography columns appear to have no GiST index | `db/migrations/0003` | **MEDIUM** (verify on a live DB) |
| B11 | **Not a git repository** | no `.git` | **HIGH (process)** — no history, no diff, no rollback, no CI |
| B12 | **No README** | — | **LOW** but it is the first thing a new contributor looks for |

## 11.2 Broken imports / missing modules

**None.** Every import resolves and `tsc --noEmit` exits 0. Notably `upload-panel.tsx` correctly
imports `@/server/domains/files/limits` and `@/server/domains/files/model` **directly instead of the
barrel**, with a comment explaining why: the barrel re-exports `service.ts` → `repo.ts` → `pg`, and
webpack follows that into the client bundle even through a dynamic import, failing the build on
`net`/`tls`. **Preserve that import shape.**

## 11.3 Dead / unreachable code

The dominant form of debt in this repo. Approximate line counts with **zero reachable callers**:

| Area | Lines | Callers |
|---|---|---|
| `src/server/auth/**` (6 modules) | **2,668** | tests only |
| `src/server/core/{rbac,audit,rate-limit,config-store}` | **2,990** | tests only |
| `src/server/db/{client,migrator}` | 900 | none |
| `src/server/domains/*/repo.ts` | 1,139 | lazily, only when `DATABASE_URL` is set |
| `src/components/ui/field.tsx` | 356 | none — no form exists |
| `src/lib/order-status.ts` | 245 | none — no order screen exists |
| Unused skeletons (`OrderRowSkeleton`, `OrderListSkeleton`, `StatSkeleton`, `BentoSkeleton`, `TableSkeleton`) | in 134 | none |
| `BentoCell` / `BentoGrid` | in 175 | none — no dashboard exists |
| `scripts/node-test-shim/**` | — | none |
| **Rough total** | **≈ 8,500–9,000 lines (~27% of `src`)** | |

This is not necessarily *waste* — most of it is foundation waiting for its consumer. But per the
instruction it **must not be counted as functionality.**

## 11.4 Unused dependencies (declared, zero imports)

Verified by grepping every import in `src` and `scripts`:

`bullmq`, `web-push`, `qrcode`, `@types/qrcode`, `sharp`, `pdf-lib`, `nanoid`, `date-fns`,
`date-fns-tz`, `server-only`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`,
and **15 of the 16 `@radix-ui/*` packages** (only `@radix-ui/react-slot` is imported, in
`components/ui/button.tsx`) — accordion, checkbox, dialog, dropdown-menu, label, popover, progress,
radio-group, scroll-area, select, separator, switch, tabs, tooltip, visually-hidden.

**≈ 24 unused packages.** All are for planned work (queues, push, QR, image/PDF processing, S3,
richer UI), so they are premature rather than wrong. `nanoid` and `date-fns` are genuinely
redundant — `src/lib/ids.ts` and `src/lib/time.ts` implement those jobs by hand. **Not removed.**

## 11.5 Type / lint issues

**None outstanding.** `tsc --noEmit` and `eslint .` are both clean. `CHAAPO_STATUS.md` records that
13 typecheck errors and an ESLint-cannot-run condition were fixed in an earlier phase.
`exactOptionalPropertyTypes: false` is the one loosened strictness flag.

## 11.6 Architectural inconsistencies

1. **Two modules disagree on how storage is selected** (§11.1 B4) — `env.ts` keys off
   `STORAGE_PROVIDER`; `storage/index.ts` ignores it and keys off credential presence.
2. **`src/server/http/` holds one file** where the architecture calls for the whole Next-aware HTTP
   layer (route wrapper, auth context, CSRF, request identity). Server actions were used instead of
   `/api/v1`, which is a legitimate choice for the customer PWA but leaves the planned API absent
   and unversioned.
3. **`draft-identity.ts` deliberately bypasses `getConfig()`**, reading `process.env.SESSION_SECRET`
   directly with a random per-process fallback, "because `getConfig()` validates every provider key
   … the upload flow has to work on a laptop with nothing configured." Pragmatic and documented —
   but it means **restarting the dev server invalidates every draft cookie** when
   `SESSION_SECRET` is unset, and it is a second source of truth for a secret.
4. **`describeAvailability` duplicates `discovery/service.ts`'s `availabilityOf`** in spirit — the
   attempt to share one implementation between server and client is what caused B1.
5. **Discovery fixtures (608 lines) are a parallel data model** to the SQL schema, never
   cross-checked against it. Drift here will surface only when `DATABASE_URL` is first set.
6. **`readDraftAction` mints a cookie on page view**, contradicting the documented intent in
   `page.tsx` that a passive visitor never receives one (§2.J).

## 11.7 Misleading documentation — the largest integrity finding

**`IMPLEMENTATION_PLAN.md`** (660 lines, 52,422 bytes, mtime **2026-08-26 20:04**, i.e. **six days
stale**) is written in the **past tense** and asserts, among other things:

| Claim in `IMPLEMENTATION_PLAN.md` | Reality on disk |
|---|---|
| "MVP built in full", all MVP screens built | 3 routes exist, **all 3 broken** |
| 13 domains | **3** |
| `withRoute()` in `src/server/http/route.ts` | **file does not exist** |
| `/api/v1/**` | **does not exist** |
| 30-transition state machine in `domains/orders/state-machine.ts` | **file and directory do not exist** |
| `MockPaymentProvider` + `RazorpayRouteProvider` | **neither exists** |
| 4 notification adapters, `notification_outbox` | **none exist; no such table** |
| SSE hub | **does not exist** |
| `scripts/worker.ts` | **does not exist** |
| Seed data: 12 shops, ~24 orders | **no `scripts/seed.ts`; SQL seeds reference data only** |
| "37 tables" | migrations create **68** |

**Recommendation for the next agent: treat `IMPLEMENTATION_PLAN.md` as a design sketch of intent,
never as a status report.** `CHAAPO_TODO.md:70` already carries the note "Reconcile or delete
`IMPLEMENTATION_PLAN.md` — it overstates completion."

**`CHAAPO_TODO.md`** is stale in the opposite direction: its PHASE 2 checkboxes at lines 13–20 are
**unchecked although the files now exist**. Its "Known 404s" list (lines 66–69) and "Missing tests"
notes are accurate.

**`CHAAPO_STATUS.md`** (97 lines) is broadly accurate and usefully self-critical — it claims
"~25% of the domain layer, ~5% of the user journey" and records that an earlier bug meant "every
audit write would have failed at runtime". **`CHAAPO_HANDOFF.md`** (100 lines) has accurate run
instructions and environment caveats.

## 11.8 Security notes (observations, not exploits)

- ✅ CSP with a per-request nonce and `'strict-dynamic'` is applied (verified).
- ✅ No public file URLs; no `url` column; ownership is a query parameter.
- ✅ Signature-before-payload ordering in `auth/tokens.ts`.
- ✅ `env.ts` blocks `dev-only` secrets, `OTP_DEV_ECHO`, plaintext `APP_URL`, `S3_SSE=none`,
  `MALWARE_SCANNER=noop` and `mock` payments **in production**.
- ⚠️ `.env.local` contains **development placeholder secrets in plaintext** (`SESSION_SECRET`,
  `ENCRYPTION_KEY`, `PICKUP_TOKEN_SECRET`, `MOCK_PAYMENT_WEBHOOK_SECRET`, S3 keys) and there is **no
  `.git`**, so `.gitignore` is currently protecting nothing. **Rotate every one of these before the
  first real deployment, and confirm `.env.local` is ignored the moment `git init` is run.**
- ⚠️ The object-token signing code has **zero tests** (§10.4 rank 1).
- ⚠️ **No rate limiting** on the four server actions — including the one that reserves storage keys.
- ⚠️ **No malware scanning** on uploads.
- ⚠️ `dev-only-local-storage-secret` is a hard-coded fallback in `providers/storage/local.ts` when
  `SESSION_SECRET` is unset.

---

# 12. IMPLEMENTATION STATUS

Every percentage below is followed by its reasoning. Per the instruction, **volume of
infrastructure does not inflate the number.**

## A. Code written — **~35%**

38,122 lines exist across 148 files, and the quality is high. But measured against the PRD's
scope — 3 surfaces, ~47 screens, 13 domains, 6 provider capabilities, a worker, an API, realtime —
what is written is: the shared foundation (near-complete), 3 of 13 domains, 1 of 6 providers,
3 of ~47 screens, 0 of 1 API, 0 of 1 worker.
*Reasoning:* the horizontal foundation (money, result, errors, logger, rbac, audit, config-store,
rate-limit, crypto, pii, the 68-table schema, the design system) is perhaps 85% done and is roughly
half the total line count; the vertical features are ~8% done. Blend ≈ 35%.

## B. UI implemented — **~12%**

3 of ~47 planned screens exist (all customer-side), plus a genuinely complete component kit and
token layer. Shop surface: **0 of ~14**. Admin surface: **0 of ~12**. Remaining customer screens:
**0 of ~18**.
*Reasoning:* the design system (~1,450 lines of `ui/` + 447 lines of tokens) is real, reusable and
close to done — call it 70% of the *system*, but a system is not a screen. Screens: 3/47 ≈ 6%.
Weighted ≈ 12%.

## C. Backend implemented — **~30%**

*Reasoning:* schema 95% (68 tables, 240 indexes, 75 triggers — though **unapplied and unverified**);
core/cross-cutting 85%; auth logic 80% (but no session wiring, no login, no OTP delivery);
domains 3/13 ≈ 23% and none functioning; providers 1/6 ≈ 17% and the one that exists is broken;
API 0%; worker 0%; realtime 0%. Weighted ≈ 30%.

## D. End-to-end functionality — **~2%**

*Reasoning:* this measures *observed working behaviour*, and the honest observation is that
**not one customer screen renders.** What works end to end: the 404 page, the offline page, the
service-worker registration, the CSP. What does not: discovery, shop profile, upload, configure,
price, pay, order, track, pickup, review, shop dashboard, admin — all of it. A customer cannot
complete a single step of the core journey. 2%, not 0%, only because the shell, routing, styling and
error handling demonstrably work.

## E. MVP completion — **~15%**

*Reasoning:* the MVP is defined by a customer placing and collecting a paid print order, a shop
fulfilling it, and an admin verifying the shop. **Zero of those three journeys is completable.**
Of ~20 MVP capabilities, 0 are complete, ~6 are partial (discovery logic, file upload protocol,
pricing engine, auth logic, audit, config), ~14 are missing (orders, payments, payouts,
notifications, pickup, reviews, shop dashboard, shop onboarding/KYC, catalogue management, admin
console, privacy, analytics, realtime, worker). Partial credit for the deep foundation gives ≈ 15%.
This is close to `CHAAPO_STATUS.md`'s own honest self-assessment ("~25% of the domain layer, ~5% of
the user journey") and **nowhere near `IMPLEMENTATION_PLAN.md`'s claim of a complete MVP.**

## F. Production readiness — **~5%**

*Reasoning:* three live runtime failures; the schema has **never touched a PostgreSQL server**; no
S3 adapter exists so production storage is impossible by construction; `env.ts` cannot currently be
satisfied; no rate limiting; no malware scanning; no retention job; no payments; no auth; no
worker; no CI; **no version control**; no README; ~24 unused dependencies; development placeholder
secrets in a plaintext file that nothing is ignoring. The 5% credits real production-grade
groundwork: CSP with nonce, private-file architecture, integer-paise money, audit immutability
guards, drift-detecting migrator, production env guardrails.

## Summary

| Dimension | Estimate |
|---|---|
| A. Code written | **~35%** |
| B. UI implemented | **~12%** |
| C. Backend implemented | **~30%** |
| D. End-to-end functionality | **~2%** |
| E. MVP completion | **~15%** |
| F. Production readiness | **~5%** |

> **The gap between A (35%) and D (2%) is the single most important number in this document.**
> There is a large, well-built foundation and almost no working product on top of it. The next
> phase of work should be measured by D, not by A.

---

# 13. WHAT IS LEFT TO BUILD

**Ordered by dependency, not by screen.** The rule throughout: *database → provider → domain →
API/action → UI → test*. **Do not implement any of this now; this is the plan, not the work.**

## Phase 0 — Make the existing product visible (½–1 day) · **DO THIS FIRST**

**Objective:** the three routes that already exist render. No new features.

| Step | Files | What |
|---|---|---|
| 0.1 | **`git init`**, first commit | There is no version control. Do this before touching anything, so every later step is revertible. Confirm `.env.local` is ignored (it is listed in `.gitignore`). |
| 0.2 | Move `describeAvailability` out of the `'use client'` module | Relocate from `components/discovery/open-state-badge.tsx` to a server-safe module (`src/lib/` or `src/server/domains/discovery/`; note `service.ts` already has `availabilityOf`). Update the 3 importers: `open-state-badge.tsx`, `shop-card.tsx:16`, `shops/[id]/page.tsx:30`. |
| 0.3 | Reconcile the storage seam | Decide the contract: `storageSource()` should honour `STORAGE_PROVIDER` rather than credential presence, **and** `env.ts`'s `superRefine` must agree with it. Then either write the S3 adapter behind `StoragePort` or make development reliably select `local-dev-disk`. Fix the misleading `notImplemented` message either way. |
| 0.4 | Wrap `getStorage()` so it returns `Result` | `files/service.ts:127,187,303` — a seam failure should be a message, not an unhandled action error. |
| 0.5 | **Verify by execution** | Load `/`, `/shops/[id]`, `/order/new?shop=…` in a browser. **Actually upload a PDF end to end** — this has never been done. Confirm bytes land under `.chaapo-storage/`, `completeUpload` reports a real page count, and a rejected file shows its reason. |
| 0.6 | Add the smoke test that would have caught all of this | A render/route test per route asserting the error boundary is absent. **This is the highest-value test in the repo.** |
| 0.7 | Stub or hide the 3 dead tabs | `/map`, `/orders`, `/account` — either minimal "coming soon" routes or remove them from `customer-tab-bar.tsx`. A 404 behind a persistent tab is worse than an absent tab. |

**Acceptance:** all three routes render real content in a browser; one file uploads and is
inspected successfully; `typecheck`, `lint`, `test` still green; smoke tests added and passing.
**Blockers:** none. **This phase needs no database, no Docker and no new dependency.**

## Phase 1 — Prove the database (1 day)

**Objective:** the 5,493 lines of SQL are executed by PostgreSQL for the first time.

| Step | What |
|---|---|
| 1.1 | Install Docker, then `npm run infra:up` (postgres+postgis, redis, minio, mailpit, clamav) |
| 1.2 | **Restore `DATABASE_URL` in `.env.local`** — it is currently commented out at line 27 with an explanation. Uncomment it once Postgres is up. |
| 1.3 | `npm run db:migrate` — expect first-run SQL errors; fix by **adding** migrations, never editing applied ones (the migrator does checksum drift detection) |
| 1.4 | `npm run db:status` — confirm all 11 applied |
| 1.5 | Resolve the `env.ts` contradictions from §1.7 so `loadEnv()` actually parses |
| 1.6 | `npm run test:integration` — run the 40 integration tests for the first time (`config-store.itest.ts`, `schema-parity.itest.ts`) |
| 1.7 | Write `scripts/seed.ts` — port `discovery/fixtures.ts` (~18 shops) and `pricing/fixtures.ts` (12 catalogues) into real rows, so both seams can be compared |
| 1.8 | Add the missing GiST index on the geography columns if §8.3 is confirmed |
| 1.9 | Flip each seam to the database path and re-verify Phase 0's screens against real rows |

**Acceptance:** migrations applied; `schema-parity.itest.ts` passes; discovery renders from Postgres,
not fixtures; both storage paths verified.
**Blockers:** **Docker is not installed on the current machine** — this phase cannot start until it
is, or until an external Postgres+PostGIS is reachable.

## Phase 2 — Identity and sessions (2–3 days)

**Objective:** wake up the 2,668 lines of auth logic that nothing calls.

| Step | What |
|---|---|
| 2.1 | Build `src/server/http/` for real: `route.ts` (`withRoute()` wrapper), auth context, CSRF, request identity, error→HTTP mapping. **This is the layer the whole API depends on.** |
| 2.2 | `src/server/providers/notifications/port.ts` + an SMS/OTP dev adapter (`OTP_DEV_ECHO` already exists) |
| 2.3 | `domains/identity/service.ts` composing `auth/{otp,password,policy,repo,tokens,totp}` |
| 2.4 | `/api/v1/auth/*`: request-otp, verify-otp, session, refresh, logout, mfa — **with `enforceRateLimit()` wired in**, the first real use of `core/rate-limit.ts` |
| 2.5 | Session middleware; upgrade the anonymous `chaapo_draft` cookie to a real user on login **without losing the draft** (PRD R14) |
| 2.6 | C-17 login/OTP screen (`ui/field.tsx` is waiting, unused) |
| 2.7 | First real `recordAudit()` calls — login, logout, role grant |
| 2.8 | Tests for `auth/repo.ts` (currently 1,204 lines, 0 tests) |

**Acceptance:** a phone number logs in, a session persists across reload, an anonymous draft
survives login, rate limits reject a flood, audit rows are written with their own `newId()`.
**Depends on:** Phase 1.

## Phase 3 — Orders and the state machine (3–4 days)

**Objective:** an order exists as a server-enforced state machine (PRD R11, R12).

| Step | What |
|---|---|
| 3.1 | `domains/orders/model.ts` + `state-machine.ts` — declare every legal transition explicitly; refuse illegal ones server-side. `orderStateEnum` and `order_state_transitions` already define the vocabulary; `src/lib/order-status.ts` is the ready-made view model. |
| 3.2 | `domains/orders/repo.ts` + `service.ts` — create, list, detail, transition, cancel; **every transition writes `order_events` and an audit row inside the same transaction** (`withTransaction` exists) |
| 3.3 | Idempotency: use `idempotency_keys` + `newIdempotencyKey()` on every transition and creation |
| 3.4 | Price snapshotting (R9): freeze the quote onto the order at placement using `quotes` and `isQuoteFresh()` |
| 3.5 | `/api/v1/orders/**` via `withRoute()` |
| 3.6 | Unit tests for every legal and illegal transition — this is the highest-value test suite in the whole project |

**Acceptance:** an order is created, advances only through legal transitions, refuses illegal ones,
and every move is auditable and idempotent.
**Depends on:** Phases 1–2.

## Phase 4 — Complete the customer order journey (3–4 days)

**Objective:** a customer goes from files to a placed, priced order. **This finally consumes the
694-line pricing engine.**

| Step | What |
|---|---|
| 4.1 | **C-08 Choose print options** — the next intended step when work stopped. Per-file: colour mode, sides, paper size, copies, page ranges, finishings. `ui/field.tsx` (`Segmented`, `OptionCard`, `Select`) exists for exactly this. |
| 4.2 | Wire `pricing/service.ts` → `quoteForShop()` and show a live price using `ui/money.tsx` |
| 4.3 | Handle `QuoteBlock` honestly — the quote-required path (R10) already exists in the engine; render it as "this needs a quote from the shop", never as a fake price |
| 4.4 | **C-09** review & price summary |
| 4.5 | **C-11** confirmation, **C-12/C-13** tracking + list (reuse `order-status.ts`, `OrderListSkeleton`) |
| 4.6 | Re-enable the `disabled` button at `upload-panel.tsx:334` **only when C-08 actually exists** |

**Acceptance:** upload → configure → see a real price computed by the engine → place an order that
lands in Postgres with a snapshotted quote. **Still no payment.**
**Depends on:** Phase 3.

## Phase 5 — Payments, the marketplace way (4–5 days) · **highest-risk phase**

**Objective:** money moves correctly, and never through Chaapo's own account (PRD R6, R7, R13).

| Step | What |
|---|---|
| 5.1 | `providers/payments/port.ts` — intent creation, status, refund, split/transfer, webhook verification |
| 5.2 | `MockPaymentProvider` — a real state machine with HMAC-signed webhooks posted back to `/api/v1/webhooks/payments`, supporting forced `fail`/`timeout`/`duplicate` outcomes. `MOCK_PAYMENT_WEBHOOK_SECRET` is already configured. |
| 5.3 | `RazorpayRouteProvider` — sub-merchant accounts, split settlement, **on-hold transfers**. `middleware.ts` already allows Razorpay in `frame-src`. |
| 5.4 | `domains/payments/**` — payments, refunds, ledger entries, `shop_balances`, invoices |
| 5.5 | **Webhook idempotency** via `payment_webhook_events` — process exactly once, tolerate replays and out-of-order delivery |
| 5.6 | Funds held until verified collection: `order_holds` + payout release on pickup verification |
| 5.7 | **C-10** checkout screen; recover cleanly from an abandoned or timed-out payment (R14) |
| 5.8 | Double-entry assertions in tests: **every ledger must balance** |

**Acceptance:** mock provider completes, fails, times out and duplicates without corrupting state;
the ledger balances; funds show as held, not released; no code path pools money in a platform
account. **Never fake a payment success.**
**Depends on:** Phase 3. **Risk:** highest in the project — do it with tests first.

## Phase 6 — Shop surface (4–5 days)

**Objective:** a shop can actually receive and fulfil the order the customer placed.

`domains/shops/**` (profile, hours, closures, staff, capabilities) → shop auth + RBAC scoping
(`core/rbac.ts` already models shop roles) → `/api/v1/shop/**` → screens: onboarding, KYC upload,
dashboard (`BentoGrid`/`BentoCell` are waiting), job queue, job detail, mark-ready,
**pickup verification (R8: verify the code/QR, then release funds)**, catalogue & pricing
management (`shop_price_history` is the audit trail), hours, staff, payouts, settings.

**Acceptance:** a shop sees the order, moves it through the state machine, verifies a pickup code,
and the payout releases. **This is the first point at which the marketplace loop closes.**
**Depends on:** Phases 3–5.

## Phase 7 — Notifications, realtime, worker (3–4 days)

**Objective:** both sides find out what happened without refreshing.

`providers/notifications/**` (WhatsApp utility templates, SMS with TRAI DLT headers, SMTP→Mailpit,
web-push VAPID — `web-push` is already installed) → `domains/notifications/**` (templates,
outbox-style dispatch, deliveries, provider calls) → **`scripts/worker.ts` with BullMQ** (installed,
never imported; `WORKER_CONCURRENCY`/`WORKER_ENABLED` already configured) → `src/server/realtime/`
SSE hub over Redis pub/sub (CSP already permits it) → **the retention job that finally keeps the
24-hour deletion promise (R4)** → the malware-scan job (ClamAV, R2/B6) → session and OTP cleanup
(`deleteExpiredSessions`, `deleteExpiredOtpChallenges` exist with no caller) → analytics rollups
into `shop_daily_stats` / `platform_daily_stats`.

**Acceptance:** a state change pushes to both surfaces within seconds; an abandoned draft is
genuinely deleted after 24 h; an infected file is quarantined.
**Depends on:** Phases 3–6.

## Phase 8 — Admin console (3–4 days)

`domains/admin/**` → `/api/v1/admin/**` → screens: overview, shop verification queue (R1 gate),
orders, payments, payouts, refunds, disputes, users, **platform config + feature flags (the
891-line `config-store.ts` finally gets its UI)**, notification inspector, audit log viewer,
privacy requests. **Every money/verification/privacy/override action must be reason-required and
audited (R17)** — `MIN_REASON_LENGTH` and `AUDIT_ACTIONS` already exist for this.

**Depends on:** Phases 2–7.

## Phase 9 — Privacy, reviews, remaining screens (2–3 days)

`domains/privacy/**` (export, erasure, consent, retention reporting; `'privacy_export'` and
`'unsubscribe'` token purposes already exist) → `domains/reviews/**` (submission via `mayRate`,
moderation, aggregation, `MIN_RATINGS_TO_DISPLAY`) → `/s/[slug]` short-link route handler
(`newQrSlug` exists) → `/map` (`NEXT_PUBLIC_MAP_PROVIDER`) → `/account` → `/legal/{terms,privacy,refunds}`
→ `/support`.

## Phase 10 — Hardening and production (3–5 days)

Rate limiting on **every** entry point · **S3 adapter behind `StoragePort` with SSE-KMS
(`aws:kms`, customer-managed key, ap-south-1)** · CI pipeline running `npm run verify` ·
health/readiness endpoints using the existing `checkDbHealth`/`checkRedisHealth` ·
observability wiring for `core/logger.ts` · **rotate every secret currently in `.env.local`** ·
remove or use the ~24 unused dependencies · write a README · load-test the PostGIS radius query ·
E2E suite for all three surfaces · **reconcile or delete `IMPLEMENTATION_PLAN.md`**.

## Effort summary

| Phase | Estimate | Blocked by |
|---|---|---|
| 0 — Make it visible | ½–1 day | nothing |
| 1 — Prove the database | 1 day | **Docker/Postgres** |
| 2 — Identity | 2–3 days | 1 |
| 3 — Orders | 3–4 days | 2 |
| 4 — Customer journey | 3–4 days | 3 |
| 5 — Payments | 4–5 days | 3 |
| 6 — Shop surface | 4–5 days | 5 |
| 7 — Notifications/realtime/worker | 3–4 days | 6 |
| 8 — Admin | 3–4 days | 7 |
| 9 — Privacy/reviews/rest | 2–3 days | 8 |
| 10 — Hardening | 3–5 days | all |
| **Total** | **≈ 29–39 focused days** | |

---

# 14. START HERE IN VS CODE

## 14.1 What you are inheriting

A **Next.js 15 / React 19 / TypeScript modular monolith**, 148 source files, **38,122 lines**, with:

- a **68-table PostgreSQL + PostGIS schema** in 11 hand-written migrations (5,493 lines) that has
  **never been applied to a real database**;
- an excellent **shared foundation** — integer-paise money, `Result`/`AppError`, structured logging,
  a 952-line RBAC capability catalogue, a 651-line audit catalogue, an 891-line platform-config
  store, rate limiting, crypto/PII;
- **3 of 13 domains** (`discovery`, `pricing`, `files`);
- **1 of 6 providers** (storage — development disk only, and its seam is broken);
- **3 of ~47 screens**, all customer-side, **all three currently rendering an error boundary**;
- **684 passing unit tests** that cannot detect any of those failures;
- **no version control, no README, no CI, no API, no worker.**

## 14.2 What NOT to redo — this code is good, reuse it

| Do not rewrite | Why |
|---|---|
| `src/lib/money.ts` | Integer paise as `bigint`, basis points, allocation, GST. 33 tests. Correct. |
| `src/lib/{ids,time,phone,digits}.ts` | IDs, order numbers, pickup codes, IST time, Indian phone handling. 126 tests. |
| `src/server/core/**` | ~4,400 lines of errors/result/logger/audit/rbac/rate-limit/crypto/pii/config-store. 296 tests. |
| `src/server/auth/**` | 2,668 lines of OTP/password/TOTP/session-policy/repo. Needs *wiring*, not rewriting. |
| `db/migrations/**` + `src/server/db/schema/**` | The schema is the most complete artefact here. **Never edit an applied migration** (the migrator detects checksum drift) — add new ones. |
| `src/server/domains/pricing/engine.ts` | 694 lines, 73 tests, including the quote-required path. |
| `src/server/domains/files/**` | The three-step never-proxy-bytes upload protocol. Architecturally right. |
| `src/components/ui/**` + `src/app/globals.css` | The design system. `field.tsx` (356 lines) is fully built and completely unused — use it for C-08 and the login screen. |
| `src/middleware.ts` | Per-request CSP nonce, correct. |

## 14.3 What NOT to assume works

| Do not assume | Reality |
|---|---|
| "The MVP is built" (`IMPLEMENTATION_PLAN.md`) | **False.** See §11.7 — that document is six days stale and describes a system that does not exist. |
| "Green tests mean it works" | 684 tests pass and **no page renders**. Nothing in the suite renders a component or issues a request. |
| "The schema is verified" | **It has never been parsed by PostgreSQL.** |
| "Upload works" | **No file has ever been uploaded through this app.** The route handler has never received a byte. |
| "Discovery is verified" | 1,740 lines, **zero tests**, and its pages throw. |
| "The env config is usable" | It currently is not — see §1.7. Two contradictions. |
| "`/api/v1` exists" | It does not. Four server actions are the entire application API. |
| "There is a worker / state machine / payment provider / SSE hub" | None of these files exist. |
| "There's a git history to consult" | **There is no `.git` directory.** |
| "`CHAAPO_TODO.md` checkboxes reflect reality" | PHASE 2 items are unchecked although the files exist. Its 404 list *is* accurate. |

## 14.4 Verify these five things before writing any code

```bash
npm run typecheck && npm run lint && npm run test
```
Expect: exit 0, exit 0, 684/684. If not, the tree changed since this audit.

```bash
npm run dev:offline
```
Then, in a real browser (not curl — status codes are 200 even when the page fails):
1. Open `/`. **Expect the error boundary, digest 2044459844.** If you see shop cards, someone
   already fixed §4.1.
2. Open a shop profile. **Expect digest 2791453749.**
3. Open `/order/new?shop=<slug>`. **Expect digest 139087369.**
4. Open `/offline`. **Expect it to work** — this is your control.
5. Read `.env.local` lines 22–27 and 44–51, and confirm §1.7's two contradictions still hold.

**Note:** `CHAAPO_OFFLINE_FONTS=1` is needed only where `fonts.googleapis.com` is blocked.
**Never set it in production.**

## 14.5 The correct dependency order (do not deviate)

```
git init
   ↓
Phase 0  fix the two render bugs, verify a real upload, add smoke tests   ← NO DATABASE NEEDED
   ↓
Phase 1  Docker → migrate → integration tests → seed → flip the seams
   ↓
Phase 2  http layer (withRoute) → identity → auth API → login screen
   ↓
Phase 3  orders domain + explicit server-enforced state machine
   ↓                              ↓
Phase 4  customer journey     Phase 5  payments (mock first, then Razorpay Route)
   ↓                              ↓
Phase 6  shop surface + pickup verification + payout release
   ↓
Phase 7  notifications + realtime + worker (retention, malware, rollups)
   ↓
Phase 8  admin console      →   Phase 9  privacy/reviews/rest   →   Phase 10  hardening
```

Within every phase: **database → provider → domain → API/action → UI → test.**

## 14.6 Your first implementation phase, concretely

**Phase 0. Nothing else. It takes under a day and turns 0 working screens into 3.**

1. `git init`, `git add -A`, first commit. Verify `.env.local` is ignored.
2. Move `describeAvailability` out of `components/discovery/open-state-badge.tsx` into a
   server-safe module; update its 3 importers (§4.1).
3. Reconcile `storageSource()` with `env.ts` on what selects storage; make development
   deterministically choose `local-dev-disk`; fix the misleading `notImplemented` message (§4.2).
4. Make `getStorage()` failures return `Result` instead of throwing through
   `files/service.ts:127,187,303`.
5. **Upload a real PDF in a real browser.** Confirm bytes on disk under `.chaapo-storage/`, a real
   page count from `inspectPdf`, and a rejected file showing its own reason.
6. Add one smoke test per route asserting the error boundary is absent.
7. Either stub or remove the `/map`, `/orders`, `/account` tabs.
8. Re-run `npm run verify`.

**Stop there and re-assess.** Do not start C-08 until a file has genuinely uploaded.

## 14.7 Inspect these before touching code, in this order

1. `CHAAPO_STATUS.md`, `CHAAPO_HANDOFF.md`, `CHAAPO_TODO.md` — accurate; then **ignore
   `IMPLEMENTATION_PLAN.md`** except as a design sketch.
2. `eslint.config.mjs` — the layering rules are mechanical and will reject architecture violations.
3. `src/server/core/{errors,result}.ts` — every domain returns `Result<T, AppError>`;
   `errors.validation` takes `FieldError[]`.
4. `src/lib/money.ts` — before writing any code that touches money.
5. `src/server/domains/discovery/source.ts` (and the `pricing`/`files` twins) — the seam pattern,
   including the **lazy** `repo.ts` import.
6. `src/server/domains/files/service.ts` + `app/(customer)/order/new/{actions.ts,upload-panel.tsx}` —
   the reference implementation for a full vertical slice.
7. `db/migrations/0001_extensions_and_types.sql` and `0010_immutability_and_guards.sql` — the enums
   and the append-only guards you must not fight.
8. `src/server/config/env.ts` — so §1.7's contradictions do not surprise you.
9. `src/middleware.ts` — before adding any script, iframe or external connection.

## 14.8 Traps that will cost you a day each

1. **A plain helper exported from a `'use client'` file cannot be called by a server component.**
   This is the bug behind two of the three broken routes, and it fails in production too.
2. **Do not import the `files` barrel from a client component.** It re-exports `service.ts` →
   `repo.ts` → `pg`, and webpack follows it into the client bundle even through a dynamic import,
   failing the build on `net`/`tls`. Import `files/limits` and `files/model` directly, as
   `upload-panel.tsx` already does — and read the comment there before "tidying" it.
3. **`getConfig()` throws with the current `.env.local`** because `DATABASE_URL` is required. It is
   reached only from `core/pii.ts`, `core/redis.ts` and `db/client.ts` today; the first feature that
   needs PII, Redis or the database will hit it.
4. **Money never becomes a `number`.** Paise as `bigint`, serialised as a decimal string across the
   RSC/JSON boundary.
5. **`audit_logs.id` and `platform_config_history.id` have no DB default** — pass `newId()`. This
   already caused a bug where every audit write failed at runtime.
6. **`paper_sizes.code` is UPPERCASE** and is an FK target from `files.dominant_page_size`.
7. **Never edit an applied migration** — the migrator detects checksum drift and refuses to run.
8. **Relative imports inside `src/server`**; `@/*` only in `src/app` and `src/components` (the
   worker will run without the alias).
9. **Never set `CHAAPO_OFFLINE_FONTS` in production.**
10. **Do not trust a 200.** All three broken routes return HTTP 200 and then swap in the error
    boundary client-side. Assert on rendered content.

---

# 15. FINAL HANDOFF

## A. WHAT IS DONE

*Complete and verified by execution, or complete as an artefact:*

1. **Project scaffolding** — Next.js 15 App Router, React 19, TS 5.7 strict, Tailwind v4, Vitest ×2
   configs, ESLint with mechanical layering enforcement, PostCSS, Drizzle config, docker-compose for
   the full local stack.
2. **Design system** — 7 UI modules (~1,450 lines) + a 447-line token layer. Warm paper/ink/chaap
   palette, Instrument Serif + Inter + IBM Plex Mono, glass/clay/bento surfaces used selectively as
   the brief requires. Renders correctly.
3. **Shared libraries (~1,300 lines, 126 tests)** — integer-paise money with GST and allocation,
   IDs/order numbers/pickup codes, IST time and weekly-hours logic, Indian phone normalisation.
4. **Core infrastructure (~4,400 lines, 296 tests)** — `AppError`/`Result`, structured logging with
   async context and redaction, a 952-line RBAC capability catalogue, a 651-line audit action
   catalogue, an 891-line platform-config store with history and feature flags, a 496-line rate
   limiter (memory/Redis/noop), AES-256-GCM + scrypt crypto, PII protect/reveal/hash.
5. **Database schema as an artefact** — 11 migrations, 5,493 lines, 68 tables, 14 enums,
   240 indexes, 75 triggers, 21 functions, 267 CHECKs, 157 FKs, reference-data seeds, immutability
   guards; mirrored by 68 Drizzle `pgTable` definitions and a checksum-drift-detecting migrator.
6. **Auth logic (2,668 lines, 145 tests)** — OTP lifecycle, password policy and strength, TOTP with
   recovery codes, per-surface session policy and cookie builders, non-JWT composite and signed
   tokens with signature-before-payload verification, and a 1,204-line auth repository.
7. **Pricing engine (694 lines, 85 tests)** — bands, sheets, sides, finishings, GST, rupee rounding,
   and the quote-required path the PRD demands.
8. **CSP middleware** — per-request nonce, `'strict-dynamic'`, verified applied.
9. **PWA basics** — manifest, service worker + registration, working offline page, icon set.
10. **Working routes** — `/offline` and the 404 page. **These are the only two.**
11. **684 unit tests passing**, `typecheck` clean, `lint` clean.

## B. WHAT IS PARTIALLY DONE

1. **Discovery** — 1,740 lines (model, service, PostGIS repo, seam, ~18 dev shops). Verified-only
   filtering implemented. **Zero tests. Its pages throw.**
2. **Files/uploads** — the complete three-step never-proxy-bytes protocol, magic-byte sniffing, PDF
   page/size inspection, in-memory and database stores, dev object store with signed tokens, a route
   handler, four server actions, a 549-line client panel. **Never executed once.**
3. **Pricing** — engine and service complete and well tested; **no UI consumes them.**
4. **Auth** — logic complete; **no login screen, no session middleware, no API, no caller.**
5. **RBAC / audit / rate limiting / config store** — engines complete; **zero callers.**
6. **Draft identity** — signed `chaapo_draft` cookie implemented; works only on a page that throws;
   mints on page view, contrary to its own documented intent.
7. **Pickup verification** — code/QR *primitives* exist and are tested; no flow, no QR rendering.
8. **Price snapshotting** — `quotes` table + `isQuoteFresh()`; nothing to snapshot onto.
9. **PWA** — installable and offline-capable; **push notifications missing entirely.**
10. **Observability** — logger built, partially wired, no sink.

## C. WHAT IS MISSING

**Domains (10 of 13):** orders, payments, payouts, notifications, reviews, privacy, analytics,
shops (owner-side), catalogue management, admin.
**Providers (5 of 6):** payments (mock + Razorpay Route), notifications (WhatsApp/SMS/SMTP/push),
geo, malware scanning, document processing.
**Whole layers:** `/api/v1/**` (all of it), `src/server/http/` beyond one file (no `withRoute()`,
no auth context, no CSRF), `src/server/realtime/` (no SSE), `src/server/queue/` and
`scripts/worker.ts` (no worker at all — **so no retention job, no notification dispatch, no payout
runs, no analytics rollups, no session/OTP cleanup**).
**Surfaces:** the entire shop dashboard (~14 screens), the entire admin console (~12 screens).
**Customer screens:** C-03 map, C-06 short link, C-08 print options, C-09 summary, C-10 checkout,
C-11 confirmation, C-12/13 tracking + list, C-14 pickup, C-15 rating, C-16 account, C-17 login,
C-20 legal, C-21 support.
**Data:** `scripts/seed.ts` — no demo shops, orders or users in SQL.
**Process:** **version control**, CI, README, health endpoints, E2E tests, an S3 adapter.

## D. WHAT IS BROKEN

| # | Broken thing | Digest | Root cause | Fix location |
|---|---|---|---|---|
| 1 | `/` — discovery home | **2044459844** | `describeAvailability` exported from a `'use client'` module, called from the server component `ShopCard` (~18 throws/render) | `open-state-badge.tsx:31` → `shop-card.tsx:56` |
| 2 | `/shops/[id]` — shop profile | **2791453749** | same class of violation | `open-state-badge.tsx:31` → `shops/[id]/page.tsx:124` |
| 3 | `/order/new` — add files | **139087369** | S3 credentials present in `.env.local` push `storageSource()` to `'s3'`; `getStorage()` throws because **no S3 adapter exists** | `providers/storage/index.ts:36-52` → `order/new/page.tsx:110` |
| 4 | The whole upload flow | — | same `getStorage()` throw, **uncaught**, inside `beginUpload`/`completeUpload`/`removeFile` | `files/service.ts:127,187,303` |
| 5 | 3 of 4 persistent tabs | — | `/map`, `/orders`, `/account` do not exist | `customer-tab-bar.tsx:32-34` |
| 6 | `env.ts` cannot be satisfied | — | `DATABASE_URL` required but deliberately commented out; and `STORAGE_PROVIDER=s3` demands the very S3 keys that break `getStorage()` | `config/env.ts` vs `providers/storage/index.ts` |
| 7 | The misleading error message | — | tells you to set `APP_ENV=development`, which is already set and is not the failing condition | `providers/storage/index.ts:49-51` |
| 8 | `IMPLEMENTATION_PLAN.md` | — | describes a system that does not exist | the document itself |

**Consequence, stated plainly: there is currently no working customer screen and no reachable route
into the order flow.**

## E. WHAT WAS BEING WORKED ON WHEN STOPPED

**The C-07 "Add your files" upload slice.** `src/app/(customer)/order/new/page.tsx` is the most
recently modified source file (mtime **2026-09-01 20:40**).

**Five new source files** were created in that final push —
`src/server/http/draft-identity.ts`, `order/new/page.tsx`, `order/new/upload-panel.tsx`,
`order/new/actions.ts`, `api/storage/local/[...key]/route.ts` — **plus one modification**,
`src/server/auth/tokens.ts`, to add the `'draft_owner'` signed-token purpose.
The `providers/storage/**` and `domains/files/**` trees were written in the same effort.

**Last completed step:** the slice was written end to end and `typecheck`/`lint`/`test` were green.
**Next intended step:** C-08 "Choose print options" — **not started**; its button is deliberately
`disabled` at `upload-panel.tsx:334`.
**What was never done:** *the slice was never opened in a browser.* The three error-boundary
failures were discovered by this audit, after work had already stopped. **No file has ever been
uploaded through this application.**

## F. WHAT VS CODE SHOULD CONTINUE FROM

**Start at §14.6 — Phase 0. Do not start C-08.**

Turn 0 working screens into 3, then verify one real upload:
`git init` → move `describeAvailability` to a server-safe module → reconcile the storage seam with
`env.ts` → make `getStorage()` failures return `Result` → **upload a real PDF in a real browser** →
add one smoke test per route asserting the error boundary is absent → stub or remove the three dead
tabs → `npm run verify`.

Only then continue in the order set out in §14.5.

## G. FULL REMAINING IMPLEMENTATION ROADMAP

Detailed in §13. In dependency order:

| Phase | Objective | Estimate |
|---|---|---|
| **0** | Make the existing product visible; verify a real upload | ½–1 day |
| **1** | Prove the database: Docker → migrate → integration tests → seed → flip the seams | 1 day |
| **2** | `src/server/http/` + identity + auth API + login screen; first real audit and rate-limit calls | 2–3 days |
| **3** | Orders domain with an explicit, server-enforced, idempotent, audited state machine | 3–4 days |
| **4** | Customer journey C-08 → C-13; finally consume the pricing engine | 3–4 days |
| **5** | Payments: port → mock provider with signed webhooks → Razorpay Route; funds held, ledger balances | 4–5 days |
| **6** | Shop surface: onboarding, KYC, dashboard, job queue, pickup verification, payout release | 4–5 days |
| **7** | Notifications, SSE realtime, and the worker (retention, malware scan, rollups, cleanup) | 3–4 days |
| **8** | Admin console with reason-required audited actions | 3–4 days |
| **9** | Privacy, reviews, short links, map, account, legal, support | 2–3 days |
| **10** | Hardening: rate limits everywhere, S3+KMS adapter, CI, health probes, secret rotation, README, E2E | 3–5 days |
| | **Total** | **≈ 29–39 focused days** |

## H. KNOWN RISKS / BLOCKERS

| Risk | Impact | Mitigation |
|---|---|---|
| **No version control** | No history, no rollback, no diff, no CI. Every change so far is unrecoverable. | **`git init` before anything else.** |
| **Docker not installed on this machine** | Phase 1 cannot start; migrations, integration tests and the whole database path stay unverified. | Install Docker, or point `DATABASE_URL` at an external Postgres 16 + PostGIS 3.4. |
| **5,493 lines of SQL never parsed by PostgreSQL** | First `db:migrate` will likely fail somewhere. 68 tables, 75 triggers, 21 functions of untested DDL. | Budget a day. Fix with *new* migrations only. |
| **No S3 adapter exists** | Production storage is impossible by construction; `getStorage()` throws. | Write it behind `StoragePort` (Phase 0/10). `@aws-sdk/*` is already installed. |
| **`env.ts` currently unsatisfiable** | The first feature needing PII, Redis or the DB will fail to boot. | Resolve §1.7's two contradictions early. |
| **Payments (Phase 5) is the highest-risk work** | Real money; PRD forbids pooled funds; needs idempotency under replay and out-of-order webhooks. | Mock provider with forced fail/timeout/duplicate first; ledger-balance assertions in tests; never fake a success. |
| **Security-critical token signing has zero tests** | `verifyObjectToken` is all that protects one customer's file from another. | Test it in Phase 0. |
| **1,204-line `auth/repo.ts` has zero tests** | Sessions, OTP consumption, role grants. | Test in Phase 2. |
| **Discovery has zero tests** | 1,740 lines gating "verified shops only". | Test in Phase 0/1. |
| **No rate limiting anywhere** | Abuse of OTP, uploads, storage-key reservation. | Wire `enforceRateLimit()` from Phase 2 onward. |
| **No malware scanning** | Arbitrary uploads served to shop owners. | Phase 7, ClamAV is already in compose. |
| **No retention job** | The UI promises 24-hour deletion; the code does not deliver it. **A stated privacy commitment is currently unmet.** | Phase 7. |
| **Development secrets in plaintext `.env.local` with no `.gitignore` in effect** | Leak risk the moment the repo is published. | Rotate all of them; confirm the ignore rule after `git init`. |
| **Test suite cannot catch render failures** | A green suite hid three broken pages. | Add route smoke tests in Phase 0. |
| **`IMPLEMENTATION_PLAN.md` misleads** | An agent trusting it will skip work it thinks is done. | Treat as a sketch; reconcile or delete. |
| **Fixtures may drift from the SQL schema** | The dev path (~18 shops, 12 catalogues in TypeScript) has never been cross-checked against the tables. | Phase 1.7 seed script. |
| **~24 unused dependencies** | Supply-area surface and confusion about what is in play. | Use or remove in Phase 10. |

## I. VERIFICATION CHECKLIST

**Baseline — confirm the tree matches this audit**

- [ ] `npm run typecheck` → exit 0
- [ ] `npm run lint` → exit 0, no output
- [ ] `npm run test` → 22 files, 684/684 passing
- [ ] `npm run dev:offline` starts
- [ ] `/` shows the error boundary, digest **2044459844**
- [ ] a shop profile shows digest **2791453749**
- [ ] `/order/new?shop=<slug>` shows digest **139087369**
- [ ] `/offline` renders correctly (control)
- [ ] `/nope` renders the branded 404
- [ ] `/map`, `/orders`, `/account` are 404s
- [ ] `find src/server/domains -maxdepth 1 -type d` lists only `discovery`, `files`, `pricing`
- [ ] `src/app/api/` contains only `storage/local/[...key]/route.ts`
- [ ] `scripts/worker.ts`, `src/server/http/route.ts`, `src/server/realtime/`, `src/app/shop/`, `src/app/admin/` do **not** exist
- [ ] no `.git` directory; no `README.md`

**Phase 0 exit criteria**

- [ ] `git init` done, first commit made, `.env.local` confirmed ignored
- [ ] `describeAvailability` lives in a server-safe module; all 3 importers updated
- [ ] `/` renders shop cards in a real browser
- [ ] a shop profile renders, **and its "Start a print order" link is present in the DOM**
- [ ] `/order/new?shop=<slug>` renders the upload panel
- [ ] **a real PDF uploads: bytes on disk under `.chaapo-storage/`, a real page count, "Ready" badge**
- [ ] an oversized/unsupported file is refused with a readable sentence, and the row can be removed
- [ ] a storage-seam failure surfaces as a message, not an unhandled action error
- [ ] one smoke test per route asserts the error boundary is absent — and they pass
- [ ] `/map`, `/orders`, `/account` no longer 404 from the tab bar (stubbed or removed)
- [ ] `npm run verify` green

**Phase 1 exit criteria**

- [ ] `npm run infra:up` brings up postgres+postgis, redis, minio, mailpit, clamav
- [ ] `DATABASE_URL` restored in `.env.local`
- [ ] `npm run db:migrate` applies all 11 migrations; `db:status` confirms
- [ ] `npm run test:integration` runs for the first time and passes (40 tests)
- [ ] `schema-parity.itest.ts` passes — Drizzle matches the real database
- [ ] `scripts/seed.ts` exists; discovery renders from Postgres, not fixtures
- [ ] `loadEnv()` parses successfully with the real configuration
- [ ] geography columns have a spatial index; the radius query uses it

**Ongoing gates for every later phase**

- [ ] `npm run verify` green before every commit
- [ ] every new domain has `model` / `service` / `repo` / `source` and **tests**
- [ ] every state transition is idempotent and writes an audit row in the same transaction
- [ ] every new entry point calls `enforceRateLimit()`
- [ ] no money is ever a `number`
- [ ] no public file URL is ever produced
- [ ] no payment success is ever faked
- [ ] no screen is created as a placeholder to claim a screen exists
- [ ] every "works" claim in a status document is backed by an execution you actually performed

---

## Audit provenance

**Executed during this audit (read-only):** `npx tsc --noEmit --incremental false` (exit 0);
`npx eslint .` (exit 0); `npx vitest run` (exit 0, 684/684, 1.04 s); `npm run dev:sandbox` on port
3100; real browser navigation to `/`, a shop profile, `/order/new`, `/offline`, `/nope` with
`document.body.innerText` and accessibility snapshots read back; parsing of the 80.2 KB persisted
dev-server error log to attribute each digest to a stack frame; `find`/`grep`/`wc`/`stat` inventory
of 148 source files; full reads of `env.ts`, `draft-identity.ts`, `actions.ts`, `upload-panel.tsx`,
`order/new/page.tsx`, `providers/storage/index.ts`, `.env.local`, `package.json`, `tsconfig.json`,
`vitest.config.ts`, and all four existing markdown documents.

**Not executed, deliberately:** `next build`; `npm run db:migrate`; `npm run test:integration`;
`docker compose up`; any dependency install; any file write outside `$TMPDIR` and this document.
`tsc` was run with `--incremental false` specifically to avoid a `tsconfig.tsbuildinfo` write.

**Could not be verified in this environment, and is therefore reported as inspection-only:**
the `DATABASE_URL`-required finding (an attempt to prove it by execution failed —
`npx tsx` → `Error: listen EPERM … tsx-501/68215.pipe`); anything requiring PostgreSQL, Redis,
Docker, or `next build`.

**Repository modifications made to produce this report: none.** This document is the only file
created. (Note: `.next/` and `tsconfig.tsbuildinfo` carry today's mtimes because the dev server was
running during the audit; both are build artefacts, not source.)

**Changed earlier in the session, *before* the stop instruction, and disclosed here for
completeness:** `.env.local` (`DATABASE_URL` commented out — **this changes which seam every domain
selects and should be restored when Postgres comes up**), `package.json` (two dev scripts added),
`.claude/launch.json` (a dev-server entry added). No source file was modified after work stopped.

