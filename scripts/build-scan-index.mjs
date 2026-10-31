// CIAC scanner index: a perceptual fingerprint of every catalog card that has
// a TCGdex image, so the app can recognise a card from the camera on the
// device, with no server. Incremental: only cards not yet in the index are
// downloaded.
//
// Fingerprint (46 bytes per card), computed identically in the app
// (src/scan/fingerprint.ts) from a 128×176 RGB raster of the card:
//   - artHash  32 bytes: 256-bit difference hash of the art window
//              (x 10..118, y 18..88), area-averaged to a 17×16 luma grid
//   - cardHash  8 bytes: 64-bit difference hash of the whole card (9×8)
//   - color     6 bytes: mean RGB of the art window and of the whole card
//
// Output (scan/):
//   index.bin   records in the order of ids.json
//   ids.json    { version, count, generatedAt, ids: [cardId, …] }
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const OUT = path.join(ROOT, 'scan')
const ASSETS = 'https://assets.tcgdex.net/'
const REC = 46
const W = 128, H = 176
const CONCURRENCY = Number(process.env.CONCURRENCY || 12)
const LIMIT = Number(process.env.LIMIT || 0)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function fetchBuf(url) {
  for (let a = 1; ; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'ciac-scan-index/1 (+https://zyzythepizi.github.io/ciac/)' }, signal: AbortSignal.timeout(30000) })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      if (a >= 4) return null
      await sleep(400 * a * a)
    }
  }
}

/** Area-average a region of an RGB raster into a gw×gh luma grid. */
export function lumaGrid(rgb, w, x0, y0, x1, y1, gw, gh) {
  const out = new Float64Array(gw * gh)
  const cw = (x1 - x0) / gw, ch = (y1 - y0) / gh
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const sx = x0 + gx * cw, sy = y0 + gy * ch
      let sum = 0, n = 0
      for (let y = Math.floor(sy); y < Math.ceil(sy + ch); y++) {
        for (let x = Math.floor(sx); x < Math.ceil(sx + cw); x++) {
          const i = (y * w + x) * 3
          sum += 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2]; n++
        }
      }
      out[gy * gw + gx] = sum / n
    }
  }
  return out
}
function dhash(grid, gw, gh, bytes) {
  const out = new Uint8Array(bytes)
  let bit = 0
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw - 1; x++) {
    if (grid[y * gw + x] < grid[y * gw + x + 1]) out[bit >> 3] |= 1 << (bit & 7)
    bit++
  }
  return out
}
function meanRgb(rgb, w, x0, y0, x1, y1) {
  let r = 0, g = 0, b = 0, n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 3; r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2]; n++ }
  return [r / n, g / n, b / n].map(v => Math.round(v))
}
export function fingerprint(rgb) {
  const rec = new Uint8Array(REC)
  rec.set(dhash(lumaGrid(rgb, W, 10, 18, 118, 88, 17, 16), 17, 16, 32), 0)
  rec.set(dhash(lumaGrid(rgb, W, 0, 0, W, H, 9, 8), 9, 8, 8), 32)
  rec.set([...meanRgb(rgb, W, 10, 18, 118, 88), ...meanRgb(rgb, W, 0, 0, W, H)], 40)
  return rec
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const prevIds = existsSync(path.join(OUT, 'ids.json')) ? JSON.parse(await readFile(path.join(OUT, 'ids.json'), 'utf8')).ids : []
  const prevBin = existsSync(path.join(OUT, 'index.bin')) ? await readFile(path.join(OUT, 'index.bin')) : Buffer.alloc(0)
  const have = new Map(prevIds.map((id, i) => [id, prevBin.subarray(i * REC, (i + 1) * REC)]))

  const todo = []
  const all = []
  for (const lang of ['en', 'ja']) {
    const f = JSON.parse(await readFile(path.join(ROOT, 'catalog', 'v2', `cards-${lang}.json`), 'utf8'))
    const ci = Object.fromEntries(f.fields.map((n, i) => [n, i]))
    for (const r of f.rows) {
      const img = r[ci.image]
      if (!img || /^https?:/.test(img)) continue // only TCGdex images (Pokéllector's are large PNGs)
      all.push(r[ci.id])
      if (!have.has(r[ci.id])) todo.push({ id: r[ci.id], url: `${ASSETS}${img}/low.webp` })
    }
  }
  const work = LIMIT ? todo.slice(0, LIMIT) : todo
  console.log(`${all.length} cards with images, ${have.size} indexed, ${work.length} to fetch`)
  let next = 0, done = 0, failed = 0
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < work.length) {
      const job = work[next++]
      const buf = await fetchBuf(job.url)
      if (buf) {
        try {
          const { data } = await sharp(buf).resize(W, H, { fit: 'fill', kernel: 'cubic' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
          have.set(job.id, Buffer.from(fingerprint(data)))
        } catch { failed++ }
      } else failed++
      if (++done % 1000 === 0) console.log(`  ${done}/${work.length}`)
    }
  }))
  const ids = all.filter(id => have.has(id))
  const bin = Buffer.alloc(ids.length * REC)
  ids.forEach((id, i) => have.get(id).copy(bin, i * REC))
  await writeFile(path.join(OUT, 'index.bin'), bin)
  await writeFile(path.join(OUT, 'ids.json'), JSON.stringify({ version: 1, record: REC, raster: [W, H], count: ids.length, generatedAt: new Date().toISOString(), ids }))
  console.log(`index: ${ids.length} cards (${(bin.length / 1024).toFixed(0)} KB), ${failed} failed`)
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main().catch(e => { console.error(e); process.exit(1) })
