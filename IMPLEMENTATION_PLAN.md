# Chaapo — Implementation Plan

> Derived **exclusively** from `Chaapo-Print-Marketplace-PRD.md` (v1.0, 26 Aug 2026).
> Every decision below cites the PRD section (§) or requirement (FR/NFR) it satisfies.
>
> **Product promise:** *"Send your print job before you reach the shop. Skip the queue."*

---

## 0. Requirement extraction summary

### 0.1 Scope tiers (from §62–§65)

| Tier | Contents | Build status in this repo |
|---|---|---|
| **MVP** (§62) | Discovery (PostGIS, verified+open+capable) · device upload (PDF/JPG/PNG, multipart resumable) · per-item configuration · live itemised quote + quote-required fallback · compliant PA payment (split, hold-till-collect) · pickup code/QR · SSE live status · core notifications (push + WhatsApp/SMS + email receipt) · order history + reorder · post-pickup rating · file auto-delete · shop onboarding + KYC + catalogue/pricing + availability + Live Queue + verify-pickup + re-price + earnings · admin verification/orders/refunds/disputes/commission/belts/KPI/audit log/DPDP · server-resolved shop QR · malware scan · signed URLs · reconciliation basics · event instrumentation | **Built in full** |
| **V1** (§63) | Per-page colour detect · DOCX/PPT render · cloud-drive ingest · order chat · text reviews+moderation · rich analytics · staff sub-accounts · full notification matrix + prefs UI · reconciliation dashboard + tax exports · i18n (kn/hi) · dynamic capacity/ETA · fraud scoring · native apps · DPDP automation | **Schema + provider seams + feature flags in place; UI/logic deliberately not built.** Marked `// [V1]` at every seam. |
| **V2** (§64) | Delivery · scheduling/slots · wallet/credits · scan/photo/merch SKUs · masked calling · subscriptions/featured · WhatsApp-native ordering · multi-city | **Not built.** Taxonomy/capability flags reserve space only. |
| **FUTURE** (§65) | B2B/institutional · design templates · offset brokerage · print-anywhere · voice/AI · supply-side finance | **Not built.** |

**Hard rule (§62 "Out", §12 Non-Goals, §68 R13):** no delivery, no native app, no design editor, no chat, no cloud-drive ingest, no auto per-page colour, no DOCX render, no multi-language, no wallet/ads/subscriptions, no scan/photo/merch SKUs, no scheduling. Anything in this list that appears is a scope-creep bug.

### 0.2 Roles & permissions (§14, §15)

Six roles. `customer`, `shop_owner`, `shop_staff` [V1], `admin_support`, `admin_finance`, `admin_super`.
The §15 permission matrix is encoded **verbatim** as data in `src/server/core/rbac.ts` (capability × role → `full | own | conditional | none`) and enforced by a single server-side guard on every request (FR-004). Client-side checks are cosmetic only.

Auth (§14, §45, FR-001/002/003/005):
- Customer → phone + OTP (6-digit, hashed, 5 min TTL, rate-limited, lockout after 5 attempts).
- Shop owner / admin → email + password (Argon2id) **and** mandatory TOTP 2FA.
- Sessions → short-lived access JWT (15 min, httpOnly cookie) + rotating refresh token (30 d, hashed in DB, revocable, reuse-detection).

### 0.3 Screens (§A.1–A.3) — 70 specified, MVP subset built

- **Customer (C-01…C-26):** all MVP-labelled screens built. C-22 (payment methods) uses the PA's saved instruments per spec. C-21/C-23/C-24/C-25 built at the MVP-lite level the PRD specifies.
- **Shop (S-01…S-20):** S-01…S-14, S-18, S-19 built (MVP). S-15 basic counts only; S-16/S-17/S-20 are V1 — not built.
- **Admin (A-01…A-24):** A-01…A-05, A-07…A-12, A-14, A-19, A-21, A-24 built; A-06 and A-17/A-20 at MVP-lite; A-13/A-15/A-16/A-18/A-22/A-23 are V1 — A-13 ships as raw CSV export only, per §A.3.

### 0.4 Functional requirements

All 74 numbered FRs (FR-001…FR-1106) are catalogued in §19 Traceability with the module that implements them. Every MVP-priority FR is implemented; every V1 FR is either schema-reserved or explicitly listed as not built.

### 0.5 Non-functional requirements (§D)

NFR-01…NFR-23 map to concrete measures in §17 Performance strategy, §14 Security/privacy, §16 Testing, §18 Deployment. Performance budgets, idempotency, audit immutability, retention execution and residency posture are all enforced in code, not just documented.

---

## 1. Architecture

### 1.1 Shape — modular monolith (§54)

One deployable Next.js application plus one worker process, sharing the same domain code. **Not** microservices (§54, "DO NOT over-engineer").

```
┌────────────────────────────── Clients ──────────────────────────────┐
│  Customer PWA (mobile-first)   Shop Dashboard (desktop-first)   Admin Console │
│         /(customer)                    /shop                       /admin      │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │  HTTPS · JSON · SSE
┌──────────────────────────────────▼──────────────────────────────────┐
│                 Next.js App (app router, RSC + route handlers)       │
│  src/app/api/v1/**  →  src/server/http (envelope, auth, RBAC,        │
│                        idempotency, rate-limit, validation)          │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
┌──────────────────────────────────▼──────────────────────────────────┐
│                        src/server/domains (the monolith's modules)   │
│ identity · shops · catalog · discovery · files · pricing · orders     │
│ payments · payouts · notifications · reviews · privacy · admin       │
│ analytics                                                            │
│  ── orders owns the state machine; emits ORDER_EVENT to the outbox ── │
└───────┬──────────────────┬─────────────────┬───────────────────┬────┘
        │                  │                 │                   │
   ┌────▼────┐      ┌──────▼──────┐   ┌──────▼──────┐    ┌───────▼────────┐
   │ Postgres│      │    Redis    │   │  S3 (private)│    │ src/server/providers │
   │ +PostGIS│      │ cache/queue │   │  ap-south-1  │    │ payments·notify·geo  │
   │         │      │ pubsub/rl   │   │              │    │ storage·malware·doc  │
   └─────────┘      └─────────────┘   └──────────────┘    └───────┬────────┘
                            │                                     │
                    ┌───────▼────────┐                    ┌───────▼────────┐
                    │ Worker process │                    │ External APIs  │
                    │ (BullMQ)       │                    │ PA · WA · SMS  │
                    │ scan·preview·  │                    │ SES · Maps ·   │
                    │ notify·sla·    │                    │ FCM/WebPush ·  │
                    │ retention·     │                    │ ClamAV         │
                    │ settle·recon   │                    └────────────────┘
                    └────────────────┘
```

### 1.2 Stack (§54, §70)

| Layer | Choice | Why (PRD) |
|---|---|---|
| Language | TypeScript (strict) | §54 "TypeScript everywhere" |
| Web/API | Next.js 15 App Router + React 19 | §54 Next.js/React; RSC gives fast mobile first paint (NFR-02) |
| Styling | Tailwind CSS v4 (CSS-first tokens) + Radix primitives | tokenised design system (§51), a11y (§50) |
| DB | PostgreSQL 16 + **PostGIS 3.4** | §33.2, §55, §58 |
| ORM | **Drizzle ORM** | typed SQL with a first-class raw-SQL escape hatch for `ST_DWithin`/KNN `<->` (§33.2, Appendix C) |
| Cache/queue/pubsub/rate-limit/sessions | Redis 7 + **BullMQ** | §54, §58 |
| Object storage | S3 API (`ap-south-1`); **MinIO** locally | §34, §58, NFR-23 |
| Realtime | **SSE** + Redis pub/sub fan-out + `order_events` outbox | §57 (SSE for MVP; outbox is the durable spine) |
| Push | Web Push (VAPID) | §41.1, FR-602 |
| Validation | Zod (shared client/server schemas) | §45 input validation |
| Auth | `jose` JWT, Argon2id, `otpauth` TOTP | §45 |
| Tests | Vitest (unit + integration) | §16 |
| Money | integer **paise** everywhere | §E "Money in paise (integer)" |

### 1.3 Why Next.js route handlers rather than a separate API server

The PRD asks for a modular monolith with clear internal domains (§54) and warns against over-engineering. The domain layer under `src/server/domains` has **zero** Next.js imports — it is pure TypeScript over Drizzle + provider interfaces. `src/app/api/v1/**` is a thin HTTP adapter. The same domain code is imported by the standalone worker (`scripts/worker.ts`). If the API ever needs to split out (§54 "extract services later"), the adapter is the only thing that changes.

### 1.4 Request pipeline

Every `/api/v1` handler runs through `withRoute()` in `src/server/http/route.ts`:

1. correlation ID (NFR-17) → 2. structured request log → 3. rate limit (Redis token bucket, §45) → 4. session resolve + CSRF (double-submit on cookie auth) → 5. RBAC capability check (FR-004) → 6. Zod validation of params/query/body → 7. idempotency replay for money/order mutations (FR-401, FR-510) → 8. domain call inside a transaction where needed → 9. typed error → HTTP mapping with a stable error envelope (§56) → 10. audit write for money/verification/PII actions (FR-1007).

---

## 2. Folder structure

```
chaapo/
├── IMPLEMENTATION_PLAN.md          # this file
├── README.md                       # run instructions, ops runbook
├── docker-compose.yml              # postgres+postgis, redis, minio, clamav, mailpit
├── .env.example                    # every knob, documented
├── package.json  tsconfig.json  next.config.ts  eslint.config.mjs
├── vitest.config.ts  drizzle.config.ts  postcss.config.mjs
├── db/
│   ├── migrations/                 # SQL migrations (drizzle-kit generated + hand-written PostGIS/trigger DDL)
│   └── sql/                        # extensions, audit-immutability triggers, indexes
├── scripts/
│   ├── worker.ts                   # BullMQ worker entrypoint (separate process)
│   ├── seed.ts                     # demo/seed data (§15)
│   └── migrate.ts                  # migration runner
├── public/
│   ├── manifest.webmanifest        # PWA (§51, §53)
│   ├── sw.js                       # offline shell + push handler
│   └── brand/                      # logo, icons
└── src/
    ├── app/
    │   ├── layout.tsx  globals.css
    │   ├── (customer)/             # mobile-first PWA — C-01…C-26
    │   ├── shop/                   # desktop-first dashboard — S-01…S-19
    │   ├── admin/                  # web console — A-01…A-24
    │   ├── s/[slug]/route.ts       # server-resolved shop QR 302 (FR-701/702)
    │   └── api/v1/**               # HTTP adapter only
    ├── components/
    │   ├── ui/                     # design system primitives
    │   ├── customer/  shop/  admin/
    │   └── shared/                 # status stepper, price breakdown, uploader, states
    ├── lib/                        # isomorphic: formatting, zod schemas, api client, hooks
    └── server/
        ├── config/env.ts           # zod-validated env, fails fast
        ├── db/{client,schema,geo}.ts
        ├── core/{errors,result,logger,ids,money,time,crypto,rbac,audit,config-store}.ts
        ├── auth/{session,otp,totp,password,guards}.ts
        ├── providers/
        │   ├── storage/            # types, s3, index
        │   ├── payments/           # types, mock, razorpay-route, index
        │   ├── notifications/      # types, whatsapp, sms, email, push, dev-transport, index
        │   ├── geo/                # types, local, google, index
        │   ├── malware/            # types, clamd, heuristic, index
        │   └── docproc/            # types, local (pdf-lib + sharp + poppler), index
        ├── domains/<13 modules>/   # service.ts, repo.ts, schemas.ts, + domain-specific files
        ├── realtime/{hub,sse}.ts
        ├── queue/{queues,jobs/*}.ts
        └── http/{route,context,responses,idempotency,ratelimit}.ts
```

---

## 3. Database / schema plan (§55, §E, §58)

PostgreSQL 16 + PostGIS. Money is `bigint` **paise**. All tables get `created_at`/`updated_at`. Enums are Postgres enums so the DB rejects invalid states.

### 3.1 Tables (37)

**Identity & access** — `users`, `sessions`, `otp_challenges`, `user_consents`, `customer_profiles`, `saved_locations`, `push_subscriptions`.

**Geography** — `belts` (PostGIS `MULTIPOLYGON` + centroid, `is_active`), `belt_waitlist`.

**Supply** — `shops` (PostGIS `geography(Point,4326)` + **GiST index**), `shop_capabilities`, `shop_staff` [V1 schema], `kyc_records`, `bank_accounts`, `shop_qr_scans`.

**Catalogue** — `service_taxonomy` (global, admin-governed — A-06), `service_items` (per-shop price + `version`), `service_item_price_history`.

**Ordering** — `quotes` (server-computed, referenced at order creation so the client can never send a price — FR-303), `orders`, `order_items`, `order_item_finishings`, `order_events` (append-only, per-order monotonic `seq`), `pickup_codes`.

**Files** — `file_assets` (metadata only — FR-201), `file_access_log` (every signed-URL issuance — NFR-09).

**Money** — `payments`, `payment_webhook_events` (unique provider event id → idempotent processing, FR-510), `refunds`, `ledger_entries` (double-entry-ish audit of every money movement), `payouts`, `payout_items`.

**Trust & platform** — `reviews`, `disputes`, `content_reports`, `notifications`, `notification_templates`, `audit_logs` (immutable), `platform_config`, `privacy_requests`, `retention_runs`, `idempotency_keys`.

### 3.2 Key invariants enforced *in the database*

| Invariant | Mechanism | PRD |
|---|---|---|
| Immutable audit log | `BEFORE UPDATE OR DELETE` trigger raises exception on `audit_logs`, `order_events`, `ledger_entries` | FR-1007, §F inv. 4 |
| One review per order | `UNIQUE (order_id)` on `reviews` | FR-801, §E |
| Unique PAN per entity | `UNIQUE (pan_hash)` on `kyc_records` | §28, §E |
| Every file has a retention deadline | `retention_delete_at NOT NULL` | FR-1001, §E |
| No double-transition | `orders.version` optimistic lock + `UNIQUE (order_id, seq)` on `order_events` | FR-407, §F inv. 5 |
| Money integrity | all `bigint` paise; `CHECK (total_paise = subtotal_paise + platform_fee_paise + tax_paise)` | §E, NFR-18 |
| Payout gate | `CHECK` + service guard: payout requires KYC approved **and** bank verified | FR-506, §E |
| Geo search speed | `GIST (geo)` on `shops`; `GIST (geo)` on `belts` | §33.2, NFR-01 |
| Webhook idempotency | `UNIQUE (provider, provider_event_id)` | FR-510 |

### 3.3 Migrations

`db/migrations/0000_init.sql` … hand-checked SQL (PostGIS `CREATE EXTENSION`, enums, tables, indexes, triggers). Runner: `scripts/migrate.ts` (ordered, tracked in `_migrations`). Backups/PITR are a deployment concern (§18, NFR-19).

---

## 4. Authentication / RBAC plan (§14, §15, §45)

### 4.1 Flows

- **Customer:** `POST /auth/otp/request` → `otp_challenges` row (SHA-256 of code, 5 min TTL) → dev transport prints code / prod sends DLT SMS + WhatsApp → `POST /auth/otp/verify` → user upserted, session issued. Rate limits: 3 requests/phone/10 min, 20/IP/hour; 5 verify attempts then challenge lockout (FR-003).
- **Shop owner / admin:** `POST /auth/password` → Argon2id verify → if `totp_enabled`, returns a short-lived `mfa_token` and **no session**; `POST /auth/totp/verify` completes login. Admins cannot disable TOTP (§14 "mandatory").
- **Sessions:** access JWT (`HS256`, 15 min, `httpOnly` `SameSite=Lax` cookie) + refresh token (opaque 32 B, SHA-256 in `sessions`, 30 d, rotated on use, reuse revokes the family). `POST /auth/logout` revokes; `GET /auth/sessions` + `DELETE` for device management (§45).
- **CSRF:** double-submit token on all cookie-authenticated mutations.

### 4.2 RBAC

`CAPABILITIES` in `core/rbac.ts` is the §15 matrix as data:

```ts
'order.transition':      { customer:'none', shop_owner:'own', shop_staff:'own',
                           admin_support:'conditional', admin_finance:'none', admin_super:'full' }
```

`requireCapability(ctx, cap, scope)` resolves `own` against real ownership (`order.customer_user_id === ctx.userId`, `order.shop_id ∈ ctx.shopIds`) and `conditional` against a required, audited reason string. There is no path to an object that bypasses this (FR-004, §45 "No client-trusted authorization").

---

## 5. Customer application plan (§21, §24, §53, A.1)

Mobile-first PWA. Route group `src/app/(customer)`.

| Route | Screens | Notes |
|---|---|---|
| `/` | C-01, C-02, C-03, C-05, C-26 | Discovery = home. Server component streams first shop page; client island for filters/geolocation. Skeletons, empty (§48), error (§47). |
| `/map` | C-04 | Clustered pins from the same PostGIS result; no paid per-search maps call (FR-105). |
| `/shops/[id]` | C-06 | Header, capabilities, **price list**, photos, rating. Closed/paused → status + nearby alternatives. |
| `/order/new?shop=` | C-07, C-08, C-09, C-10 | Four steps, persisted draft (survives reload/network loss — NFR-06). Persistent live price bar. |
| `/orders` | C-15, C-16 | Active + history, reorder. |
| `/orders/[id]` | C-11, C-12, C-13, C-14, C-17, C-18 | SSE stepper, **pinned pickup code/QR**, policy-aware cancel, awaiting-quote, re-price approval, rate. |
| `/account` | C-19…C-25 | Profile, saved locations, notification consent, **privacy centre** (export/erase), help. |

**PWA:** `manifest.webmanifest`, service worker caching the app shell + active-order view for offline (§53), Web Push subscribe, `beforeinstallprompt` hint.

**Repeat order < 60 s (NFR-13, US-13):** `/orders/[id]` → Reorder prefills shop + specs; only file re-upload (files are deleted — §49) and pay remain.

**Uploader:** custom hook over presigned S3 multipart — 8 MB parts, 4 concurrent, exponential backoff, resume from `multipart_upload_id` persisted in `file_assets`, per-part progress. Draft never lost (US-4).

---

## 6. Shop dashboard plan (§22, §25, §52, A.2)

Desktop-first, route `src/app/shop`.

| Route | Screens |
|---|---|
| `/shop/login` | S-01 (password + TOTP) |
| `/shop/onboarding` | S-02 resumable 7-step wizard, save-as-draft |
| `/shop/queue` | **S-04 Live Queue** (default) + S-06 alert + S-07/S-08/S-09 dialogs |
| `/shop/orders`, `/shop/orders/[id]` | S-05 order detail, signed-URL files, printable job ticket |
| `/shop/catalogue` | S-10 pricing matrix, min-order, quote-required rules |
| `/shop/capabilities` | S-11 |
| `/shop/profile` | S-12 (address → map pin), S-13 hours/availability |
| `/shop/earnings` | S-14 gross → commission/GST/TDS/TCS → net |
| `/shop/kyc` | S-03 |
| `/shop/settings` | S-18, S-19 |

**Live Queue design (§52):** 5 columns New → Accepted → Printing → Ready → Collected-today. Large cards, ready-by countdown, capability-sized tap targets. New order → Web Push + audible cue + toast (FR-602). SSE keeps it live; on reconnect the client sends `lastEventId` and the server **replays** from `order_events` (FR-601, §57). Server is source of truth — the board reconciles a full snapshot on reconnect, so an order is never missed (§52, NFR-06). Keyboard shortcuts `A`/`S`/`R`/`V`. Optimistic-lock conflicts surface as "another device already moved this order" rather than double-transitioning (FR-407, §49).

---

## 7. Admin console plan (§23, §26, A.3)

Route `src/app/admin`. Every route requires an admin role + TOTP; every money/verification/PII action writes `audit_logs` (FR-1007, §26).

`/admin` A-02 KPIs · `/admin/verification` A-03 · `/admin/shops` A-04/A-05/A-06 · `/admin/orders` A-07 · `/admin/disputes` A-08 · `/admin/finance/{reconciliation,refunds,payouts,commission,exports}` A-09…A-13 · `/admin/customers` A-14 · `/admin/privacy` A-19/A-20 · `/admin/geography` A-21 · `/admin/reports` A-17 · `/admin/audit` A-24.

**Dense-but-safe (§G.6):** destructive/money actions require a typed confirmation + mandatory reason; support access to a customer's order files requires a reason that lands in `file_access_log` **and** `audit_logs` (§15 "🟡 support view, audited").

---

## 8. File-upload architecture (§34, §35, §37, FR-201…208)

```
client                          api                      s3 (private)        worker
  │ POST /files/presign ────────►│ validate type/size cap
  │                              │ create file_assets(pending) + multipart
  │◄──── uploadId + part urls ───│
  │ PUT part 1..n ──────────────────────────────────────►│   (bytes bypass app servers)
  │ POST /files/{id}/complete ──►│ CompleteMultipartUpload
  │                              │ enqueue file.process ──────────────────────►│ malware scan
  │  GET /files/{id} (poll/SSE)  │                                             │ page count
  │◄──── scan_status, pages ─────│                                             │ preview render
```

- **Private buckets, zero public URLs.** Access only via `GET /files/{id}/signed-url` → server authorises (owner customer, or assigned shop **while the order is active**, or admin with audited reason) → 10 min presigned GET → row in `file_access_log` (FR-207, §37.2, NFR-09).
- **Caps:** 200 MB/file, 1 GB/order, 2000 pages/order, 10 files/order — all in `platform_config` (FR-208).
- **Content-type sniffed from magic bytes**, not the extension; executables/archives rejected (FR-205).
- **Malware scan** before the file is usable; `infected` → quarantine + customer-facing message (FR-204, §47).
- **Page count**: `pdf-lib` for PDFs, 1 for images; `is_page_count_reliable=false` for scanned-image PDFs (no extractable text and no page labels) and for DOCX/PPT → **quote-required** (FR-206, §31.3).
- **Retention:** `retention_delete_at` set on every asset. Unpaid/abandoned uploads → 6 h. Order files → `collected_at + 48 h` (configurable), or terminal-state + 24 h. A worker deletes the bytes, nulls the keys, sets `deleted_at`, and writes an audit row (FR-1001/1002, §37.1). S3 lifecycle rules aborts incomplete multiparts as the belt-and-braces layer (§35).

---

## 9. Pricing engine (§31, FR-301…309)

Pure, deterministic, **server-only** module: `src/server/domains/pricing`.

```
side_price   = service_items[print.{size}.{colorMode}].price_paise
billable_sides = pagesInRange × copies                     // each printed side billed once
sheets       = duplex ? ceil(pagesInRange/2) × copies : billable_sides   // informational
print_total  = side_price × billable_sides
finishing    = Σ finishing_unit_price × qty                 // per job or per sheet per taxonomy
item_total   = print_total + finishing
subtotal     = Σ item_total, then max(subtotal, shop.min_order_paise)
platform_fee = feeModel.customerFee ? max(pct × subtotal, floor) : 0    // §61 — 0 and hidden by default
tax          = gstOnPlatformFee(platform_fee)               // shop prices are inclusive
total        = subtotal + platform_fee + tax
```

- **Quote-required triggers (§31.3):** unreliable page count · non-auto-priceable format (DOCX/PPT/XLS) · finishing needing physical inspection (`hard_bind`, `custom`) · job over the large-job page threshold · a taxonomy item the shop hasn't priced.
- **Client never sends a price (FR-303).** `POST /v1/quotes` returns a `quote_id` + itemised breakdown; `POST /v1/orders` accepts only `quote_id`. Quotes expire in 30 min and are re-validated against the live catalogue at order creation; a changed catalogue → `409 QUOTE_STALE` with the new quote.
- **Price snapshot (FR-306):** `orders.price_snapshot` stores the full computed quote + the exact `service_items` rows and versions used. Later catalogue edits cannot touch a placed order (§49).
- **Re-price before print (FR-307, §31.4):** shop proposes a delta; bounded to **upward only, ≤ 50 % or ≤ ₹200 over the snapshot** (configurable cap); requires customer approval (C-14); recorded as `order_events` + `audit_logs`; decline → full refund pre-print (§40).
- Rounding to whole ₹ at the item level; never a ₹0 payable order (FR-308).

Fully unit-tested — this module is where the "radical price transparency" promise (§G.2) lives.

---

## 10. Order state machine (§20, §F, FR-402/406/407)

Declarative table in `src/server/domains/orders/state-machine.ts`. All 20 states from §F, all 30 transitions with `event`, `allowedActors`, `guard`, `to`, `sideEffects`, `moneyEffect`.

```ts
{ from: 'ready', event: 'pickup_verified', actors: ['shop_owner','shop_staff','admin_super'],
  guard: g => g.pickupCodeVerified,           // server-verified, no exceptions
  to: 'collected', money: 'schedule_release',
  effects: ['notify_customer_collected','enable_rating','schedule_retention'] }
```

`OrdersService.transition()` is the **only** way an order changes state:

1. `SELECT … FOR UPDATE` on the order (serialises concurrent staff actions — §49).
2. Optimistic version check → `409 STALE_ORDER` (FR-407).
3. Idempotency: replaying the same `(order, event, idempotency_key)` returns the original result, never a second transition (§F inv. 5).
4. Actor authorised for this transition (FR-402); guard evaluated against fresh DB state.
5. Money effect executed through the payment provider **inside** the same logical unit, with the ledger written (§F inv. 2/3).
6. `order_events` row with per-order monotonic `seq` (FR-406) → published to Redis → SSE + notification jobs.
7. `audit_logs` row whenever money moves (§F inv. 4).

**Enforced invariants (§F):** no `collected` without a server-verified pickup code · funds never released before `collected` · every terminal-refund path returns held funds via the PA · every transition writes an event · transitions idempotent + concurrency-guarded · price fixed at `placed` except via the bounded customer-approved re-price.

**Timers (FR-403, FR-410):** BullMQ delayed jobs — accept-SLA (default 10 min) → `auto_cancelled` + full refund + nearest-alternative suggestion (FR-409); no-show grace (default 48 h after `ready`) → `expired` with the configured money treatment. Timers are re-derivable from `orders.sla_accept_deadline_at` / `grace_deadline_at`, so a lost Redis job is recovered by a sweeper — an order can never get stuck.

---

## 11. Payment abstraction (§38, §39, §40, FR-501…512)

### 11.1 Interface

```ts
interface PaymentProvider {
  readonly id: string
  createCheckout(i: CreateCheckoutInput): Promise<CheckoutSession>   // hosted checkout, idempotent
  verifyWebhook(raw: string, headers): WebhookVerification           // signature → source of truth
  parseWebhook(payload): PaymentWebhookEvent
  captureStatus(providerPaymentId): Promise<PaymentStatus>
  holdShare(i: HoldInput): Promise<HoldRef>                          // Route/Easy-Split hold
  releaseShare(i: ReleaseInput): Promise<SettlementRef>              // only after collected
  refund(i: RefundInput): Promise<RefundRef>                         // idempotent
  createSubMerchant(i): Promise<SubMerchantRef>                      // shop KYC → linked account
  verifyBankAccount(i): Promise<PennyDropResult>
}
```

Two implementations:

- **`MockPaymentProvider`** (default in dev/test) — a *real* state machine: creates a checkout the local UI can complete or fail, computes and stores splits, honours hold/release, refunds against captured amounts, emits **HMAC-signed webhooks** to the app's own webhook endpoint with the same shape as the production provider, and rejects invalid signatures. Failure modes (`fail`, `timeout`, `duplicate`) are triggerable from the dev checkout page so the §47 error paths are testable. **This is not a fake success flow** — the order only reaches `placed` after a signature-verified webhook, exactly as in production (FR-503).
- **`RazorpayRouteProvider`** — the production adapter, written against Razorpay Orders/Payments/Transfers/Refunds/Route with real request shapes, `X-Razorpay-Signature` HMAC-SHA256 verification, and `Idempotency-Key` headers. Activated by `PAYMENT_PROVIDER=razorpay_route` + credentials. Marked `[VERIFY]` where the PRD says to confirm behaviour with the PA (§38.1, Appendix C).

### 11.2 Money rules in code

- Funds **captured at `placed`**, shop share **held**, released only at `collected → settled` (FR-504, §F).
- Settlement math (§39.1): `net = gross − commission − GST(18 %) on commission − 194-O TDS (0.1 %) − GST TCS (0.5 %)`. Every rate lives in `platform_config` with a `[VERIFY]` note, because the PRD requires them to be confirmed before launch (§60, Appendix C).
- **Refund matrix (§40.2) implemented as a data table**, evaluated by `computeRefund(state, actor, policy)` — full auto-refund on every pre-acceptance failure, disclosed partial/zero after the shop has incurred cost, all shown to the customer *before* they confirm a cancel (§40.1).
- `ledger_entries` records every capture/hold/release/commission/tax/refund/adjustment so A-09 reconciliation is a real query, not a mock.
- Never a payout to a shop that isn't KYC-approved with a verified bank account (FR-506).

**Explicitly not built:** any pooled-money path. There is no code that can move customer funds through a platform account — the only money movements are provider calls (§38.1).

---

## 12. Notification abstraction (§41, FR-601…608)

```ts
interface NotificationChannelProvider {
  channel: 'whatsapp' | 'sms' | 'email' | 'push'
  send(msg: OutboundMessage): Promise<SendResult>
}
```

`NotificationsService.dispatch(event)` resolves the §41.2 event→channel matrix, checks **per-channel consent** (`user_consents`; transactional-essential messages exempt from marketing opt-out but still consent-recorded — FR-606), renders a **registered template** (`notification_templates`, mirroring WhatsApp utility-template and TRAI-DLT template registration — FR-604/605), and enqueues one `notifications` row per channel with a **`dedupe_key`** so retries can never double-send (FR-607). Quiet hours + per-user rate caps per §41.3.

Adapters: `MetaWhatsAppProvider`, `DltSmsProvider` (header/template ids required), `SesEmailProvider`, `WebPushProvider` (VAPID — works for real locally), and a `DevTransport` that writes to the DB outbox and a dev inbox page at `/admin/notifications` so every message is inspectable without credentials.

---

## 13. Realtime architecture (§57, FR-601/602)

- **Transport:** SSE at `GET /api/v1/orders/[id]/events` (customer) and `GET /api/v1/shop/queue/events` (shop). Heartbeat every 20 s; `Last-Event-ID` honoured.
- **Durable spine:** `order_events` is the outbox. Every publish also writes the row first, so a client reconnecting with `lastEventId` gets an exact **replay of missed events** (§57, FR-601). Status is never silently stale (§G.8).
- **Fan-out:** Redis pub/sub channel per order + per shop, so any app instance can serve any stream (horizontal scale, NFR-07). Local single-instance dev uses the same code path.
- **Out-of-app:** Web Push for shop new-order alerts and customer ready alerts (FR-602/603).
- **Semantics:** at-least-once delivery, per-order monotonic `seq`, idempotent client reducer (§57).
- **V1 seam:** `RealtimeHub` is an interface, so swapping in Ably/Pusher touches one file (§57 scale path).

---

## 14. Security / privacy architecture (§37, §45, §46, FR-1001…1007)

| Area | Implementation |
|---|---|
| Transport | HTTPS enforced; HSTS, CSP (no `unsafe-inline` in prod), `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` in `next.config.ts` |
| Authz | single server-side RBAC guard; ownership resolved from the DB on every object access (FR-004) |
| Files | private buckets, 10-min signed URLs, per-request authorisation, `file_access_log`, AV scan, magic-byte type check, SSE-KMS at rest (FR-207, §45) |
| Secrets | env-only, zod-validated at boot, never logged; `redactor` scrubs tokens/PII from logs |
| PII at rest | AES-256-GCM envelope encryption (`core/crypto.ts`) for PAN, bank account number, pickup codes, Aadhaar-class docs; **masked** display values stored separately; full Aadhaar never persisted (FR-1005, §37.2, §60) |
| Payments | no card data ever touches us; hosted checkout; webhook signature required; idempotency keys (FR-502/503/510) |
| Pickup integrity | 6-char code (Crockford base32, ambiguity-free) hashed for verification + encrypted for customer display; QR carries a JWT bound to `{order_id, shop_id, jti, exp}`; server-side verification only; 5 failed attempts → revoke + regenerate (FR-405, FR-703, §32.2) |
| Rate limits | Redis token bucket on OTP, checkout, upload presign, pickup verify, discovery (§46) |
| Audit | append-only `audit_logs` with DB-level immutability trigger; written for every money, verification, override and PII-access action (FR-1007) |
| DPDP | consent records at signup and per channel; privacy centre with export + erasure request; admin queue A-19; retention monitor A-20; auto-deletion with audit trail (FR-1001…1004, §37.3) |
| Fraud (§46) | KYC + penny-drop gate, hold-till-collect, verified-only reviews, AV scan, pickup-code requirement, OTP lockouts, re-price cap, velocity limits, `ready→collected` gap metric. Advanced scoring is V1. |
| Guardrail | **zero** unauthorised file accesses; every denial logged and counted as a metric (NFR-09) |

---

## 15. API / domain architecture (§56)

Versioned REST at `/api/v1`. Envelope: `{ data }` or `{ error: { code, message, details?, correlationId } }`. Cursor pagination. `Idempotency-Key` **required** on every money/order-mutating POST.

| Domain | Surface |
|---|---|
| identity | `POST /auth/otp/request|verify`, `/auth/password`, `/auth/totp/{setup,verify}`, `/auth/refresh`, `/auth/logout`, `GET/DELETE /auth/sessions` |
| discovery | `GET /shops?lat&lng&radiusM&filters&sort`, `GET /shops/{id}`, `GET /belts/serviceability`, `POST /belts/waitlist`, `GET /s/{slug}` (302) |
| files | `POST /files/presign`, `POST /files/{id}/complete`, `POST /files/{id}/abort`, `GET /files/{id}`, `GET /files/{id}/signed-url` |
| pricing | `POST /quotes`, `GET /quotes/{id}` |
| orders | `POST /orders` (idempotent), `GET /orders`, `GET /orders/{id}`, `POST /orders/{id}/pay`, `POST /orders/{id}/transition`, `POST /orders/{id}/cancel`, `POST /orders/{id}/reprice/{approve,decline}`, `GET /orders/{id}/events` (SSE), `GET /orders/{id}/pickup-code`, `POST /orders/{id}/review`, `POST /orders/{id}/dispute` |
| shop | `/shop/onboarding/*`, `/shop/profile`, `/shop/availability`, `/shop/capabilities`, `/shop/catalogue`, `/shop/kyc`, `/shop/bank`, `/shop/queue`, `/shop/queue/events` (SSE), `/shop/orders/*`, `/shop/orders/{id}/{accept,reject,start,ready,hold,resume,reprice,verify-pickup}`, `/shop/earnings`, `/shop/payouts` |
| payments | `POST /webhooks/payments/{provider}` (signature-verified, idempotent) |
| admin | `/admin/kpis`, `/admin/verification/*`, `/admin/shops/*`, `/admin/orders/*`, `/admin/disputes/*`, `/admin/finance/*`, `/admin/config/*`, `/admin/belts/*`, `/admin/privacy/*`, `/admin/audit`, `/admin/notifications` |

Each domain module exposes a `service.ts` (use cases, returns `Result<T, DomainError>`), a `repo.ts` (all SQL), and `schemas.ts` (Zod, shared with clients via `src/lib/schemas`). Cross-domain calls go service→service; no domain reaches into another's tables. The **orders** domain owns state transitions and is the only emitter of `order_events` (§56).

---

## 16. Testing strategy

| Level | Tool | Coverage |
|---|---|---|
| Unit | Vitest | pricing engine (every §31 formula, rounding, quote-required triggers) · state machine (all 30 §F transitions, each invariant, illegal transitions rejected) · refund matrix (all 10 §40.2 rows) · settlement math (§39.1) · RBAC matrix (§15 cell-by-cell) · pickup code + crypto · money helpers · geo helpers |
| Integration | Vitest + real Postgres/Redis/MinIO from `docker-compose` | full core loop: discover → presign+upload → quote → order → mock-PA webhook → accept → print → ready → verify pickup → collected → settle · idempotency (double webhook, double transition) · concurrency (two staff accept at once) · authorisation denials (customer B cannot read A's file) · retention deletion · SSE replay after disconnect |
| Contract | Vitest | provider adapters against recorded fixtures; mock and Razorpay adapters satisfy the same interface tests |
| Quality gate | `npm run verify` = `typecheck && lint && test && build` |

Test data comes from the seed factories, so tests exercise the same shapes as the demo environment.

---

## 17. Seed / demo data strategy

`npm run db:seed` builds a realistic launch-belt slice from the PRD's own research (§6, Appendix B):

- 1 active belt (Bengaluru college belt) + 1 inactive belt to exercise the "not serviceable" + waitlist path (FR-106).
- **12 shops** with real Bengaluru-shaped coordinates: 9 live/verified, 1 pending verification (populates A-03), 1 changes-requested, 1 suspended. Mixed availability (open/busy/closed/paused) and mixed capabilities so discovery filters demonstrably exclude incapable shops (US-2).
- Catalogues seeded from the Appendix B bands (₹1–3 B&W A4, ₹5–15 colour, ₹30–70 spiral, ₹120–400 hard-bind → quote-required) with per-shop variation so price sorting is meaningful.
- Personas from §5: `Deadline Divya`, `Office Arjun` (customers), `Shopkeeper Suresh` (shop owner), `Admin Ananya` (super admin) + support and finance admins.
- ~24 orders spread across **every** state in §F, including refunded, expired, disputed, awaiting-quote and on-hold, so all three dashboards have non-empty, honest data — plus a `--empty` flag to demonstrate every empty state (§48).
- Payments/refunds/ledger/payouts consistent with those orders so reconciliation (A-09) balances.
- Sample PDFs generated at seed time (including a deliberately unreliable scanned-image-style PDF that routes to quote-required).

Credentials printed at the end of the seed run.

---

## 18. Deployment strategy (§54, §58, §60, NFR-19/23)

- **Region:** India (`ap-south-1` / Mumbai) for app, DB and object storage — DPDP residency posture (NFR-23, §60).
- **Artefacts:** one container for the Next.js app (`output: 'standalone'`), one for the worker; identical image, different entrypoint.
- **Local dev:** `docker-compose up -d` gives Postgres+PostGIS, Redis, MinIO, ClamAV and Mailpit; `npm run dev` + `npm run worker`.
- **Config:** everything through zod-validated env (`src/server/config/env.ts`) — fails fast and loudly at boot on a missing secret.
- **Migrations:** run as a pre-deploy step; forward-only.
- **Backups:** managed Postgres automated backups + PITR; documented RPO ≤ 15 min / RTO ≤ 1 h (NFR-19).
- **Rollout:** rolling deploys; feature flags in `platform_config` for staged enablement (FR-1105 groundwork).
- **Observability (NFR-17):** structured JSON logs with correlation IDs, `/api/health` (liveness) and `/api/health/deep` (DB/Redis/S3/queue), queue depth + job failure metrics, error tracking hook.

---

## 19. Performance strategy (§NFR-01…07, §53)

| Target | Approach |
|---|---|
| Discovery p95 < 1.5 s (NFR-01) | single PostGIS query, GiST index, `ST_DWithin` + KNN `<->`; capability filters as indexed joins; Redis cache of belt polygons; **no paid maps call per search** (FR-105); response capped at 50 shops with cursor paging |
| PWA FMP < 3 s on mid-range Android/4G (NFR-02) | RSC-rendered discovery (no client data waterfall), zero heavy client libs on the critical path, `next/font` with `display:swap`, system-font fallback metrics, responsive `next/image`, route-level code splitting, service-worker app shell |
| Live status < 2 s (NFR-03) | SSE push (not polling) + Redis fan-out |
| Upload success ≥ 99 % (NFR-05) | multipart + resume + per-part retry with backoff; bytes bypass app servers |
| No lost orders (NFR-06) | draft persisted server-side; idempotency keys; webhook-as-truth; delayed-job timers re-derivable from DB deadlines; outbox replay |
| 10× pilot scale (NFR-07) | stateless app instances, Redis-backed sessions/rate limits/pubsub, read-replica-ready repo layer, queue-based async work |
| Low bandwidth | no blur-heavy chrome on the critical path; glass/clay effects used selectively and implemented with cheap composited properties only; motion respects `prefers-reduced-motion`; images lazy below the fold |

Deliberate constraint from the brief: **glassmorphism and claymorphism are used selectively** (order status card, pickup-code card, queue column headers, KPI bento tiles) and never as full-page backdrop filters, because `backdrop-filter` on large surfaces is the single worst thing for mid-range Android scroll performance.

---

## 20. Design direction

Premium editorial, not an admin template. The concept is **ink on paper**: warm paper surfaces, near-black ink type, a single vermilion "stamp" accent (the *chaap*).

- **Type:** `Instrument Serif` for editorial display, `Inter` for UI (tabular numerals for every price), `IBM Plex Mono` for pickup codes and order IDs. Prices and codes must read unambiguously at a counter.
- **Colour:** `paper` (#FBF8F3 warm off-white) surfaces · `ink` (#12131A) type · `chaap` (#D93F2B vermilion) accent · semantic states (emerald/amber/rose) with icon + label so status never relies on colour alone (§50).
- **Layout:** bento grids for admin KPIs and the shop earnings summary; a single-column thumb-reachable funnel with a persistent price bar for customers; a 5-column board for the shop queue.
- **Motion:** 150–220 ms ease-out on state changes only; the status stepper animates its advancing segment; nothing loops; everything respects reduced-motion.
- **Density:** customer = generous; shop = large targets, high contrast, legible across a counter; admin = dense tables with sticky headers and confirm-guarded actions.

---

## 21. Phased implementation order

| Phase | Deliverable | Gate |
|---|---|---|
| **P0** | Scaffold: package/ts/next/tailwind/eslint/vitest config, docker-compose, env schema, design tokens | `typecheck` |
| **P1** | Schema + migrations + PostGIS + platform config defaults | migrations apply |
| **P2** | Core: errors, Result, logger, ids, money, time, crypto, RBAC, audit, config store | unit tests |
| **P3** | Auth: OTP, password, TOTP, sessions, guards, rate limits, CSRF | unit + integration |
| **P4** | Providers: storage, malware, docproc, payments (mock + Razorpay), notifications (4 channels + dev transport), geo | contract tests |
| **P5** | Domains A: shops, catalog, discovery (PostGIS), files | unit + integration |
| **P6** | Domains B: pricing engine, orders + state machine, payments, payouts, refunds | full unit suite |
| **P7** | Domains C: notifications dispatch, reviews, privacy/retention, admin/trust, analytics | unit |
| **P8** | HTTP layer: all `/api/v1` routes, SSE, webhooks, QR resolve | integration: full core loop |
| **P9** | Workers: file.process, notify, sla, retention, settle, reconcile, sweeper | integration |
| **P10** | Design system + customer PWA (C-01…C-26) | build, manual flow |
| **P11** | Shop dashboard (S-01…S-19) | build, manual flow |
| **P12** | Admin console (A-01…A-24 MVP subset) | build, manual flow |
| **P13** | Seed/demo data, README/runbook, final `npm run verify` | all green |

---

## 22. Requirement → implementation traceability

### 22.1 Functional requirements

| FR | Implementation |
|---|---|
| FR-001…003 | `server/auth/otp.ts`, `server/http/ratelimit.ts` |
| FR-004 | `server/core/rbac.ts`, `server/http/route.ts` |
| FR-005 | `server/auth/session.ts` |
| FR-006/007 | *V1* — roles + `shop_staff` in schema; UI not built |
| FR-101/102 | `(customer)/page.tsx` geolocation island + `domains/discovery` pincode/saved-location fallback |
| FR-103/104/107 | `domains/discovery/repo.ts` (`ST_DWithin` + KNN, capability/open/rating filters, ETA) |
| FR-105 | `providers/geo` — geocode once at onboarding, cached on `shops.geo` |
| FR-106 | `domains/discovery/serviceability.ts`, `belt_waitlist` |
| FR-201…208 | `domains/files/*`, `providers/storage`, `providers/malware`, `providers/docproc` |
| FR-209/210 | *V1* — `DocumentProcessor` interface reserves the render seam |
| FR-301/302 | `domains/catalog/service.ts` (go-live blocked when an enabled item lacks a price) |
| FR-303/304 | `domains/pricing/engine.ts`, `POST /v1/quotes`, live client breakdown |
| FR-305 | `domains/pricing/quote-required.ts` |
| FR-306 | `orders.price_snapshot` written in `orders/service.ts#create` |
| FR-307 | `orders/reprice.ts` + C-14 / S-08 |
| FR-308 | `core/money.ts` rounding + `shops.min_order_paise` |
| FR-309 | *V1* — `colorPages` field reserved on `order_items` |
| FR-401 | `POST /v1/orders` + `http/idempotency.ts` |
| FR-402/404/406/407/408 | `domains/orders/state-machine.ts`, `service.ts`, `order_events` |
| FR-403/410 | `queue/jobs/order-sla.ts`, `order-grace.ts` + deadline sweeper |
| FR-405 | `domains/orders/pickup.ts` |
| FR-409 | `domains/discovery/alternatives.ts` |
| FR-501…507, 510 | `domains/payments/*`, `providers/payments/*`, `ledger_entries` |
| FR-508 | *V1* — `payouts.hold_reason` + negative-balance detection stubbed with a test |
| FR-509/511 | `domains/payouts/statements.ts`, `admin/finance/reconciliation` |
| FR-512 | CSV export at MVP (`/admin/finance/exports`); rich reports V1 |
| FR-601 | `realtime/sse.ts` + `order_events` replay |
| FR-602 | `providers/notifications/push.ts` + queue board alert |
| FR-603…607 | `domains/notifications/*`, `notification_templates`, `user_consents`, `dedupe_key` |
| FR-608 | *V1* — MVP ships consent toggles only |
| FR-701/702 | `app/s/[slug]/route.ts`, `shops.qr_slug`, `qr_slug_active` |
| FR-703 | `domains/orders/pickup.ts` signed token |
| FR-704 | `shop_qr_scans` written at MVP; analytics view V1 |
| FR-801/802 | `domains/reviews/*` |
| FR-803/804 | *V1* — `reviews.text`/`shop_response`/`status` reserved |
| FR-805 | `content_reports` + `/admin/reports` (MVP-lite) |
| FR-806 | `domains/admin/moderation.ts` suspend shop/customer |
| FR-901…906 | `domains/shops/onboarding.ts`, `kyc.ts`, `domains/admin/verification.ts`, `core/crypto.ts` |
| FR-1001/1002 | `queue/jobs/retention.ts`, `retention_runs` |
| FR-1003…1005 | `user_consents`, `domains/privacy/*`, `core/crypto.ts` masking |
| FR-1006 | TLS at edge + SSE-KMS on the bucket + field-level AES-GCM |
| FR-1007 | `core/audit.ts` + immutability trigger |
| FR-1101/1102 | `domains/admin/config.ts`, `belts` |
| FR-1103 | `domains/analytics/kpis.ts` + A-02 |
| FR-1104 | `/admin/orders/[id]` audited file access + state override |
| FR-1105/1106 | *V1* — `platform_config` flag store present; broadcast UI not built |

### 22.2 Non-functional requirements

| NFR | Implementation |
|---|---|
| 01–03 | §19 Performance strategy |
| 04–07 | stateless app + worker, idempotency, outbox, delayed-job sweeper, read-replica-ready repos |
| 08–10 | §14 Security architecture; `npm audit` in the verify script |
| 11 | `queue/jobs/retention.ts` + `retention_runs` monitor (A-20) |
| 12 | compliance choices encoded: PA-only money movement, tax fields on every payout, DLT/WhatsApp template registry, consent records, DPDP requests |
| 13 | reorder path + saved instruments |
| 14 | Radix primitives, focus management, labelled forms, icon+label status, contrast tokens |
| 15/16 | PWA + service worker; shop dashboard avoids modern-only APIs on the critical path and tolerates reconnects |
| 17 | `core/logger.ts` correlation IDs, health endpoints, queue metrics |
| 18 | paise integers, price snapshots, ledger, immutable audit |
| 19 | documented in README ops section |
| 20 | modular monolith + provider interfaces |
| 21 | `lib/i18n.ts` with an `en` catalogue and no hardcoded UI strings in shared components (kn/hi are V1) |
| 22 | per-order cost knobs in `platform_config`; no paid maps per search; dedupe on notifications |
| 23 | India-region defaults everywhere in `.env.example` |

---

## 23. Open questions — decisions taken (§69)

The PRD lists 10 open questions. Each needs a build-time default; here is what the code does and where to change it.

| § 69 | Decision for this build | Config key |
|---|---|---|
| 1. Fee model | **Shop-side commission only**, 8 %; customer fee ₹0 and the line **hidden** (§61 recommendation, §31.2). Both models implemented and switchable. | `pricing.feeModel` |
| 2. No-show / post-accept policy | Free cancel until `accepted`; `accepted`→pre-print = 100 % refund; during/after printing = 0 %; no-show grace 48 h → `expired`, no refund, shop paid. All disclosed pre-purchase (§40.1). | `refund.*` |
| 3. Launch belt | One seeded Bengaluru college belt; belts are admin data, not code. | `belts` table |
| 4. PA choice | Interface + `MockPaymentProvider` (dev) + `RazorpayRouteProvider` (prod adapter). | `PAYMENT_PROVIDER` |
| 5. File formats | PDF/JPG/PNG auto-priced; DOCX/PPT/XLS accepted → **quote-required** with convert-to-PDF guidance (§34.2 MVP recommendation). | `files.autoPriceableTypes` |
| 6. WhatsApp at launch | All four channels behind the abstraction; dev transport to a DB outbox; WhatsApp/SMS enabled by credentials + registered templates. | `NOTIFY_*` |
| 7. Brand/domain | Treated as **unverified** (§68 R12): no QR posters generated for print, name isolated in `lib/brand.ts`. | `lib/brand.ts` |
| 8. Pricing defaults | Appendix B bands as editable per-shop defaults. | `service_taxonomy.default_price_paise` |
| 9. Storage residency | S3 `ap-south-1` default; endpoint override supports MinIO/R2. | `S3_*` |
| 10. Insurance/liability | Out of software scope; policy text surfaced at checkout from config. | `policy.*` |

All tax rates, thresholds and provider behaviours carry a `[VERIFY]` comment at their definition, mirroring §0 and Appendix C. **This build does not assert any of them are current.**

---

## 24. Explicitly out of scope for this build

Delivery/logistics · native apps · design/template editor · cloud-drive & WhatsApp file ingest · per-page auto colour detection · DOCX/PPT server render · order chat · text reviews + moderation + responses · rich shop analytics · staff sub-account UI · multi-shop switcher · multi-language UI · wallet/credits · subscriptions/featured placement · scanning/photo/merch SKUs · pickup scheduling/slots · masked calling · fraud scoring · DPDP self-serve automation · microservices.

Every item above is in the PRD's deferred lists (§12, §62 "Out", §63–65). Building any of them now would violate §68 R13.
