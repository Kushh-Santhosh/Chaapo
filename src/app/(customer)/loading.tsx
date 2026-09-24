/**
 * The first-paint skeleton for discovery.
 *
 * Shaped like the real cards — thumb, two lines, a chip row — so the page does not
 * jump when the data lands. A generic grey block would be honest about waiting and
 * dishonest about what is coming.
 */

import { ShopListSkeleton, Skeleton } from '@/components/ui/skeleton'

export default function DiscoveryLoading() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-5 sm:py-8">
      <Skeleton className="h-3 w-32" />
      <Skeleton className="mt-3 h-9 w-full" />
      <Skeleton className="mt-2 h-9 w-2/3" />

      <div className="mt-6 flex gap-2">
        <Skeleton className="h-11 flex-1 rounded-lg" />
        <Skeleton className="h-11 w-11 rounded-lg sm:w-28" />
      </div>
      <div className="mt-3 flex gap-2">
        {[64, 72, 88, 80].map((width) => (
          <Skeleton key={width} className="h-8 rounded-full" style={{ width }} />
        ))}
      </div>

      <div className="mt-6">
        <ShopListSkeleton count={5} />
      </div>
    </div>
  )
}
