/**
 * The config store against a real database.
 *
 * Three things can only be proved here:
 *
 *   • **Parity with the seeded rows.** The unit test compares `CONFIG_SPECS` with
 *     the migration's SQL text. This compares it with what Postgres actually holds
 *     after every migration has run — including any later migration that adds,
 *     renames or retypes a key.
 *
 *   • **The write path.** A config change is four writes that must happen together:
 *     the row, its version, a history row, and an audit row. `platform_config_history`
 *     has no trigger behind it, so "history was written" is an application promise,
 *     and this is where it is kept honest.
 *
 *   • **The gates.** The capability check and the row's own `requires_super_admin`
 *     compose: a Finance Admin may change an SLA timer and may not change the
 *     commission rate. That is two different mechanisms agreeing, and only the
 *     database has the second one.
 */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { newId } from '@/lib/ids'
import {
  CONFIG_KEYS,
  CONFIG_SPECS,
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
  coerceConfigValue,
  invalidateConfigCache,
  isFeatureEnabled,
  listConfig,
  loadSettings,
  setConfigValue,
  setFeatureFlag,
  type ConfigKey,
} from '@/server/core/config-store'
import { getDb } from '@/server/db/client'
import { featureFlags, platformConfig, platformConfigHistory } from '@/server/db/schema/config'
import { users } from '@/server/db/schema/identity'
import { auditLogs } from '@/server/db/schema/trust'
import { raw, truncateToReferenceData } from '@/test/db'
import type { AuthContext } from '@/server/core/rbac'

const SUPER_ID = newId()
const FINANCE_ID = newId()

function admin(role: 'admin_super' | 'admin_finance' | 'admin_support', mfaSatisfied = true): AuthContext {
  return {
    actorType: 'admin',
    userId: role === 'admin_super' ? SUPER_ID : FINANCE_ID,
    role,
    roles: [role],
    shopIds: [],
    surface: 'admin',
    sessionId: 'session-itest',
    mfaSatisfied,
    impersonatedUserId: null,
    label: role === 'admin_super' ? 'Super · Meera' : 'Finance · Anil',
  }
}

const customer: AuthContext = {
  actorType: 'customer',
  userId: newId(),
  role: 'customer',
  roles: ['customer'],
  shopIds: [],
  surface: 'customer',
  sessionId: 'session-customer',
  mfaSatisfied: false,
  impersonatedUserId: null,
  label: 'Customer',
}

const REASON = 'board approved the new turnaround target for the Pune belt'

/** Enough of a user row to satisfy the foreign keys the store writes. */
async function seedAdmins(): Promise<void> {
  await getDb()
    .insert(users)
    .values(
      [
        { id: SUPER_ID, name: 'super' },
        { id: FINANCE_ID, name: 'finance' },
      ].map(({ id, name }) => ({
        id,
        phoneEncrypted: `enc:${name}`,
        phoneHash: `hash:${name}`,
        phoneMasked: '+91 ***** **210',
        fullName: name,
      })),
    )
}

async function historyFor(key: string) {
  return getDb()
    .select()
    .from(platformConfigHistory)
    .where(eq(platformConfigHistory.key, key))
}

async function rowFor(key: string) {
  const [row] = await getDb().select().from(platformConfig).where(eq(platformConfig.key, key))
  return row
}

async function auditFor(action: string) {
  return getDb().select().from(auditLogs).where(eq(auditLogs.action, action))
}

beforeEach(async () => {
  await truncateToReferenceData()
  invalidateConfigCache()
  await seedAdmins()
})

describe('the TypeScript spec table and the database agree', () => {
  it('holds exactly the keys the code knows about', async () => {
    const rows = await getDb().select({ key: platformConfig.key }).from(platformConfig)
    expect(rows.map((row) => row.key).sort()).toEqual([...CONFIG_KEYS].sort())
  })

  it('declares the same value type for every key', async () => {
    const rows = await getDb()
      .select({ key: platformConfig.key, valueType: platformConfig.valueType })
      .from(platformConfig)
    for (const row of rows) {
      expect(CONFIG_SPECS[row.key as ConfigKey].type, row.key).toBe(row.valueType)
    }
  })

  it('stores a value every key can actually read back', async () => {
    // The failure this catches: a seeded `'8'` where the code wants a number, or a
    // paise value stored as a string. Both look fine in psql.
    const rows = await getDb().select().from(platformConfig)
    for (const row of rows) {
      const coerced = coerceConfigValue(row.key, row.valueType, row.value)
      expect(coerced.ok, `${row.key} = ${JSON.stringify(row.value)}`).toBe(true)
    }
  })

  it('loads a complete snapshot', async () => {
    const settings = await loadSettings()
    for (const key of CONFIG_KEYS) {
      expect(settings.has(key), key).toBe(true)
    }
    expect(settings.get('commission.rate_bps')).toBe(800)
    expect(settings.get('commission.min_paise')).toBe(200n)
    expect(settings.get('payouts.schedule')).toBe('weekly')
    expect(settings.get('refunds.free_cancel_until_accepted')).toBe(true)
  })

  it('holds exactly the feature flags the code knows about, in their seeded state', async () => {
    const rows = await getDb().select().from(featureFlags)
    expect(rows.map((row) => row.key).sort()).toEqual([...FEATURE_FLAG_KEYS].sort())
    for (const row of rows) {
      const spec = FEATURE_FLAGS[row.key as keyof typeof FEATURE_FLAGS]
      expect(row.isEnabled, row.key).toBe(spec.seedEnabled)
      expect(row.rolloutBps, row.key).toBe(spec.seedRolloutBps)
    }
  })

  it('exposes the bounds and section the admin console renders', async () => {
    const rows = await listConfig()
    expect(rows).toHaveLength(CONFIG_KEYS.length)
    const rate = rows.find((row) => row.key === 'commission.rate_bps')
    expect(rate).toMatchObject({
      section: 'commission',
      unit: '%',
      minValue: '0',
      maxValue: '3000',
      requiresSuperAdmin: true,
      isReadonly: false,
      version: 1,
    })
  })
})

describe('setConfigValue', () => {
  it('changes the value, bumps the version, and records who and why', async () => {
    const result = await setConfigValue({
      key: 'sla.dispute_first_response_hours',
      value: 12,
      actor: admin('admin_super'),
      reason: REASON,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({ version: 2, previous: 24, current: 12, changed: true })

    const row = await rowFor('sla.dispute_first_response_hours')
    expect(row?.value).toBe(12)
    expect(row?.version).toBe(2)
    expect(row?.updatedBy).toBe(SUPER_ID)

    const history = await historyFor('sla.dispute_first_response_hours')
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      version: 2,
      oldValue: 24,
      newValue: 12,
      changedBy: SUPER_ID,
      reason: REASON,
    })

    const audit = await auditFor('config.changed')
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      category: 'config',
      actorUserId: SUPER_ID,
      targetType: 'platform_config',
      targetLabel: 'sla.dispute_first_response_hours',
      reason: REASON,
    })
    expect(audit[0]?.before).toEqual({ value: 24, version: 1 })
    expect(audit[0]?.after).toEqual({ value: 12, version: 2 })
  })

  it('is visible to the next reader without waiting for the cache to lapse', async () => {
    const before = await loadSettings()
    expect(before.get('orders.accept_window_minutes')).toBe(15)

    const result = await setConfigValue({
      key: 'orders.accept_window_minutes',
      value: 20,
      actor: admin('admin_super'),
      reason: REASON,
    })
    expect(result.ok).toBe(true)

    const after = await loadSettings()
    expect(after.get('orders.accept_window_minutes')).toBe(20)
  })

  it('stores money as a number and reads it back as paise', async () => {
    const result = await setConfigValue({
      key: 'payouts.min_paise',
      value: 25_000,
      actor: admin('admin_super'),
      reason: REASON,
    })
    expect(result.ok).toBe(true)

    const settings = await loadSettings()
    expect(settings.get('payouts.min_paise')).toBe(25_000n)

    const [row] = await raw<{ value: unknown }>(
      "SELECT value FROM platform_config WHERE key = 'payouts.min_paise'",
    )
    expect(row?.value).toBe(25_000)
  })

  it('treats re-submitting the value already in force as no change', async () => {
    const result = await setConfigValue({
      key: 'orders.accept_window_minutes',
      value: 15,
      actor: admin('admin_super'),
      reason: REASON,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.changed).toBe(false)
    expect(result.value.version).toBe(1)

    // No version churn, no history noise, no audit entry for a non-event.
    expect((await rowFor('orders.accept_window_minutes'))?.version).toBe(1)
    expect(await historyFor('orders.accept_window_minutes')).toHaveLength(0)
    expect(await auditFor('config.changed')).toHaveLength(0)
  })

  it('keeps a history row per change, in version order', async () => {
    for (const value of [20, 25, 30]) {
      const result = await setConfigValue({
        key: 'orders.accept_window_minutes',
        value,
        actor: admin('admin_super'),
        reason: REASON,
      })
      expect(result.ok, String(value)).toBe(true)
    }

    const history = (await historyFor('orders.accept_window_minutes')).sort(
      (a, b) => a.version - b.version,
    )
    expect(history.map((row) => [row.version, row.oldValue, row.newValue])).toEqual([
      [2, 15, 20],
      [3, 20, 25],
      [4, 25, 30],
    ])
    expect((await rowFor('orders.accept_window_minutes'))?.version).toBe(4)
  })

  it('will not let history be rewritten', async () => {
    await setConfigValue({
      key: 'orders.accept_window_minutes',
      value: 20,
      actor: admin('admin_super'),
      reason: REASON,
    })

    await expect(
      raw("UPDATE platform_config_history SET reason = 'something else'"),
    ).rejects.toThrow()
    await expect(raw('DELETE FROM platform_config_history')).rejects.toThrow()
  })
})

describe('setConfigValue — the gates', () => {
  it('lets a Finance Admin change ordinary policy, with a reason', async () => {
    const result = await setConfigValue({
      key: 'sla.shop_first_response_minutes',
      value: 8,
      actor: admin('admin_finance'),
      reason: REASON,
    })
    expect(result.ok).toBe(true)
  })

  it('refuses a Finance Admin the commission rate, which needs a Super Admin', async () => {
    // The capability grants finance a conditional cell; the row's own
    // `requires_super_admin` is the second gate, and it is the one that holds here.
    const result = await setConfigValue({
      key: 'commission.rate_bps',
      value: 900,
      actor: admin('admin_finance'),
      reason: REASON,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('forbidden')
    expect((await rowFor('commission.rate_bps'))?.value).toBe(800)
    expect(await historyFor('commission.rate_bps')).toHaveLength(0)
  })

  it('lets a Super Admin change the commission rate, and files it separately', async () => {
    const result = await setConfigValue({
      key: 'commission.rate_bps',
      value: 900,
      actor: admin('admin_super'),
      reason: REASON,
    })

    expect(result.ok).toBe(true)
    expect((await rowFor('commission.rate_bps'))?.value).toBe(900)

    // Revenue-model changes get their own action, so "who changed our take rate"
    // is one query rather than a scan of every config edit.
    const audit = await auditFor('config.commission_changed')
    expect(audit).toHaveLength(1)
    expect(audit[0]?.severity).toBe('critical')
    expect(await auditFor('config.changed')).toHaveLength(0)
  })

  it('refuses a Support Admin outright', async () => {
    const result = await setConfigValue({
      key: 'orders.accept_window_minutes',
      value: 20,
      actor: admin('admin_support'),
      reason: REASON,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('forbidden')
  })

  it('refuses a customer', async () => {
    const result = await setConfigValue({
      key: 'orders.accept_window_minutes',
      value: 20,
      actor: customer,
      reason: REASON,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('forbidden')
  })

  it('refuses an admin who has not satisfied MFA in this session', async () => {
    const result = await setConfigValue({
      key: 'orders.accept_window_minutes',
      value: 20,
      actor: admin('admin_super', false),
      reason: REASON,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('mfa_required')
    expect((await rowFor('orders.accept_window_minutes'))?.value).toBe(15)
  })

  it('demands a reason long enough to be one', async () => {
    const result = await setConfigValue({
      key: 'orders.accept_window_minutes',
      value: 20,
      actor: admin('admin_super'),
      reason: 'nope',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('precondition_failed')
  })

  it('enforces the bounds the row declares, and writes nothing when it fails', async () => {
    const result = await setConfigValue({
      key: 'commission.rate_bps',
      value: 5000,
      actor: admin('admin_super'),
      reason: REASON,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('validation_failed')
    expect(result.error.fields?.[0]?.message).toContain('3000')

    expect((await rowFor('commission.rate_bps'))?.value).toBe(800)
    expect((await rowFor('commission.rate_bps'))?.version).toBe(1)
    expect(await historyFor('commission.rate_bps')).toHaveLength(0)
    expect(await auditFor('config.commission_changed')).toHaveLength(0)
  })

  it('refuses a value of the wrong type', async () => {
    const result = await setConfigValue({
      key: 'commission.rate_bps',
      value: '900',
      actor: admin('admin_super'),
      reason: REASON,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('validation_failed')
  })

  it('refuses a key the migration marks read-only', async () => {
    await raw(
      "UPDATE platform_config SET is_readonly = true WHERE key = 'privacy.financial_retention_years'",
    )

    const result = await setConfigValue({
      key: 'privacy.financial_retention_years',
      value: 10,
      actor: admin('admin_super'),
      reason: REASON,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('forbidden')
    expect(result.error.message).toContain('migration')
  })

  it('reports a key that does not exist as not found', async () => {
    await raw("DELETE FROM platform_config WHERE key = 'ratings.window_days'")
    const result = await setConfigValue({
      key: 'ratings.window_days',
      value: 21,
      actor: admin('admin_super'),
      reason: REASON,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('not_found')
  })
})

describe('loadSettings — a database that has drifted', () => {
  it('refuses to serve a value it cannot read as its declared type', async () => {
    // Better to fail the request than to price an order from a value nobody can
    // interpret. This is the one case where the store is deliberately fragile.
    await raw(
      `UPDATE platform_config SET value = '"soon"'::jsonb WHERE key = 'orders.accept_window_minutes'`,
    )
    invalidateConfigCache()

    await expect(loadSettings()).rejects.toThrow(/unreadable/)
  })

  it('ignores a key the code has not caught up with yet', async () => {
    // A migration that adds a key ahead of the code that reads it is a normal
    // deploy ordering, not an outage.
    await raw(`
      INSERT INTO platform_config (key, value, value_type, section, label, description)
      VALUES ('future.something', '1'::jsonb, 'integer', 'orders', 'Future', 'Added by a later migration.')
    `)
    invalidateConfigCache()

    const settings = await loadSettings()
    expect(settings.has('future.something')).toBe(false)
    expect(settings.get('orders.accept_window_minutes')).toBe(15)
  })
})

describe('setFeatureFlag', () => {
  it('turns a flag on for a percentage of subjects and audits it', async () => {
    const result = await setFeatureFlag({
      key: 'scan_at_counter',
      isEnabled: true,
      rolloutBps: 5_000,
      actor: admin('admin_super'),
      reason: 'piloting counter scanning with the Kothrud shops',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({ isEnabled: true, rolloutBps: 5_000 })

    const [row] = await getDb().select().from(featureFlags).where(eq(featureFlags.key, 'scan_at_counter'))
    expect(row?.isEnabled).toBe(true)
    expect(row?.rolloutBps).toBe(5_000)
    expect(row?.updatedBy).toBe(SUPER_ID)

    const audit = await auditFor('feature_flag.changed')
    expect(audit).toHaveLength(1)
    expect(audit[0]?.targetLabel).toBe('scan_at_counter')
  })

  it('is reflected by the next flag check', async () => {
    await expect(isFeatureEnabled('scan_at_counter')).resolves.toBe(false)

    await setFeatureFlag({
      key: 'scan_at_counter',
      isEnabled: true,
      rolloutBps: 10_000,
      actor: admin('admin_super'),
      reason: 'enabling counter scanning for the pilot',
    })

    await expect(isFeatureEnabled('scan_at_counter')).resolves.toBe(true)
  })

  it('adds an explicit shop without changing the percentage', async () => {
    const shopId = newId()
    const result = await setFeatureFlag({
      key: 'large_format_catalogue',
      isEnabled: true,
      enabledShopIds: [shopId],
      actor: admin('admin_super'),
      reason: 'one shop has the A1 plotter installed',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.rolloutBps).toBe(0)

    await expect(isFeatureEnabled('large_format_catalogue', { shopId })).resolves.toBe(true)
    await expect(isFeatureEnabled('large_format_catalogue', { shopId: newId() })).resolves.toBe(
      false,
    )
  })

  it('leaves a flag alone when only one field is supplied', async () => {
    await setFeatureFlag({
      key: 'quote_flow',
      isEnabled: false,
      actor: admin('admin_super'),
      reason: 'pausing quote-required orders while we fix pricing',
    })

    const [row] = await getDb().select().from(featureFlags).where(eq(featureFlags.key, 'quote_flow'))
    expect(row?.isEnabled).toBe(false)
    // The rollout was not mentioned, so it is untouched — turning a flag off and
    // back on must not silently reset it to zero.
    expect(row?.rolloutBps).toBe(10_000)
  })

  it('refuses a rollout outside the basis-point scale', async () => {
    const result = await setFeatureFlag({
      key: 'scan_at_counter',
      rolloutBps: 10_001,
      actor: admin('admin_super'),
      reason: 'testing the upper bound of the rollout',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('validation_failed')
  })

  it('is a Super Admin capability only', async () => {
    const result = await setFeatureFlag({
      key: 'scan_at_counter',
      isEnabled: true,
      actor: admin('admin_finance'),
      reason: 'finance would like to try counter scanning',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('forbidden')

    const [row] = await getDb().select().from(featureFlags).where(eq(featureFlags.key, 'scan_at_counter'))
    expect(row?.isEnabled).toBe(false)
  })
})
