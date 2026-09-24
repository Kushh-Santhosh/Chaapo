import { AppError, errors } from './errors'
import { err, ok, type Result } from './result'
import { USER_ROLES, type UserRole } from '../db/schema/enums'
// Type-only: erased at build, so this file pulls no table definitions into the
// bundle. `actor_type` is a CHECK-constrained column, so the SQL it mirrors is
// the reason the union lives beside the table rather than here.
import type { ActorType } from '../db/schema/trust'

export type { ActorType }

/**
 * Role-based access control.
 *
 * The PRD's §15 permission matrix is encoded below **as data**, one entry per
 * capability, with the matrix row it came from named on every entry. Nothing in
 * this codebase is allowed to decide access any other way: there is a single
 * guard, `requireCapability`, and it is called on the server for every request
 * that reaches a domain service (FR-004, §45 "No client-trusted authorization").
 *
 * Three things the matrix's four symbols mean here:
 *
 *   ✅ `full`        — may act on any object of this kind.
 *   🔵 `own`         — may act only on objects they own. Ownership is resolved
 *                      against real data (`order.customerUserId === actor.userId`,
 *                      `order.shopId ∈ actor.shopIds`), never against a claim in
 *                      the request body.
 *   🟡 `conditional` — may act, but must supply a written reason, and the action
 *                      is written to the audit log with that reason attached.
 *                      This is the "support override" path, and the friction is
 *                      deliberate.
 *   ❌ `none`        — no path. The default for every role on every capability,
 *                      so a capability added without thinking about a role denies
 *                      that role.
 *
 * Two rules that are easy to get wrong and so are enforced structurally:
 *
 *   • A call site that asks for `own` access without telling us *what* is being
 *     acted on is a bug, not a denial. `requireCapability` throws in that case
 *     rather than returning a polite 403, because a silent denial would hide the
 *     mistake until someone reported that the shop dashboard had stopped working.
 *
 *   • Client-side checks are cosmetic. `accessFor` and `capabilitiesForRole`
 *     exist so the UI can hide a button the user cannot use; hiding it is a
 *     courtesy, and the server never trusts that it happened.
 *
 * `shop_staff` rows are present and correct but unreachable in this build: staff
 * sub-accounts are V1 (§63). The matrix carries them so that turning staff on is
 * a feature, not an access-control redesign.
 */

export type Access = 'full' | 'own' | 'conditional' | 'none'

/** Which surface a session was issued for. A shop session cannot drive /admin. */
export type Surface = 'customer' | 'shop' | 'admin'

/**
 * What `own` means for a capability.
 *
 * `user` — the object belongs to a person (their order, their files, their profile).
 * `shop` — the object belongs to a shop the actor may act for.
 * `user_or_shop` — either side may own it, and which one depends on the actor
 *   (a dispute is owned by both the customer who raised it and the shop it names).
 * `none` — the capability has no `own` cell in the matrix.
 */
export type Ownership = 'user' | 'shop' | 'user_or_shop' | 'none'

export interface CapabilitySpec {
  /**
   * The §15 matrix row this capability comes from, quoted. Where a capability
   * has no matrix row — worker-only mechanics, admin tooling described elsewhere
   * — this names the PRD section instead and begins with `§`.
   */
  readonly prdRow: string
  /** What exercising it means, in product terms. */
  readonly summary: string
  /**
   * Why the encoding below departs from a literal reading of the row. Present
   * only where it does, and only ever in the safe direction: a cell may be
   * tightened, never loosened.
   */
  readonly note?: string
  readonly ownership: Ownership
  /**
   * Admin actors must have satisfied their second factor in this session. Set on
   * everything touching money, verification, privacy and configuration (§14
   * "mandatory 2FA", §45).
   */
  readonly requiresMfa: boolean
  /**
   * Every exercise is written to the audit log, not only the conditional ones.
   * Set where the PRD requires a record regardless of who acted: file access,
   * money movement, verification decisions, privacy operations (NFR-16).
   */
  readonly alwaysAudit: boolean
  /**
   * The worker may exercise this without a session. Deliberately opt-in: a
   * system actor is not a superuser, it is a process with a job list.
   */
  readonly system: boolean
  readonly access: Readonly<Record<UserRole, Access>>
}

const DENY_ALL = Object.freeze(
  Object.fromEntries(USER_ROLES.map((role) => [role, 'none'])) as Record<UserRole, Access>,
)

/** Deny by default; name only the roles the matrix grants something to. */
function access(grants: Partial<Record<UserRole, Access>>): Readonly<Record<UserRole, Access>> {
  return Object.freeze({ ...DENY_ALL, ...grants })
}

/**
 * The matrix.
 *
 * Two kinds of faithful-but-not-literal encoding happen here, and both are
 * marked with a `note`:
 *
 *   • **A row is split.** Where a cell's parenthetical names a *different action*
 *     from the row's headline — "🟡 (respond)" beside "✅" on disputes, "✅ (pay)"
 *     beside "🟡 (trigger refund)" — it becomes its own capability citing the same
 *     row. Flattening them would make a shop's ability to answer a dispute and an
 *     admin's ability to decide one the same permission, which they are not.
 *
 *   • **A cell is tightened.** Where the row grants `full` but the object is
 *     someone's private data, the encoding is `own` or `conditional` instead.
 *     Never the other way round.
 *
 * The `prdRow` strings are what the traceability test in `rbac.test.ts` checks
 * against the 21 rows of §15, so all 21 stay accounted for as this table grows.
 */
export const CAPABILITIES = {
  // ── Account ───────────────────────────────────────────────────────────────
  'profile.manage': {
    prdRow: 'Register / manage own profile',
    summary: 'Read and update your own name, contact details and preferences.',
    note:
      'The row reads ✅ for five of six roles, but its subject is "own profile": ' +
      'there is no cell here that lets anyone edit anyone else. Encoded as `own` ' +
      'throughout so that stays true by construction; editing another account is ' +
      'the separate, audited `user.manage_any`.',
    ownership: 'user',
    requiresMfa: false,
    alwaysAudit: false,
    system: false,
    access: access({
      customer: 'own',
      shop_owner: 'own',
      shop_staff: 'own',
      admin_support: 'own',
      admin_finance: 'own',
      admin_super: 'own',
    }),
  },
  'user.manage_any': {
    prdRow: '§50 Admin console — user lookup and account actions',
    summary: "Change another person's account: correct a phone number, suspend, reinstate.",
    note: 'No §15 row. Derived from §14 least privilege: the narrowest capability that covers it.',
    ownership: 'none',
    requiresMfa: true,
    alwaysAudit: true,
    system: false,
    access: access({ admin_support: 'conditional', admin_super: 'full' }),
  },

  // ── Discovery and ordering ────────────────────────────────────────────────
  'shop.discover': {
    prdRow: 'Discover shops / search nearby',
    summary: 'Search verified, open, capable shops near a location.',
    ownership: 'none',
    requiresMfa: false,
    alwaysAudit: false,
    system: false,
    access: access({ customer: 'full', admin_support: 'full', admin_super: 'full' }),
  },
  'order.create': {
    prdRow: 'Upload files & place order',
    summary: 'Create a draft order, configure items and place it.',
    ownership: 'none',
    requiresMfa: false,
    alwaysAudit: false,
    system: false,
    access: access({ customer: 'full' }),
  },
  'file.upload': {
    prdRow: 'Upload files & place order',
    summary: 'Reserve an upload and put bytes into the private bucket.',
    ownership: 'none',
    requiresMfa: false,
    alwaysAudit: false,
    system: false,
    access: access({ customer: 'full' }),
  },
  'payment.pay': {
    prdRow: 'Pay / get refund',
    summary: 'Start and complete payment for your own order.',
    note: 'The customer cell is "✅ (pay)"; the refund half of the row is `refund.initiate`.',
    ownership: 'user',
    requiresMfa: false,
    alwaysAudit: false,
    system: false,
    access: access({ customer: 'own' }),
  },

  // ── Reading orders and files ──────────────────────────────────────────────
  // Two capabilities per object, because "my order" and "an order routed to my
  // shop" are different rows of the matrix with different role columns.
  'order.view_own': {
    prdRow: 'View own orders & files',
    summary: "Read a customer's own order, its items, its price and its status.",
    ownership: 'user',
    requiresMfa: true,
    alwaysAudit: true,
    system: true,
    access: access({
      customer: 'own',
      admin_support: 'conditional',
      admin_finance: 'conditional',
      admin_super: 'conditional',
    }),
  },
  'file.view_own': {
    prdRow: 'View own orders & files',
    summary: 'Issue a short-lived signed URL for a file the actor uploaded.',
    ownership: 'user',
    requiresMfa: true,
    alwaysAudit: true,
    system: false,
    access: access({
      customer: 'own',
      admin_support: 'conditional',
      admin_finance: 'conditional',
      admin_super: 'conditional',
    }),
  },
  'order.view_shop': {
    prdRow: "View shop's incoming orders/files",
    summary: 'Read an order routed to a shop the actor works for.',
    ownership: 'shop',
    requiresMfa: false,
    alwaysAudit: false,
    system: true,
    access: access({
      shop_owner: 'own',
      shop_staff: 'own',
      admin_support: 'conditional',
      admin_finance: 'conditional',
      admin_super: 'full',
    }),
  },
  'file.view_shop': {
    prdRow: "View shop's incoming orders/files",
    summary: 'Issue a signed URL for a customer file, for printing, while the order is live.',
    note:
      'Tightened: the row gives Super Admin ✅, but a customer file is private ' +
      "data (§45). Every admin look at someone's document costs a written reason " +
      'and leaves a record, whatever the badge says.',
    ownership: 'shop',
    requiresMfa: false,
    alwaysAudit: true,
    system: false,
    access: access({
      shop_owner: 'own',
      shop_staff: 'own',
      admin_support: 'conditional',
      admin_finance: 'conditional',
      admin_super: 'conditional',
    }),
  },

  // ── Moving an order along ─────────────────────────────────────────────────
  'order.transition': {
    prdRow: 'Accept / reject / progress order',
    summary: 'Accept, reject, start printing, hold for a file issue, mark ready.',
    ownership: 'shop',
    requiresMfa: false,
    alwaysAudit: false,
    // The sweeper auto-cancels unaccepted orders and expires uncollected ones.
    system: true,
    access: access({
      shop_owner: 'own',
      shop_staff: 'own',
      admin_support: 'conditional',
      admin_super: 'full',
    }),
  },
  'order.cancel_own': {
    prdRow: 'Accept / reject / progress order',
    summary: 'Cancel your own order under the published cancellation policy.',
    note:
      'The customer cell comes from §39 (free cancellation until a shop accepts), ' +
      'not from §15; the admin cells are the "🟡 (override)" of this row.',
    ownership: 'user',
    requiresMfa: false,
    alwaysAudit: false,
    system: false,
    access: access({ customer: 'own', admin_support: 'conditional', admin_super: 'full' }),
  },
  'order.verify_pickup': {
    prdRow: 'Mark ready / verify pickup code',
    summary: 'Verify a pickup code or QR at the counter and mark the order collected.',
    ownership: 'shop',
    requiresMfa: false,
    alwaysAudit: true,
    system: false,
    access: access({
      shop_owner: 'own',
      shop_staff: 'own',
      admin_support: 'conditional',
      admin_super: 'full',
    }),
  },
  'order.quote': {
    prdRow: 'Accept / reject / progress order',
    summary: 'Answer a quote-required job with a priced, itemised quote.',
    ownership: 'shop',
    requiresMfa: false,
    alwaysAudit: false,
    system: false,
    access: access({
      shop_owner: 'own',
      shop_staff: 'own',
      admin_support: 'conditional',
      admin_super: 'full',
    }),
  },
  'order.reprice': {
    prdRow: 'Accept / reject / progress order',
    summary: 'Re-price a paid order after a file problem, for the customer to approve.',
    ownership: 'shop',
    requiresMfa: false,
    alwaysAudit: true,
    system: false,
    access: access({ shop_owner: 'own', admin_support: 'conditional', admin_super: 'full' }),
  },

  // ── Running a shop ────────────────────────────────────────────────────────
  'shop.manage': {
    prdRow: 'Manage shop profile / hours / printers',
    summary: 'Edit shop details, opening hours, capabilities and availability.',
    ownership: 'shop',
    requiresMfa: false,
    alwaysAudit: false,
    system: false,
    access: access({
      shop_owner: 'own',
      // "🟡 (if granted)" — a staff grant is a V1 feature; the cell is honest.
      shop_staff: 'conditional',
      admin_support: 'conditional',
      admin_super: 'full',
    }),
  },
  'shop.catalogue': {
    prdRow: 'Set service catalogue & pricing',
    summary: "Choose which services a shop offers and set the shop's prices.",
    ownership: 'shop',
    requiresMfa: false,
    alwaysAudit: true,
    system: false,
    access: access({ shop_owner: 'own', admin_support: 'conditional', admin_super: 'full' }),
  },
  'shop.kyc': {
    prdRow: 'Complete business KYC / bank details',
    summary: 'Submit or amend business identity and settlement bank details.',
    ownership: 'shop',
    requiresMfa: true,
    alwaysAudit: true,
    system: false,
    access: access({
      shop_owner: 'own',
      admin_support: 'conditional',
      admin_finance: 'conditional',
      admin_super: 'full',
    }),
  },
  'shop.earnings': {
    prdRow: 'View shop earnings / payouts',
    summary: 'Read a shop’s earnings, commission and payout history.',
    ownership: 'shop',
    requiresMfa: false,
    alwaysAudit: false,
    system: false,
    access: access({
      shop_owner: 'own',
      shop_staff: 'conditional',
      admin_finance: 'full',
      admin_super: 'full',
    }),
  },
  'shop.staff': {
    prdRow: 'Invite / manage staff',
    summary: 'Invite counter staff and scope what they may do. [V1]',
    ownership: 'shop',
    requiresMfa: false,
    alwaysAudit: true,
    system: false,
    access: access({ shop_owner: 'own', admin_super: 'full' }),
  },

  // ── Platform trust ────────────────────────────────────────────────────────
  'shop.verification': {
    prdRow: 'Approve / suspend shops (verification)',
    summary: 'Approve, request changes to, suspend or reinstate a shop.',
    ownership: 'none',
    requiresMfa: true,
    alwaysAudit: true,
    system: false,
    access: access({ admin_support: 'full', admin_super: 'full' }),
  },
  'geo.manage': {
    prdRow: 'Manage geographies / launch belts',
    summary: 'Open and close cities and launch belts.',
    ownership: 'none',
    requiresMfa: true,
    alwaysAudit: true,
    system: false,
    access: access({ admin_support: 'conditional', admin_super: 'full' }),
  },
  'risk.review': {
    prdRow: '§51 Fraud, abuse & risk — the trust queue',
    summary: 'Work the trust queue: investigate, confirm or dismiss a risk flag.',
    note: 'No §15 row. A risk flag is our own suspicion, not a party’s complaint, so it is not a dispute.',
    ownership: 'none',
    requiresMfa: false,
    alwaysAudit: true,
    system: true,
    access: access({ admin_support: 'full', admin_finance: 'conditional', admin_super: 'full' }),
  },

  // ── Money ─────────────────────────────────────────────────────────────────
  'refund.initiate': {
    prdRow: 'Pay / get refund',
    summary: 'Refund all or part of a captured payment.',
    note: 'The "🟡 (trigger refund)" / ✅ half of the row; `payment.pay` is the other half.',
    ownership: 'none',
    requiresMfa: true,
    alwaysAudit: true,
    // Auto-cancellation refunds the customer without anyone asking.
    system: true,
    access: access({
      admin_support: 'conditional',
      admin_finance: 'full',
      admin_super: 'full',
    }),
  },
  'payout.initiate': {
    prdRow: 'Initiate / approve payouts',
    summary: 'Close a settlement window and release a payout to a shop.',
    ownership: 'none',
    requiresMfa: true,
    alwaysAudit: true,
    system: false,
    access: access({ admin_finance: 'full', admin_super: 'full' }),
  },
  'payout.settle': {
    prdRow: 'Initiate / approve payouts',
    summary: 'Accrue collected orders into a shop balance. Worker only.',
    note: 'The machine half of the row: no human role holds it, so no human can move money silently.',
    ownership: 'none',
    requiresMfa: false,
    alwaysAudit: false,
    system: true,
    access: access({}),
  },
  'platform.commission': {
    prdRow: 'Configure commission / platform fees',
    summary: 'Change the commission rate, the minimum, or the customer platform fee.',
    ownership: 'none',
    requiresMfa: true,
    alwaysAudit: true,
    system: false,
    // "🟡 (propose)" — finance may set it, and the config store additionally
    // requires a Super Admin for any key marked `requires_super_admin`, which
    // every commission key is. The two gates compose deliberately.
    access: access({ admin_finance: 'conditional', admin_super: 'full' }),
  },
  'platform.config': {
    prdRow: 'Configure commission / platform fees',
    summary: 'Change a platform policy value: SLA timers, refund windows, retention days.',
    ownership: 'none',
    requiresMfa: true,
    alwaysAudit: true,
    system: false,
    access: access({ admin_finance: 'conditional', admin_super: 'full' }),
  },
  'feature_flag.manage': {
    prdRow: 'Configure commission / platform fees',
    summary: 'Turn a feature flag on or off, or change its rollout.',
    ownership: 'none',
    requiresMfa: true,
    alwaysAudit: true,
    system: false,
    access: access({ admin_super: 'full' }),
  },

  // ── Disputes and reviews ──────────────────────────────────────────────────
  'dispute.raise': {
    prdRow: 'Handle disputes / issue adjustments',
    summary: 'Open a dispute about an order.',
    ownership: 'user_or_shop',
    requiresMfa: false,
    alwaysAudit: false,
    system: false,
    access: access({
      customer: 'own',
      shop_owner: 'own',
      shop_staff: 'own',
      admin_support: 'full',
      admin_super: 'full',
    }),
  },
  'dispute.respond': {
    prdRow: 'Handle disputes / issue adjustments',
    summary: 'Add evidence or a reply to an open dispute. "🟡 (respond)" in §15.',
    ownership: 'user_or_shop',
    requiresMfa: false,
    alwaysAudit: false,
    system: false,
    access: access({
      customer: 'own',
      shop_owner: 'own',
      shop_staff: 'own',
      admin_support: 'full',
      admin_super: 'full',
    }),
  },
  'dispute.handle': {
    prdRow: 'Handle disputes / issue adjustments',
    summary: 'Decide a dispute and issue the adjustment that follows from it.',
    ownership: 'none',
    requiresMfa: true,
    alwaysAudit: true,
    system: false,
    access: access({
      admin_support: 'full',
      admin_finance: 'conditional',
      admin_super: 'full',
    }),
  },
  'review.create': {
    prdRow: 'Moderate reviews',
    summary: 'Rate a shop for an order you collected.',
    ownership: 'user',
    requiresMfa: false,
    alwaysAudit: false,
    system: false,
    access: access({ customer: 'own' }),
  },
  'review.report': {
    prdRow: 'Moderate reviews',
    summary: 'Report a review as unfair or abusive. "🟡 (report)" in §15.',
    ownership: 'shop',
    requiresMfa: false,
    alwaysAudit: false,
    system: false,
    access: access({ shop_owner: 'own', admin_support: 'full', admin_super: 'full' }),
  },
  'review.moderate': {
    prdRow: 'Moderate reviews',
    summary: 'Hide, restore or annotate a review.',
    ownership: 'none',
    requiresMfa: false,
    alwaysAudit: true,
    system: false,
    access: access({ admin_support: 'full', admin_super: 'full' }),
  },

  // ── Audit, privacy and support tooling ────────────────────────────────────
  'audit.read': {
    prdRow: 'Access audit logs / PII exports',
    summary: 'Browse the audit trail. Reading it is itself audited.',
    ownership: 'none',
    requiresMfa: true,
    alwaysAudit: true,
    system: false,
    access: access({
      admin_support: 'conditional',
      admin_finance: 'conditional',
      admin_super: 'full',
    }),
  },
  'privacy.export': {
    prdRow: 'Access audit logs / PII exports',
    summary: 'Build the archive of everything held about a person.',
    ownership: 'user',
    requiresMfa: true,
    alwaysAudit: true,
    system: true,
    access: access({
      customer: 'own',
      admin_support: 'conditional',
      admin_finance: 'conditional',
      admin_super: 'full',
    }),
  },
  'privacy.erase_request': {
    prdRow: 'Force-delete user data (DPDP erasure)',
    summary: 'Ask for an account and its data to be erased. "🟡 (request)" in §15.',
    ownership: 'user',
    requiresMfa: false,
    alwaysAudit: true,
    system: false,
    access: access({ customer: 'own', admin_support: 'conditional', admin_super: 'full' }),
  },
  'privacy.erase_execute': {
    prdRow: 'Force-delete user data (DPDP erasure)',
    summary: 'Execute an erasure, or cancel or block one. "🟡 (process)" in §15.',
    ownership: 'none',
    requiresMfa: true,
    alwaysAudit: true,
    system: true,
    access: access({ admin_support: 'conditional', admin_super: 'full' }),
  },
  'file.retention_delete': {
    prdRow: 'Force-delete user data (DPDP erasure)',
    summary: 'Delete file bytes whose retention period has elapsed. Worker only.',
    ownership: 'none',
    requiresMfa: false,
    alwaysAudit: false,
    system: true,
    access: access({}),
  },
  'admin.impersonate': {
    prdRow: 'Access audit logs / PII exports',
    summary: 'View the app as a user for support. Off by default; every session audited.',
    ownership: 'user',
    requiresMfa: true,
    alwaysAudit: true,
    system: false,
    // Conditional for Super Admin too: impersonation always needs a stated reason.
    access: access({ admin_support: 'conditional', admin_super: 'conditional' }),
  },
  'notification.send': {
    prdRow: 'Access audit logs / PII exports',
    summary: 'Send or resend a message to a user outside the automatic flow.',
    ownership: 'none',
    requiresMfa: false,
    alwaysAudit: true,
    system: true,
    access: access({ admin_support: 'conditional', admin_super: 'full' }),
  },
  'analytics.read': {
    prdRow: 'View shop earnings / payouts',
    summary: 'Read aggregate metrics: platform KPIs, or one shop’s own numbers.',
    ownership: 'shop',
    requiresMfa: false,
    alwaysAudit: false,
    system: false,
    access: access({
      shop_owner: 'own',
      shop_staff: 'own',
      admin_support: 'full',
      admin_finance: 'full',
      admin_super: 'full',
    }),
  },
} as const satisfies Record<string, CapabilitySpec>

export type Capability = keyof typeof CAPABILITIES

export const ALL_CAPABILITIES = Object.keys(CAPABILITIES) as Capability[]

// ── The actor ───────────────────────────────────────────────────────────────

/**
 * Everything the guard is allowed to know about who is asking.
 *
 * Built in exactly two places: `src/server/http/context.ts`, from a verified
 * session, and the system/provider constructors below. A domain service never
 * constructs one, which is what makes "there is no path to an object that
 * bypasses this" true rather than aspirational.
 */
export interface AuthContext {
  readonly actorType: ActorType
  readonly userId: string | null
  /** The role this session is exercising. One role at a time, by design. */
  readonly role: UserRole | null
  /** Every non-revoked grant the user holds, for surface and role switching. */
  readonly roles: readonly UserRole[]
  /** Shops the actor may act for. Read from `user_roles`, never from the request. */
  readonly shopIds: readonly string[]
  readonly surface: Surface | null
  readonly sessionId: string | null
  /** Whether the second factor has been satisfied in this session. */
  readonly mfaSatisfied: boolean
  /** Set while an admin is acting as a user. Both identities are audited. */
  readonly impersonatedUserId: string | null
  /**
   * A non-PII label for the audit trail: "Support · Priya", "Shop · Sharma
   * Xerox", "worker · order.sweeper". Denormalised so the log stays readable
   * after erasure.
   */
  readonly label: string | null
  readonly correlationId?: string | null
  readonly ipHash?: string | null
  readonly userAgentFamily?: string | null
}

const ANONYMOUS: AuthContext = Object.freeze({
  actorType: 'customer',
  userId: null,
  role: null,
  roles: [],
  shopIds: [],
  surface: null,
  sessionId: null,
  mfaSatisfied: false,
  impersonatedUserId: null,
  label: null,
})

/** An unauthenticated visitor. Every capability check fails with 401. */
export function anonymousActor(surface: Surface = 'customer'): AuthContext {
  return { ...ANONYMOUS, surface }
}

/**
 * The worker process. May only exercise capabilities marked `system: true`, so
 * adding a job that moves money is a visible change to this file.
 */
export function systemActor(jobName: string): AuthContext {
  return {
    ...ANONYMOUS,
    actorType: 'system',
    label: `worker · ${jobName}`,
  }
}

/** An inbound webhook that authenticated by signature. Acts for nobody. */
export function providerActor(provider: string): AuthContext {
  return {
    ...ANONYMOUS,
    actorType: 'provider',
    label: `provider · ${provider}`,
  }
}

// ── The guard ───────────────────────────────────────────────────────────────

export interface Scope {
  /** The user who owns the object being acted on. */
  readonly ownerUserId?: string | null
  /** The shop that owns the object being acted on. */
  readonly shopId?: string | null
  /** Required for `conditional` access. Written to the audit log verbatim. */
  readonly reason?: string | null
}

export interface Grant {
  readonly capability: Capability
  readonly basis: 'full' | 'own' | 'conditional' | 'system'
  readonly reason: string | null
  /** True when this exercise must be written to `audit_logs`. */
  readonly mustAudit: boolean
  readonly ownerUserId: string | null
  readonly shopId: string | null
}

/**
 * The shortest a `conditional` reason may be.
 *
 * An override that a support agent cannot be bothered to explain in ten
 * characters is one that should go to a supervisor instead. This is friction on
 * purpose (§50, NFR-16).
 */
export const MIN_REASON_LENGTH = 10

export const ADMIN_ROLES: readonly UserRole[] = ['admin_support', 'admin_finance', 'admin_super']
export const SHOP_ROLES: readonly UserRole[] = ['shop_owner', 'shop_staff']

export function isAdminRole(role: UserRole): boolean {
  return ADMIN_ROLES.includes(role)
}

export function isShopRole(role: UserRole): boolean {
  return SHOP_ROLES.includes(role)
}

/** Which surface a role signs in to. Used when issuing a session. */
export function surfaceForRole(role: UserRole): Surface {
  if (isAdminRole(role)) return 'admin'
  if (isShopRole(role)) return 'shop'
  return 'customer'
}

/**
 * The matrix cell for a role, with no scope resolution.
 *
 * For the UI and for the admin console's role-matrix screen. A `full` here does
 * not mean the actor may act on a *particular* object — only `requireCapability`
 * answers that.
 */
export function accessFor(role: UserRole | null, capability: Capability): Access {
  if (!role) return 'none'
  return CAPABILITIES[capability].access[role]
}

/** Cosmetic: enough to decide whether to render a button. */
export function mayAttempt(actor: AuthContext, capability: Capability): boolean {
  if (actor.actorType === 'system' || actor.actorType === 'provider') {
    return CAPABILITIES[capability].system
  }
  return accessFor(actor.role, capability) !== 'none'
}

/** Every capability a role has some access to, for the session bootstrap payload. */
export function capabilitiesForRole(role: UserRole): Array<{ capability: Capability; access: Access }> {
  return ALL_CAPABILITIES.filter((capability) => accessFor(role, capability) !== 'none').map(
    (capability) => ({ capability, access: accessFor(role, capability) }),
  )
}

/**
 * The only authorization decision in the application.
 *
 * Returns `err` for a real denial — the caller turns that into a 401/403 — and
 * **throws** when the call site is wrong: asking for `own` access without saying
 * what is owned, or asking a capability to resolve ownership it does not have.
 * Those are bugs, and a bug that presents as a 403 is a bug nobody finds.
 */
export function requireCapability(
  actor: AuthContext,
  capability: Capability,
  scope: Scope = {},
): Result<Grant, AppError> {
  const spec = CAPABILITIES[capability]

  if (actor.actorType === 'system' || actor.actorType === 'provider') {
    if (!spec.system) {
      // Not a product outcome: a job asked for something no job may do.
      throw new Error(
        `${actor.actorType} actor attempted "${capability}", which is not marked system-callable`,
      )
    }
    return ok({
      capability,
      basis: 'system',
      reason: scope.reason?.trim() ?? null,
      mustAudit: spec.alwaysAudit,
      ownerUserId: scope.ownerUserId ?? null,
      shopId: scope.shopId ?? null,
    })
  }

  if (!actor.userId || !actor.role) return err(errors.unauthenticated())

  const cell = spec.access[actor.role]
  if (cell === 'none') return err(denied(capability))

  if (spec.requiresMfa && isAdminRole(actor.role) && !actor.mfaSatisfied) {
    return err(errors.mfaRequired())
  }

  if (cell === 'full') {
    return ok({
      capability,
      basis: 'full',
      reason: scope.reason?.trim() ?? null,
      mustAudit: spec.alwaysAudit,
      ownerUserId: scope.ownerUserId ?? null,
      shopId: scope.shopId ?? null,
    })
  }

  if (cell === 'own') {
    const owns = resolveOwnership(actor, capability, spec, scope)
    if (!owns) return err(denied(capability))
    return ok({
      capability,
      basis: 'own',
      reason: scope.reason?.trim() ?? null,
      mustAudit: spec.alwaysAudit,
      ownerUserId: scope.ownerUserId ?? null,
      shopId: scope.shopId ?? null,
    })
  }

  // conditional
  const reason = scope.reason?.trim() ?? ''
  if (reason.length < MIN_REASON_LENGTH) {
    return err(
      errors.preconditionFailed(
        'This action needs a written reason, which is recorded in the audit log.',
        { capability, minimumReasonLength: MIN_REASON_LENGTH },
      ),
    )
  }
  return ok({
    capability,
    basis: 'conditional',
    reason,
    mustAudit: true,
    ownerUserId: scope.ownerUserId ?? null,
    shopId: scope.shopId ?? null,
  })
}

/**
 * Resolve `own` against real ownership.
 *
 * The scope fields are supplied by the caller from a row it has already loaded —
 * `order.customerUserId`, `order.shopId` — never from the request body. A caller
 * that has not loaded the row cannot answer the question, which is why a missing
 * scope throws.
 */
function resolveOwnership(
  actor: AuthContext,
  capability: Capability,
  spec: CapabilitySpec,
  scope: Scope,
): boolean {
  switch (spec.ownership) {
    case 'user': {
      if (scope.ownerUserId === undefined) throw missingScope(capability, 'ownerUserId')
      return scope.ownerUserId !== null && scope.ownerUserId === actor.userId
    }
    case 'shop': {
      if (scope.shopId === undefined) throw missingScope(capability, 'shopId')
      return scope.shopId !== null && actor.shopIds.includes(scope.shopId)
    }
    case 'user_or_shop': {
      if (scope.ownerUserId === undefined && scope.shopId === undefined) {
        throw missingScope(capability, 'ownerUserId or shopId')
      }
      const byUser = Boolean(scope.ownerUserId) && scope.ownerUserId === actor.userId
      const byShop = Boolean(scope.shopId) && actor.shopIds.includes(scope.shopId as string)
      return byUser || byShop
    }
    case 'none':
      throw new Error(
        `Capability "${capability}" grants "own" access but declares no ownership dimension`,
      )
  }
}

function missingScope(capability: Capability, field: string): Error {
  return new Error(
    `requireCapability("${capability}") needs scope.${field}: "own" access cannot be ` +
      'resolved without the object it applies to',
  )
}

/**
 * One message for every denial — "not yours" and "not your role" read
 * identically — so probing the API cannot map the permission matrix. The
 * capability name travels in `details` because it is not sensitive and it is the
 * first thing support asks for.
 */
function denied(capability: Capability): AppError {
  return new AppError('forbidden', 'You do not have access to this.', {
    details: { capability },
  })
}
