// Card tiles: a 245 px WebP for every catalog card whose picture is a big PNG on another host (Pokéllector,
// Limitless, pokemontcg.io, Scrydex: 50–600 KB each), served from this site next to the catalog. The app's
// grids load these (~15–20 KB) instead of asking wsrv.nl, whose first fetch of a picture waits on the
// original host (CIAC docs/dev/performance.md "Card pictures per source").
//
//   catalog/v2/cards-{en,ja}.json image  https://den-cards.pokellector.com/228/Pinsir.SM4+.2.19578.png
//   → tiles/pk/228/Pinsir.SM4_.2.19578.webp
//
// The tile path comes from the picture's URL alone (tilePath below; the app's src/lib/cards.ts `tileUrl` is the
// same rule), so no index is needed: a new card gets its tile in the same daily run that adds it to the catalog.
// Incremental: only pictures without a tile are fetched. A picture that fails is retried the next day; the
// app falls back to the original meanwhile.
//
//   node scripts/build-tiles.mjs [--limit N] [--parallel N]
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const UA = { 'user-agent': 'CIAC-relay (https://ciac-tcg.com)' }
const WIDTH = 245
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? +process.argv[i + 1] : d }
const LIMIT = arg('--limit', Infinity), PARALLEL = arg('--parallel', 6)

/** host → the tile folder's short name. Keep in step with the app's `TILE_HOSTS` (src/lib/cards.ts). */
export const TILE_HOSTS = {
  'den-cards.pokellector.com': 'pk',
  'limitlesstcg.nyc3.cdn.digitaloceanspaces.com': 'll',
  'images.pokemontcg.io': 'ptcg',
  'images.scrydex.com': 'sx',
}
/** The tile's path under the site root for a picture URL, or null when its host gets no tile. */
export function tilePath(url) {
  const m = /^https:\/\/([^/]+)\/(.+)$/.exec(url || '')
  const short = m && TILE_HOSTS[m[1]]
  if (!short) return null
  return `tiles/${short}/${m[2].replace(/\.(png|jpe?g|webp)$/i, '').replace(/[^A-Za-z0-9._/-]/g, '_')}.webp`
}

async function catalogUrls() {
  const urls = new Set()
  for (const lang of ['en', 'ja']) {
    const j = JSON.parse(await readFile(path.join(ROOT, `catalog/v2/cards-${lang}.json`), 'utf8'))
    const i = j.fields.indexOf('image')
    for (const r of j.rows) if (tilePath(r[i])) urls.add(r[i])
  }
  return [...urls]
}

async function tile(url) {
  const out = path.join(ROOT, tilePath(url))
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) })
      if (res.status === 404) return 'missing'
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const webp = await sharp(buf).resize({ width: WIDTH, withoutEnlargement: true }).webp({ quality: 80, effort: 5 }).toBuffer()
      await mkdir(path.dirname(out), { recursive: true })
      await writeFile(out, webp)
      return webp.length
    } catch (e) {
      if (attempt === 2) return `error ${e.message}`
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const all = await catalogUrls()
  const missing = all.filter(u => !existsSync(path.join(ROOT, tilePath(u))))
  const todo = missing.slice(0, LIMIT)
  console.log(`tiles: ${all.length} pictures, ${all.length - missing.length} have a tile, ${todo.length} to make`)
  let made = 0, bytes = 0, done = 0
  const failed = []
  // one queue per host: Pokéllector's origin takes 1–10 s a picture, the CDNs ~50 ms, so a shared queue would
  // leave the fast hosts waiting behind it
  const queues = {}
  for (const u of todo) (queues[new URL(u).host] ??= []).push(u)
  await Promise.all(Object.values(queues).flatMap(q => Array.from({ length: PARALLEL }, async () => {
    while (q.length) {
      const u = q.shift(), r = await tile(u)
      if (typeof r === 'number') { made++; bytes += r } else failed.push(`${r} ${u}`)
      if (++done % 250 === 0) console.log(`  ${done}/${todo.length}`)
    }
  })))
  console.log(`tiles: made ${made} (avg ${made ? (bytes / made / 1024).toFixed(1) : 0} KB), failed ${failed.length}`)
  for (const f of failed.slice(0, 20)) console.log('  ' + f)
}
