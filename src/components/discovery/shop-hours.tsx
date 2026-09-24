/**
 * The weekly hours table on a shop profile.
 *
 * Today is highlighted and listed in place rather than pulled to the top, because
 * someone checking Saturday's hours on a Tuesday needs the week to read as a week.
 * Split shifts (a shop that closes 2–4 pm for lunch) render as two intervals on one
 * row — collapsing them to "9:00 am – 9:00 pm" would be a lie people walk on.
 */

import { cn } from '@/lib/cn'
import { formatMinutesOfDay, istWeekday, MINUTES_PER_DAY, type WeeklyHours } from '@/lib/time'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

function describeDay(intervals: readonly { open: number; close: number }[]): string {
  if (intervals.length === 0) return 'Closed'
  return [...intervals]
    .sort((a, b) => a.open - b.open)
    .map((interval) => {
      const close = interval.close % MINUTES_PER_DAY
      // A close past midnight is marked, not silently wrapped to an earlier time.
      const suffix = interval.close >= MINUTES_PER_DAY ? ' (next day)' : ''
      return `${formatMinutesOfDay(interval.open)} – ${formatMinutesOfDay(close)}${suffix}`
    })
    .join(', ')
}

export function ShopHours({ hours, now }: { hours: WeeklyHours; now: Date }) {
  const today = istWeekday(now)

  return (
    <dl className="divide-y divide-rule">
      {DAY_NAMES.map((name, index) => {
        const intervals = hours[index] ?? []
        const isToday = index === today
        return (
          <div
            key={name}
            className={cn(
              'flex items-baseline justify-between gap-4 py-2 text-sm',
              isToday && '-mx-2 rounded-md bg-chaap-tint/70 px-2',
            )}
          >
            <dt className={cn('text-ink-2', isToday && 'font-semibold text-chaap-deep')}>
              {name}
              {isToday ? <span className="ml-1.5 text-2xs font-medium text-chaap">Today</span> : null}
            </dt>
            <dd
              className={cn(
                'text-right font-mono text-xs tabular-nums',
                intervals.length === 0 ? 'text-ink-4' : 'text-ink',
              )}
            >
              {describeDay(intervals)}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
