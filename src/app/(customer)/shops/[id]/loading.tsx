/**
 * Shop profile skeleton.
 *
 * Shaped like the real page — identity row, the four-fact clay card, then three
 * panels — so the content lands where the grey was instead of shoving it down.
 */

import { Card } from '@/components/ui/card'
import { Skeleton, SkeletonText } from '@/components/ui/skeleton'

export default function ShopProfileLoading() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-5 sm:py-8" aria-busy>
      <div className="flex items-start gap-3.5">
        <Skeleton className="size-20 rounded-xl" />
        <div className="min-w-0 flex-1">
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="mt-2 h-4 w-1/2" />
        </div>
      </div>

      <Card variant="clay" padding="md" className="mt-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3.5 sm:grid-cols-4">
          {[0, 1, 2, 3].map((cell) => (
            <div key={cell}>
              <Skeleton className="h-2.5 w-14" />
              <Skeleton className="mt-2 h-4 w-20" />
            </div>
          ))}
        </div>
      </Card>

      {[0, 1, 2].map((panel) => (
        <Card key={panel} className="mt-4">
          <Skeleton className="h-2.5 w-16" />
          <Skeleton className="mt-2 h-5 w-40" />
          <SkeletonText lines={4} className="mt-3.5" />
        </Card>
      ))}
    </div>
  )
}
