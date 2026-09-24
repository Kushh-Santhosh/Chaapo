# Chaapo Final Status

Updated: 2026-09-03

## Payment requirements implemented

- Existing pricing and order domains remain the source of truth.
- Payment orchestration now has a dedicated boundary at `src/server/domains/payments/service.ts`.
- Customer checkout has real server actions for payment initiation and completion.
- Customer order detail supports payment, retry after failure, and cancellation.
- No React-only payment state or fake success button is used.

## Payment state model

The persisted development order record carries:

- `paymentStatus`: `pending`, `captured`, `failed`, or `cancelled`
- `paymentProvider`
- `providerPaymentId`
- `paymentAttempt`

An unpaid order is created as `payment_pending`. Successful provider completion moves it to `placed` and records `captured`. Provider failure moves it to `failed`; retry is allowed. Cancellation records `cancelled` payment state and leaves the order retryable.

## Provider architecture

`src/server/providers/payments/port.ts` defines the provider contract for start, complete, and cancel. The mock provider is isolated in `mock.ts` and is deterministic for local testing. A provider payment ID ending in `-fail` deliberately exercises failure. Razorpay remains an explicit `not implemented` provider and is not claimed as integrated.

## Persistence and restart behavior

Payment fields are written through the existing `.chaapo-orders.json` development persistence seam after every payment mutation. The order and payment state therefore share one persisted order record and are restart-safe within the development store.

The database schema already contains the production `payments` and `idempotency_keys` tables, but Postgres integration has not been run in this environment. The development seam uses the existing order record rather than inventing a second in-memory order model.

## Security and RBAC

- Customer payment actions resolve the effective customer identity from the signed customer/draft identity seam.
- The existing `payment.pay` capability is enforced with the order's loaded owner ID.
- Cross-customer payment attempts return forbidden.
- Shop access remains shop-scoped through the existing shop identity seam.
- Shop order detail shows payment status only; it does not expose provider IDs or provider failure details.
- Shop fulfillment actions are blocked unless payment is captured. Unpaid orders have no legal accept/fulfillment action.

## Failure, retry, cancellation, and idempotency

- Deterministic mock failure is covered by provider tests.
- Failed payment is persisted and can be retried.
- Cancellation calls the provider cancel operation and persists cancelled payment state.
- Completion for an already captured/placed order returns the existing order without charging again.
- Payment attempt count is persisted.
- The production schema's idempotency and provider-event uniqueness constraints remain the intended gateway/webhook protections; the development seam uses captured-state duplicate protection.

## Browser E2E evidence

The existing development server on `http://localhost:3100` was used. No second server or port was started. The browser navigated directly to `/`, selected Shivaji Xerox & Stationery, and opened `/order/new?shop=shivaji-xerox-fc-road`.

The browser-accessible fixture `public/e2e/valid-order-test.pdf` was fetched from the app origin inside the browser and injected into the existing file input. This preserved the real customer upload UI, signed local-storage PUT, server inspection, and completion action. The successful order evidence was:

- Order number: `CHP-38HZ-SZEV`
- Upload: `browser-payment-2.pdf`, 607 bytes, 1-page PDF, ready
- Options: A4, B&W, one side, 1 copy
- Quote: ₹20.00 including minimum-order rounding
- Payment UI: `Place order` -> `Payment: pending` -> `Start payment` -> `Complete payment` -> `Payment: captured`
- Customer order list/detail: `Sent to shop`, payment `captured`
- Customer detail refresh: same order and payment `captured`
- Shop login and queue: same order visible in Shivaji Xerox queue
- Shop detail: payment `Captured`, fulfillment eligible
- Legal shop transitions: `Accepted` -> `Printing` -> `Ready` -> `Collected` -> `Settled`

Negative browser evidence:

- Invalid PDF content: `invalid-order-2.pdf` contained 18 bytes of text and was shown as `Cannot print` with the real content-mismatch refusal.
- Unpaid order: `CHP-21TM-S854` was placed through the real customer flow and left unpaid. Shop queue/detail showed `Unpaid` / `Payment pending` and no queue actions, so fulfillment could not proceed.

Browser failure/retry, duplicate completion, cancellation, and cross-customer payment were verified through the real server/domain path and focused tests, but not claimed as browser actions because the current UI has no failure-injection or second-customer session control. The browser-origin fixture removed the earlier filesystem blocker.

## Restart evidence

The persisted development order store contains the captured and settled `CHP-38HZ-SZEV` record and the unpaid `CHP-21TM-S854` record. The server was kept running on the requested port during browser verification per the runtime instruction not to restart a healthy server. Persistence across a deliberate restart was already covered by the order-service persistence tests; a second live browser restart was not performed in this pass because the server remained healthy.

## Tests and build

Passed:

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `CHAAPO_OFFLINE_FONTS=1 npm run build`

Latest test result: 29 test files, 700 tests passed.

## Production payment setup still required

- Implement the Razorpay adapter behind the existing provider port.
- Configure production credentials and webhook signing secrets.
- Persist payments, webhook inbox events, idempotency keys, ledger entries, and refunds through Postgres repositories.
- Process only verified provider webhooks for production capture; the development provider is intentionally local and deterministic.

## Remaining MVP gaps

- Production Postgres migration/integration verification.
- Razorpay checkout and signed webhook reconciliation.
- Full payment/refund ledger implementation in the runtime domain.
- Customer account/auth flows beyond the current draft identity seam.
- Notifications, admin surfaces, pickup verification, refund workflows, and remaining legal/support screens.

## Maps and shop registration update

### Map provider and runtime fix

- Provider: OpenStreetMap standard tiles at `https://tile.openstreetmap.org/{z}/{x}/{y}.png`.
- Attribution: clickable OpenStreetMap copyright attribution is supplied by the existing Leaflet `TileLayer`.
- CSP: `tile.openstreetmap.org` is explicitly allowed in `img-src`.
- SSR: Leaflet is loaded through a client-only dynamic wrapper so `window` is never evaluated during server rendering.
- Existing provider abstraction remains in `src/lib/map/provider.ts`; MapTiler remains available for a configured future provider.

The browser previously showed a blank map because CSP blocked every OSM tile request and the server also evaluated Leaflet during SSR. Both source causes are fixed. A permitted clean restart of the same port-3100 server removed the stale compilation graph, and the browser now visibly renders real map tiles.

Browser evidence: Leaflet container mounted; 12/12 tile images loaded with 256x256 natural dimensions from `tile.openstreetmap.org`; no `window is not defined` or tile CSP error occurred after the clean restart; 8 markers matched the 8 nearby list entries; zoom changed tile coordinates; the first marker opened the Shivaji Xerox popup and its `/shops/...` link; denied geolocation showed the fallback message; allowed geolocation changed the URL to `?lat=18.52040&lng=73.85670`, changed the control to `Update my location`, and returned 5 nearby shops with distance labels. A screenshot also visibly confirmed the Pune map, OSM labels, markers, zoom controls, attribution, and nearby list.

### Registration architecture and browser evidence

- Added persisted development registration store: `.chaapo-registered-shops.json`.
- Added `/shop/register` and a server action with required field, email, phone, coordinate, duplicate-name, and capability validation.
- Registration creates one shop fixture entity consumed by the existing discovery/profile/map read path.
- The owner session uses the existing `chaapo_shop_session` cookie and lands on the existing shop dashboard route.
- Browser-created shop: `Browser Test Prints 2`.
- Browser evidence: registration form submitted successfully, redirected to `/shop/orders`, showed the new owner label and empty dashboard, survived dashboard refresh, and appeared in customer discovery as a real shop.

The registration surface currently captures the core MVP details and a fixed initial service capability set. Editing, full catalogue management, production auth/database persistence, and admin verification are still required before production onboarding.

### Payment negative-case status

Payment failure, retry, duplicate completion, cancellation, cross-customer ownership rejection, and unpaid fulfillment rejection are covered by the actual payment/order server path and tests. Browser evidence is complete for unpaid fulfillment blocking; the current browser UI does not expose failure injection or a second customer identity, so those specific negative cases are not claimed as browser-only checks.
