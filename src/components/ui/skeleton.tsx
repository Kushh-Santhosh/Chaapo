/**
 * Skeletons.
 *
 * Shaped, not generic. A skeleton whose blocks do not match the real content's
 * geometry produces a visible jump on hydration, which is worse than a spinner —
 * so each of these mirrors one real component: a shop card, an order row, a KPI cell.
 *
 * The shimmer is a background-position animation on a gradient (see the `skeleton`
 * utility): compositor-only, no layout, and it stops entirely under
 * `prefers-reduced-motion`.
 */

import { cn } from '@/lib/cn'

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn('skeleton rounded-md', className)} {...props} />
}

/**
 * A skeleton line. `w` is a Tailwind width class rather than a number, because varying
 * the widths across a paragraph is what makes a block of lines read as text.
 */
export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number
  className?: string
}) {
  const widths = ['w-full', 'w-11/12', 'w-4/5', 'w-9/12', 'w-2/3']
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-hidden>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn('h-3.5', widths[index % widths.length])} />
      ))}
    </div>
  )
}

/** Matches `ShopCard`: 64px thumb, two lines, a meta row, a chip row. */
export function ShopCardSkeleton() {
  return (
    <div className="flex gap-3.5 rounded-xl bg-paper-raised p-4 shadow-hair">
      <Skeleton className="size-16 shrink-0 rounded-lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-3 w-3/5" />
        <div className="mt-1 flex gap-1.5">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
      </div>
    </div>
  )
}

export function ShopListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="Loading shops">
      {Array.from({ length: count }, (_, index) => (
        <ShopCardSkeleton key={index} />
      ))}
      <span className="sr-only">Loading nearby print shops…</span>
    </div>
  )
}

/** Matches an order row: status chip, order number, shop, amount. */
export function OrderRowSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-paper-raised p-4 shadow-hair">
      <Skeleton className="size-10 shrink-0 rounded-lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <Skeleton className="h-4 w-14" />
    </div>
  )
}

export function OrderListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="Loading orders">
      {Array.from({ length: count }, (_, index) => (
        <OrderRowSkeleton key={index} />
      ))}
      <span className="sr-only">Loading your orders…</span>
    </div>
  )
}

/** Matches a bento KPI cell: eyebrow, big number, delta line. */
export function StatSkeleton() {
  return (
    <div className="rounded-xl bg-paper-raised p-4 shadow-hair sm:p-5">
      <Skeleton className="h-2.5 w-20" />
      <Skeleton className="mt-3 h-8 w-28" />
      <Skeleton className="mt-3 h-3 w-16" />
    </div>
  )
}

export function BentoSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="bento" role="status" aria-label="Loading">
      {Array.from({ length: count }, (_, index) => (
        <StatSkeleton key={index} />
      ))}
      <span className="sr-only">Loading dashboard…</span>
    </div>
  )
}

/** Matches a dense admin table. Header row plus n body rows, same column rhythm. */
export function TableSkeleton({ rows = 8, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="overflow-hidden rounded-xl bg-paper-raised shadow-hair" role="status">
      <div className="flex gap-4 border-b border-rule bg-paper-sunk px-4 py-2.5">
        {Array.from({ length: columns }, (_, index) => (
          <Skeleton key={index} className="h-2.5 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex gap-4 border-b border-rule/60 px-4 py-3 last:border-0">
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} className="h-3.5 flex-1" />
          ))}
        </div>
      ))}
      <span className="sr-only">Loading table…</span>
    </div>
  )
}
