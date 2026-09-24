import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  CONFIG_KEYS,
  CONFIG_SPECS,
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
  __setFeatureFlagsForTests,
  capabilityForConfigKey,
  coerceConfigValue,
  evaluateFlag,
  isFeatureEnabled,
  rolloutBucket,
  serialiseConfigValue,
  settingsFromSpecs,
  type ConfigKey,
  type ConfigValueType,
  type FlagState,
} from './config-store'

/**
 * Three things are tested here, none of which need a database:
 *
 *   • **Parity with the migration.** `CONFIG_SPECS` and `FEATURE_FLAGS` restate the
 *     keys, types and seeded values from migration 0011. Reading the SQL and
 *     comparing is cheap and catches the drift the moment it happens, rather than
 *     leaving it for the integration suite — or for a shop's payout.
 *
 *   • **Coercion.** A config store whose types are advisory is worse than none,
 *     because every call site then quietly assumes its own. `"800"` is not 800.
 *
 *   • **Flag evaluation.** Pure, so all of it is testable: the master switch, the
 *     explicit lists, and the bucketing that has to give the same answer in every
 *     process for the same subject.
 *
 * `setConfigValue` and `setFeatureFlag` need a transaction and a row lock, so they
 * are asserted in `config-store.itest.ts`.
 */

const MIGRATION = 'db/migrations/0011_reference_data.sql'

/** A SQL single-quoted string, with '' as the escape. */
const SQL_STRING = "'((?:[^']|'')*)'"

function migrationBlock(startsWith: string): string {
  const sql = readFileSync(MIGRATION, 'utf8')
  const start = sql.indexOf(startsWith)
  if (start === -1) throw new Error(`Could not find "${startsWith}" in ${MIGRATION}`)
  const end = sql.indexOf('ON CONFLICT', start)
  if (end === -1) throw new Error(`Could not find the end of "${startsWith}" in ${MIGRATION}`)
  return sql.slice(start, end)
}

/** The (key, value, value_type) of every seeded platform_config row. */
function seededConfigRows(): Array<{ key: string; value: string; valueType: string }> {
  // Anchored at the start of a line, which is where every tuple in the VALUES list
  // begins. Without the anchor, a parenthesis inside a description could start a
  // spurious match.
  const tuple = new RegExp(`^\\s*\\(\\s*${SQL_STRING},\\s*${SQL_STRING},\\s*${SQL_STRING},`, 'gm')
  const rows = [...migrationBlock('INSERT INTO platform_config').matchAll(tuple)].map((match) => ({
    key: match[1] as string,
    value: (match[2] as string).replace(/''/g, "'"),
    valueType: match[3] as string,
  }))
  if (rows.length === 0) throw new Error(`Parsed no platform_config rows from ${MIGRATION}`)
  return rows
}

/** The (key, is_enabled, rollout_bps) of every seeded feature flag. */
function seededFlags(): Array<{ key: string; isEnabled: boolean; rolloutBps: number }> {
  const tuple = new RegExp(
    `^\\s*\\(\\s*${SQL_STRING},\\s*${SQL_STRING},\\s*${SQL_STRING},\\s*(true|false),\\s*(\\d+)\\)`,
    'gm',
  )
  const rows = [...migrationBlock('INSERT INTO feature_flags').matchAll(tuple)].map((match) => ({
    key: match[1] as string,
    isEnabled: match[4] === 'true',
    rolloutBps: Number(match[5]),
  }))
  if (rows.length === 0) throw new Error(`Parsed no feature_flags rows from ${MIGRATION}`)
  return rows
}

function flag(overrides: Partial<FlagState> = {}): FlagState {
  return {
    key: 'quote_flow',
    isEnabled: true,
    rolloutBps: 10_000,
    enabledUserIds: [],
    enabledShopIds: [],
    enabledCityIds: [],
    ...overrides,
  }
}

describe('CONFIG_SPECS matches the migration that seeds it', () => {
  const seeded = seededConfigRows()

  it('knows about exactly the keys the database is seeded with', () => {
    expect([...CONFIG_KEYS].sort()).toEqual(seeded.map((row) => row.key).sort())
  })

  it('declares the same value type as the row', () => {
    for (const row of seeded) {
      expect(CONFIG_SPECS[row.key as ConfigKey].type, row.key).toBe(row.valueType)
    }
  })

  it('carries the same seeded value, coerced', () => {
    for (const row of seeded) {
      const spec = CONFIG_SPECS[row.key as ConfigKey]
      const coerced = coerceConfigValue(row.key, spec.type, JSON.parse(row.value))
      expect(coerced.ok, `${row.key}: ${row.value}`).toBe(true)
      if (!coerced.ok) continue
      expect(coerced.value, row.key).toEqual(spec.seed)
    }
  })

  it('uses bigint for money and plain numbers for everything countable', () => {
    for (const key of CONFIG_KEYS) {
      const spec = CONFIG_SPECS[key]
      if (spec.type === 'paise') expect(typeof spec.seed, key).toBe('bigint')
      if (spec.type === 'bps') {
        expect(typeof spec.seed, key).toBe('number')
        expect(spec.seed as number, key).toBeGreaterThanOrEqual(0)
        expect(spec.seed as number, key).toBeLessThanOrEqual(10_000)
      }
    }
  })
})

describe('FEATURE_FLAGS matches the migration that seeds it', () => {
  const seeded = seededFlags()

  it('knows about exactly the seeded flags', () => {
    expect([...FEATURE_FLAG_KEYS].sort()).toEqual(seeded.map((row) => row.key).sort())
  })

  it('records the same seeded state', () => {
    for (const row of seeded) {
      const spec = FEATURE_FLAGS[row.key as keyof typeof FEATURE_FLAGS]
      expect(spec.seedEnabled, row.key).toBe(row.isEnabled)
      expect(spec.seedRolloutBps, row.key).toBe(row.rolloutBps)
    }
  })

  it('ships deferred features off', () => {
    // The PRD defers these; the flags exist so the code paths are real, not so
    // they can be on. A migration that turned one on by accident fails here.
    for (const key of [
      'whatsapp_notifications',
      'scan_at_counter',
      'large_format_catalogue',
      'scheduled_pickup',
      'shop_counter_orders',
      'admin_impersonation',
    ] as const) {
      expect(FEATURE_FLAGS[key].seedEnabled, key).toBe(false)
    }
  })
})

describe('the seeded policy still says what the PRD says', () => {
  const settings = settingsFromSpecs()

  it('takes 8% commission from the shop and nothing from the customer', () => {
    expect(settings.get('commission.rate_bps')).toBe(800)
    expect(settings.get('customer.platform_fee_paise')).toBe(0n)
  })

  it('refunds in full before printing and nothing after', () => {
    expect(settings.get('refunds.free_cancel_until_accepted')).toBe(true)
    expect(settings.get('refunds.accepted_pre_print_bps')).toBe(10_000)
    expect(settings.get('refunds.during_printing_bps')).toBe(0)
    expect(settings.get('refunds.expired_pickup_bps')).toBe(0)
  })

  it('keeps signed file URLs short-lived', () => {
    // NFR: a link that leaks is a link that has already expired.
    expect(settings.get('files.signed_url_ttl_seconds')).toBeLessThanOrEqual(900)
  })

  it('deletes files rather than keeping them', () => {
    for (const key of [
      'files.retention_days_after_collection',
      'files.retention_days_unused',
      'files.retention_days_cancelled',
    ] as const) {
      const days = settings.get(key)
      expect(days, key).toBeGreaterThan(0)
      expect(days, key).toBeLessThanOrEqual(90)
    }
  })

  it('holds funds past collection before releasing them', () => {
    expect(settings.get('payouts.hold_hours_after_collection')).toBeGreaterThanOrEqual(0)
    expect(settings.get('pickup.grace_hours')).toBe(48)
  })
})

describe('settingsFromSpecs', () => {
  it('returns every key with its seeded value', () => {
    const settings = settingsFromSpecs()
    for (const key of CONFIG_KEYS) {
      expect(settings.has(key), key).toBe(true)
    }
    expect(settings.get('orders.accept_window_minutes')).toBe(15)
  })

  it('lets a test override the value it cares about', () => {
    const settings = settingsFromSpecs({ 'commission.rate_bps': 1200 })
    expect(settings.get('commission.rate_bps')).toBe(1200)
    expect(settings.get('commission.min_paise')).toBe(200n)
  })

  it('throws rather than guessing for a key it does not have', () => {
    const settings = settingsFromSpecs()
    expect(() => settings.get('commission.nonexistent' as ConfigKey)).toThrow(/db:migrate/)
  })
})

describe('coerceConfigValue', () => {
  const cases: Array<[ConfigValueType, unknown, unknown]> = [
    ['integer', 5, 5],
    ['minutes', 15, 15],
    ['days', 7, 7],
    ['hours', 24, 24],
    ['bps', 800, 800],
    ['paise', 200, 200n],
    ['boolean', true, true],
    ['string', 'weekly', 'weekly'],
    ['json', { a: 1 }, { a: 1 }],
  ]

  it.each(cases)('reads a %s', (type, raw, expected) => {
    const result = coerceConfigValue('k', type, raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(expected)
  })

  it('refuses a number that arrived as a string', () => {
    // The classic config bug: `"800"` reads as truthy, sorts wrong, and multiplies
    // into `NaN` three layers away from here.
    const result = coerceConfigValue('commission.rate_bps', 'bps', '800')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('validation_failed')
    expect(result.error.fields?.[0]?.message).toContain('commission.rate_bps')
  })

  it('refuses a fractional count', () => {
    expect(coerceConfigValue('k', 'minutes', 1.5).ok).toBe(false)
    expect(coerceConfigValue('k', 'paise', 199.5).ok).toBe(false)
  })

  it('refuses basis points outside the scale', () => {
    expect(coerceConfigValue('k', 'bps', -1).ok).toBe(false)
    expect(coerceConfigValue('k', 'bps', 10_001).ok).toBe(false)
    expect(coerceConfigValue('k', 'bps', 10_000).ok).toBe(true)
  })

  it('refuses negative money', () => {
    expect(coerceConfigValue('k', 'paise', -1).ok).toBe(false)
    expect(coerceConfigValue('k', 'paise', 0).ok).toBe(true)
  })

  it('refuses 1 and 0 for a boolean', () => {
    expect(coerceConfigValue('k', 'boolean', 1).ok).toBe(false)
    expect(coerceConfigValue('k', 'boolean', 'true').ok).toBe(false)
  })

  it('refuses null everywhere', () => {
    for (const type of ['integer', 'bps', 'paise', 'boolean', 'string', 'json'] as const) {
      expect(coerceConfigValue('k', type, null).ok, type).toBe(false)
    }
  })

  it('reads a string array and freezes it', () => {
    const result = coerceConfigValue('k', 'string_array', ['a', 'b'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(['a', 'b'])
    expect(Object.isFrozen(result.value)).toBe(true)
  })

  it('refuses a mixed array', () => {
    expect(coerceConfigValue('k', 'string_array', ['a', 2]).ok).toBe(false)
  })

  it('names the type it wanted, so the admin console can say so', () => {
    const result = coerceConfigValue('payouts.schedule', 'string', 3)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.fields?.[0]?.message).toBe('payouts.schedule expects a string, got number.')
  })
})

describe('serialiseConfigValue', () => {
  it('stores paise as a JSON number', () => {
    expect(serialiseConfigValue('k', 200n)).toBe(200)
  })

  it('passes everything else through untouched', () => {
    expect(serialiseConfigValue('k', 'weekly')).toBe('weekly')
    expect(serialiseConfigValue('k', false)).toBe(false)
    expect(serialiseConfigValue('k', ['a'])).toEqual(['a'])
  })

  it('refuses to quietly lose the low digits of a large amount', () => {
    expect(() => serialiseConfigValue('k', 2n ** 60n)).toThrow(/too large/)
  })
})

describe('capabilityForConfigKey', () => {
  it('puts the revenue model behind its own capability', () => {
    expect(capabilityForConfigKey('commission.rate_bps')).toBe('platform.commission')
    expect(capabilityForConfigKey('commission.tds_rate_bps')).toBe('platform.commission')
    expect(capabilityForConfigKey('customer.platform_fee_paise')).toBe('platform.commission')
  })

  it('treats everything else as ordinary policy', () => {
    expect(capabilityForConfigKey('orders.accept_window_minutes')).toBe('platform.config')
    expect(capabilityForConfigKey('refunds.during_printing_bps')).toBe('platform.config')
  })
})

describe('evaluateFlag', () => {
  const USER = '01890000-0000-7000-8000-000000000001'
  const SHOP = '01890000-0000-7000-8000-00000000000a'
  const CITY = '01890000-0000-7000-8000-0000000000c1'

  it('is on for everyone at a full rollout', () => {
    expect(evaluateFlag(flag())).toBe(true)
    expect(evaluateFlag(flag(), { userId: USER })).toBe(true)
  })

  it('is off for everyone when the master switch is off', () => {
    // Including the people on the explicit list — otherwise turning a
    // misbehaving feature off leaves it on for exactly the pilot users.
    expect(
      evaluateFlag(flag({ isEnabled: false, enabledUserIds: [USER] }), { userId: USER }),
    ).toBe(false)
  })

  it('lets an explicit id beat a zero rollout', () => {
    const pilot = flag({ rolloutBps: 0, enabledUserIds: [USER] })
    expect(evaluateFlag(pilot, { userId: USER })).toBe(true)
    expect(evaluateFlag(pilot, { userId: 'someone-else' })).toBe(false)
  })

  it('accepts a shop or a city on the list too', () => {
    expect(
      evaluateFlag(flag({ rolloutBps: 0, enabledShopIds: [SHOP] }), { shopId: SHOP }),
    ).toBe(true)
    expect(
      evaluateFlag(flag({ rolloutBps: 0, enabledCityIds: [CITY] }), { cityId: CITY }),
    ).toBe(true)
  })

  it('is off at a zero rollout with nobody listed', () => {
    expect(evaluateFlag(flag({ rolloutBps: 0 }), { userId: USER })).toBe(false)
  })

  it('is off for a partial rollout with nobody to bucket', () => {
    // A percentage rollout that silently reads as 100% for anonymous traffic is
    // the failure that makes flags untrustworthy.
    expect(evaluateFlag(flag({ rolloutBps: 5_000 }))).toBe(false)
  })

  it('gives the same subject the same answer every time', () => {
    const partial = flag({ rolloutBps: 5_000 })
    const first = evaluateFlag(partial, { userId: USER })
    for (let i = 0; i < 20; i += 1) {
      expect(evaluateFlag(partial, { userId: USER })).toBe(first)
    }
  })

  it('buckets a partial rollout roughly in proportion', () => {
    const partial = flag({ rolloutBps: 5_000 })
    let on = 0
    for (let i = 0; i < 2000; i += 1) {
      if (evaluateFlag(partial, { userId: `user-${i}` })) on += 1
    }
    // Wide bounds on purpose: this asserts the bucketing is not degenerate, not
    // that SHA-256 is uniform.
    expect(on).toBeGreaterThan(800)
    expect(on).toBeLessThan(1200)
  })

  it('does not put the same user at the front of every rollout', () => {
    // Keyed by the flag name as well as the subject, so a 1% rollout of one
    // feature and a 1% rollout of another do not hit the same hundred people.
    const buckets = ['quote_flow', 'scan_at_counter', 'scheduled_pickup'].map((key) =>
      rolloutBucket(key, USER),
    )
    expect(new Set(buckets).size).toBe(3)
  })

  it('buckets inside the basis-point scale', () => {
    for (let i = 0; i < 200; i += 1) {
      const bucket = rolloutBucket('quote_flow', `user-${i}`)
      expect(bucket).toBeGreaterThanOrEqual(0)
      expect(bucket).toBeLessThan(10_000)
    }
  })

  it('falls back through user, shop then city for a subject to bucket', () => {
    const partial = flag({ rolloutBps: 5_000 })
    const byShop = evaluateFlag(partial, { shopId: SHOP })
    expect(byShop).toBe(rolloutBucket('quote_flow', SHOP) < 5_000)
  })
})

describe('isFeatureEnabled', () => {
  it('reads the injected flags in a unit test', async () => {
    __setFeatureFlagsForTests({ quote_flow: { isEnabled: true } })
    await expect(isFeatureEnabled('quote_flow')).resolves.toBe(true)

    __setFeatureFlagsForTests({ quote_flow: { isEnabled: false } })
    await expect(isFeatureEnabled('quote_flow')).resolves.toBe(false)

    __setFeatureFlagsForTests(null)
  })

  it('treats a flag the database has never heard of as off', async () => {
    // A deploy that reads a flag before its migration lands must degrade to the
    // old behaviour, which is what "off" means for every flag we ship.
    __setFeatureFlagsForTests({})
    await expect(isFeatureEnabled('quote_flow')).resolves.toBe(false)
    __setFeatureFlagsForTests(null)
  })
})
