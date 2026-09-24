import { describe, expect, it } from 'vitest'

import { USER_ROLES, type UserRole } from '../db/schema/enums'

import {
  ALL_CAPABILITIES,
  CAPABILITIES,
  MIN_REASON_LENGTH,
  accessFor,
  anonymousActor,
  capabilitiesForRole,
  isAdminRole,
  mayAttempt,
  providerActor,
  requireCapability,
  surfaceForRole,
  systemActor,
  type AuthContext,
  type Capability,
} from './rbac'

/**
 * The permission matrix is the one place where a typo is a privacy incident, so
 * this file tests two different things:
 *
 *   • **The table's shape.** Structural invariants that make a malformed entry a
 *     test failure rather than a runtime surprise — every role accounted for,
 *     `own` never granted without an ownership dimension to resolve it against.
 *
 *   • **Traceability to §15.** All 21 rows of the PRD matrix are named, and every
 *     capability either cites one of them or cites the PRD section it came from.
 *     A capability invented without a source fails here.
 *
 * …and then the guard's behaviour, one branch at a time.
 */

/**
 * The row labels of PRD §15, verbatim and in order.
 *
 * Kept as literal strings rather than derived from `CAPABILITIES`, because the
 * point is to compare the code against the specification. Deriving it from the
 * code would make the test agree with itself.
 */
const PRD_15_ROWS = [
  'Register / manage own profile',
  'Discover shops / search nearby',
  'Upload files & place order',
  'Pay / get refund',
  'View own orders & files',
  "View shop's incoming orders/files",
  'Accept / reject / progress order',
  'Mark ready / verify pickup code',
  'Manage shop profile / hours / printers',
  'Set service catalogue & pricing',
  'Complete business KYC / bank details',
  'View shop earnings / payouts',
  'Invite / manage staff',
  'Approve / suspend shops (verification)',
  'Configure commission / platform fees',
  'Initiate / approve payouts',
  'Handle disputes / issue adjustments',
  'Moderate reviews',
  'Access audit logs / PII exports',
  'Manage geographies / launch belts',
  'Force-delete user data (DPDP erasure)',
] as const

const CUSTOMER_ID = '01890000-0000-7000-8000-000000000001'
const OTHER_CUSTOMER_ID = '01890000-0000-7000-8000-000000000002'
const SHOP_ID = '01890000-0000-7000-8000-00000000000a'
const OTHER_SHOP_ID = '01890000-0000-7000-8000-00000000000b'

function actor(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    actorType: 'customer',
    userId: CUSTOMER_ID,
    role: 'customer',
    roles: ['customer'],
    shopIds: [],
    surface: 'customer',
    sessionId: 'session-1',
    mfaSatisfied: false,
    impersonatedUserId: null,
    label: 'Customer',
    ...overrides,
  }
}

const customer = (userId = CUSTOMER_ID) => actor({ userId })

const shopOwner = (shopIds: string[] = [SHOP_ID]) =>
  actor({
    actorType: 'shop',
    role: 'shop_owner',
    roles: ['shop_owner'],
    shopIds,
    surface: 'shop',
    userId: '01890000-0000-7000-8000-0000000000f1',
  })

const adminActor = (role: UserRole, mfaSatisfied = true) =>
  actor({
    actorType: 'admin',
    role,
    roles: [role],
    surface: 'admin',
    mfaSatisfied,
    userId: '01890000-0000-7000-8000-0000000000f9',
  })

/** A reason long enough to clear MIN_REASON_LENGTH, as a support agent would write. */
const REASON = 'customer reported a wrong page count'

describe('the capability table', () => {
  it('gives every role an explicit cell on every capability', () => {
    for (const capability of ALL_CAPABILITIES) {
      const { access } = CAPABILITIES[capability]
      expect(Object.keys(access).sort(), capability).toEqual([...USER_ROLES].sort())
      for (const role of USER_ROLES) {
        expect(['full', 'own', 'conditional', 'none'], `${capability}.${role}`).toContain(
          access[role],
        )
      }
    }
  })

  it('never grants "own" without an ownership dimension to resolve it against', () => {
    for (const capability of ALL_CAPABILITIES) {
      const spec = CAPABILITIES[capability]
      const grantsOwn = USER_ROLES.some((role) => spec.access[role] === 'own')
      if (grantsOwn) {
        expect(spec.ownership, `${capability} grants "own"`).not.toBe('none')
      }
    }
  })

  it('covers all 21 rows of the §15 matrix', () => {
    const cited = new Set(ALL_CAPABILITIES.map((c) => CAPABILITIES[c].prdRow))
    const uncovered = PRD_15_ROWS.filter((row) => !cited.has(row))
    expect(uncovered, 'PRD §15 rows with no capability').toEqual([])
  })

  it('cites a §15 row or a PRD section for every capability', () => {
    const rows = new Set<string>(PRD_15_ROWS)
    const unsourced = ALL_CAPABILITIES.filter((capability) => {
      const { prdRow } = CAPABILITIES[capability]
      return !rows.has(prdRow) && !prdRow.startsWith('§')
    })
    expect(unsourced, 'capabilities citing neither a §15 row nor a PRD section').toEqual([])
  })

  it('explains every departure from a literal reading of the row', () => {
    // A capability whose `prdRow` is a section rather than a matrix row is a
    // derivation, and must say so.
    for (const capability of ALL_CAPABILITIES) {
      // Widened deliberately: `note` is optional, so on the union of every capability
      // spec it only exists on the members that have one — which is precisely the thing
      // under test, and cannot be asked of the union type itself.
      const spec: { prdRow: string; note?: string } = CAPABILITIES[capability]
      if (spec.prdRow.startsWith('§')) {
        expect(spec.note, `${capability} is derived and needs a note`).toBeTruthy()
      }
    }
  })

  it('keeps worker-only mechanics unreachable by any human role', () => {
    for (const capability of ['payout.settle', 'file.retention_delete'] as const) {
      const spec = CAPABILITIES[capability]
      expect(spec.system, capability).toBe(true)
      for (const role of USER_ROLES) {
        expect(spec.access[role], `${capability}.${role}`).toBe('none')
      }
    }
  })

  it('requires a second factor on everything that moves money or touches privacy', () => {
    const sensitive: Capability[] = [
      'refund.initiate',
      'payout.initiate',
      'platform.commission',
      'platform.config',
      'feature_flag.manage',
      'shop.verification',
      'shop.kyc',
      'audit.read',
      'privacy.export',
      'privacy.erase_execute',
      'admin.impersonate',
      'user.manage_any',
    ]
    for (const capability of sensitive) {
      expect(CAPABILITIES[capability].requiresMfa, capability).toBe(true)
      expect(CAPABILITIES[capability].alwaysAudit, capability).toBe(true)
    }
  })

  it('audits every exercise of file access', () => {
    for (const capability of ['file.view_own', 'file.view_shop'] as const) {
      expect(CAPABILITIES[capability].alwaysAudit, capability).toBe(true)
    }
  })
})

describe('requireCapability — authentication', () => {
  it('refuses an anonymous visitor with 401, not 403', () => {
    const result = requireCapability(anonymousActor(), 'order.create')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unauthenticated')
    expect(result.error.status).toBe(401)
  })

  it('refuses a session with a user but no active role', () => {
    const result = requireCapability(actor({ role: null }), 'order.create')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unauthenticated')
  })
})

describe('requireCapability — denial by default', () => {
  it('denies a role with no cell, and says nothing about why', () => {
    const result = requireCapability(customer(), 'shop.verification')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('forbidden')
    expect(result.error.status).toBe(403)
    expect(result.error.details).toEqual({ capability: 'shop.verification' })
  })

  it('gives the same error for "not your role" and "not yours"', () => {
    const wrongRole = requireCapability(customer(), 'order.view_shop', { shopId: SHOP_ID })
    const notYours = requireCapability(shopOwner(), 'order.view_shop', { shopId: OTHER_SHOP_ID })
    expect(wrongRole.ok).toBe(false)
    expect(notYours.ok).toBe(false)
    if (wrongRole.ok || notYours.ok) return
    expect(wrongRole.error.message).toBe(notYours.error.message)
  })
})

describe('requireCapability — own', () => {
  it('grants a customer access to their own order', () => {
    const result = requireCapability(customer(), 'order.view_own', { ownerUserId: CUSTOMER_ID })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.basis).toBe('own')
    // §15 marks this row as audited even for the owner.
    expect(result.value.mustAudit).toBe(true)
  })

  it("never lets a customer reach another customer's files", () => {
    const result = requireCapability(customer(), 'file.view_own', {
      ownerUserId: OTHER_CUSTOMER_ID,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('forbidden')
  })

  it('resolves shop ownership against the roles the actor holds', () => {
    const owner = shopOwner([SHOP_ID, OTHER_SHOP_ID])
    expect(requireCapability(owner, 'order.transition', { shopId: OTHER_SHOP_ID }).ok).toBe(true)
    expect(
      requireCapability(shopOwner([SHOP_ID]), 'order.transition', { shopId: OTHER_SHOP_ID }).ok,
    ).toBe(false)
  })

  it('treats a null owner as unowned rather than as a match', () => {
    // A draft order with no customer attached must not become everyone's.
    const result = requireCapability(actor({ userId: CUSTOMER_ID }), 'order.view_own', {
      ownerUserId: null,
    })
    expect(result.ok).toBe(false)
  })

  it('accepts either side of a jointly-owned object', () => {
    const byCustomer = requireCapability(customer(), 'dispute.respond', {
      ownerUserId: CUSTOMER_ID,
      shopId: OTHER_SHOP_ID,
    })
    const byShop = requireCapability(shopOwner(), 'dispute.respond', {
      ownerUserId: OTHER_CUSTOMER_ID,
      shopId: SHOP_ID,
    })
    expect(byCustomer.ok).toBe(true)
    expect(byShop.ok).toBe(true)
  })

  it('throws when the call site forgot to say what is owned', () => {
    // A bug, not a denial: a silent 403 here would look like a permissions
    // problem and send someone hunting through the matrix instead of the caller.
    expect(() => requireCapability(customer(), 'order.view_own')).toThrow(/scope\.ownerUserId/)
    expect(() => requireCapability(shopOwner(), 'order.transition')).toThrow(/scope\.shopId/)
    expect(() => requireCapability(customer(), 'dispute.raise')).toThrow(
      /scope\.ownerUserId or shopId/,
    )
  })
})

describe('requireCapability — conditional', () => {
  it('demands a written reason', () => {
    const result = requireCapability(adminActor('admin_support'), 'order.view_own', {
      ownerUserId: CUSTOMER_ID,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('precondition_failed')
    expect(result.error.details).toMatchObject({ minimumReasonLength: MIN_REASON_LENGTH })
  })

  it('rejects a reason too short to mean anything', () => {
    const result = requireCapability(adminActor('admin_support'), 'order.view_own', {
      ownerUserId: CUSTOMER_ID,
      reason: '   ok   ',
    })
    expect(result.ok).toBe(false)
  })

  it('grants with the trimmed reason attached, and forces an audit entry', () => {
    const result = requireCapability(adminActor('admin_support'), 'order.view_own', {
      ownerUserId: CUSTOMER_ID,
      reason: `  ${REASON}  `,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.basis).toBe('conditional')
    expect(result.value.reason).toBe(REASON)
    expect(result.value.mustAudit).toBe(true)
  })

  it('does not let a conditional cell reach past its own capability', () => {
    // Support may view an order with a reason; support may not pay for one.
    const result = requireCapability(adminActor('admin_support'), 'payment.pay', {
      ownerUserId: CUSTOMER_ID,
      reason: REASON,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('forbidden')
  })
})

describe('requireCapability — second factor', () => {
  it('blocks an admin who has not satisfied MFA in this session', () => {
    const result = requireCapability(adminActor('admin_finance', false), 'payout.initiate')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('mfa_required')
  })

  it('lets the same admin through once MFA is satisfied', () => {
    expect(requireCapability(adminActor('admin_finance'), 'payout.initiate').ok).toBe(true)
  })

  it('does not impose the admin MFA gate on a shop owner', () => {
    // `shop.kyc` is MFA-gated for admins assisting with it. A shop owner
    // submitting their own bank details is not held to the admin console's bar.
    const result = requireCapability(shopOwner(), 'shop.kyc', { shopId: SHOP_ID })
    expect(result.ok).toBe(true)
  })

  it('checks MFA before ownership, so a missing factor is never reported as a 403', () => {
    const result = requireCapability(adminActor('admin_super', false), 'privacy.erase_execute', {
      reason: REASON,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('mfa_required')
  })
})

describe('requireCapability — system and provider actors', () => {
  it('lets the sweeper transition an order', () => {
    const result = requireCapability(systemActor('order.sweeper'), 'order.transition', {
      shopId: SHOP_ID,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.basis).toBe('system')
  })

  it('throws when a job asks for something no job may do', () => {
    // Not a 403: the worker has no user to show it to, and the job list is code.
    expect(() => requireCapability(systemActor('order.sweeper'), 'order.create')).toThrow(
      /not marked system-callable/,
    )
    expect(() => requireCapability(providerActor('razorpay'), 'shop.verification')).toThrow(
      /not marked system-callable/,
    )
  })

  it('lets a signed webhook refund a payment, and records it', () => {
    const result = requireCapability(providerActor('razorpay'), 'refund.initiate')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.mustAudit).toBe(true)
  })

  it('does not require a reason from a system actor', () => {
    const result = requireCapability(systemActor('privacy.erasure'), 'privacy.erase_execute')
    expect(result.ok).toBe(true)
  })
})

describe('mustAudit', () => {
  it('is set on a full-access grant when the capability is always audited', () => {
    const result = requireCapability(adminActor('admin_super'), 'order.verify_pickup', {
      shopId: SHOP_ID,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.basis).toBe('full')
    expect(result.value.mustAudit).toBe(true)
  })

  it('is not set on ordinary shop work', () => {
    const result = requireCapability(shopOwner(), 'order.transition', { shopId: SHOP_ID })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.mustAudit).toBe(false)
  })
})

describe('cosmetic helpers', () => {
  it('reports no access for a role-less actor', () => {
    expect(accessFor(null, 'order.create')).toBe('none')
  })

  it('routes each role to the surface it signs in to', () => {
    expect(surfaceForRole('customer')).toBe('customer')
    expect(surfaceForRole('shop_owner')).toBe('shop')
    expect(surfaceForRole('shop_staff')).toBe('shop')
    expect(surfaceForRole('admin_support')).toBe('admin')
    expect(surfaceForRole('admin_finance')).toBe('admin')
    expect(surfaceForRole('admin_super')).toBe('admin')
  })

  it('classifies admin roles', () => {
    expect(USER_ROLES.filter(isAdminRole)).toEqual([
      'admin_support',
      'admin_finance',
      'admin_super',
    ])
  })

  it('lists only what a role can attempt', () => {
    const forCustomer = capabilitiesForRole('customer').map((entry) => entry.capability)
    expect(forCustomer).toContain('order.create')
    expect(forCustomer).toContain('review.create')
    expect(forCustomer).not.toContain('shop.verification')
    expect(forCustomer).not.toContain('payout.initiate')
  })

  it('agrees with the guard about what is worth rendering', () => {
    expect(mayAttempt(customer(), 'order.create')).toBe(true)
    expect(mayAttempt(customer(), 'payout.initiate')).toBe(false)
    expect(mayAttempt(systemActor('sweeper'), 'order.transition')).toBe(true)
    expect(mayAttempt(systemActor('sweeper'), 'order.create')).toBe(false)
  })
})
