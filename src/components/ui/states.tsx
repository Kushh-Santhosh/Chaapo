/**
 * Empty, error and loading states.
 *
 * The rule these encode (PRD §47–§48): an empty state names the thing that is missing
 * and offers the one action that would fix it, and an error state says what failed, in
 * what the person can do about it, and never shows a stack trace or a code they cannot
 * use. "Something went wrong" with a retry button is the failure mode being avoided
 * here, not the goal.
 *
 * Both are deliberately plain surfaces. An empty state is the *absence* of content;
 * dressing it in glass or clay makes nothing look like something.
 */

import { AlertTriangle, Inbox, RefreshCw, WifiOff } from 'lucide-react'

import { cn } from '@/lib/cn'

import { Button } from './button'

export interface EmptyStateProps {
  icon?: React.ReactNode
  title: string
  /** One or two sentences. What is missing, and why there is nothing here. */
  description?: React.ReactNode
  /** The single action that resolves the emptiness. */
  action?: React.ReactNode
  /** A quieter secondary route out. */
  secondaryAction?: React.ReactNode
  className?: string
  /** Dense variant for table bodies and queue columns. */
  compact?: boolean
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  className,
  compact,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-14',
        className,
      )}
    >
      <div
        className={cn(
          'grid place-items-center rounded-full bg-paper-sunk text-ink-4 shadow-inset-well',
          compact ? 'size-9' : 'size-14',
        )}
        aria-hidden
      >
        {icon ?? <Inbox className={compact ? 'size-4' : 'size-6'} />}
      </div>
      <div className="max-w-sm">
        <h3
          className={cn(
            'font-display text-ink',
            compact ? 'text-base' : 'text-xl display-tight',
          )}
        >
          {title}
        </h3>
        {description ? (
          <p className={cn('mt-1.5 leading-relaxed text-ink-3', compact ? 'text-xs' : 'text-sm')}>
            {description}
          </p>
        ) : null}
      </div>
      {action || secondaryAction ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  )
}

export interface ErrorStateProps {
  title?: string
  /** Written for the person reading it. No error codes, no provider names. */
  description?: React.ReactNode
  onRetry?: () => void
  /** Shown small and monospace under the message — safe to read out to support. */
  correlationId?: string
  className?: string
  compact?: boolean
  /** Network failures get different wording and a different glyph. */
  variant?: 'error' | 'offline'
}

export function ErrorState({
  title,
  description,
  onRetry,
  correlationId,
  className,
  compact,
  variant = 'error',
}: ErrorStateProps) {
  const offline = variant === 'offline'

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-12',
        className,
      )}
    >
      <div
        className={cn(
          'grid place-items-center rounded-full border',
          offline
            ? 'border-rule bg-neutral-tint text-ink-3'
            : 'border-danger-edge bg-danger-tint text-danger',
          compact ? 'size-9' : 'size-14',
        )}
        aria-hidden
      >
        {offline ? (
          <WifiOff className={compact ? 'size-4' : 'size-6'} />
        ) : (
          <AlertTriangle className={compact ? 'size-4' : 'size-6'} />
        )}
      </div>
      <div className="max-w-sm">
        <h3 className={cn('font-semibold text-ink', compact ? 'text-sm' : 'text-lg')}>
          {title ?? (offline ? 'You are offline' : 'That did not load')}
        </h3>
        <p className={cn('mt-1.5 leading-relaxed text-ink-3', compact ? 'text-xs' : 'text-sm')}>
          {description ??
            (offline
              ? 'Check your connection. Nothing has been lost — this page will fill in once you are back.'
              : 'The problem is on our side, not yours. Try again in a moment.')}
        </p>
      </div>
      {onRetry ? (
        <Button variant="secondary" size={compact ? 'sm' : 'md'} onClick={onRetry} className="mt-1">
          <RefreshCw className="size-4" aria-hidden />
          Try again
        </Button>
      ) : null}
      {correlationId ? (
        <p className="mt-1 font-mono text-2xs text-ink-4">Reference {correlationId}</p>
      ) : null}
    </div>
  )
}

/**
 * A centred spinner for the rare case where a skeleton is wrong — a modal that is
 * still resolving, a step transition. Prefer a shaped skeleton for page content.
 */
export function LoadingState({
  label = 'Loading…',
  className,
}: {
  label?: string
  className?: string
}) {
  return (
    <div
      role="status"
      className={cn('flex flex-col items-center justify-center gap-3 px-6 py-12', className)}
    >
      <span
        className="size-6 animate-spin-slow rounded-full border-2 border-rule border-t-chaap"
        aria-hidden
      />
      <span className="text-sm text-ink-3">{label}</span>
    </div>
  )
}

/**
 * An inline banner, for problems attached to a region rather than replacing it — a
 * failed payment retry above a checkout form, a file the shop flagged.
 */
export interface NoticeProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: 'info' | 'warn' | 'danger' | 'success'
  /** Rendered content, not the DOM tooltip — hence the `Omit` above. */
  title?: React.ReactNode
  icon?: React.ReactNode
  action?: React.ReactNode
}

const noticeTones = {
  info: 'border-info-edge bg-info-tint text-info',
  warn: 'border-warn-edge bg-warn-tint text-warn',
  danger: 'border-danger-edge bg-danger-tint text-danger',
  success: 'border-success-edge bg-success-tint text-success',
} as const

export function Notice({
  className,
  tone = 'info',
  title,
  icon,
  action,
  children,
  ...props
}: NoticeProps) {
  return (
    <div
      className={cn('flex items-start gap-3 rounded-xl border px-3.5 py-3', noticeTones[tone], className)}
      {...props}
    >
      {icon ? (
        <span className="mt-px shrink-0" aria-hidden>
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        {title ? <p className="text-sm font-semibold">{title}</p> : null}
        {children ? (
          <div className={cn('text-sm leading-relaxed text-ink-2', title && 'mt-0.5')}>
            {children}
          </div>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
