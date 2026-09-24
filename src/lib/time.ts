import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz'

/**
 * Time.
 *
 * Everything is stored and computed in UTC and *displayed* in IST. Shops,
 * customers, SLA clocks, cut-off times, settlement windows and the daily
 * summary all live in Asia/Kolkata regardless of where the server runs
 * (NFR-19). This module is the only place that knows the timezone.
 *
 * Opening hours are minutes-from-midnight integers rather than time strings,
 * because we need arithmetic on them (SLA deadlines that only tick while the
 * shop is open) and because a shop that closes at 01:00 is a normal thing in
 * an Indian market street — `close` may exceed 1440.
 */

export const IST = 'Asia/Kolkata' as const

export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000
export const MINUTES_PER_DAY = 1440

export function nowUtc(): Date {
  return new Date()
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS)
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS)
}

export function diffMinutes(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / MINUTE_MS)
}

export function isBefore(a: Date, b: Date): boolean {
  return a.getTime() < b.getTime()
}

export function isAfter(a: Date, b: Date): boolean {
  return a.getTime() > b.getTime()
}

export function earliest(...dates: Date[]): Date {
  return dates.reduce((min, d) => (d.getTime() < min.getTime() ? d : min))
}

export function latest(...dates: Date[]): Date {
  return dates.reduce((max, d) => (d.getTime() > max.getTime() ? d : max))
}

// ── Display ─────────────────────────────────────────────────────────────────

/** `26 Aug 2026, 7:42 pm` */
export function formatIstDateTime(date: Date): string {
  return formatInTimeZone(date, IST, "d MMM yyyy, h:mm aaa")
}

/** `7:42 pm` */
export function formatIstTime(date: Date): string {
  return formatInTimeZone(date, IST, 'h:mm aaa')
}

/** `26 Aug 2026` */
export function formatIstDate(date: Date): string {
  return formatInTimeZone(date, IST, 'd MMM yyyy')
}

/** `2026-08-26` — for grouping, filenames and CSV columns. */
export function istDateKey(date: Date): string {
  return formatInTimeZone(date, IST, 'yyyy-MM-dd')
}

/** `Wed` */
export function formatIstWeekday(date: Date): string {
  return formatInTimeZone(date, IST, 'EEE')
}

/** IST day-of-week, 0 = Sunday … 6 = Saturday. */
export function istWeekday(date: Date): number {
  return toZonedTime(date, IST).getDay()
}

/** Minutes elapsed since IST midnight. */
export function istMinutesOfDay(date: Date): number {
  const zoned = toZonedTime(date, IST)
  return zoned.getHours() * 60 + zoned.getMinutes()
}

/** Start of the IST day containing `date`, as a UTC instant. */
export function startOfIstDay(date: Date): Date {
  return fromZonedTime(`${formatInTimeZone(date, IST, 'yyyy-MM-dd')} 00:00:00`, IST)
}

/** The UTC instant of `HH:mm` IST on the IST day containing `date`. */
export function istTimeOnDay(date: Date, minutesFromMidnight: number): Date {
  return new Date(startOfIstDay(date).getTime() + minutesFromMidnight * MINUTE_MS)
}

/** `7:42 pm` → 1062. Accepts `19:42`, `7:42 pm`, `0742`. */
export function parseMinutesOfDay(input: string): number | null {
  const cleaned = input.trim().toLowerCase()
  const meridiem = /(am|pm)$/.exec(cleaned)?.[1]
  const digits = cleaned.replace(/(am|pm)$/, '').trim()
  const match = /^(\d{1,2})[:.]?(\d{2})?$/.exec(digits)
  if (!match) return null
  let hours = Number(match[1])
  const minutes = Number(match[2] ?? '0')
  if (Number.isNaN(hours) || Number.isNaN(minutes) || minutes > 59) return null
  if (meridiem === 'pm' && hours < 12) hours += 12
  if (meridiem === 'am' && hours === 12) hours = 0
  if (hours > 30) return null
  return hours * 60 + minutes
}

/** 1062 → `5:42 pm`. Handles values past midnight (1500 → `1:00 am`). */
export function formatMinutesOfDay(minutes: number): string {
  const normalised = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  const hours24 = Math.floor(normalised / 60)
  const mins = normalised % 60
  const meridiem = hours24 < 12 ? 'am' : 'pm'
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12
  return `${hours12}:${mins.toString().padStart(2, '0')} ${meridiem}`
}

/**
 * Short relative time, in the register the product speaks in: `now`, `in 12 min`,
 * `in 2 h 10 m`, `4 min ago`, `yesterday`, `26 Aug`.
 */
export function formatRelative(target: Date, from: Date = nowUtc()): string {
  const deltaMs = target.getTime() - from.getTime()
  const future = deltaMs > 0
  const abs = Math.abs(deltaMs)

  if (abs < 45 * 1000) return 'now'
  if (abs < HOUR_MS) {
    const mins = Math.round(abs / MINUTE_MS)
    return future ? `in ${mins} min` : `${mins} min ago`
  }
  if (abs < 12 * HOUR_MS) {
    const hours = Math.floor(abs / HOUR_MS)
    const mins = Math.round((abs % HOUR_MS) / MINUTE_MS)
    const body = mins > 0 ? `${hours} h ${mins} m` : `${hours} h`
    return future ? `in ${body}` : `${body} ago`
  }

  const targetKey = istDateKey(target)
  const todayKey = istDateKey(from)
  if (targetKey === todayKey) return formatIstTime(target)
  const yesterdayKey = istDateKey(new Date(from.getTime() - DAY_MS))
  const tomorrowKey = istDateKey(new Date(from.getTime() + DAY_MS))
  if (targetKey === yesterdayKey) return `yesterday, ${formatIstTime(target)}`
  if (targetKey === tomorrowKey) return `tomorrow, ${formatIstTime(target)}`
  return formatInTimeZone(target, IST, 'd MMM, h:mm aaa')
}

/** `12 min left`, `overdue by 4 min` — for the shop dashboard SLA column. */
export function formatCountdown(deadline: Date, from: Date = nowUtc()): string {
  const deltaMs = deadline.getTime() - from.getTime()
  const abs = Math.abs(deltaMs)
  const mins = Math.floor(abs / MINUTE_MS)
  const body =
    mins < 60
      ? `${Math.max(mins, 0)} min`
      : `${Math.floor(mins / 60)} h${mins % 60 > 0 ? ` ${mins % 60} m` : ''}`
  return deltaMs >= 0 ? `${body} left` : `overdue by ${body}`
}

// ── Opening hours ───────────────────────────────────────────────────────────

/**
 * One opening interval, in minutes from IST midnight. `close` may exceed 1440 to
 * express closing after midnight (e.g. 09:00–01:00 is `{ open: 540, close: 1500 }`).
 */
export interface HoursInterval {
  open: number
  close: number
}

/** Index 0 = Sunday … 6 = Saturday. An empty array means closed that day. */
export type WeeklyHours = readonly (readonly HoursInterval[])[]

export const CLOSED_ALL_WEEK: WeeklyHours = [[], [], [], [], [], [], []]

export function isValidInterval(interval: HoursInterval): boolean {
  return (
    Number.isInteger(interval.open) &&
    Number.isInteger(interval.close) &&
    interval.open >= 0 &&
    interval.open < MINUTES_PER_DAY &&
    interval.close > interval.open &&
    interval.close <= MINUTES_PER_DAY + 12 * 60
  )
}

export function isValidWeeklyHours(hours: WeeklyHours): boolean {
  if (hours.length !== 7) return false
  return hours.every((day) => {
    if (!day.every(isValidInterval)) return false
    const sorted = [...day].sort((a, b) => a.open - b.open)
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i]!.open < sorted[i - 1]!.close) return false // overlapping
    }
    return true
  })
}

/**
 * Is the shop open at `at`? Checks today's intervals and yesterday's intervals
 * that run past midnight.
 */
export function isOpenAt(hours: WeeklyHours, at: Date): boolean {
  if (hours.length !== 7) return false
  const day = istWeekday(at)
  const minutes = istMinutesOfDay(at)

  const today = hours[day] ?? []
  if (today.some((i) => minutes >= i.open && minutes < i.close)) return true

  const yesterday = hours[(day + 6) % 7] ?? []
  return yesterday.some((i) => i.close > MINUTES_PER_DAY && minutes < i.close - MINUTES_PER_DAY)
}

/**
 * The next instant the shop opens, at or after `from`. Returns null if it is
 * closed for the whole search window (default 14 days), which is how a shop with
 * no configured hours reads.
 */
export function nextOpenAt(hours: WeeklyHours, from: Date, searchDays = 14): Date | null {
  if (isOpenAt(hours, from)) return from
  for (let offset = 0; offset <= searchDays; offset += 1) {
    const dayStart = startOfIstDay(new Date(from.getTime() + offset * DAY_MS))
    const day = istWeekday(dayStart)
    const intervals = [...(hours[day] ?? [])].sort((a, b) => a.open - b.open)
    for (const interval of intervals) {
      const openAt = new Date(dayStart.getTime() + interval.open * MINUTE_MS)
      if (openAt.getTime() >= from.getTime()) return openAt
    }
  }
  return null
}

/** The instant the shop next closes, at or after `from`. */
export function closingAfter(hours: WeeklyHours, from: Date, searchDays = 14): Date | null {
  for (let offset = 0; offset <= searchDays; offset += 1) {
    const dayStart = startOfIstDay(new Date(from.getTime() + offset * DAY_MS))
    const day = istWeekday(dayStart)
    const intervals = [...(hours[day] ?? [])].sort((a, b) => a.open - b.open)
    for (const interval of intervals) {
      const closeAt = new Date(dayStart.getTime() + interval.close * MINUTE_MS)
      if (closeAt.getTime() > from.getTime()) return closeAt
    }
  }
  return null
}

/**
 * Add `minutes` of *open* time to `from`, skipping over closed periods.
 *
 * This is how promised-ready times and SLA deadlines are computed: a job placed
 * at 20:55 on a shop that closes at 21:00 with a 30-minute turnaround is not
 * late at 21:25 — it is due 25 minutes after the shop reopens (PRD §33.4).
 * Returns null if the shop never accumulates that much open time in the window.
 */
export function addOpenMinutes(
  hours: WeeklyHours,
  from: Date,
  minutes: number,
  searchDays = 14,
): Date | null {
  if (minutes <= 0) return from
  let cursor = isOpenAt(hours, from) ? from : nextOpenAt(hours, from, searchDays)
  if (!cursor) return null
  let remaining = minutes
  const horizon = from.getTime() + searchDays * DAY_MS

  while (cursor.getTime() <= horizon) {
    const closesAt = closingAfter(hours, cursor, searchDays)
    if (!closesAt) return null
    const availableMinutes = Math.floor((closesAt.getTime() - cursor.getTime()) / MINUTE_MS)
    if (availableMinutes >= remaining) {
      return new Date(cursor.getTime() + remaining * MINUTE_MS)
    }
    remaining -= availableMinutes
    const reopensAt = nextOpenAt(hours, new Date(closesAt.getTime() + MINUTE_MS), searchDays)
    if (!reopensAt) return null
    cursor = reopensAt
  }
  return null
}

/** Minutes of open time between two instants. Used for SLA reporting. */
export function openMinutesBetween(hours: WeeklyHours, from: Date, to: Date): number {
  if (to.getTime() <= from.getTime()) return 0
  let cursor = isOpenAt(hours, from) ? from : nextOpenAt(hours, from, 30)
  let total = 0
  while (cursor && cursor.getTime() < to.getTime()) {
    const closesAt = closingAfter(hours, cursor, 30)
    if (!closesAt) break
    const segmentEnd = closesAt.getTime() < to.getTime() ? closesAt : to
    total += Math.max(0, Math.floor((segmentEnd.getTime() - cursor.getTime()) / MINUTE_MS))
    if (segmentEnd.getTime() >= to.getTime()) break
    cursor = nextOpenAt(hours, new Date(closesAt.getTime() + MINUTE_MS), 30)
  }
  return total
}

/** `Open until 9:00 pm` / `Closed · opens 9:00 am tomorrow` / `Closed` */
export function describeOpenState(
  hours: WeeklyHours,
  at: Date = nowUtc(),
): { open: boolean; label: string; changesAt: Date | null } {
  if (isOpenAt(hours, at)) {
    const closesAt = closingAfter(hours, at)
    return {
      open: true,
      label: closesAt ? `Open until ${formatIstTime(closesAt)}` : 'Open',
      changesAt: closesAt,
    }
  }
  const opensAt = nextOpenAt(hours, at)
  if (!opensAt) return { open: false, label: 'Closed', changesAt: null }
  const sameDay = istDateKey(opensAt) === istDateKey(at)
  const tomorrow = istDateKey(opensAt) === istDateKey(new Date(at.getTime() + DAY_MS))
  const when = sameDay
    ? formatIstTime(opensAt)
    : tomorrow
      ? `${formatIstTime(opensAt)} tomorrow`
      : `${formatIstWeekday(opensAt)} ${formatIstTime(opensAt)}`
  return { open: false, label: `Closed · opens ${when}`, changesAt: opensAt }
}

// ── Availability badge ──────────────────────────────────────────────────────

/** The badge state computed server-side for the first paint and recomputed on the client. */
export interface Availability {
  tone: 'success' | 'warn' | 'neutral'
  label: string
  /** Open right now — the only state whose dot is allowed to breathe. */
  live: boolean
}

/**
 * What the availability badge should show: the server computes this for the first
 * paint, then the client recomputes it every minute from the same `hours` array so
 * a card that says "Open until 9:00 pm" does not still say it at 9:05.
 *
 * A paused shop reads as paused, with the shop's own reason, rather than as closed:
 * "Machine servicing, back by 3 pm" stops someone walking over, and hiding the shop
 * entirely would make them think it had shut down.
 *
 * Shared by the server render and the client tick, so the two cannot disagree.
 */
export function describeAvailability(
  hours: WeeklyHours,
  pausedUntil: string | null,
  pauseReason: string | null,
  now: Date,
): Availability {
  if (pausedUntil && new Date(pausedUntil).getTime() > now.getTime()) {
    return { tone: 'warn', label: pauseReason?.trim() || 'Paused — not taking orders', live: false }
  }
  const state = describeOpenState(hours, now)
  return state.open
    ? { tone: 'success', label: state.label, live: true }
    : { tone: 'neutral', label: state.label, live: false }
}
