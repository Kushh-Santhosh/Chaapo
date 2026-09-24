/**
 * The published price list on a shop profile.
 *
 * This is a rate card, not a quote. Every row is what the shop charges per unit, and
 * the screen says so, because the number a customer will actually pay depends on page
 * count, colour split and finishing — and is only fixed when the order is placed.
 *
 * Tiered rates render as their bands rather than as a single "from" number. A shop
 * whose price drops at 51 pages has said something useful about bulk work, and
 * flattening it to the cheapest band would quote a price that only applies to a job
 * nobody is placing.
 */

import { Money } from '@/components/ui/money'
import { cn } from '@/lib/cn'
import type { ShopPriceGroup, ShopPriceItem, ShopPriceTier } from '@/server/domains/discovery'

function tierRange(tier: ShopPriceTier): string {
  if (tier.toQuantity === null) return `${tier.fromQuantity}+`
  if (tier.toQuantity === tier.fromQuantity) return `${tier.fromQuantity}`
  return `${tier.fromQuantity}–${tier.toQuantity}`
}

function PriceRow({ item }: { item: ShopPriceItem }) {
  // A single band is a flat rate wearing a tier's clothes; show it as a flat rate.
  const tiers = item.tiers.length > 1 ? item.tiers : []

  return (
    <div className="py-2.5">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-ink">{item.label}</p>
          {item.qualifier ? <p className="mt-0.5 text-xs text-ink-3">{item.qualifier}</p> : null}
        </div>
        <p className="shrink-0 text-right">
          <Money value={item.pricePaise} size="lg" />
          <span className="text-xs text-ink-3">/{item.unit}</span>
        </p>
      </div>

      {tiers.length > 0 ? (
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-paper-sunk px-2.5 py-2 shadow-inset-well">
          {tiers.map((tier) => (
            <div key={`${tier.fromQuantity}`} className="flex items-baseline gap-1.5 text-xs">
              <dt className="font-mono tabular-nums text-ink-3">{tierRange(tier)}</dt>
              <dd className="text-ink-2">
                <Money value={tier.pricePaise} size="sm" />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  )
}

export function PriceList({ groups, className }: { groups: ShopPriceGroup[]; className?: string }) {
  const populated = groups.filter((group) => group.items.length > 0)
  if (populated.length === 0) {
    return (
      <p className={cn('text-sm leading-relaxed text-ink-3', className)}>
        This shop has not published a rate card yet. Start an order and you will still get an
        itemised price before you pay anything.
      </p>
    )
  }

  return (
    <div className={cn('space-y-5', className)}>
      {populated.map((group) => (
        <section key={group.heading}>
          <h3 className="eyebrow">{group.heading}</h3>
          <div className="mt-1 divide-y divide-rule">
            {group.items.map((item) => (
              <PriceRow key={item.code} item={item} />
            ))}
          </div>
        </section>
      ))}
      <p className="text-xs leading-relaxed text-ink-4">
        Rates are per unit and set by the shop. Your total is calculated from your actual files and
        options, shown before payment, and fixed once the order is placed.
      </p>
    </div>
  )
}
