/**
 * Button.
 *
 * Four intents, and the constraint that makes the design language hold: exactly
 * one `primary` button is visible in a view at a time. It is the only surface that
 * gets the clay treatment — outer lift, inner top highlight, inner bottom shade —
 * so "the thing you are meant to do" is legible before any text is read.
 *
 * Pressed states are real: the surface drops 1px and the inner highlight
 * collapses, which is what makes a clay control feel like it depresses rather than
 * merely change colour. That is a transform on a fixed-size element, so it costs
 * nothing.
 *
 * `loading` keeps the label mounted and overlays the spinner, so the button does
 * not change width mid-submit — a button that shrinks under the cursor is a button
 * you double-click.
 */

'use client'

import { Slot } from '@radix-ui/react-slot'
import { Loader2 } from 'lucide-react'
import { forwardRef } from 'react'

import { cn } from '@/lib/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link'
export type ButtonSize = 'sm' | 'md' | 'lg'

const base = [
  'relative inline-flex select-none items-center justify-center gap-2',
  'font-medium whitespace-nowrap',
  'transition-[transform,box-shadow,background-color,color,border-color]',
  'duration-fast ease-out-soft',
  'disabled:pointer-events-none disabled:opacity-55',
  // A tap on a phone must not leave a grey flash behind the clay.
  '[-webkit-tap-highlight-color:transparent]',
].join(' ')

const variants: Record<ButtonVariant, string> = {
  primary: cn(
    'clay-chaap rounded-lg text-white',
    'hover:bg-chaap-deep',
    'active:translate-y-px active:shadow-[inset_0_2px_5px_color-mix(in_oklab,var(--color-chaap-press)_55%,transparent)]',
  ),
  secondary: cn(
    'rounded-lg bg-paper-raised text-ink shadow-hair',
    'hover:bg-paper-sunk hover:shadow-card',
    'active:translate-y-px active:bg-paper-shade active:shadow-inset-well',
  ),
  ghost: 'rounded-lg text-ink-2 hover:bg-paper-sunk hover:text-ink active:bg-paper-shade',
  danger: cn(
    'rounded-lg bg-danger text-white',
    'shadow-[0_1px_1px_rgba(0,0,0,0.08),0_10px_24px_-16px_color-mix(in_oklab,var(--color-danger)_60%,transparent)]',
    'hover:brightness-95 active:translate-y-px active:brightness-90',
  ),
  link: 'rounded-xs text-chaap underline decoration-chaap-edge decoration-2 underline-offset-[3px] hover:decoration-chaap',
}

const sizes: Record<ButtonSize, string> = {
  // 36px — dense dashboard rows and table actions.
  sm: 'h-9 px-3 text-sm',
  // 44px — the mobile default, matching the minimum comfortable tap target.
  md: 'h-11 px-4 text-base',
  // 52px — the single primary action on a customer screen.
  lg: 'h-13 px-6 text-lg',
}

const linkSizes: Record<ButtonSize, string> = { sm: 'text-sm', md: 'text-base', lg: 'text-lg' }

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Stretch to the container. The mobile pattern for a sticky action bar. */
  block?: boolean
  loading?: boolean
  /** Render as the single child element instead of a `<button>` — for `<Link>`. */
  asChild?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', block, loading, asChild, children, ...props },
  ref,
) {
  const classes = cn(
    base,
    variants[variant],
    variant === 'link' ? linkSizes[size] : sizes[size],
    block && 'w-full',
    className,
  )

  /*
   * `asChild` takes a separate branch rather than swapping the element type, because the
   * two shapes genuinely differ. `Slot` merges its props onto exactly one child element,
   * so the label wrapper and the spinner overlay below would be two children and Slot
   * would throw ("Slot failed to slot onto its children") — which is what broke the 404
   * page's prerender. It would also put `disabled` and `aria-busy` on an `<a>`, where
   * neither is valid.
   *
   * A link cannot be mid-submit, so `loading` is deliberately ignored here.
   */
  if (asChild) {
    return (
      <Slot ref={ref} className={classes} {...props}>
        {children}
      </Slot>
    )
  }

  return (
    <button
      ref={ref}
      // A `loading` button that is still clickable submits twice.
      disabled={props.disabled ?? loading}
      data-loading={loading ? '' : undefined}
      aria-busy={loading ? true : undefined}
      className={classes}
      {...props}
    >
      {/* The label stays in flow and only fades, so the width never moves. */}
      <span className={cn('inline-flex items-center gap-2', loading && 'opacity-0')}>
        {children}
      </span>
      {loading ? (
        <span className="absolute inset-0 grid place-items-center">
          <Loader2 className="size-[1.15em] animate-spin-slow" aria-hidden />
          <span className="sr-only">Working…</span>
        </span>
      ) : null}
    </button>
  )
})

/**
 * A square icon-only button.
 *
 * Separate from `Button` rather than a prop of it, because the thing that makes an
 * icon button correct is the accessible name — and making it a required prop is the
 * only way to actually get one.
 */
export interface IconButtonProps extends Omit<ButtonProps, 'block' | 'asChild'> {
  label: string
}

const iconSizes: Record<ButtonSize, string> = { sm: 'size-9', md: 'size-11', lg: 'size-13' }

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, label, variant = 'ghost', size = 'md', loading, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      disabled={props.disabled ?? loading}
      aria-busy={loading ? true : undefined}
      className={cn(base, variants[variant], iconSizes[size], 'shrink-0 p-0', className)}
      {...props}
    >
      {loading ? <Loader2 className="size-[45%] animate-spin-slow" aria-hidden /> : children}
    </button>
  )
})
