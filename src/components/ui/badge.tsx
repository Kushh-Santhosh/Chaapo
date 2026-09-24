/**
 * Badge — a state label, not a decoration.
 *
 * Tones come in tint/edge pairs from the theme, so a badge is a filled chip with a
 * hairline of the same hue rather than a saturated block. That reads at 11px against
 * warm paper, which a flat brand-colour pill does not.
 *
 * `Stamp` is the one loud mark in the system: mono, boxed, slightly rotated, and it
 * lands with the `stamp` animation. It exists for exactly two things — the "READY"
 * mark on a collected order and the pickup code — and should not be used for a third
 * without a reason, because its whole value is that it is rare.
 */

import { cn } from '@/lib/cn'

export type BadgeTone = 'neutral' | 'chaap' | 'success' | 'warn' | 'danger' | 'info'
export type BadgeSize = 'sm' | 'md'

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-tint text-ink-2 border-rule',
  chaap: 'bg-chaap-tint text-chaap-deep border-chaap-edge',
  success: 'bg-success-tint text-success border-success-edge',
  warn: 'bg-warn-tint text-warn border-warn-edge',
  danger: 'bg-danger-tint text-danger border-danger-edge',
  info: 'bg-info-tint text-info border-info-edge',
}

const badgeSizes: Record<BadgeSize, string> = {
  sm: 'h-5 gap-1 px-1.5 text-2xs',
  md: 'h-6 gap-1.5 px-2 text-xs',
}

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
  size?: BadgeSize
  /** A 6px dot before the label. Use on live states, where "now" is the point. */
  dot?: boolean
  /** Make the dot breathe. Only for states that are actively changing. */
  pulse?: boolean
}

export function Badge({
  className,
  tone = 'neutral',
  size = 'md',
  dot,
  pulse,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border font-medium whitespace-nowrap',
        tones[tone],
        badgeSizes[size],
        className,
      )}
      {...props}
    >
      {dot ? (
        <span
          className={cn('size-1.5 rounded-full bg-current', pulse && 'animate-pulse-soft')}
          aria-hidden
        />
      ) : null}
      {children}
    </span>
  )
}

/**
 * A numeric counter, for queue column headers and nav items.
 *
 * Tabular by default and min-width'd to two digits, so a count going 9 → 10 does not
 * nudge the label beside it.
 */
export function CountBadge({
  count,
  tone = 'neutral',
  className,
  ...props
}: { count: number; tone?: BadgeTone } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-full border px-1.5',
        'font-mono text-2xs tabular-nums',
        tones[tone],
        className,
      )}
      {...props}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

export interface StampProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Extract<BadgeTone, 'chaap' | 'success' | 'danger'>
}

const stampTones = {
  chaap: 'text-chaap',
  success: 'text-success',
  danger: 'text-danger',
} as const

export function Stamp({ className, tone = 'chaap', children, ...props }: StampProps) {
  return (
    <span
      className={cn(
        'stamp inline-flex items-center rounded-md px-2.5 py-1',
        'text-sm font-semibold tracking-[0.14em] uppercase',
        stampTones[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  )
}
