// Elevation for CIAC's region maps (the app's /regions pages): every Pokémon
// region is modelled on a real place, and this bakes that place's real terrain
// into one small grid per region, plus one grid of the whole world for the globe.
//
// Source: AWS Open Data Terrain Tiles (Mapzen "terrarium" PNGs, free, attribution
// only: https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
// Output, in regions/v1/:
//   <key>.bin   Uint8 grid, row by row from the north-west: 0 = sea, 1..255 = land,
//               height linear from sea level to `max` metres
//   index.json  for every region: bbox [west, south, east, north], w, h, max
//   world.bin   the same for the whole world, 512 × 256, equirectangular
//
//   node scripts/build-regions.mjs
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const OUT = 'regions/v1'
const TILE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'
// [key, west, south, east, north]: the real place each region is modelled on
const REGIONS = [
  ['kanto', 138.3, 34.5, 141.0, 37.3],
  ['johto', 134.2, 33.4, 138.0, 36.5],
  ['hoenn', 129.3, 30.0, 132.2, 34.1],
  ['sinnoh', 139.6, 41.3, 146.0, 45.6],
  ['unova', -74.65, 40.45, -73.35, 41.0],
  ['kalos', -3.4, 45.4, 8.2, 50.2],
  ['alola', -160.35, 18.85, -154.75, 22.3],
  ['galar', -6.4, 49.9, 1.9, 58.8],
  ['paldea', -9.6, 35.9, 3.4, 43.9],
]

const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z }

const cache = new Map()
async function tile(z, x, y) {
  const key = `${z}/${x}/${y}`
  if (cache.has(key)) return cache.get(key)
  const n = 2 ** z
  const xx = ((x % n) + n) % n
  let data = null
  for (let attempt = 0; attempt < 3 && !data; attempt++) {
    try {
      const res = await fetch(`${TILE}/${z}/${xx}/${y}.png`)
      if (!res.ok) throw new Error(String(res.status))
      const { data: raw } = await sharp(Buffer.from(await res.arrayBuffer())).raw().toBuffer({ resolveWithObject: true })
      data = raw
    } catch (e) { if (attempt === 2) throw new Error(`tile ${key}: ${e.message}`); await new Promise(r => setTimeout(r, 800)) }
  }
  cache.set(key, data)
  return data
}

/** Elevation in metres at a lat/lon, read from the zoom-z tiles (bilinear inside a tile pixel). */
async function elevation(lat, lon, z) {
  const fx = lon2x(lon, z), fy = lat2y(Math.max(-85, Math.min(85, lat)), z)
  const tx = Math.floor(fx), ty = Math.min(2 ** z - 1, Math.max(0, Math.floor(fy)))
  const px = Math.min(255, Math.floor((fx - tx) * 256)), py = Math.min(255, Math.floor((fy - ty) * 256))
  const d = await tile(z, tx, ty)
  const i = (py * 256 + px) * (d.length / 65536)
  return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768
}

async function grid(bbox, w, h, z) {
  const [west, south, east, north] = bbox
  const out = new Float32Array(w * h)
  for (let r = 0; r < h; r++) {
    const lat = north - ((r + 0.5) / h) * (north - south)
    for (let c = 0; c < w; c++) out[r * w + c] = await elevation(lat, west + ((c + 0.5) / w) * (east - west), z)
  }
  return out
}

function quantise(el) {
  let max = 1
  for (const v of el) if (v > max) max = v
  const q = new Uint8Array(el.length)
  for (let i = 0; i < el.length; i++) q[i] = el[i] <= 0 ? 0 : 1 + Math.min(254, Math.round((254 * el[i]) / max))
  return { q, max: Math.round(max) }
}

fs.mkdirSync(OUT, { recursive: true })
const index = { source: 'AWS Open Data Terrain Tiles (Mapzen terrarium)', attribution: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md', regions: {} }
for (const [key, ...bbox] of REGIONS) {
  const [west, south, east, north] = bbox
  const mid = ((south + north) / 2) * (Math.PI / 180)
  // 288 samples across; rows in proportion to the real ground distance
  const w = 288, h = Math.round((w * (north - south)) / ((east - west) * Math.cos(mid)))
  // the zoom that gives at least as many tile pixels as samples across
  let z = 4
  while ((lon2x(east, z) - lon2x(west, z)) * 256 < w * 1.2 && z < 12) z++
  const el = await grid(bbox, w, h, z)
  const { q, max } = quantise(el)
  fs.writeFileSync(path.join(OUT, `${key}.bin`), q)
  index.regions[key] = { bbox, w, h, max, zoom: z }
  console.log(key, `${w}×${h}`, `z${z}`, `max ${max} m`, `${cache.size} tiles`)
}
// the world, for the globe
{
  const w = 512, h = 256
  const el = await grid([-180, -85, 180, 85], w, h, 3)
  const { q, max } = quantise(el)
  fs.writeFileSync(path.join(OUT, 'world.bin'), q)
  index.world = { bbox: [-180, -85, 180, 85], w, h, max }
  console.log('world', `${w}×${h}`, `max ${max} m`)
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1))
