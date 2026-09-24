import { newId } from '../../lib/ids'
import { getDb, type DbHandle } from '../db/client'
import { auditLogs } from '../db/schema/trust'
import { currentLogContext, logger, redact } from './logger'
import { CAPABILITIES, type AuthContext, type Capability, type Grant } from './rbac'
// Relative, not `@/`: this module also runs inside the worker process, where the
// tsconfig path alias is one more thing that has to be wired up correctly.
import type { Paise } from '../../lib/money'
import type { UserRole } from '../db/schema/enums'

/**
 * The audit trail.
 *
 * NFR-16 and PRD §14: every admin action on money, verification or personal data
 * is written to an immutable log, and so is every state transition that matters.
 * `audit_logs` has a BEFORE UPDATE OR DELETE trigger calling `forbid_mutation()`,
 * so the database refuses to rewrite history even if the application asks.
 *
 * Three decisions worth stating, because each has a plausible-looking alternative:
 *
 *   • **`recordAudit` takes a `DbHandle` and joins the caller's transaction.**
 *     If the audit write fails, the action fails. The alternative — fire the audit
 *     row on a queue and let the action commit — trades a small availability win
 *     for the possibility of a refund that nobody can account for. For the things
 *     this log covers, that is the wrong trade.
 *
 *   • **It throws rather than returning a `Result`.** An action that must be
 *     audited and cannot be is not a product outcome the user chooses between; it
 *     is a broken deployment. Throwing rolls back the transaction, which is
 *     exactly the behaviour we want.
 *
 *   • **`before`/`after` go through the logger's `redact`.** A diff of a user row
 *     would otherwise put a plaintext phone number in a table that, by design,
 *     can never be corrected. Redaction is applied on the way in, once.
 *
 * The log is written for a person reading it a year later, which is why every row
 * carries a denormalised `actorLabel` and `targetLabel`: after an erasure the
 * foreign keys go null, and "Support · Priya changed the commission rate" must
 * still be legible.
 */

/** Matches the `audit_logs_category_valid` CHECK in migration 0009. */
export const AUDIT_CATEGORIES = [
  'auth',
  'account',
  'shop',
  'verification',
  'catalogue',
  'order',
  'payment',
  'refund',
  'payout',
  'file',
  'privacy',
  'config',
  'notification',
  'dispute',
  'admin',
  'security',
] as const

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number]

/** Matches the `audit_logs_severity_valid` CHECK in migration 0009. */
export const AUDIT_SEVERITIES = ['info', 'notice', 'warning', 'critical'] as const

export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number]

export interface AuditActionSpec {
  readonly category: AuditCategory
  /**
   * `info` is routine, `notice` is worth reading in a weekly review, `warning`
   * wants an explanation, `critical` should page someone.
   */
  readonly severity: AuditSeverity
  /** One line, present tense, as it appears in the admin console's timeline. */
  readonly summary: string
  /**
   * A written justification is mandatory. Set on overrides, money movements and
   * access to another person's data. Missing one throws — the action does not
   * quietly proceed unexplained.
   */
  readonly requiresReason: boolean
  /** `amountPaise` must be supplied, so money queries never miss a row. */
  readonly requiresAmount: boolean
  /** The kind of object this action is about, for the `target_type` column. */
  readonly targetType: string
}

function action(
  category: AuditCategory,
  targetType: string,
  summary: string,
  options: { severity?: AuditSeverity; reason?: boolean; amount?: boolean } = {},
): AuditActionSpec {
  return {
    category,
    targetType,
    summary,
    severity: options.severity ?? 'info',
    requiresReason: options.reason ?? false,
    requiresAmount: options.amount ?? false,
  }
}

/**
 * Every auditable action, named once.
 *
 * A closed registry rather than free-text strings, so that the admin console can
 * render a timeline without a `switch` that falls through to "unknown event", and
 * so that adding an action is a decision about category, severity and whether it
 * needs a reason — not an afterthought at the call site.
 *
 * Dotted names read `domain.thing.happened`, past tense, because the log records
 * what did happen rather than what was attempted.
 */
export const AUDIT_ACTIONS = {
  // ── Authentication and sessions ───────────────────────────────────────────
  'auth.otp.requested': action('auth', 'user', 'Requested a one-time code'),
  'auth.otp.verified': action('auth', 'user', 'Signed in with a one-time code'),
  'auth.otp.failed': action('auth', 'user', 'Entered an incorrect one-time code', {
    severity: 'notice',
  }),
  'auth.password.signed_in': action('auth', 'user', 'Signed in with a password'),
  'auth.password.failed': action('auth', 'user', 'Failed a password sign-in', {
    severity: 'notice',
  }),
  'auth.password.changed': action('auth', 'user', 'Changed their password', {
    severity: 'notice',
  }),
  'auth.mfa.enrolled': action('auth', 'user', 'Set up two-factor authentication', {
    severity: 'notice',
  }),
  'auth.mfa.satisfied': action('auth', 'user', 'Completed two-factor authentication'),
  'auth.mfa.failed': action('auth', 'user', 'Failed two-factor authentication', {
    severity: 'warning',
  }),
  'auth.mfa.reset': action('auth', 'user', 'Had two-factor authentication reset', {
    severity: 'critical',
    reason: true,
  }),
  'auth.session.created': action('auth', 'session', 'Started a session'),
  'auth.session.revoked': action('auth', 'session', 'Ended a session'),
  'auth.session.revoked_all': action('auth', 'user', 'Signed out of every device', {
    severity: 'notice',
  }),
  'auth.locked_out': action('security', 'user', 'Was locked out after repeated failures', {
    severity: 'warning',
  }),

  // ── Accounts ──────────────────────────────────────────────────────────────
  'account.registered': action('account', 'user', 'Created an account'),
  'account.profile_updated': action('account', 'user', 'Updated their profile'),
  'account.phone_changed': action('account', 'user', 'Changed their phone number', {
    severity: 'notice',
  }),
  'account.suspended': action('account', 'user', 'Was suspended', {
    severity: 'critical',
    reason: true,
  }),
  'account.reinstated': action('account', 'user', 'Was reinstated', {
    severity: 'notice',
    reason: true,
  }),
  'account.role_granted': action('account', 'user', 'Was granted a role', {
    severity: 'notice',
    reason: true,
  }),
  'account.role_revoked': action('account', 'user', 'Had a role revoked', {
    severity: 'notice',
    reason: true,
  }),
  'account.consent_recorded': action('privacy', 'user', 'Recorded a consent decision'),

  // ── Shops and verification ────────────────────────────────────────────────
  'shop.created': action('shop', 'shop', 'Registered a shop'),
  'shop.updated': action('shop', 'shop', 'Updated shop details'),
  'shop.hours_updated': action('shop', 'shop', 'Changed opening hours'),
  'shop.availability_changed': action('shop', 'shop', 'Changed accepting-orders status'),
  'shop.kyc_submitted': action('verification', 'shop', 'Submitted business KYC', {
    severity: 'notice',
  }),
  'shop.bank_updated': action('verification', 'shop', 'Changed settlement bank details', {
    severity: 'critical',
    reason: true,
  }),
  'shop.verification.approved': action('verification', 'shop', 'Approved a shop', {
    severity: 'critical',
    reason: true,
  }),
  'shop.verification.changes_requested': action(
    'verification',
    'shop',
    'Asked a shop for corrections',
    { severity: 'notice', reason: true },
  ),
  'shop.verification.rejected': action('verification', 'shop', 'Rejected a shop', {
    severity: 'critical',
    reason: true,
  }),
  'shop.suspended': action('verification', 'shop', 'Suspended a shop', {
    severity: 'critical',
    reason: true,
  }),
  'shop.reinstated': action('verification', 'shop', 'Reinstated a shop', {
    severity: 'warning',
    reason: true,
  }),
  'shop.staff_invited': action('shop', 'shop', 'Invited a staff member', { severity: 'notice' }),
  'shop.staff_removed': action('shop', 'shop', 'Removed a staff member', { severity: 'notice' }),

  // ── Catalogue and pricing ─────────────────────────────────────────────────
  'catalogue.service_enabled': action('catalogue', 'shop_service', 'Started offering a service'),
  'catalogue.service_disabled': action('catalogue', 'shop_service', 'Stopped offering a service'),
  'catalogue.price_changed': action('catalogue', 'shop_service', 'Changed a price', {
    severity: 'notice',
  }),

  // ── Orders ────────────────────────────────────────────────────────────────
  'order.created': action('order', 'order', 'Started an order'),
  'order.placed': action('order', 'order', 'Placed an order', { amount: true }),
  'order.state_changed': action('order', 'order', 'Moved to a new state'),
  'order.accepted': action('order', 'order', 'Accepted an order'),
  'order.rejected': action('order', 'order', 'Rejected an order', { reason: true }),
  'order.printing_started': action('order', 'order', 'Started printing'),
  'order.ready': action('order', 'order', 'Marked an order ready'),
  'order.held': action('order', 'order', 'Put an order on hold', { reason: true }),
  'order.repriced': action('order', 'order', 'Re-priced an order', {
    severity: 'notice',
    reason: true,
    amount: true,
  }),
  'order.reprice_approved': action('order', 'order', 'Approved a new price', { amount: true }),
  'order.quote_requested': action('order', 'order', 'Asked for a quote'),
  'order.quote_provided': action('order', 'order', 'Sent a quote', { amount: true }),
  'order.quote_accepted': action('order', 'order', 'Accepted a quote', { amount: true }),
  'order.cancelled': action('order', 'order', 'Cancelled an order', { reason: true }),
  'order.auto_cancelled': action('order', 'order', 'Was cancelled automatically', {
    severity: 'notice',
  }),
  'order.expired': action('order', 'order', 'Expired uncollected', { severity: 'notice' }),
  'order.collected': action('order', 'order', 'Was collected'),
  'order.transition_overridden': action('order', 'order', 'Forced an order into a new state', {
    severity: 'critical',
    reason: true,
  }),

  // ── Pickup ────────────────────────────────────────────────────────────────
  'pickup.code_verified': action('order', 'order', 'Verified a pickup code'),
  'pickup.code_failed': action('order', 'order', 'Entered a wrong pickup code', {
    severity: 'notice',
  }),
  'pickup.locked': action('security', 'order', 'Locked pickup after repeated wrong codes', {
    severity: 'warning',
  }),
  'pickup.overridden': action('order', 'order', 'Released an order without a valid code', {
    severity: 'critical',
    reason: true,
  }),

  // ── Files ─────────────────────────────────────────────────────────────────
  'file.uploaded': action('file', 'file', 'Uploaded a file'),
  'file.scan_failed': action('file', 'file', 'Uploaded a file that failed scanning', {
    severity: 'warning',
  }),
  'file.url_issued': action('file', 'file', 'Was given a signed link to a file'),
  'file.url_issued_by_admin': action('file', 'file', "Opened a customer's file", {
    severity: 'warning',
    reason: true,
  }),
  'file.downloaded_by_shop': action('file', 'file', 'Downloaded a file for printing'),
  'file.deleted': action('file', 'file', 'Was deleted'),
  'file.retention_deleted': action('file', 'file', 'Was deleted on schedule'),

  // ── Payments ──────────────────────────────────────────────────────────────
  'payment.intent_created': action('payment', 'payment', 'Started a payment', { amount: true }),
  'payment.captured': action('payment', 'payment', 'Paid', { severity: 'notice', amount: true }),
  'payment.failed': action('payment', 'payment', 'Had a payment fail', { severity: 'notice' }),
  'payment.webhook_received': action('payment', 'payment', 'Reported a payment event'),
  'payment.reconciled': action('payment', 'payment', 'Was reconciled against the provider', {
    severity: 'notice',
    amount: true,
  }),
  'payment.mismatch_detected': action('payment', 'payment', 'Did not match provider records', {
    severity: 'critical',
    amount: true,
  }),

  // ── Refunds ───────────────────────────────────────────────────────────────
  'refund.requested': action('refund', 'refund', 'Asked for a refund', { amount: true }),
  'refund.auto_approved': action('refund', 'refund', 'Was refunded automatically', {
    severity: 'notice',
    amount: true,
  }),
  'refund.approved': action('refund', 'refund', 'Approved a refund', {
    severity: 'warning',
    reason: true,
    amount: true,
  }),
  'refund.rejected': action('refund', 'refund', 'Declined a refund', {
    severity: 'warning',
    reason: true,
  }),
  'refund.processed': action('refund', 'refund', 'Was sent to the provider', { amount: true }),
  'refund.failed': action('refund', 'refund', 'Failed at the provider', {
    severity: 'critical',
    amount: true,
  }),

  // ── Payouts and ledger ────────────────────────────────────────────────────
  'payout.window_closed': action('payout', 'payout', 'Closed a settlement window', {
    severity: 'notice',
    amount: true,
  }),
  'payout.initiated': action('payout', 'payout', 'Released a payout', {
    severity: 'critical',
    reason: true,
    amount: true,
  }),
  'payout.paid': action('payout', 'payout', 'Reached the shop', {
    severity: 'notice',
    amount: true,
  }),
  'payout.failed': action('payout', 'payout', 'Failed', { severity: 'critical', amount: true }),
  'payout.blocked': action('payout', 'payout', 'Was held back', {
    severity: 'warning',
    reason: true,
  }),
  'ledger.adjustment_posted': action('payout', 'shop', 'Posted a manual adjustment', {
    severity: 'critical',
    reason: true,
    amount: true,
  }),

  // ── Configuration ─────────────────────────────────────────────────────────
  'config.changed': action('config', 'platform_config', 'Changed a platform setting', {
    severity: 'warning',
    reason: true,
  }),
  'config.commission_changed': action('config', 'platform_config', 'Changed commission', {
    severity: 'critical',
    reason: true,
  }),
  'feature_flag.changed': action('config', 'feature_flag', 'Changed a feature flag', {
    severity: 'warning',
    reason: true,
  }),
  'geo.city_changed': action('config', 'city', 'Changed a city’s launch status', {
    severity: 'warning',
    reason: true,
  }),

  // ── Disputes, reviews, risk ───────────────────────────────────────────────
  'dispute.raised': action('dispute', 'dispute', 'Raised a dispute', { severity: 'notice' }),
  'dispute.responded': action('dispute', 'dispute', 'Replied to a dispute'),
  'dispute.resolved': action('dispute', 'dispute', 'Resolved a dispute', {
    severity: 'warning',
    reason: true,
  }),
  'review.created': action('shop', 'review', 'Left a review'),
  'review.reported': action('shop', 'review', 'Reported a review', { reason: true }),
  'review.moderated': action('admin', 'review', 'Moderated a review', {
    severity: 'notice',
    reason: true,
  }),
  'risk.flag_raised': action('security', 'risk_flag', 'Tripped a risk rule', {
    severity: 'warning',
  }),
  'risk.flag_resolved': action('security', 'risk_flag', 'Closed a risk flag', {
    severity: 'notice',
    reason: true,
  }),

  // ── Privacy ───────────────────────────────────────────────────────────────
  'privacy.export_requested': action('privacy', 'user', 'Asked for a copy of their data', {
    severity: 'notice',
  }),
  'privacy.export_generated': action('privacy', 'user', 'Had their data export built', {
    severity: 'notice',
  }),
  'privacy.export_downloaded': action('privacy', 'user', 'Downloaded their data export', {
    severity: 'notice',
  }),
  'privacy.erasure_requested': action('privacy', 'user', 'Asked to be erased', {
    severity: 'warning',
  }),
  'privacy.erasure_cancelled': action('privacy', 'user', 'Cancelled an erasure request', {
    severity: 'notice',
  }),
  'privacy.erasure_executed': action('privacy', 'user', 'Was erased', {
    severity: 'critical',
    reason: true,
  }),
  'privacy.erasure_blocked': action('privacy', 'user', 'Could not be erased yet', {
    severity: 'warning',
    reason: true,
  }),

  // ── Admin tooling ─────────────────────────────────────────────────────────
  'admin.impersonation_started': action('admin', 'user', 'Started viewing as a user', {
    severity: 'critical',
    reason: true,
  }),
  'admin.impersonation_ended': action('admin', 'user', 'Stopped viewing as a user', {
    severity: 'notice',
  }),
  'admin.order_viewed': action('admin', 'order', "Opened a customer's order", {
    severity: 'warning',
    reason: true,
  }),
  'admin.audit_log_read': action('admin', 'audit_log', 'Searched the audit log', {
    severity: 'notice',
    reason: true,
  }),
  'admin.pii_exported': action('privacy', 'user', 'Exported personal data', {
    severity: 'critical',
    reason: true,
  }),

  // ── Notifications ─────────────────────────────────────────────────────────
  'notification.sent': action('notification', 'notification', 'Was notified'),
  'notification.failed': action('notification', 'notification', 'Could not be notified', {
    severity: 'notice',
  }),
  'notification.sent_manually': action('notification', 'user', 'Was sent a message by support', {
    severity: 'notice',
    reason: true,
  }),
} as const satisfies Record<string, AuditActionSpec>

export type AuditAction = keyof typeof AUDIT_ACTIONS

export const ALL_AUDIT_ACTIONS = Object.keys(AUDIT_ACTIONS) as AuditAction[]

export interface AuditTarget {
  /** Defaults to the action's declared `targetType`. */
  readonly type?: string
  readonly id?: string | null
  /**
   * A stable, non-PII description: an order number, a shop name, a config key.
   * Denormalised on purpose — it must survive the target being deleted.
   */
  readonly label?: string | null
}

export interface AuditInput {
  readonly action: AuditAction
  readonly actor: AuthContext
  readonly target: AuditTarget
  /** Only the fields that changed. Redacted on the way in. */
  readonly before?: Record<string, unknown> | null
  readonly after?: Record<string, unknown> | null
  readonly reason?: string | null
  readonly amountPaise?: Paise | null
  /**
   * The grant that authorised this. Supplying it carries the `conditional`
   * reason across without the call site repeating it, and is the normal way an
   * audited admin action is written.
   */
  readonly grant?: Grant | null
  /** Raise the severity for this occurrence. It can never be lowered. */
  readonly severity?: AuditSeverity
  /** The shop this action was taken on behalf of, when it is not the actor's own. */
  readonly shopId?: string | null
  readonly correlationId?: string | null
}

/** A row ready for insertion. Separated out so it can be tested without a database. */
export interface AuditRow {
  action: string
  category: AuditCategory
  severity: AuditSeverity
  actorType: AuthContext['actorType']
  actorUserId: string | null
  actorRole: UserRole | null
  actorLabel: string | null
  actorShopId: string | null
  impersonatedUserId: string | null
  targetType: string
  targetId: string | null
  targetLabel: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  reason: string | null
  amountPaise: Paise | null
  correlationId: string | null
  ipHash: string | null
  userAgentFamily: string | null
}

const SEVERITY_ORDER: Record<AuditSeverity, number> = {
  info: 0,
  notice: 1,
  warning: 2,
  critical: 3,
}

/** Take whichever severity is higher: an occurrence can be worse than its class, never better. */
function escalate(base: AuditSeverity, override?: AuditSeverity): AuditSeverity {
  if (!override) return base
  return SEVERITY_ORDER[override] > SEVERITY_ORDER[base] ? override : base
}

/**
 * Build the row, applying every invariant the log depends on.
 *
 * Throws on a malformed entry rather than writing a row that is misleading. The
 * three cases are all programmer errors:
 *
 *   • a human actor with no user id — the `audit_logs_human_is_identified` CHECK
 *     would reject it anyway, and a clear message here beats a constraint
 *     violation surfacing three frames away;
 *   • a required reason that is absent;
 *   • a required amount that is absent, which would silently drop the row out of
 *     every money report.
 */
export function buildAuditRow(input: AuditInput): AuditRow {
  const spec = AUDIT_ACTIONS[input.action]
  const actor = input.actor

  if (
    (actor.actorType === 'customer' || actor.actorType === 'shop' || actor.actorType === 'admin') &&
    !actor.userId
  ) {
    throw new Error(
      `Audit action "${input.action}" has actorType "${actor.actorType}" but no actorUserId. ` +
        'A human action must name the human who took it.',
    )
  }

  const reason = (input.reason ?? input.grant?.reason ?? '').trim() || null
  if (spec.requiresReason && !reason) {
    throw new Error(
      `Audit action "${input.action}" requires a reason. ` +
        'Overrides, money movements and access to another person’s data are not recorded unexplained.',
    )
  }

  const amountPaise = input.amountPaise ?? null
  if (spec.requiresAmount && amountPaise === null) {
    throw new Error(
      `Audit action "${input.action}" requires amountPaise, so that money queries cannot miss it.`,
    )
  }

  const context = currentLogContext()

  return {
    action: input.action,
    category: spec.category,
    severity: escalate(spec.severity, input.severity),
    actorType: actor.actorType,
    actorUserId: actor.userId ?? null,
    actorRole: actor.role ?? null,
    actorLabel: actor.label ?? null,
    actorShopId: input.shopId ?? input.grant?.shopId ?? actor.shopIds[0] ?? null,
    impersonatedUserId: actor.impersonatedUserId ?? null,
    targetType: input.target.type ?? spec.targetType,
    targetId: input.target.id ?? null,
    targetLabel: input.target.label ?? null,
    before: redactDiff(input.before),
    after: redactDiff(input.after),
    reason,
    amountPaise,
    correlationId: input.correlationId ?? actor.correlationId ?? context.correlationId ?? null,
    ipHash: actor.ipHash ?? null,
    userAgentFamily: actor.userAgentFamily ?? null,
  }
}

function redactDiff(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (value === null || value === undefined) return null
  const redacted = redact(value)
  // `redact` returns `unknown`; a plain object in, a plain object out.
  return redacted as Record<string, unknown>
}

/**
 * Write one audit row.
 *
 * Pass the transaction the action is running in. Doing so is what makes the log
 * trustworthy: either the refund and its audit row both exist, or neither does.
 * Returns the new row's id so a caller can reference it (a dispute resolution
 * pointing at the adjustment that settled it, for instance).
 */
export async function recordAudit(input: AuditInput, db: DbHandle = getDb()): Promise<string> {
  const row = buildAuditRow(input)
  // `audit_logs.id` has no database default (migration 0009 declares a bare
  // `uuid PRIMARY KEY`), so the id is minted here. A uuid v7 also makes the primary key
  // time-ordered, which is the order the audit browser reads rows in.
  const [inserted] = await db
    .insert(auditLogs)
    .values({ id: newId(), ...row })
    .returning({ id: auditLogs.id })

  if (!inserted) {
    // `insert ... returning` returning nothing means the row did not land.
    throw new Error(`Audit row for "${input.action}" was not written`)
  }

  // Also emit a log line, so the operational view and the audit trail agree.
  // `warning` and `critical` are what an on-call engineer greps for.
  const fields = {
    audit: input.action,
    auditId: inserted.id,
    targetType: row.targetType,
    targetId: row.targetId,
    actorRole: row.actorRole,
    ...(row.amountPaise === null ? {} : { amountPaise: row.amountPaise.toString() }),
  }
  if (row.severity === 'critical' || row.severity === 'warning') {
    logger.warn(AUDIT_ACTIONS[input.action].summary, fields)
  } else {
    logger.info(AUDIT_ACTIONS[input.action].summary, fields)
  }

  return inserted.id
}

/**
 * Record the exercise of a capability, for grants that demand it.
 *
 * The shape most admin call sites want: they already hold a `Grant` from
 * `requireCapability`, and `grant.mustAudit` already says whether a row is owed.
 * Returns `null` when none is.
 */
export async function recordGrantedAction(
  grant: Grant,
  input: Omit<AuditInput, 'grant'>,
  db: DbHandle = getDb(),
): Promise<string | null> {
  if (!grant.mustAudit) return null
  return recordAudit({ ...input, grant }, db)
}

/** For the admin console's timeline and for error messages. */
export function describeAuditAction(action: AuditAction): AuditActionSpec {
  return AUDIT_ACTIONS[action]
}

/**
 * Which capabilities promise an audit row, for the traceability test.
 *
 * `alwaysAudit` on a capability is a promise; this is how a test can check the
 * promise is kept by the code that exercises it.
 */
export function auditedCapabilities(): Capability[] {
  return (Object.keys(CAPABILITIES) as Capability[]).filter(
    (capability) => CAPABILITIES[capability].alwaysAudit,
  )
}
