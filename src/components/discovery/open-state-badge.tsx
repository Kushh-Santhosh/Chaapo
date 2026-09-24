'use client'

/**
 * The availability badge on a shop card.
 *
 * The label is computed on the server for the first paint and passed in, then this
 * component takes ownership and recomputes it every minute from the same `hours`
 * array — so a card that says "Open until 9:00 pm" does not still say it at 9:05.
 * Passing the server's answer in as the initial state (rather than reading the
 * clock during render) is what keeps hydration from mismatching on a phone whose
 * clock differs from the server's by a few seconds.
 *
 * A paused shop reads as paused, with the shop's own reason, rather than as
 * closed: "Machine servicing, back by 3 pm" stops someone walking over, and
 * hiding the shop entirely would make them think it had shut down.
 */

import { useEffect, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { describeAvailability, type Availability, type WeeklyHours } from '@/lib/time'

// Re-export for backward compatibility (though new code should import from src/lib/time)
export type { Availability }
export { describeAvailability }

export interface OpenStateBadgeProps {
  hours: WeeklyHours
  pausedUntil: string | null
  pauseReason: string | null
  /** Computed on the server so the first paint is correct and stable. */
  initial: Availability
  size?: 'sm' | 'md'
}

export function OpenStateBadge({
  hours,
  pausedUntil,
  pauseReason,
  initial,
  size = 'sm',
}: OpenStateBadgeProps) {
  const [availability, setAvailability] = useState(initial)

  useEffect(() => {
    const recompute = () => setAvailability(describeAvailability(hours, pausedUntil, pauseReason, new Date()))
    recompute()
    const tick = window.setInterval(recompute, 60_000)
    return () => window.clearInterval(tick)
  }, [hours, pausedUntil, pauseReason])

  return (
    <Badge tone={availability.tone} size={size} dot pulse={availability.live}>
      {availability.label}
    </Badge>
  )
}
