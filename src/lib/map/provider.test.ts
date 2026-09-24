import { describe, expect, it } from 'vitest'

import { getMapTileProvider } from './provider'

describe('getMapTileProvider', () => {
  it('uses an OpenStreetMap-compatible tile layer for development', () => {
    const provider = getMapTileProvider('osm')

    expect(provider.id).toBe('osm')
    expect(provider.tiles[0]).toContain('tile.openstreetmap.org')
    expect(provider.attribution).toContain('OpenStreetMap')
  })
})
