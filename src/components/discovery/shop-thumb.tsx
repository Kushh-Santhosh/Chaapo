/**
 * The shop tile on a discovery card.
 *
 * There is no photo yet — the only shop images in the schema are KYC evidence,
 * which must never reach a customer, and a public gallery will arrive with the
 * signed-URL image proxy. So this draws a deterministic tile from the shop's own
 * initials instead of an empty grey box: derived from the id, it is stable across
 * renders and across devices, and it never looks like a failed image.
 */

import { cn } from '@/lib/cn'

/** Four warm ink washes that all sit correctly beside vermilion. */
const WASHES = [
  'bg-[#efe6d6] text-[#7a5c2e]',
  'bg-[#e6ebe4] text-[#3f6046]',
  'bg-[#e9e6ef] text-[#4d466d]',
  'bg-[#f0e4e1] text-[#8a4436]',
] as const

function washFor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 997
  return WASHES[hash % WASHES.length] ?? WASHES[0]
}

/** "Shivaji Xerox & Stationers" → "SX". Skips the noise words. */
export function shopInitials(name: string): string {
  const words = name
    .split(/[\s&·,-]+/)
    .filter((word) => word.length > 1 && !/^(the|and|shop|centre|center)$/i.test(word))
  const letters = (words.length > 0 ? words : name.split(/\s+/)).slice(0, 2).map((word) => word[0] ?? '')
  return letters.join('').toUpperCase() || '?'
}

export interface ShopThumbProps {
  name: string
  seed: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizes = {
  sm: 'size-12 rounded-lg text-base',
  md: 'size-16 rounded-xl text-xl',
  lg: 'size-20 rounded-xl text-2xl',
}

export function ShopThumb({ name, seed, size = 'md', className }: ShopThumbProps) {
  return (
    <div
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center font-display shadow-inset-well select-none',
        sizes[size],
        washFor(seed),
        className,
      )}
    >
      {shopInitials(name)}
    </div>
  )
}
