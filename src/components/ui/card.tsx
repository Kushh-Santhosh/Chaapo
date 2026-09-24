/**
 * Card — the surface vocabulary.
 *
 * Five variants, and which one a thing gets is a statement about its role rather
 * than a taste decision:
 *
 *   • `plain`  — a white panel on paper. Forms, tables, dense operational lists.
 *                The default, because most surfaces should be quiet.
 *   • `clay`   — soft depth. Reserved for the few cards that carry the outcome of a
 *                screen: the quote total, the pickup code, a KPI you look at first.
 *   • `glass`  — translucent. Only for surfaces that float *over* content —
 *                floating panels, selected overlays. Never on a scrolling list,
 *                because a backdrop filter repaints every frame of the scroll.
 *   • `sunk`   — an inset well. Something contained rather than presented: an
 *                uploaded-file list inside a form, a price breakdown inside a card.
 *   • `outline`— hairline only, no fill. Grid cells in a bento where the grid itself
 *                is the structure and per-cell fills would be noise.
 *
 * `Card` is a plain surface with padding scales; the sub-components exist so that a
 * header/body/footer split lands on consistent rhythm instead of each screen
 * inventing its own.
 */

import { cn } from '@/lib/cn'

export type CardVariant = 'plain' | 'clay' | 'glass' | 'sunk' | 'outline'
export type CardPadding = 'none' | 'sm' | 'md' | 'lg'

const variants: Record<CardVariant, string> = {
  plain: 'bg-paper-raised shadow-hair',
  clay: 'clay',
  glass: 'glass-raised',
  sunk: 'bg-paper-sunk shadow-inset-well',
  outline: 'border border-rule bg-transparent',
}

const paddings: Record<CardPadding, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4 sm:p-5',
  lg: 'p-5 sm:p-7',
}

export interface CardProps extends React.HTMLAttributes<HTMLElement> {
  variant?: CardVariant
  padding?: CardPadding
  /**
   * Lift on hover. Only for cards that are themselves a link or a button — a
   * decorative hover on a static panel teaches people to click things that do
   * nothing.
   */
  interactive?: boolean
  as?: 'div' | 'section' | 'article' | 'li'
}

export function Card({
  className,
  variant = 'plain',
  padding = 'md',
  interactive,
  as = 'div',
  ...props
}: CardProps) {
  // Typed on the attributes rather than on the element: a card rendered `as="li"` is
  // still handed div-shaped props by its caller, and `HTMLAttributes<HTMLLIElement>`
  // would refuse them over `HTMLLIElement`'s extra `type` and `value`.
  const Component = as as React.ElementType<React.HTMLAttributes<HTMLElement>>
  return (
    <Component
      className={cn(
        'rounded-xl',
        variant === 'clay' && 'rounded-clay',
        variants[variant],
        paddings[padding],
        interactive && [
          'cursor-pointer transition-[transform,box-shadow,background-color]',
          'duration-base ease-out-soft',
          'hover:-translate-y-0.5 hover:shadow-lift active:translate-y-0 active:shadow-hair',
        ],
        className,
      )}
      {...props}
    />
  )
}

/**
 * Header row. `title` is a node rather than a string because half the headers in
 * this product pair a title with a status badge on the same baseline.
 */
export interface CardHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** The 11px uppercase kicker above the title. */
  eyebrow?: React.ReactNode
  /**
   * `Omit`ted from the native attributes above rather than narrowed: the DOM `title`
   * is the tooltip string, and this one is rendered content.
   */
  title?: React.ReactNode
  description?: React.ReactNode
  /** Right-aligned actions, vertically centred against the title block. */
  action?: React.ReactNode
}

export function CardHeader({
  className,
  eyebrow,
  title,
  description,
  action,
  children,
  ...props
}: CardHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-3', className)} {...props}>
      <div className="min-w-0">
        {eyebrow ? <div className="eyebrow mb-1.5">{eyebrow}</div> : null}
        {title ? (
          <h3 className="text-base leading-snug font-semibold text-ink text-balance">{title}</h3>
        ) : null}
        {description ? (
          <p className="mt-1 text-sm leading-relaxed text-ink-3">{description}</p>
        ) : null}
        {children}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  )
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-4', className)} {...props} />
}

/**
 * Footer. The hairline is drawn with a border rather than an `<hr>` so it inherits
 * the card's padding box and does not need negative margins to span the full width.
 */
export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mt-5 flex items-center gap-3 border-t border-rule pt-4', className)}
      {...props}
    />
  )
}

/**
 * A bento grid cell.
 *
 * `span` is in columns of the 4-column `bento` utility. Kept to 1/2/4 because a
 * 3-of-4 cell leaves a single orphan column that never looks deliberate.
 */
export interface BentoCellProps extends CardProps {
  span?: 1 | 2 | 4
  rows?: 1 | 2
}

export function BentoCell({ span = 1, rows = 1, className, ...props }: BentoCellProps) {
  return (
    <Card
      className={cn(
        span === 2 && 'sm:col-span-2',
        span === 4 && 'sm:col-span-2 lg:col-span-4',
        rows === 2 && 'row-span-2',
        className,
      )}
      {...props}
    />
  )
}

/** The grid itself. Thin wrapper, but it keeps the utility name out of screens. */
export function BentoGrid({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('bento', className)} {...props} />
}
