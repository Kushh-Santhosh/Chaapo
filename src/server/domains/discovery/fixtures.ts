/**
 * Development shop data.
 *
 * This is the local *data source*, not fake behaviour. It exists because the product
 * has to be openable on a laptop with no Postgres and no PostGIS, and it is wired in
 * only by `source.ts`, which refuses to select it when `DATABASE_URL` is set or the
 * app is running production-like. Everything downstream — the query shapes, the
 * filters, the sorts, the DTOs — is the same code that runs against the database.
 *
 * The shops are Pune-shaped on purpose: real localities, real Indian print-shop
 * pricing (₹2/page B&W, ₹8–10 colour, ₹40 spiral), and the awkward cases a screen has
 * to survive — a shop with no ratings yet, a shop paused for lunch, one that closes
 * on Sundays, one that only does black and white, one whose turnaround is a day
 * because it is a binding specialist.
 *
 * Coordinates are the real localities so distance sorting is meaningful when the
 * browser reports a Pune location; `seed.ts` inserts this same set into Postgres so
 * the dev experience does not change shape when the database appears.
 */

import type { HoursInterval, WeeklyHours } from '../../../lib/time'
import type {
  ShopCapabilitySummary,
  ShopDetail,
  ShopPriceGroup,
  ShopReview,
  ShopSummary,
} from './model'

const h = (openHour: number, closeHour: number): HoursInterval => ({
  open: Math.round(openHour * 60),
  close: Math.round(closeHour * 60),
})

/**
 * Weekly hours from a compact description. Index 0 is Sunday, matching
 * `WeeklyHours` and `shop_hours.weekday`.
 */
function week(params: {
  monToSat: HoursInterval[]
  sunday?: HoursInterval[]
  /** Overrides for a specific weekday, e.g. a half-day Saturday. */
  saturday?: HoursInterval[]
}): WeeklyHours {
  return [
    params.sunday ?? [],
    params.monToSat,
    params.monToSat,
    params.monToSat,
    params.monToSat,
    params.monToSat,
    params.saturday ?? params.monToSat,
  ]
}

const NO_CAPABILITIES: ShopCapabilitySummary = {
  paperSizes: ['a4'],
  colour: false,
  bw: true,
  duplex: true,
  finishings: [],
  cardStock: false,
  photoPaper: false,
  largeFormat: false,
  scanning: false,
  printerCount: 1,
}

const caps = (overrides: Partial<ShopCapabilitySummary>): ShopCapabilitySummary => ({
  ...NO_CAPABILITIES,
  ...overrides,
})

/**
 * A published rating. Stars and a date only — review text is V1, so there is nowhere
 * for a fixture sentence to go and none is written.
 */
const review = (id: string, authorLabel: string, stars: number, daysAgo: number): ShopReview => ({
  id,
  authorLabel,
  stars,
  createdAt: new Date(Date.UTC(2026, 7, 29) - daysAgo * 86_400_000).toISOString(),
})

/** The standard printing block, parameterised by the two rates a shop charges. */
function printingPrices(params: {
  bwPaise: number
  bwBulkPaise?: number
  colourPaise?: number
  a3ColourPaise?: number
}): ShopPriceGroup {
  const items: ShopPriceGroup['items'] = [
    {
      code: 'print_bw_a4',
      label: 'Black & white',
      qualifier: 'A4 · one side',
      pricePaise: String(params.bwPaise),
      unit: 'page',
      tiers: params.bwBulkPaise
        ? [
            { fromQuantity: 1, toQuantity: 50, pricePaise: String(params.bwPaise) },
            { fromQuantity: 51, toQuantity: null, pricePaise: String(params.bwBulkPaise) },
          ]
        : [],
    },
  ]
  if (params.colourPaise) {
    items.push({
      code: 'print_colour_a4',
      label: 'Colour',
      qualifier: 'A4 · one side',
      pricePaise: String(params.colourPaise),
      unit: 'page',
      tiers: [],
    })
  }
  if (params.a3ColourPaise) {
    items.push({
      code: 'print_colour_a3',
      label: 'Colour',
      qualifier: 'A3 · one side',
      pricePaise: String(params.a3ColourPaise),
      unit: 'page',
      tiers: [],
    })
  }
  return { heading: 'Printing', items }
}

const bindingPrices = (items: ShopPriceGroup['items']): ShopPriceGroup => ({
  heading: 'Binding & finishing',
  items,
})

const spiral = (paise: number, upTo: string): ShopPriceGroup['items'][number] => ({
  code: 'bind_spiral',
  label: 'Spiral binding',
  qualifier: upTo,
  pricePaise: String(paise),
  unit: 'book',
  tiers: [],
})

const lamination = (paise: number): ShopPriceGroup['items'][number] => ({
  code: 'finish_lamination',
  label: 'Lamination',
  qualifier: 'A4 · both sides',
  pricePaise: String(paise),
  unit: 'sheet',
  tiers: [],
})

/**
 * A shop, with the fields a card needs plus the fields a profile needs.
 *
 * `distanceMetres` is deliberately absent: it is computed against the search origin,
 * never stored, so a fixture that carried one would lie the moment the customer moved.
 */
export type ShopFixture = Omit<ShopDetail, 'distanceMetres'> & {
  latitude: number
  longitude: number
}

export const DEV_SHOPS: ShopFixture[] = [
  {
    id: '01924f10-0000-7000-8000-000000000001',
    slug: 'shivaji-xerox-fc-road',
    name: 'Shivaji Xerox & Stationery',
    tagline: 'Two machines, no queue, since 1998',
    about:
      'Family-run shop opposite Fergusson College gate 2. Bulk assignment printing, spiral binding while you wait, and project reports finished same day. Ask for Sandeep.',
    localityName: 'Shivajinagar',
    cityName: 'Pune',
    addressLine1: '14, Ashoka Complex, FC Road',
    addressLine2: 'Opposite Fergusson College Gate 2',
    landmark: 'Next to Vaishali Restaurant',
    pincode: '411005',
    latitude: 18.5236,
    longitude: 73.8412,
    ratingAvgCenti: 462,
    ratingCount: 214,
    ordersCompleted: 1893,
    medianReadyMinutes: 18,
    defaultTurnaroundMinutes: 25,
    acceptWindowMinutes: 10,
    pickupGraceHours: 48,
    minOrderValuePaise: '2000',
    maxPagesPerOrder: 600,
    maxFilesPerOrder: 15,
    contactPhoneMasked: '+91 ••••• 41290',
    fromPrice: { pricePaise: '100', unit: 'page', label: 'B&W A4 · 51+' },
    capabilities: caps({
      paperSizes: ['a4', 'a3', 'legal'],
      colour: true,
      finishings: ['staple', 'spiral', 'soft_bind', 'lamination'],
      scanning: true,
      printerCount: 3,
    }),
    hours: week({ monToSat: [h(8.5, 21.5)], sunday: [h(10, 18)] }),
    pausedUntil: null,
    pauseReason: null,
    photoKey: 'dev/shops/shivaji-xerox/front.jpg',
    photoKeys: ['dev/shops/shivaji-xerox/front.jpg', 'dev/shops/shivaji-xerox/counter.jpg'],
    verifiedAt: '2026-02-11T06:20:00.000Z',
    priceList: [
      printingPrices({ bwPaise: 150, bwBulkPaise: 100, colourPaise: 800, a3ColourPaise: 1600 }),
      bindingPrices([spiral(4000, 'up to 200 pages'), lamination(2000)]),
      {
        heading: 'Scanning',
        items: [
          {
            code: 'scan_a4',
            label: 'Scan to PDF',
            qualifier: 'A4 · 300 dpi',
            pricePaise: '500',
            unit: 'page',
            tiers: [],
          },
        ],
      },
    ],
    recentReviews: [
      review('r1', 'Aditi M.', 5, 2),
      review('r2', 'Rohan K.', 5, 6),
      review('r3', 'Sneha P.', 4, 11),
    ],
    closures: [],
  },
  {
    id: '01924f10-0000-7000-8000-000000000002',
    slug: 'kothrud-digital-prints',
    name: 'Kothrud Digital Prints',
    tagline: 'Colour work, done properly',
    about:
      'Digital press setup for colour reports, photo prints and A3 posters. We colour-proof anything over 20 pages before it runs, so a 60-page project does not come out muddy.',
    localityName: 'Kothrud',
    cityName: 'Pune',
    addressLine1: 'Shop 3, Sai Prasad Building, Paud Road',
    addressLine2: null,
    landmark: 'Above Karnataka Bank',
    pincode: '411038',
    latitude: 18.5074,
    longitude: 73.8077,
    ratingAvgCenti: 481,
    ratingCount: 96,
    ordersCompleted: 640,
    medianReadyMinutes: 42,
    defaultTurnaroundMinutes: 45,
    acceptWindowMinutes: 15,
    pickupGraceHours: 72,
    minOrderValuePaise: '5000',
    maxPagesPerOrder: 400,
    maxFilesPerOrder: 10,
    contactPhoneMasked: null,
    fromPrice: { pricePaise: '200', unit: 'page', label: 'B&W A4' },
    capabilities: caps({
      paperSizes: ['a4', 'a3', 'a5'],
      colour: true,
      finishings: ['staple', 'spiral', 'lamination'],
      cardStock: true,
      photoPaper: true,
      largeFormat: true,
      printerCount: 2,
    }),
    hours: week({ monToSat: [h(9.5, 20)], saturday: [h(9.5, 15)] }),
    pausedUntil: null,
    pauseReason: null,
    photoKey: 'dev/shops/kothrud-digital/front.jpg',
    photoKeys: ['dev/shops/kothrud-digital/front.jpg'],
    verifiedAt: '2026-04-02T09:05:00.000Z',
    priceList: [
      printingPrices({ bwPaise: 200, colourPaise: 1000, a3ColourPaise: 2500 }),
      bindingPrices([spiral(5000, 'up to 300 pages'), lamination(2500)]),
      {
        heading: 'Large format',
        items: [
          {
            code: 'print_poster_a2',
            label: 'Poster',
            qualifier: 'A2 · 170 gsm',
            pricePaise: '9000',
            unit: 'sheet',
            tiers: [],
          },
        ],
      },
    ],
    recentReviews: [
      review('r4', 'Farhan S.', 5, 4),
      review('r5', 'Meera J.', 5, 9),
    ],
    closures: [],
  },
  {
    id: '01924f10-0000-7000-8000-000000000003',
    slug: 'balaji-xerox-swargate',
    name: 'Balaji Xerox',
    tagline: 'Black & white, ₹1 a page, that is it',
    about:
      'One machine, one price, fastest turnaround on the street. We do not do colour — if you need colour, Sai Copy two doors down will sort you out.',
    localityName: 'Swargate',
    cityName: 'Pune',
    addressLine1: '7, Laxmi Narayan Chowk',
    addressLine2: null,
    landmark: 'Near Swargate bus stand',
    pincode: '411002',
    latitude: 18.5011,
    longitude: 73.8578,
    ratingAvgCenti: 421,
    ratingCount: 58,
    ordersCompleted: 412,
    medianReadyMinutes: 9,
    defaultTurnaroundMinutes: 15,
    acceptWindowMinutes: 8,
    pickupGraceHours: 24,
    minOrderValuePaise: '1000',
    maxPagesPerOrder: 300,
    maxFilesPerOrder: 8,
    contactPhoneMasked: '+91 ••••• 77104',
    fromPrice: { pricePaise: '80', unit: 'page', label: 'B&W A4 · 51+' },
    capabilities: caps({ paperSizes: ['a4', 'legal'], finishings: ['staple'], printerCount: 1 }),
    hours: week({ monToSat: [h(9, 14), h(16, 21)] }),
    // The lunch break a single-machine shop actually takes.
    pausedUntil: null,
    pauseReason: null,
    photoKey: null,
    photoKeys: [],
    verifiedAt: '2026-05-19T11:40:00.000Z',
    priceList: [
      printingPrices({ bwPaise: 100, bwBulkPaise: 80 }),
      bindingPrices([
        {
          code: 'finish_staple',
          label: 'Stapling',
          qualifier: null,
          pricePaise: '0',
          unit: 'set',
          tiers: [],
        },
      ]),
    ],
    recentReviews: [
      review('r6', 'Nikhil D.', 4, 3),
      review('r7', 'Priya R.', 5, 14),
    ],
    closures: [],
  },
  {
    id: '01924f10-0000-7000-8000-000000000004',
    slug: 'aundh-print-hub',
    name: 'Aundh Print Hub',
    tagline: 'Thesis binding and hard cover work',
    about:
      'Specialists in hard-bound thesis, project reports and gold-foil lettering. Turnaround is a working day because the binding needs to set — plan for it.',
    localityName: 'Aundh',
    cityName: 'Pune',
    addressLine1: '22, Sanewadi, ITI Road',
    addressLine2: 'First floor',
    landmark: 'Above Sujata Mastani',
    pincode: '411007',
    latitude: 18.5593,
    longitude: 73.807,
    ratingAvgCenti: 490,
    ratingCount: 141,
    ordersCompleted: 903,
    medianReadyMinutes: 1080,
    defaultTurnaroundMinutes: 1440,
    acceptWindowMinutes: 30,
    pickupGraceHours: 96,
    minOrderValuePaise: '15000',
    maxPagesPerOrder: 1200,
    maxFilesPerOrder: 6,
    contactPhoneMasked: '+91 ••••• 03318',
    fromPrice: { pricePaise: '140', unit: 'page', label: 'B&W A4 · 51+' },
    capabilities: caps({
      paperSizes: ['a4', 'a3', 'legal', 'letter'],
      colour: true,
      finishings: ['spiral', 'soft_bind', 'hard_bind', 'lamination'],
      cardStock: true,
      printerCount: 2,
    }),
    hours: week({ monToSat: [h(10, 19.5)], sunday: [] }),
    pausedUntil: null,
    pauseReason: null,
    photoKey: 'dev/shops/aundh-hub/front.jpg',
    photoKeys: ['dev/shops/aundh-hub/front.jpg', 'dev/shops/aundh-hub/bindery.jpg'],
    verifiedAt: '2026-01-28T05:15:00.000Z',
    priceList: [
      printingPrices({ bwPaise: 180, bwBulkPaise: 140, colourPaise: 900 }),
      bindingPrices([
        spiral(4500, 'up to 250 pages'),
        {
          code: 'bind_hard',
          label: 'Hard-bound thesis',
          qualifier: 'with gold foil lettering',
          pricePaise: '35000',
          unit: 'book',
          tiers: [],
        },
        lamination(2200),
      ]),
    ],
    recentReviews: [
      review('r8', 'Karthik V.', 5, 7),
      review('r9', 'Ananya B.', 5, 21),
    ],
    closures: [
      {
        startsAt: '2026-09-05T18:30:00.000Z',
        endsAt: '2026-09-07T18:30:00.000Z',
        reason: 'Ganpati',
      },
    ],
  },
  {
    id: '01924f10-0000-7000-8000-000000000005',
    slug: 'viman-nagar-copy-point',
    name: 'Copy Point',
    tagline: 'Open till midnight',
    about:
      'Late-night shop next to the Phoenix gate. Popular with the IT crowd for boarding passes, ID copies and last-minute decks.',
    localityName: 'Viman Nagar',
    cityName: 'Pune',
    addressLine1: 'Unit 4, Nagar Road Service Lane',
    addressLine2: null,
    landmark: 'Beside Phoenix Marketcity gate 3',
    pincode: '411014',
    latitude: 18.5619,
    longitude: 73.9188,
    // A new shop: verified, live, and no ratings yet. The card must not look broken.
    ratingAvgCenti: null,
    ratingCount: 1,
    ordersCompleted: 12,
    medianReadyMinutes: null,
    defaultTurnaroundMinutes: 20,
    acceptWindowMinutes: 10,
    pickupGraceHours: 48,
    minOrderValuePaise: '1500',
    maxPagesPerOrder: null,
    maxFilesPerOrder: null,
    contactPhoneMasked: null,
    fromPrice: { pricePaise: '200', unit: 'page', label: 'B&W A4' },
    capabilities: caps({
      paperSizes: ['a4', 'a3'],
      colour: true,
      finishings: ['staple', 'spiral', 'lamination'],
      photoPaper: true,
      scanning: true,
      printerCount: 2,
    }),
    hours: week({ monToSat: [h(10, 24)], sunday: [h(11, 23)] }),
    pausedUntil: null,
    pauseReason: null,
    photoKey: 'dev/shops/copy-point/front.jpg',
    photoKeys: ['dev/shops/copy-point/front.jpg'],
    verifiedAt: '2026-08-14T13:00:00.000Z',
    priceList: [
      printingPrices({ bwPaise: 200, colourPaise: 1000 }),
      bindingPrices([spiral(5000, 'up to 200 pages'), lamination(3000)]),
      {
        heading: 'Scanning',
        items: [
          {
            code: 'scan_a4',
            label: 'Scan to PDF',
            qualifier: 'A4 · 300 dpi',
            pricePaise: '600',
            unit: 'page',
            tiers: [],
          },
        ],
      },
    ],
    recentReviews: [review('r10', 'Devang T.', 5, 5)],
    closures: [],
  },
  {
    id: '01924f10-0000-7000-8000-000000000006',
    slug: 'sadashiv-peth-book-print',
    name: 'Sadashiv Peth Book & Print',
    tagline: 'Study material, bulk rates',
    about:
      'Bulk printing for classes and coaching batches. Give us 500 pages and the rate drops; give us 2000 and we will deliver to your class.',
    localityName: 'Sadashiv Peth',
    cityName: 'Pune',
    addressLine1: '311, Bajirao Road',
    addressLine2: null,
    landmark: 'Near Sarasbaug',
    pincode: '411030',
    latitude: 18.5045,
    longitude: 73.8494,
    ratingAvgCenti: 438,
    ratingCount: 77,
    ordersCompleted: 559,
    medianReadyMinutes: 95,
    defaultTurnaroundMinutes: 120,
    acceptWindowMinutes: 20,
    pickupGraceHours: 72,
    minOrderValuePaise: '10000',
    maxPagesPerOrder: 3000,
    maxFilesPerOrder: 20,
    contactPhoneMasked: '+91 ••••• 62205',
    fromPrice: { pricePaise: '80', unit: 'page', label: 'B&W A4 · 51+' },
    capabilities: caps({
      paperSizes: ['a4', 'legal'],
      finishings: ['staple', 'spiral', 'soft_bind'],
      printerCount: 4,
    }),
    // Paused for a two-hour machine service — the dashboard's "back soon" toggle.
    pausedUntil: '2026-08-29T09:30:00.000Z',
    pauseReason: 'Machine servicing, back by 3 pm',
    hours: week({ monToSat: [h(9, 20)], sunday: [] }),
    photoKey: 'dev/shops/sadashiv-peth/front.jpg',
    photoKeys: ['dev/shops/sadashiv-peth/front.jpg'],
    verifiedAt: '2026-03-06T07:45:00.000Z',
    priceList: [
      printingPrices({ bwPaise: 120, bwBulkPaise: 80 }),
      bindingPrices([spiral(3500, 'up to 200 pages')]),
    ],
    recentReviews: [
      review('r11', 'Shreyas G.', 4, 8),
      review('r12', 'Ritu A.', 4, 16),
    ],
    closures: [],
  },
]

/**
 * Strip a fixture down to a card.
 *
 * Written as an explicit projection rather than a spread-and-delete, because the
 * point of the summary type is that a profile-only field — the address, the phone,
 * the price list — cannot leak into a list response by accident.
 */
export function summaryOf(shop: ShopFixture, distanceMetres: number | null): ShopSummary {
  return {
    id: shop.id,
    slug: shop.slug,
    name: shop.name,
    tagline: shop.tagline,
    localityName: shop.localityName,
    cityName: shop.cityName,
    distanceMetres,
    ratingAvgCenti: shop.ratingAvgCenti,
    ratingCount: shop.ratingCount,
    ordersCompleted: shop.ordersCompleted,
    medianReadyMinutes: shop.medianReadyMinutes,
    defaultTurnaroundMinutes: shop.defaultTurnaroundMinutes,
    fromPrice: shop.fromPrice,
    capabilities: shop.capabilities,
    hours: shop.hours,
    pausedUntil: shop.pausedUntil,
    pauseReason: shop.pauseReason,
    latitude: shop.latitude,
    longitude: shop.longitude,
    photoKey: shop.photoKey,
    verifiedAt: shop.verifiedAt,
  }
}

export function detailOf(shop: ShopFixture, distanceMetres: number | null): ShopDetail {
  return {
    ...summaryOf(shop, distanceMetres),
    about: shop.about,
    addressLine1: shop.addressLine1,
    addressLine2: shop.addressLine2,
    landmark: shop.landmark,
    pincode: shop.pincode,
    latitude: shop.latitude,
    longitude: shop.longitude,
    contactPhoneMasked: shop.contactPhoneMasked,
    acceptWindowMinutes: shop.acceptWindowMinutes,
    pickupGraceHours: shop.pickupGraceHours,
    minOrderValuePaise: shop.minOrderValuePaise,
    maxPagesPerOrder: shop.maxPagesPerOrder,
    maxFilesPerOrder: shop.maxFilesPerOrder,
    priceList: shop.priceList,
    photoKeys: shop.photoKeys,
    recentReviews: shop.recentReviews,
    closures: shop.closures,
  }
}

export function findDevShop(idOrSlug: string): ShopFixture | null {
  return DEV_SHOPS.find((shop) => shop.id === idOrSlug || shop.slug === idOrSlug) ?? null
}

/**
 * Great-circle distance in metres.
 *
 * The database uses `ST_Distance` on `geography`, which is the same measurement; this
 * is here so the dev path sorts by the same quantity rather than by insertion order,
 * which would hide every distance bug until Postgres appeared.
 */
export function haversineMetres(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const EARTH_RADIUS_M = 6_371_000
  const toRad = (degrees: number) => (degrees * Math.PI) / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLon = toRad(b.longitude - a.longitude)
  const lat1 = toRad(a.latitude)
  const lat2 = toRad(b.latitude)
  const sinLat = Math.sin(dLat / 2)
  const sinLon = Math.sin(dLon / 2)
  const chord = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(chord))))
}

