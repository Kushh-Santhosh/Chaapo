import { describe, expect, it } from 'vitest'
import {
  addOpenMinutes,
  closingAfter,
  describeOpenState,
  formatCountdown,
  formatIstDate,
  formatIstDateTime,
  formatMinutesOfDay,
  formatRelative,
  isOpenAt,
  istDateKey,
  istMinutesOfDay,
  istWeekday,
  isValidWeeklyHours,
  nextOpenAt,
  openMinutesBetween,
  parseMinutesOfDay,
  startOfIstDay,
  type WeeklyHours,
} from './time'

/** 2026-08-26 is a Wednesday. 14:30 IST = 09:00 UTC. */
const WED_1430_IST = new Date('2026-08-26T09:00:00.000Z')
const WED_2055_IST = new Date('2026-08-26T15:25:00.000Z')
const WED_0700_IST = new Date('2026-08-26T01:30:00.000Z')

/** 9:00–21:00 every day. */
const ALL_WEEK_9_TO_21: WeeklyHours = Array.from({ length: 7 }, () => [{ open: 540, close: 1260 }])

/** Closed Sunday; 9–14 and 16–21 the rest of the week (an afternoon break). */
const SPLIT_SHIFT: WeeklyHours = [
  [],
  [
    { open: 540, close: 840 },
    { open: 960, close: 1260 },
  ],
  [
    { open: 540, close: 840 },
    { open: 960, close: 1260 },
  ],
  [
    { open: 540, close: 840 },
    { open: 960, close: 1260 },
  ],
  [
    { open: 540, close: 840 },
    { open: 960, close: 1260 },
  ],
  [
    { open: 540, close: 840 },
    { open: 960, close: 1260 },
  ],
  [
    { open: 540, close: 840 },
    { open: 960, close: 1260 },
  ],
]

/** 09:00 to 01:00 the next morning. */
const LATE_NIGHT: WeeklyHours = Array.from({ length: 7 }, () => [{ open: 540, close: 1500 }])

describe('IST conversion', () => {
  it('reads the IST calendar day and weekday regardless of server timezone', () => {
    expect(istDateKey(WED_1430_IST)).toBe('2026-08-26')
    expect(istWeekday(WED_1430_IST)).toBe(3) // Wednesday
    expect(istMinutesOfDay(WED_1430_IST)).toBe(870) // 14:30
  })

  it('keeps late-evening UTC instants on the correct IST day', () => {
    // 2026-08-26T19:00Z is 00:30 IST on the 27th — a real off-by-one-day trap.
    const lateUtc = new Date('2026-08-26T19:00:00.000Z')
    expect(istDateKey(lateUtc)).toBe('2026-08-27')
    expect(istMinutesOfDay(lateUtc)).toBe(30)
  })

  it('computes the start of the IST day as a UTC instant', () => {
    expect(startOfIstDay(WED_1430_IST).toISOString()).toBe('2026-08-25T18:30:00.000Z')
  })

  it('formats for display in IST', () => {
    expect(formatIstDate(WED_1430_IST)).toBe('26 Aug 2026')
    expect(formatIstDateTime(WED_1430_IST)).toBe('26 Aug 2026, 2:30 pm')
  })
})

describe('minutes-of-day parsing', () => {
  it('accepts the shapes a shop owner will actually type', () => {
    expect(parseMinutesOfDay('09:00')).toBe(540)
    expect(parseMinutesOfDay('9:00')).toBe(540)
    expect(parseMinutesOfDay('9')).toBe(540)
    expect(parseMinutesOfDay('9:30 pm')).toBe(1290)
    expect(parseMinutesOfDay('12:00 am')).toBe(0)
    expect(parseMinutesOfDay('12:00 pm')).toBe(720)
    expect(parseMinutesOfDay('0930')).toBe(570)
  })

  it('rejects nonsense', () => {
    expect(parseMinutesOfDay('99:99')).toBeNull()
    expect(parseMinutesOfDay('later')).toBeNull()
    expect(parseMinutesOfDay('')).toBeNull()
  })

  it('renders minutes for display', () => {
    expect(formatMinutesOfDay(540)).toBe('9:00 am')
    expect(formatMinutesOfDay(1260)).toBe('9:00 pm')
    expect(formatMinutesOfDay(0)).toBe('12:00 am')
    expect(formatMinutesOfDay(720)).toBe('12:00 pm')
    // Past midnight, as a late-night shop's closing time.
    expect(formatMinutesOfDay(1500)).toBe('1:00 am')
  })
})

describe('opening-hours validation', () => {
  it('accepts well-formed weeks', () => {
    expect(isValidWeeklyHours(ALL_WEEK_9_TO_21)).toBe(true)
    expect(isValidWeeklyHours(SPLIT_SHIFT)).toBe(true)
    expect(isValidWeeklyHours(LATE_NIGHT)).toBe(true)
  })

  it('rejects a week that is not seven days', () => {
    expect(isValidWeeklyHours([[], []])).toBe(false)
  })

  it('rejects overlapping intervals', () => {
    const overlapping: WeeklyHours = [
      [
        { open: 540, close: 900 },
        { open: 840, close: 1260 },
      ],
      [],
      [],
      [],
      [],
      [],
      [],
    ]
    expect(isValidWeeklyHours(overlapping)).toBe(false)
  })

  it('rejects a close time at or before the open time', () => {
    expect(isValidWeeklyHours([[{ open: 900, close: 900 }], [], [], [], [], [], []])).toBe(false)
    expect(isValidWeeklyHours([[{ open: 900, close: 540 }], [], [], [], [], [], []])).toBe(false)
  })
})

describe('isOpenAt', () => {
  it('is open inside an interval and closed outside it', () => {
    expect(isOpenAt(ALL_WEEK_9_TO_21, WED_1430_IST)).toBe(true)
    expect(isOpenAt(ALL_WEEK_9_TO_21, WED_0700_IST)).toBe(false)
    expect(isOpenAt(ALL_WEEK_9_TO_21, WED_2055_IST)).toBe(true)
  })

  it('respects the afternoon break', () => {
    // 15:00 IST falls in the 14:00–16:00 gap.
    const wed1500 = new Date('2026-08-26T09:30:00.000Z')
    expect(isOpenAt(SPLIT_SHIFT, wed1500)).toBe(false)
    expect(isOpenAt(SPLIT_SHIFT, WED_1430_IST)).toBe(false) // 14:30 also in the gap
    expect(isOpenAt(SPLIT_SHIFT, new Date('2026-08-26T05:00:00.000Z'))).toBe(true) // 10:30
  })

  it('is closed on the weekly off day', () => {
    const sunday = new Date('2026-08-30T06:00:00.000Z') // Sunday 11:30 IST
    expect(istWeekday(sunday)).toBe(0)
    expect(isOpenAt(SPLIT_SHIFT, sunday)).toBe(false)
  })

  it('handles a shop that closes after midnight', () => {
    const thu0030 = new Date('2026-08-26T19:00:00.000Z') // 00:30 IST Thursday
    expect(isOpenAt(LATE_NIGHT, thu0030)).toBe(true)
    const thu0130 = new Date('2026-08-26T20:00:00.000Z') // 01:30 IST Thursday
    expect(isOpenAt(LATE_NIGHT, thu0130)).toBe(false)
  })

  it('treats an empty schedule as closed rather than always open', () => {
    expect(isOpenAt([[], [], [], [], [], [], []], WED_1430_IST)).toBe(false)
  })
})

describe('nextOpenAt / closingAfter', () => {
  it('returns the instant itself when already open', () => {
    expect(nextOpenAt(ALL_WEEK_9_TO_21, WED_1430_IST)).toEqual(WED_1430_IST)
  })

  it('finds the same-day opening when called before opening', () => {
    const opensAt = nextOpenAt(ALL_WEEK_9_TO_21, WED_0700_IST)
    expect(opensAt?.toISOString()).toBe('2026-08-26T03:30:00.000Z') // 09:00 IST
  })

  it('rolls over to the next day after closing', () => {
    const wed2200 = new Date('2026-08-26T16:30:00.000Z')
    const opensAt = nextOpenAt(ALL_WEEK_9_TO_21, wed2200)
    expect(opensAt?.toISOString()).toBe('2026-08-27T03:30:00.000Z')
  })

  it('skips the weekly off day', () => {
    const saturday2200 = new Date('2026-08-29T16:30:00.000Z')
    const opensAt = nextOpenAt(SPLIT_SHIFT, saturday2200)
    // Sunday closed → Monday 09:00 IST = Monday 03:30 UTC.
    expect(opensAt?.toISOString()).toBe('2026-08-31T03:30:00.000Z')
  })

  it('returns null when the shop is never open', () => {
    expect(nextOpenAt([[], [], [], [], [], [], []], WED_1430_IST)).toBeNull()
  })

  it('finds the next closing time', () => {
    expect(closingAfter(ALL_WEEK_9_TO_21, WED_1430_IST)?.toISOString()).toBe(
      '2026-08-26T15:30:00.000Z',
    ) // 21:00 IST
  })
})

describe('addOpenMinutes — the SLA clock', () => {
  it('adds minutes directly when the shop stays open', () => {
    const due = addOpenMinutes(ALL_WEEK_9_TO_21, WED_1430_IST, 30)
    expect(due?.toISOString()).toBe('2026-08-26T09:30:00.000Z')
  })

  it('does not make a shop late for time it was closed', () => {
    // Placed 20:55 IST, 30-minute turnaround, shop shuts at 21:00. Five minutes
    // of work happen today; the remaining 25 resume at 09:00 tomorrow.
    const due = addOpenMinutes(ALL_WEEK_9_TO_21, WED_2055_IST, 30)
    expect(due?.toISOString()).toBe('2026-08-27T03:55:00.000Z') // 09:25 IST Thursday
  })

  it('steps over an afternoon break', () => {
    // 13:45 IST + 30 min, but the shop closes 14:00–16:00.
    const wed1345 = new Date('2026-08-26T08:15:00.000Z')
    const due = addOpenMinutes(SPLIT_SHIFT, wed1345, 30)
    expect(due?.toISOString()).toBe('2026-08-26T10:45:00.000Z') // 16:15 IST
  })

  it('starts the clock at opening time for an order placed while closed', () => {
    const due = addOpenMinutes(ALL_WEEK_9_TO_21, WED_0700_IST, 45)
    expect(due?.toISOString()).toBe('2026-08-26T04:15:00.000Z') // 09:45 IST
  })

  it('returns the same instant for a zero-minute promise', () => {
    expect(addOpenMinutes(ALL_WEEK_9_TO_21, WED_1430_IST, 0)).toEqual(WED_1430_IST)
  })

  it('returns null for a shop with no hours', () => {
    expect(addOpenMinutes([[], [], [], [], [], [], []], WED_1430_IST, 30)).toBeNull()
  })
})

describe('openMinutesBetween', () => {
  it('counts only open time', () => {
    const from = WED_2055_IST // 20:55 IST Wed
    const to = new Date('2026-08-27T04:00:00.000Z') // 09:30 IST Thu
    // 5 minutes Wednesday evening + 30 minutes Thursday morning.
    expect(openMinutesBetween(ALL_WEEK_9_TO_21, from, to)).toBe(35)
  })

  it('is zero for a reversed range', () => {
    expect(openMinutesBetween(ALL_WEEK_9_TO_21, WED_2055_IST, WED_1430_IST)).toBe(0)
  })
})

describe('describeOpenState', () => {
  it('says when an open shop closes', () => {
    const state = describeOpenState(ALL_WEEK_9_TO_21, WED_1430_IST)
    expect(state.open).toBe(true)
    expect(state.label).toBe('Open until 9:00 pm')
  })

  it('says when a closed shop opens', () => {
    const state = describeOpenState(ALL_WEEK_9_TO_21, WED_0700_IST)
    expect(state.open).toBe(false)
    expect(state.label).toBe('Closed · opens 9:00 am')
  })

  it('reads as plain Closed when there are no hours at all', () => {
    expect(describeOpenState([[], [], [], [], [], [], []], WED_1430_IST)).toEqual({
      open: false,
      label: 'Closed',
      changesAt: null,
    })
  })
})

describe('relative formatting', () => {
  const now = WED_1430_IST

  it('reads in the product voice', () => {
    expect(formatRelative(new Date(now.getTime() + 20_000), now)).toBe('now')
    expect(formatRelative(new Date(now.getTime() + 12 * 60_000), now)).toBe('in 12 min')
    expect(formatRelative(new Date(now.getTime() - 4 * 60_000), now)).toBe('4 min ago')
    expect(formatRelative(new Date(now.getTime() + 130 * 60_000), now)).toBe('in 2 h 10 m')
    expect(formatRelative(new Date(now.getTime() - 120 * 60_000), now)).toBe('2 h ago')
  })

  it('falls back to clock and calendar for distant times', () => {
    expect(formatRelative(new Date('2026-08-27T09:00:00.000Z'), now)).toBe('tomorrow, 2:30 pm')
    expect(formatRelative(new Date('2026-08-25T09:00:00.000Z'), now)).toBe('yesterday, 2:30 pm')
    expect(formatRelative(new Date('2026-09-02T09:00:00.000Z'), now)).toBe('2 Sep, 2:30 pm')
  })

  it('formats SLA countdowns both ways', () => {
    expect(formatCountdown(new Date(now.getTime() + 12 * 60_000), now)).toBe('12 min left')
    expect(formatCountdown(new Date(now.getTime() - 4 * 60_000), now)).toBe('overdue by 4 min')
    expect(formatCountdown(new Date(now.getTime() + 95 * 60_000), now)).toBe('1 h 35 m left')
  })
})
