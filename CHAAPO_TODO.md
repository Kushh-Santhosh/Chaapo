# CHAAPO — TODO

Ordered by the customer transaction loop, because that is the thing being finished. Each
item names its consumer; anything without one is deferred by default.

Status keys: `[ ]` not started · `[~]` in progress · `[x]` done and verified.

## Now — PHASE 2, finish the upload slice

- [x] `StoragePort` + development disk store
- [x] Files domain: limits, inspection, store contract, dev store, drizzle repo, service
- [x] 43 unit tests for limits and inspection
- [ ] `src/app/api/storage/local/[...key]/route.ts` — receives the browser's PUT against a
      signed dev credential. Consumer: the upload island.
- [ ] Draft identity — the upload flow needs an `ownerUserId` before sign-in exists. One
      signed cookie, in `src/server/http/`, reusing `auth/tokens.ts`. Consumer: `/order/new`.
- [ ] Server actions for `beginUpload` / `completeUpload` / `removeFile`. Consumer: the island.
- [ ] `/order/new?shop=<slug>` (C-07) + the client upload island: pick, PUT with progress,
      finalise, show real state, show real refusals, remove. No fake success.
- [ ] Verify the whole slice in a browser.

## Next — PHASE 3–4, configure and price

- [ ] C-08 configure: copies, colour/B&W, paper size, finishing — options derived from the
      shop's actual capabilities, never a hardcoded list.
- [ ] C-09 price: call the existing pricing engine. Quote-required when the page count is
      unreliable or the format is not auto-priceable.
- [ ] `pricing/service.test.ts` with a fake `FileFactsPort` — proves the page count comes
      from the file row and that another customer's `fileId` is refused.

## Then — PHASE 5–9, order and payment

- [ ] `src/server/http/` — auth, capability check, validation, error mapping, idempotency.
      Only the endpoints the order flow needs.
- [ ] Orders domain on the existing schema: explicit state machine, order events.
- [ ] C-10 checkout: payment provider interface + a development implementation that is
      clearly not a gateway. Never mark paid on a click.
- [ ] C-11 confirmation, C-12 active order.

## Then — PHASE 10–13, the other side of the transaction

- [ ] Shop login → dashboard → order detail → accept/reject → processing → ready
- [ ] Pickup verification (code/QR): no pickup before ready, no double pickup
- [ ] C-15/16/17 customer orders and history
- [ ] Star ratings only — text reviews are V1

## Then — PHASE 14–16

- [ ] Admin: auth, shops, users, verification/trust, config, minimum analytics — on the
      existing RBAC
- [ ] Remaining MVP customer screens: map, filters, account, notifications, legal, support
- [ ] Notifications: only what the order lifecycle actually needs

## Infrastructure debt with a known consumer

- [ ] Run the migrations against Postgres and the schema-parity integration test. Until
      then "database verified" cannot be said. (`docker compose up -d`, `npm run db:migrate`)
- [ ] S3 adapter behind `StoragePort` — the AWS SDK is installed; only a bucket is missing.
      Needed before any deployment, not before the MVP loop works.
- [ ] Swap `files/inspect.ts` page counting to `pdf-lib` (installed) so fewer PDFs fall to
      quote-required. The byte scan stays as the fallback for what pdf-lib cannot open.
- [ ] Self-host the three fonts so the build needs no network and
      `CHAAPO_OFFLINE_FONTS` can be deleted.
- [ ] Reconcile or delete `IMPLEMENTATION_PLAN.md` — it overstates completion.

## Known 404s (linked from existing UI, no page behind them)

`/map`, `/orders`, `/account`, `/shop/onboarding`, `/legal/terms`, `/legal/privacy`,
`/legal/refunds`, `/support`.

## Missing tests

Discovery domain has none. Files service (as opposed to limits/inspection) has none.
