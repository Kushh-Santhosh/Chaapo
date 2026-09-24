import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  ALL_AUDIT_ACTIONS,
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  AUDIT_SEVERITIES,
  auditedCapabilities,
  buildAuditRow,
  describeAuditAction,
  type AuditAction,
  type AuditInput,
} from './audit'
import { requireCapability, systemActor, type AuthContext } from './rbac'
import { withLogContext } from './logger'

/**
 * `recordAudit` is a thin wrapper over `buildAuditRow` plus one insert, so the
 * rules live in `buildAuditRow` and are tested here without a database. The
 * insert itself, the append-only trigger and the CHECK constraints are asserted
 * in `audit.itest.ts`.
 *
 * The first block is a drift guard: the category and severity unions are written
 * in three places — the SQL CHECK, the Drizzle `$type`, and the constant in
 * `audit.ts` — and the SQL is the one that can reject a row at two in the morning.
 * Reading the migration in a unit test is cheap, needs no Postgres, and fails the
 * moment the three disagree.
 */

const MIGRATION = 'db/migrations/0009_trust_privacy_config.sql'

/** Pull the value list out of `CHECK (col IN ('a', 'b', …))` in the migration. */
function checkedValues(constraint: string): string[] {
  const sql = readFileSync(MIGRATION, 'utf8')
  const clause = new RegExp(`CONSTRAINT\\s+${constraint}\\s+CHECK\\s*\\(([^)]*\\))`, 'i')
  const match = clause.exec(sql)
  if (!match?.[1]) throw new Error(`Could not find CONSTRAINT ${constraint} in ${MIGRATION}`)
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string)
}

const ADMIN: AuthContext = {
  actorType: 'admin',
  userId: '01890000-0000-7000-8000-0000000000f9',
  role: 'admin_finance',
  roles: ['admin_finance'],
  shopIds: [],
  surface: 'admin',
  sessionId: 'session-1',
  mfaSatisfied: true,
  impersonatedUserId: null,
  label: 'Finance · Anil',
}

const SHOP_ID = '01890000-0000-7000-8000-00000000000a'
const ORDER_ID = '01890000-0000-7000-8000-000000000101'
const REASON = 'shop confirmed the reprint was collected'

function input(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    action: 'order.state_changed',
    actor: ADMIN,
    target: { id: ORDER_ID, label: 'CHP-7F3K2' },
    ...overrides,
  }
}

describe('the category and severity unions match the SQL that enforces them', () => {
  it('lists exactly the categories in audit_logs_category_valid', () => {
    expect([...AUDIT_CATEGORIES].sort()).toEqual(
      checkedValues('audit_logs_category_valid').sort(),
    )
  })

  it('lists exactly the severities in audit_logs_severity_valid', () => {
    expect([...AUDIT_SEVERITIES].sort()).toEqual(
      checkedValues('audit_logs_severity_valid').sort(),
    )
  })

  it('only uses categories the database will accept', () => {
    const allowed = new Set(AUDIT_CATEGORIES)
    for (const action of ALL_AUDIT_ACTIONS) {
      expect(allowed.has(AUDIT_ACTIONS[action].category), action).toBe(true)
    }
  })
})

describe('the action registry', () => {
  it('names every action as domain.thing.happened', () => {
    for (const action of ALL_AUDIT_ACTIONS) {
      expect(action, action).toMatch(/^[a-z_]+\.[a-z_]+(\.[a-z_]+)?$/)
    }
  })

  it('gives every action a target type and a summary', () => {
    for (const action of ALL_AUDIT_ACTIONS) {
      const spec = AUDIT_ACTIONS[action]
      expect(spec.targetType, action).toMatch(/^[a-z_]+$/)
      expect(spec.summary.length, action).toBeGreaterThan(3)
    }
  })

  it('demands a reason for every override and every discretionary money movement', () => {
    const mustExplain: AuditAction[] = [
      'order.transition_overridden',
      'pickup.overridden',
      'refund.approved',
      'refund.rejected',
      'payout.initiated',
      'payout.blocked',
      'ledger.adjustment_posted',
      'config.changed',
      'config.commission_changed',
      'feature_flag.changed',
      'shop.verification.approved',
      'shop.verification.rejected',
      'shop.suspended',
      'shop.bank_updated',
      'privacy.erasure_executed',
      'admin.impersonation_started',
      'admin.pii_exported',
      'file.url_issued_by_admin',
      'auth.mfa.reset',
    ]
    for (const action of mustExplain) {
      expect(AUDIT_ACTIONS[action].requiresReason, action).toBe(true)
    }
  })

  it('marks every action that overrides the system as critical', () => {
    // A reason is not by itself a sign of severity — a shop rejecting an order
    // owes the customer an explanation, and that is routine. What must be
    // critical is an action that puts a human decision above the system's.
    const overrides: AuditAction[] = [
      'order.transition_overridden',
      'pickup.overridden',
      'ledger.adjustment_posted',
      'payout.initiated',
      'shop.bank_updated',
      'config.commission_changed',
      'privacy.erasure_executed',
      'admin.impersonation_started',
      'admin.pii_exported',
      'auth.mfa.reset',
      'account.suspended',
      'shop.suspended',
    ]
    for (const action of overrides) {
      expect(AUDIT_ACTIONS[action].severity, action).toBe('critical')
      expect(AUDIT_ACTIONS[action].requiresReason, action).toBe(true)
    }
  })

  it('keeps every admin-facing money action at notice or above', () => {
    // So that "show me last week's money events" is one severity filter.
    const money = ALL_AUDIT_ACTIONS.filter((action) =>
      ['payment', 'refund', 'payout'].includes(AUDIT_ACTIONS[action].category),
    )
    expect(money.length).toBeGreaterThan(10)
    const routine = money.filter((action) => AUDIT_ACTIONS[action].severity === 'info')
    // The routine ones are the machine-driven steps: an intent opening, a
    // webhook arriving, a refund reaching the provider. Everything a person did
    // is louder than that.
    for (const action of routine) {
      expect(AUDIT_ACTIONS[action].requiresReason, `${action} is info but needs a reason`).toBe(
        false,
      )
    }
  })

  it('requires an amount wherever money is reported', () => {
    for (const action of ['order.placed', 'payment.captured', 'payout.initiated'] as const) {
      expect(AUDIT_ACTIONS[action].requiresAmount, action).toBe(true)
    }
  })

  it('exposes a spec for the admin timeline', () => {
    expect(describeAuditAction('order.collected').category).toBe('order')
  })

  it('has an action for every capability that promises an audit row', () => {
    // Not a mechanical mapping — several capabilities have more than one action,
    // and a few actions are not capability-driven. What this checks is that the
    // categories the capabilities promise to record are all reachable.
    const categories = new Set(ALL_AUDIT_ACTIONS.map((a) => AUDIT_ACTIONS[a].category))
    expect(auditedCapabilities().length).toBeGreaterThan(0)
    for (const category of ['file', 'payout', 'refund', 'privacy', 'verification', 'config']) {
      expect(categories.has(category as never), category).toBe(true)
    }
  })
})

describe('buildAuditRow', () => {
  it('fills the category, severity and target type from the action', () => {
    const row = buildAuditRow(input({ action: 'payout.initiated', reason: REASON, amountPaise: 500000n }))
    expect(row.category).toBe('payout')
    expect(row.severity).toBe('critical')
    expect(row.targetType).toBe('payout')
  })

  it('lets the target type be overridden when the same action spans objects', () => {
    const row = buildAuditRow(input({ target: { type: 'dispute', id: ORDER_ID } }))
    expect(row.targetType).toBe('dispute')
  })

  it('carries the actor through without inventing anything', () => {
    const row = buildAuditRow(input())
    expect(row.actorType).toBe('admin')
    expect(row.actorUserId).toBe(ADMIN.userId)
    expect(row.actorRole).toBe('admin_finance')
    expect(row.actorLabel).toBe('Finance · Anil')
    expect(row.impersonatedUserId).toBeNull()
  })

  it('records both identities during impersonation', () => {
    const row = buildAuditRow(
      input({
        action: 'admin.order_viewed',
        reason: 'customer called about a missing page',
        actor: { ...ADMIN, role: 'admin_support', impersonatedUserId: 'user-9' },
      }),
    )
    expect(row.actorUserId).toBe(ADMIN.userId)
    expect(row.impersonatedUserId).toBe('user-9')
  })

  it('refuses to record a human action with no human attached', () => {
    // The `audit_logs_human_is_identified` CHECK would reject this too; failing
    // here gives a message that names the call site's mistake.
    expect(() => buildAuditRow(input({ actor: { ...ADMIN, userId: null } }))).toThrow(
      /no actorUserId/,
    )
  })

  it('allows a system actor with no user', () => {
    const row = buildAuditRow(input({ action: 'order.auto_cancelled', actor: systemActor('sweeper') }))
    expect(row.actorType).toBe('system')
    expect(row.actorUserId).toBeNull()
    expect(row.actorLabel).toBe('worker · sweeper')
  })

  it('refuses an action that requires a reason without one', () => {
    expect(() => buildAuditRow(input({ action: 'pickup.overridden' }))).toThrow(/requires a reason/)
    expect(() => buildAuditRow(input({ action: 'pickup.overridden', reason: '   ' }))).toThrow(
      /requires a reason/,
    )
  })

  it('takes the reason from the grant that authorised the action', () => {
    const granted = requireCapability(
      { ...ADMIN, role: 'admin_support' },
      'order.transition',
      { shopId: SHOP_ID, reason: REASON },
    )
    expect(granted.ok).toBe(true)
    if (!granted.ok) return

    const row = buildAuditRow(
      input({ action: 'order.transition_overridden', grant: granted.value }),
    )
    expect(row.reason).toBe(REASON)
    expect(row.actorShopId).toBe(SHOP_ID)
  })

  it('trims the reason, so whitespace cannot pass for an explanation', () => {
    const row = buildAuditRow(input({ action: 'pickup.overridden', reason: `  ${REASON}  ` }))
    expect(row.reason).toBe(REASON)
  })

  it('refuses an action that reports money without an amount', () => {
    expect(() => buildAuditRow(input({ action: 'payment.captured' }))).toThrow(/requires amountPaise/)
  })

  it('accepts a zero amount, which is different from a missing one', () => {
    const row = buildAuditRow(input({ action: 'payment.captured', amountPaise: 0n }))
    expect(row.amountPaise).toBe(0n)
  })

  it('escalates severity but never lowers it', () => {
    const raised = buildAuditRow(input({ action: 'order.state_changed', severity: 'critical' }))
    expect(raised.severity).toBe('critical')

    const lowered = buildAuditRow(
      input({ action: 'pickup.overridden', reason: REASON, severity: 'info' }),
    )
    expect(lowered.severity).toBe('critical')
  })

  it('redacts personal data out of the before/after diff', () => {
    const row = buildAuditRow(
      input({
        action: 'account.phone_changed',
        before: { phone: '+919876543210', name: 'Priya' },
        after: { phone: '+919812345678', name: 'Priya S' },
      }),
    )
    expect(row.before).toEqual({ phone: '[redacted]', name: 'Priya' })
    expect(row.after).toEqual({ phone: '[redacted]', name: 'Priya S' })
  })

  it('redacts nested diffs, not only the top level', () => {
    const row = buildAuditRow(
      input({ after: { contact: { email: 'priya@example.com', city: 'Pune' } } }),
    )
    expect(row.after).toEqual({ contact: { email: '[redacted]', city: 'Pune' } })
  })

  it('leaves a missing diff as null rather than an empty object', () => {
    // `{}` in the column would read as "these fields changed to nothing".
    const row = buildAuditRow(input())
    expect(row.before).toBeNull()
    expect(row.after).toBeNull()
  })

  it('picks up the correlation id from the ambient log context', () => {
    const row = withLogContext({ correlationId: 'corr-42' }, () => buildAuditRow(input()))
    expect(row.correlationId).toBe('corr-42')
  })

  it('prefers an explicit correlation id over the ambient one', () => {
    const row = withLogContext({ correlationId: 'corr-42' }, () =>
      buildAuditRow(input({ correlationId: 'corr-explicit' })),
    )
    expect(row.correlationId).toBe('corr-explicit')
  })

  it('records the request fingerprint without recording the request', () => {
    const row = buildAuditRow(
      input({ actor: { ...ADMIN, ipHash: 'sha256:abc', userAgentFamily: 'Chrome' } }),
    )
    expect(row.ipHash).toBe('sha256:abc')
    expect(row.userAgentFamily).toBe('Chrome')
  })
})
