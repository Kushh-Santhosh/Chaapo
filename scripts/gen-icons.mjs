/**
 * Rasterises the Chaapo app icons.
 *
 * `public/brand/icon.svg` is the source of truth for the mark; PWA install
 * prompts and iOS home screens still want PNGs, so this script draws the same
 * geometry with pixel maths and writes them. Kept in the repo (rather than a
 * one-off) so the icons can be regenerated when the brand colours move:
 *
 *   node scripts/gen-icons.mjs
 *
 * No image library is used on purpose — this must run on a machine with nothing
 * installed, which is also the machine the app has to open on.
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'brand')

const PAPER = [0xfb, 0xf8, 0xf3]
const CHAAP = [0xd9, 0x3f, 0x2b]
const ROTATION = (-6 * Math.PI) / 180
/** Supersampling factor per axis. 3×3 is enough to hide the rotated edges. */
const SS = 3

/** Signed distance to a rounded rectangle centred on the origin. */
function roundedRectDistance(x, y, halfWidth, halfHeight, radius) {
  const dx = Math.abs(x) - (halfWidth - radius)
  const dy = Math.abs(y) - (halfHeight - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - radius
}

function mix(from, to, t) {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ]
}

/**
 * @param size    output edge length in pixels
 * @param maskable when true the mark shrinks and the paper bleeds to the edge,
 *                 so Android's circular crop never clips the stamp
 */
function drawIcon(size, { maskable = false } = {}) {
  const pixels = Buffer.alloc(size * size * 3)
  const centre = size / 2
  const scale = size / 512

  // Geometry in the 512-unit design space, then scaled.
  const tileRadius = maskable ? 0 : 112 * scale
  const inset = maskable ? 1.28 : 1 // shrink the stamp inside the safe zone
  const stampHalfW = (160 * scale) / inset
  const stampHalfH = (136 * scale) / inset
  const stampRadius = (40 * scale) / inset
  const ringOuter = stampRadius - 4 * scale
  const ringWidth = 8 * scale
  const barHalfW = stampHalfW - 40 * scale
  const barHalfH = 9 * scale

  const cos = Math.cos(ROTATION)
  const sin = Math.sin(ROTATION)

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let tile = 0
      let stamp = 0
      let ring = 0

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = px + (sx + 0.5) / SS - centre
          const y = py + (sy + 0.5) / SS - centre

          if (tileRadius === 0) {
            tile += 1
          } else if (roundedRectDistance(x, y, centre, centre, tileRadius) <= 0) {
            tile += 1
          }

          // Rotate the sample into stamp space rather than rotating the stamp.
          const rx = x * cos + y * sin
          const ry = -x * sin + y * cos

          const outer = roundedRectDistance(rx, ry, stampHalfW, stampHalfH, stampRadius)
          if (outer <= 0) stamp += 1

          const innerHalfW = stampHalfW - 24 * scale
          const innerHalfH = stampHalfH - 24 * scale
          const inner = roundedRectDistance(rx, ry, innerHalfW, innerHalfH, ringOuter)
          const onRing = inner <= 0 && inner >= -ringWidth
          // Three stacked bars inside the ring — the impression, abstracted.
          const bar =
            Math.abs(rx) <= barHalfW &&
            [-46, 0, 46].some((offset) => Math.abs(ry - offset * scale) <= barHalfH)
          if (onRing || bar) ring += 1
        }
      }

      const total = SS * SS
      let colour = mix([0xff, 0xff, 0xff], PAPER, tile / total)
      colour = mix(colour, CHAAP, stamp / total)
      colour = mix(colour, PAPER, ring / total)

      const at = (py * size + px) * 3
      pixels[at] = colour[0]
      pixels[at + 1] = colour[1]
      pixels[at + 2] = colour[2]
    }
  }

  return encodePng(size, pixels)
}

/** Minimal PNG encoder: one IHDR, one IDAT, one IEND. Truecolour, 8-bit. */
function encodePng(size, rgb) {
  const stride = size * 3
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0 // filter type: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type, data) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([head, body, tail])
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

mkdirSync(OUT, { recursive: true })
const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, {}],
]
for (const [name, size, options] of targets) {
  writeFileSync(join(OUT, name), drawIcon(size, options))
  process.stdout.write(`wrote public/brand/${name} (${size}×${size})\n`)
}
