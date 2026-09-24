/**
 * Money.
 *
 * Every monetary amount in Chaapo is an integer number of **paise**, stored as
 * `bigint` in TypeScript and `bigint` (int8) in Postgres. There are no floats
 * anywhere in the money path: ₹0.005 rounding errors multiplied across a
 * settlement run are real money, and a marketplace that holds funds on behalf of
 * shops cannot lose paise. (PRD §31, §39; IMPLEMENTATION_PLAN.md §9.)
 *
 * Percentages are expressed in **basis points** (bps): 1 bps = 0.01 %, so 18 %
 * GST is 1800 bps and an 8 % commission is 800 bps. This keeps rate arithmetic
 * integral too.
 *
 * JSON has no bigint, so amounts cross the wire as decimal strings of paise
 * (`"12550"`), never as numbers. `serializePaise` / `parsePaise` are the only
 * sanctioned boundary.
 */

/** An integer number of paise. 100 paise = ₹1. */
export type Paise = bigint

/** Basis points. 10_000 bps = 100 %. */
export type Bps = number

export const PAISE_PER_RUPEE = 100n
export const ZERO: Paise = 0n
export const BPS_DENOMINATOR = 10_000n

export class MoneyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MoneyError'
  }
}

/** Construct paise from an integer count of paise. */
export function paise(value: number | bigint | string): Paise {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new MoneyError(`paise() requires an integer, received ${value}`)
    }
    if (!Number.isSafeInteger(value)) {
      throw new MoneyError(`paise() received an unsafe integer: ${value}`)
    }
    return BigInt(value)
  }
  const trimmed = value.trim()
  if (!/^-?\d+$/.test(trimmed)) {
    throw new MoneyError(`paise() requires a decimal integer string, received "${value}"`)
  }
  return BigInt(trimmed)
}

/**
 * Construct paise from rupees. Accepts at most two decimal places; anything
 * finer is a data-entry error, not something to silently round.
 */
export function rupees(value: number | string): Paise {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MoneyError(`rupees() received a non-finite number: ${value}`)
    }
    const scaled = value * 100
    const rounded = Math.round(scaled)
    if (Math.abs(scaled - rounded) > 1e-6) {
      throw new MoneyError(`rupees() accepts at most 2 decimal places, received ${value}`)
    }
    if (!Number.isSafeInteger(rounded)) {
      throw new MoneyError(`rupees() received an out-of-range amount: ${value}`)
    }
    return BigInt(rounded)
  }
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!match) {
    throw new MoneyError(`rupees() requires up to 2 decimal places, received "${value}"`)
  }
  const [, sign, whole, frac = ''] = match
  const paisePart = (frac + '00').slice(0, 2)
  const magnitude = BigInt(whole ?? '0') * PAISE_PER_RUPEE + BigInt(paisePart)
  return sign === '-' ? -magnitude : magnitude
}

// ── Arithmetic ──────────────────────────────────────────────────────────────

export function addPaise(...amounts: Paise[]): Paise {
  return amounts.reduce((total, amount) => total + amount, ZERO)
}

export function subPaise(a: Paise, b: Paise): Paise {
  return a - b
}

/** Multiply by an integer quantity (copies, sides, sheets). */
export function mulPaise(amount: Paise, quantity: number | bigint): Paise {
  const q = typeof quantity === 'bigint' ? quantity : BigInt(assertInteger(quantity, 'quantity'))
  return amount * q
}

export function sumPaise(amounts: readonly Paise[]): Paise {
  return amounts.reduce<Paise>((total, amount) => total + amount, ZERO)
}

export function maxPaise(a: Paise, b: Paise): Paise {
  return a > b ? a : b
}

export function minPaise(a: Paise, b: Paise): Paise {
  return a < b ? a : b
}

export function clampPaise(amount: Paise, low: Paise, high: Paise): Paise {
  if (low > high) throw new MoneyError('clampPaise called with low > high')
  return minPaise(maxPaise(amount, low), high)
}

export function isZero(amount: Paise): boolean {
  return amount === ZERO
}

export function absPaise(amount: Paise): Paise {
  return amount < ZERO ? -amount : amount
}

/**
 * Divide, rounding half away from zero — the convention Indian invoices use and
 * the one our tax computations are specified against.
 */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError('division by zero')
  const negative = numerator < 0n !== denominator < 0n
  const n = numerator < 0n ? -numerator : numerator
  const d = denominator < 0n ? -denominator : denominator
  const quotient = n / d
  const remainder = n % d
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient
  return negative ? -rounded : rounded
}

/** Divide, always rounding up. Used for sheet counts, never for money. */
export function divCeil(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError('division by zero')
  return (numerator + denominator - 1n) / denominator
}

/**
 * A percentage of an amount, in basis points, rounded half up.
 *
 *   pctOfPaise(rupees(100), 800)  →  800 paise  (8 % of ₹100 = ₹8)
 */
export function pctOfPaise(amount: Paise, rateBps: Bps): Paise {
  assertInteger(rateBps, 'rateBps')
  if (rateBps < 0) throw new MoneyError('rateBps cannot be negative')
  return divRoundHalfUp(amount * BigInt(rateBps), BPS_DENOMINATOR)
}

/**
 * Tax computed *on top of* a base amount (exclusive GST).
 *
 *   gstOn(rupees(100), 1800) → ₹18
 */
export function gstOn(base: Paise, rateBps: Bps): Paise {
  return pctOfPaise(base, rateBps)
}

/**
 * Split a tax-inclusive amount into base and tax components.
 * Returns `{ base, tax }` where `base + tax === inclusive` exactly.
 */
export function splitInclusiveTax(
  inclusive: Paise,
  rateBps: Bps,
): { base: Paise; tax: Paise } {
  assertInteger(rateBps, 'rateBps')
  const base = divRoundHalfUp(inclusive * BPS_DENOMINATOR, BPS_DENOMINATOR + BigInt(rateBps))
  return { base, tax: inclusive - base }
}

/**
 * Allocate an amount across weights without losing or inventing a single paisa.
 * The largest-remainder method: floor every share, then hand the leftover paise
 * to the largest fractional remainders. Used for partial refunds across items
 * and for splitting a settlement across ledger lines.
 */
export function allocatePaise(total: Paise, weights: readonly (number | bigint)[]): Paise[] {
  if (weights.length === 0) return []
  const bigWeights = weights.map((w) => (typeof w === 'bigint' ? w : BigInt(assertInteger(w, 'weight'))))
  if (bigWeights.some((w) => w < 0n)) throw new MoneyError('weights cannot be negative')
  const weightTotal = bigWeights.reduce((a, b) => a + b, 0n)
  if (weightTotal === 0n) {
    // Degenerate: everything to the first bucket rather than dropping money.
    return bigWeights.map((_, index) => (index === 0 ? total : ZERO))
  }

  const shares: Paise[] = []
  const remainders: { index: number; remainder: bigint }[] = []
  let allocated = ZERO
  bigWeights.forEach((weight, index) => {
    const exact = total * weight
    const share = exact / weightTotal
    shares.push(share)
    remainders.push({ index, remainder: exact % weightTotal })
    allocated += share
  })

  let leftover = total - allocated
  remainders.sort((a, b) => (b.remainder === a.remainder ? a.index - b.index : b.remainder > a.remainder ? 1 : -1))
  let cursor = 0
  const step = leftover >= 0n ? 1n : -1n
  while (leftover !== 0n && remainders.length > 0) {
    const target = remainders[cursor % remainders.length]!
    shares[target.index] = shares[target.index]! + step
    leftover -= step
    cursor += 1
  }
  return shares
}

// ── Formatting ──────────────────────────────────────────────────────────────

const inrWholeFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

export interface FormatPaiseOptions {
  /** Drop `.00` when the amount is a whole number of rupees. Default: true. */
  trimWholeRupees?: boolean
  /** Omit the ₹ symbol (for table columns with a currency header). */
  withoutSymbol?: boolean
}

/**
 * Render paise as Indian-format currency: ₹1,23,456.50 (lakh grouping).
 */
export function formatPaise(amount: Paise, options: FormatPaiseOptions = {}): string {
  const { trimWholeRupees = true, withoutSymbol = false } = options
  const negative = amount < ZERO
  const magnitude = negative ? -amount : amount
  const whole = magnitude / PAISE_PER_RUPEE
  const fraction = magnitude % PAISE_PER_RUPEE

  // Intl works on numbers; rupee magnitudes stay far inside Number.MAX_SAFE_INTEGER
  // (₹90,07,19,92,54,740 ceiling), and we format whole and fractional parts
  // separately so no float ever touches the paise.
  const rupeeValue = Number(whole)
  let formatted: string
  if (trimWholeRupees && fraction === 0n) {
    formatted = inrWholeFormatter.format(rupeeValue)
  } else {
    const base = inrWholeFormatter.format(rupeeValue)
    formatted = `${base}.${fraction.toString().padStart(2, '0')}`
  }
  if (withoutSymbol) formatted = formatted.replace(/^₹\s?/, '')
  return negative ? `−${formatted}` : formatted
}

/** Exact two-decimal rupee string with grouping, for invoices and exports. */
export function formatPaiseExact(amount: Paise): string {
  return formatPaise(amount, { trimWholeRupees: false })
}

/** Plain decimal rupees, no symbol or grouping — for CSV and API display fields. */
export function paiseToRupeeString(amount: Paise): string {
  const negative = amount < ZERO
  const magnitude = negative ? -amount : amount
  const whole = magnitude / PAISE_PER_RUPEE
  const fraction = magnitude % PAISE_PER_RUPEE
  return `${negative ? '-' : ''}${whole}.${fraction.toString().padStart(2, '0')}`
}

/** Render a bps rate as a human percentage: 1800 → "18%", 25 → "0.25%". */
export function formatBps(rateBps: Bps): string {
  const value = rateBps / 100
  return `${Number.isInteger(value) ? value : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`
}

// ── Wire boundary ───────────────────────────────────────────────────────────

/** Paise → JSON-safe decimal string. */
export function serializePaise(amount: Paise): string {
  return amount.toString(10)
}

/** JSON decimal string → paise. */
export function parsePaise(value: string | number | bigint): Paise {
  return paise(value)
}

function assertInteger(value: number, label: string): number {
  if (!Number.isInteger(value)) throw new MoneyError(`${label} must be an integer, got ${value}`)
  return value
}
