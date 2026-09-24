/**
 * Form controls.
 *
 * The shape here is deliberate: `Field` owns the label, the hint and the error, and
 * hands ids down to the control. Controls do not carry their own labels. That is what
 * makes `aria-describedby` and `aria-invalid` correct by construction rather than by
 * whoever wrote the screen remembering.
 *
 * Inputs are 44px on the customer surface and 36px in dense dashboard forms. They sit
 * on `paper-raised` with a hairline and an inset well on focus, so a focused field
 * reads as a slot you are typing into. No glass anywhere near a text input — text over
 * a blurred backdrop is the single worst legibility trade in this vocabulary.
 */

'use client'

import { AlertCircle, ChevronDown } from 'lucide-react'
import { createContext, forwardRef, useContext, useId } from 'react'

import { cn } from '@/lib/cn'

interface FieldContextValue {
  controlId: string
  describedBy: string | undefined
  invalid: boolean
}

const FieldContext = createContext<FieldContextValue | null>(null)

/** Controls read their wiring from here; standalone use (a filter bar) is fine too. */
function useFieldWiring(explicitId?: string) {
  const field = useContext(FieldContext)
  return {
    id: explicitId ?? field?.controlId,
    describedBy: field?.describedBy,
    invalid: field?.invalid ?? false,
  }
}

export interface FieldProps {
  label: React.ReactNode
  /** Shown under the control, greyed. Say what a good answer looks like. */
  hint?: React.ReactNode
  /** Shown in place of the hint, in danger tone, and sets `aria-invalid`. */
  error?: React.ReactNode
  /** Right-aligned, muted. For "Optional" or a character count. */
  aside?: React.ReactNode
  required?: boolean
  className?: string
  children: React.ReactNode
}

export function Field({
  label,
  hint,
  error,
  aside,
  required,
  className,
  children,
}: FieldProps) {
  const base = useId()
  const controlId = `${base}-control`
  const hintId = `${base}-hint`
  const errorId = `${base}-error`

  // Error wins: pointing at both would read the stale hint after the error.
  const describedBy = error ? errorId : hint ? hintId : undefined

  return (
    <FieldContext.Provider value={{ controlId, describedBy, invalid: Boolean(error) }}>
      <div className={cn('flex flex-col gap-1.5', className)}>
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={controlId} className="text-sm font-medium text-ink">
            {label}
            {required ? (
              <span className="ml-0.5 text-chaap" aria-hidden>
                *
              </span>
            ) : null}
          </label>
          {aside ? <span className="text-2xs text-ink-4">{aside}</span> : null}
        </div>

        {children}

        {error ? (
          <p id={errorId} className="flex items-start gap-1.5 text-xs text-danger">
            <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>{error}</span>
          </p>
        ) : hint ? (
          <p id={hintId} className="text-xs leading-relaxed text-ink-3">
            {hint}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  )
}

const control = [
  'w-full rounded-lg bg-paper-raised text-ink',
  'border border-rule shadow-hair',
  'placeholder:text-ink-4',
  'transition-[border-color,box-shadow,background-color] duration-fast ease-out-soft',
  'hover:border-rule-strong',
  'focus:border-chaap focus:shadow-inset-well focus:outline-none',
  'disabled:cursor-not-allowed disabled:bg-paper-sunk disabled:text-ink-4',
  'aria-[invalid=true]:border-danger-edge aria-[invalid=true]:bg-danger-tint/40',
].join(' ')

export type ControlSize = 'sm' | 'md'
const controlSizes: Record<ControlSize, string> = {
  sm: 'h-9 px-2.5 text-sm',
  md: 'h-11 px-3 text-base',
}

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  size?: ControlSize
  /**
   * A leading glyph or unit, inside the field. Purely decorative — not focusable.
   * `Omit`ted from the native attributes above, where `prefix` is a legacy XML string.
   */
  prefix?: React.ReactNode
  /**
   * Trailing content. Unlike `prefix` this stays interactive, because the thing
   * that belongs there is usually a clear button or a unit toggle.
   */
  suffix?: React.ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, size = 'md', prefix, suffix, id, ...props },
  ref,
) {
  const wiring = useFieldWiring(id)

  const input = (
    <input
      ref={ref}
      id={wiring.id}
      aria-describedby={wiring.describedBy}
      aria-invalid={wiring.invalid || undefined}
      className={cn(
        control,
        controlSizes[size],
        // Affixes are absolutely positioned, so the text needs room to clear them.
        prefix && 'pl-9',
        suffix && 'pr-9',
        className,
      )}
      {...props}
    />
  )

  if (!prefix && !suffix) return input

  return (
    <div className="relative">
      {prefix ? (
        <span
          className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-ink-4"
          aria-hidden
        >
          {prefix}
        </span>
      ) : null}
      {input}
      {suffix ? (
        <span className="absolute inset-y-0 right-2.5 grid place-items-center text-ink-4">
          {suffix}
        </span>
      ) : null}
    </div>
  )
})

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, id, rows = 3, ...props }, ref) {
    const wiring = useFieldWiring(id)
    return (
      <textarea
        ref={ref}
        id={wiring.id}
        rows={rows}
        aria-describedby={wiring.describedBy}
        aria-invalid={wiring.invalid || undefined}
        className={cn(control, 'resize-y px-3 py-2.5 text-base leading-relaxed', className)}
        {...props}
      />
    )
  },
)

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: ControlSize
}

/**
 * A native `<select>`, on purpose.
 *
 * The customer surface is a phone on a mid-range Android; the OS picker is faster,
 * scrolls better and is already accessible. Only the chevron is ours. Richer pickers
 * (the shop's catalogue combobox) get a Radix component where the interaction actually
 * needs it.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, size = 'md', id, children, ...props },
  ref,
) {
  const wiring = useFieldWiring(id)
  return (
    <div className="relative">
      <select
        ref={ref}
        id={wiring.id}
        aria-describedby={wiring.describedBy}
        aria-invalid={wiring.invalid || undefined}
        className={cn(control, controlSizes[size], 'cursor-pointer appearance-none pr-9', className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-ink-3"
        aria-hidden
      />
    </div>
  )
})

/**
 * A labelled checkbox.
 *
 * Native input, visually replaced. The 44px hit area comes from the padding on the
 * wrapping label, not from the box itself, which stays 18px so a list of options does
 * not look like a list of buttons.
 */
export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: React.ReactNode
  description?: React.ReactNode
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, label, description, ...props },
  ref,
) {
  return (
    <label
      className={cn(
        'group flex cursor-pointer items-start gap-2.5 rounded-lg py-2 select-none',
        'has-disabled:cursor-not-allowed has-disabled:opacity-55',
        className,
      )}
    >
      <input
        ref={ref}
        type="checkbox"
        className={cn(
          'mt-0.5 size-[18px] shrink-0 appearance-none rounded-sm',
          'border border-rule-strong bg-paper-raised',
          'transition-[background-color,border-color] duration-fast',
          'checked:border-chaap checked:bg-chaap',
          // The tick is a background image so there is no extra element to position.
          "checked:bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3.5 8.5l3 3 6-6'/%3E%3C/svg%3E\")] checked:bg-center checked:bg-no-repeat",
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-chaap',
        )}
        {...props}
      />
      <span className="min-w-0">
        <span className="block text-sm leading-snug text-ink">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">{description}</span>
        ) : null}
      </span>
    </label>
  )
})

/**
 * A radio group rendered as selectable cards.
 *
 * This is the workhorse of the order configurator — paper size, colour, binding. A
 * card that can be tapped anywhere beats a 16px dot on a phone, and the selected card
 * gets the chaap tint plus a ring so the choice survives a glance.
 */
export interface OptionCardProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: React.ReactNode
  description?: React.ReactNode
  /** Right-aligned, mono — the price delta for this option. */
  meta?: React.ReactNode
  icon?: React.ReactNode
}

export const OptionCard = forwardRef<HTMLInputElement, OptionCardProps>(function OptionCard(
  { className, label, description, meta, icon, ...props },
  ref,
) {
  return (
    <label
      className={cn(
        'relative flex cursor-pointer items-center gap-3 rounded-xl p-3',
        'border border-rule bg-paper-raised shadow-hair',
        'transition-[border-color,background-color,box-shadow] duration-fast ease-out-soft',
        'hover:border-rule-strong hover:bg-paper-sunk',
        'has-checked:border-chaap has-checked:bg-chaap-tint has-checked:shadow-card',
        'has-disabled:cursor-not-allowed has-disabled:opacity-55 has-disabled:hover:bg-paper-raised',
        'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-chaap',
        className,
      )}
    >
      <input ref={ref} type="radio" className="sr-only" {...props} />
      {icon ? <span className="shrink-0 text-ink-2" aria-hidden>{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs text-ink-3">{description}</span>
        ) : null}
      </span>
      {meta ? <span className="shrink-0 font-mono text-xs text-ink-2">{meta}</span> : null}
    </label>
  )
})

/** A row of segmented controls. Two to four short options, one line. */
export function Segmented({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="group"
      className={cn('flex gap-1 rounded-lg bg-paper-sunk p-1 shadow-inset-well', className)}
      {...props}
    />
  )
}

export function SegmentedItem({
  className,
  selected,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        'flex-1 rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap',
        'transition-[background-color,color,box-shadow] duration-fast ease-out-soft',
        selected ? 'bg-paper-raised text-ink shadow-hair' : 'text-ink-3 hover:text-ink',
        className,
      )}
      {...props}
    />
  )
}
