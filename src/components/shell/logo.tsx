/**
 * The Chaapo wordmark.
 *
 * The mark is the stamp tile plus the name set in the display face. Kept as a
 * component rather than an image so it inherits colour, scales with the type
 * ramp, and costs no request on the 4G first paint (NFR-02).
 */

import { cn } from '@/lib/cn'

export interface LogoProps {
  /** `sm` for the sticky bar, `md` for auth screens and the footer. */
  size?: 'sm' | 'md' | 'lg'
  /** Hide the word and keep the tile — for very narrow bars. */
  markOnly?: boolean
  className?: string
}

const tileSizes = { sm: 'size-7 rounded-md', md: 'size-9 rounded-lg', lg: 'size-12 rounded-xl' }
const wordSizes = { sm: 'text-xl', md: 'text-2xl', lg: 'text-3xl' }
const barSizes = { sm: 'h-[1.5px]', md: 'h-[2px]', lg: 'h-[3px]' }

export function Logo({ size = 'sm', markOnly, className }: LogoProps) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span
        aria-hidden
        className={cn(
          'clay-chaap grid shrink-0 -rotate-6 place-items-center',
          tileSizes[size],
        )}
      >
        <span className="flex w-[58%] flex-col gap-[0.18em]">
          <span className={cn('w-full rounded-full bg-white/85', barSizes[size])} />
          <span className={cn('w-full rounded-full bg-white/85', barSizes[size])} />
          <span className={cn('w-full rounded-full bg-white/85', barSizes[size])} />
        </span>
      </span>
      {markOnly ? (
        <span className="sr-only">Chaapo</span>
      ) : (
        <span className={cn('font-display display-tight text-ink', wordSizes[size])}>Chaapo</span>
      )}
    </span>
  )
}
