export type MapTileProviderId = 'osm' | 'maptiler'

export interface MapTileProvider {
  id: MapTileProviderId
  name: string
  tiles: string[]
  attribution: string
  maxZoom: number
}

export function getMapTileProvider(id: MapTileProviderId = 'osm'): MapTileProvider {
  switch (id) {
    case 'maptiler':
      return {
        id: 'maptiler',
        name: 'MapTiler Streets',
        tiles: [
          'https://api.maptiler.com/maps/streets/{z}/{x}/{y}.png?key={key}',
        ],
        attribution: '&copy; OpenStreetMap contributors &copy; MapTiler',
        maxZoom: 19,
      }
    case 'osm':
    default:
      return {
        id: 'osm',
        name: 'OpenStreetMap',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }
  }
}
