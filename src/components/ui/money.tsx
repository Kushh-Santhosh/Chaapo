/**
 * Money on screen.
 *
 * Two rules, both load-bearing:
 *
 * 1. Amounts cross the server→client boundary as **strings of paise**, never as
 *    numbers and never as `bigint` props. A number would silently lose paise on large
 *    totals, and a `bigint` prop depends on the serializer supporting it. `parsePaise`
 *    is the one place that converts, so a malformed amount throws here instead of
 *    rendering "₹NaN" on a checkout screen.
 * 2. Everything is mono and tabular. A total that changes — the live price bar in the
 *    configurator — must not move the layout around it, and a column of prices in a
 *    payout table must line up on the decimal.
 */

import { formatPaise, formatPaiseExact, parsePaise, type Paise } from '@/lib/money'

import { cn } from '@/lib/cn'

/** What a component accepts for an amount: paise as a string, or a real `Paise`. */
export type MoneyValue = string | Paise

export type MoneySize = 'sm' | 'md' | 'lg' | 'xl' | 'hero'

const moneySizes: Record<MoneySize, string> = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base font-medium',
  // The line-total in a quote.
  xl: 'text-xl font-semibold',
  // The one number the checkout screen is about.
  hero: 'text-3xl font-semibold tracking-tight',
}

export interface MoneyProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: MoneyValue
  size?: MoneySize
  /** Always show paise. Use on invoices, ledgers and anything reconciled. */
  exact?: boolean
  /** Drop the ₹, for columns whose header already carries it. */
  bare?: boolean
  /** Colour negative amounts (refunds, deductions) in danger tone. */
  signed?: boolean
}

export function Money({
  value,
  size = 'md',
  exact,
  bare,
  signed,
  className,
  ...props
}: MoneyProps) {
  const amount = parsePaise(value)
  const text = exact
    ? formatPaiseExact(amount)
    : formatPaise(amount, bare ? { withoutSymbol: true } : {})

  return (
    <span
      // The machine-readable value, so a screen reader announcing a table and any
      // future copy-to-clipboard both get rupees rather than the grouped glyph soup.
      data-numeric
      className={cn(
        'font-mono tabular-nums whitespace-nowrap',
        moneySizes[size],
        signed && amount < 0n && 'text-danger',
        className,
      )}
      {...props}
    >
      {text}
    </span>
  )
}

/**
 * A labelled amount row — the atom of every price breakdown in the product.
 *
 * `emphasis` is what separates the total from the lines above it: a hairline above and
 * a heavier weight, rather than a separate component that could drift out of sync.
 */
export interface AmountRowProps {
  label: React.ReactNode
  value: MoneyValue
  /** Small grey text under the label: "3 files · 24 pages". */
  note?: React.ReactNode
  emphasis?: boolean
  /** Discounts and refunds. Renders in success tone with an explicit minus. */
  credit?: boolean
  exact?: boolean
  className?: string
}

export function AmountRow({
  label,
  value,
  note,
  emphasis,
  credit,
  exact,
  className,
}: AmountRowProps) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-4 py-1.5',
        emphasis && 'mt-1 border-t border-rule pt-3',
        className,
      )}
    >
      <div className="min-w-0">
        <span
          className={cn(
            emphasis ? 'text-base font-semibold text-ink' : 'text-sm text-ink-2',
          )}
        >
          {label}
        </span>
        {note ? <span className="mt-0.5 block text-xs text-ink-4">{note}</span> : null}
      </div>
      <span className={cn('shrink-0', credit && 'text-success')}>
        {credit ? <span aria-hidden>−</span> : null}
        <Money
          value={value}
          exact={exact}
          size={emphasis ? 'xl' : 'md'}
          className={credit ? 'text-success' : undefined}
        />
      </span>
    </div>
  )
}

/**
 * "From ₹2/page" — the price teaser on a shop card.
 *
 * A separate component because the `from` matters legally as much as visually: the
 * card shows an indicative rate, and the binding price is the snapshot taken when the
 * order is placed (PRD §11). Wording that implies otherwise is a dispute.
 */
export function FromPrice({
  value,
  unit,
  note,
  className,
}: {
  value: MoneyValue
  unit: string
  /** What the rate applies to — "B&W A4 · 500+". Rendered under the amount. */
  note?: string | null
  className?: string
}) {
  return (
    <span className={cn('inline-flex flex-col items-end', className)}>
      <span className="inline-flex items-baseline gap-1 text-xs text-ink-3">
        <span>from</span>
        <Money value={value} size="md" className="text-ink" />
        <span>/{unit}</span>
      </span>
      {note ? <span className="text-2xs text-ink-4">{note}</span> : null}
    </span>
  )
}
