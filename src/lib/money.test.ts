import { describe, expect, it } from 'vitest'
import {
  addPaise,
  allocatePaise,
  divCeil,
  divRoundHalfUp,
  formatBps,
  formatPaise,
  formatPaiseExact,
  gstOn,
  MoneyError,
  mulPaise,
  paise,
  paiseToRupeeString,
  parsePaise,
  pctOfPaise,
  rupees,
  serializePaise,
  splitInclusiveTax,
  sumPaise,
} from './money'

describe('paise()', () => {
  it('accepts integers, bigints and decimal strings', () => {
    expect(paise(1250)).toBe(1250n)
    expect(paise(1250n)).toBe(1250n)
    expect(paise('1250')).toBe(1250n)
    expect(paise('-1250')).toBe(-1250n)
  })

  it('rejects fractional paise — there is no such thing', () => {
    expect(() => paise(12.5)).toThrow(MoneyError)
    expect(() => paise('12.5')).toThrow(MoneyError)
  })
})

describe('rupees()', () => {
  it('converts rupees to paise', () => {
    expect(rupees(1)).toBe(100n)
    expect(rupees(2.5)).toBe(250n)
    expect(rupees('2.05')).toBe(205n)
    expect(rupees(0)).toBe(0n)
    expect(rupees(100)).toBe(10_000n)
    expect(rupees(1000)).toBe(100_000n)
    expect(rupees('-3.75')).toBe(-375n)
  })

  it('handles the float representations that break naive conversion', () => {
    // 0.07 * 100 === 7.000000000000001 in IEEE-754.
    expect(rupees(0.07)).toBe(7n)
    expect(rupees(0.29)).toBe(29n)
    expect(rupees(8.11)).toBe(811n)
  })

  it('rejects more than two decimal places', () => {
    expect(() => rupees(1.005)).toThrow(MoneyError)
    expect(() => rupees('1.005')).toThrow(MoneyError)
  })
})

describe('arithmetic', () => {
  it('adds, multiplies and sums exactly', () => {
    expect(addPaise(rupees(1.5), rupees(2.25))).toBe(375n)
    expect(mulPaise(rupees(2.5), 3)).toBe(750n)
    expect(sumPaise([100n, 250n, 5n])).toBe(355n)
    expect(sumPaise([])).toBe(0n)
  })

  it('refuses non-integer quantities', () => {
    expect(() => mulPaise(100n, 2.5)).toThrow(MoneyError)
  })
})

describe('rounding', () => {
  it('rounds half away from zero', () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n)
    expect(divRoundHalfUp(4n, 2n)).toBe(2n)
    expect(divRoundHalfUp(3n, 2n)).toBe(2n)
    expect(divRoundHalfUp(1n, 2n)).toBe(1n)
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n)
    expect(divRoundHalfUp(-1n, 2n)).toBe(-1n)
  })

  it('ceils for sheet counts', () => {
    expect(divCeil(7n, 2n)).toBe(4n)
    expect(divCeil(8n, 2n)).toBe(4n)
    expect(divCeil(1n, 2n)).toBe(1n)
    expect(divCeil(0n, 2n)).toBe(0n)
  })

  it('throws on division by zero rather than returning Infinity', () => {
    expect(() => divRoundHalfUp(1n, 0n)).toThrow(MoneyError)
    expect(() => divCeil(1n, 0n)).toThrow(MoneyError)
  })
})

describe('percentages in basis points', () => {
  it('computes commission exactly', () => {
    // 8 % commission on ₹120.
    expect(pctOfPaise(rupees(120), 800)).toBe(960n)
  })

  it('computes 18 % GST on a commission', () => {
    // The settlement formula: GST is charged on the commission, not the order.
    const commission = pctOfPaise(rupees(120), 800) // ₹9.60
    expect(gstOn(commission, 1800)).toBe(173n) // ₹1.7280 → ₹1.73
  })

  it('computes sub-percent rates — 0.1 % TDS, 0.5 % TCS', () => {
    expect(pctOfPaise(rupees(1000), 10)).toBe(100n) // 0.1 % of ₹1000 = ₹1
    expect(pctOfPaise(rupees(1000), 50)).toBe(500n) // 0.5 % of ₹1000 = ₹5
  })

  it('rounds half up at the paisa', () => {
    // 8 % of ₹1.19 = 9.52 paise → 10 paise.
    expect(pctOfPaise(119n, 800)).toBe(10n)
    // 8 % of ₹0.06 = 0.48 paise → 0 paise.
    expect(pctOfPaise(6n, 800)).toBe(0n)
  })

  it('rejects negative rates', () => {
    expect(() => pctOfPaise(100n, -100)).toThrow(MoneyError)
  })

  it('formats rates for display', () => {
    expect(formatBps(1800)).toBe('18%')
    expect(formatBps(800)).toBe('8%')
    expect(formatBps(50)).toBe('0.5%')
    expect(formatBps(10)).toBe('0.1%')
  })
})

describe('splitInclusiveTax', () => {
  it('splits without losing a paisa', () => {
    const { base, tax } = splitInclusiveTax(rupees(118), 1800)
    expect(base).toBe(10_000n)
    expect(tax).toBe(1800n)
    expect(base + tax).toBe(rupees(118))
  })

  it('always reconciles, even on awkward amounts', () => {
    for (const amount of [1n, 7n, 99n, 12_345n, 999_999n]) {
      const { base, tax } = splitInclusiveTax(amount, 1800)
      expect(base + tax).toBe(amount)
    }
  })
})

describe('allocatePaise', () => {
  it('distributes leftovers by largest remainder and conserves the total', () => {
    const shares = allocatePaise(100n, [1, 1, 1])
    expect(sumPaise(shares)).toBe(100n)
    expect(shares).toEqual([34n, 33n, 33n])
  })

  it('weights proportionally', () => {
    const shares = allocatePaise(1000n, [50, 30, 20])
    expect(shares).toEqual([500n, 300n, 200n])
    expect(sumPaise(shares)).toBe(1000n)
  })

  it('conserves the total for adversarial inputs', () => {
    const cases: [bigint, number[]][] = [
      [1n, [1, 1, 1]],
      [7n, [3, 3, 1]],
      [10_001n, [7, 11, 13, 17]],
      [999_983n, [1, 1, 1, 1, 1, 1, 1]],
    ]
    for (const [total, weights] of cases) {
      const shares = allocatePaise(total, weights)
      expect(sumPaise(shares)).toBe(total)
      expect(shares).toHaveLength(weights.length)
    }
  })

  it('handles refunds (negative totals) without inventing money', () => {
    const shares = allocatePaise(-100n, [1, 1, 1])
    expect(sumPaise(shares)).toBe(-100n)
  })

  it('does not drop money when every weight is zero', () => {
    const shares = allocatePaise(500n, [0, 0])
    expect(sumPaise(shares)).toBe(500n)
  })

  it('returns an empty array for no buckets', () => {
    expect(allocatePaise(500n, [])).toEqual([])
  })

  it('rejects negative weights', () => {
    expect(() => allocatePaise(100n, [-1, 2])).toThrow(MoneyError)
  })
})

describe('formatting', () => {
  it('uses Indian lakh grouping', () => {
    expect(formatPaise(rupees(1234567))).toBe('₹12,34,567')
    expect(formatPaise(rupees(1000))).toBe('₹1,000')
    expect(formatPaise(rupees(100))).toBe('₹100')
  })

  it('trims .00 by default and keeps real paise', () => {
    expect(formatPaise(rupees(120))).toBe('₹120')
    expect(formatPaise(rupees(120.5))).toBe('₹120.50')
    expect(formatPaise(9n)).toBe('₹0.09')
  })

  it('can keep the exact two decimals for invoices', () => {
    expect(formatPaiseExact(rupees(120))).toBe('₹120.00')
    expect(formatPaiseExact(1n)).toBe('₹0.01')
  })

  it('can drop the symbol for table columns', () => {
    expect(formatPaise(rupees(1500), { withoutSymbol: true })).toBe('1,500')
  })

  it('renders negatives with a true minus sign', () => {
    expect(formatPaise(rupees(-250))).toBe('−₹250')
  })

  it('produces plain rupee strings for CSV', () => {
    expect(paiseToRupeeString(12_345n)).toBe('123.45')
    expect(paiseToRupeeString(5n)).toBe('0.05')
    expect(paiseToRupeeString(-5n)).toBe('-0.05')
  })
})

describe('wire boundary', () => {
  it('round-trips through decimal strings, never numbers', () => {
    const amount = rupees(1234.56)
    const wire = serializePaise(amount)
    expect(wire).toBe('123456')
    expect(typeof wire).toBe('string')
    expect(parsePaise(wire)).toBe(amount)
  })

  it('survives amounts beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = 9_007_199_254_740_993n
    expect(parsePaise(serializePaise(huge))).toBe(huge)
  })
})
