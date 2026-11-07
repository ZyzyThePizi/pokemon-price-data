// CIAC scanner, daily (scripts/scan_daily.py does the rest): lists the catalog cards the neural index doesn't
// know yet and downloads their pictures exactly as the index was built (CIAC tools/scan-train/fetch_catalog.mjs:
// sharp, 315 × 440 fill, JPEG 90), plus 50 cards the index already has, for the parity check.
//
// node scripts/scan-prep.mjs <tmpDir>   → <tmpDir>/<n>.jpg and <tmpDir>/list.json
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const OUT = process.argv[2] ?? '.scan-tmp'
const CAT = 'catalog/v2'
const SCAN = existsSync('scan/v3/ids.json') ? 'scan/v3' : 'scan/v2'
mkdirSync(OUT, { recursive: true })

let fallbacks = {}
try { fallbacks = JSON.parse(readFileSync(path.join(CAT, 'image-fallbacks.json'), 'utf8')).cards ?? {} } catch { /* none */ }
const cards = []
for (const lang of ['en', 'ja']) {
  const c = JSON.parse(readFileSync(path.join(CAT, `cards-${lang}.json`), 'utf8'))
  const f = Object.fromEntries(c.fields.map((n, i) => [n, i]))
  for (const r of c.rows) {
    const img = r[f.image] || fallbacks[r[f.id]]?.url
    if (!img) continue
    cards.push({ id: r[f.id], lang, set: r[f.setId], url: /^https?:/.test(img) ? img : `https://assets.tcgdex.net/${img}/high.webp` })
  }
}

// what the index knows: the base (English, then Japanese from jaFrom) and every daily chunk
const meta = JSON.parse(readFileSync(path.join(SCAN, 'ids.json'), 'utf8'))
const known = new Set(meta.ids.map((id, i) => `${i >= meta.jaFrom ? 'ja' : 'en'}:${id}`))
for (const ch of meta.chunks ?? []) ch.ids.forEach((id, i) => known.add(`${ch.langs[i] === 'j' ? 'ja' : 'en'}:${id}`))
const byKey = new Map(cards.map(c => [`${c.lang}:${c.id}`, c]))
const fresh = cards.filter(c => !known.has(`${c.lang}:${c.id}`))
// parity: every n-th base card that still has a picture, both languages
const parity = []
const step = Math.floor(meta.ids.length / 60)
for (let i = 7; i < meta.ids.length && parity.length < 50; i += step) {
  const c = byKey.get(`${i >= meta.jaFrom ? 'ja' : 'en'}:${meta.ids[i]}`)
  if (c) parity.push({ ...c, row: i })
}
console.log(`${SCAN}: ${known.size} cards known; catalog has ${cards.length} with pictures; ${fresh.length} new`)

async function get(c, file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(c.url, { headers: { 'user-agent': 'CIAC-scan-index (https://ciac-tcg.com)' }, signal: AbortSignal.timeout(30000) })
      if (!res.ok) throw new Error(String(res.status))
      await sharp(Buffer.from(await res.arrayBuffer())).resize(315, 440, { fit: 'fill' }).jpeg({ quality: 90 }).toFile(path.join(OUT, file))
      return true
    } catch { await new Promise(r => setTimeout(r, 800 * (attempt + 1))) }
  }
  return false
}

const jobs = [...parity.map(c => ({ c, kind: 'parity' })), ...fresh.map(c => ({ c, kind: 'new' }))]
const list = { scan: SCAN, parity: [], new: [], failed: [] }
let next = 0
await Promise.all(Array.from({ length: 12 }, async () => {
  while (next < jobs.length) {
    const n = next++, { c, kind } = jobs[n], file = `${n}.jpg`
    if (await get(c, file)) list[kind].push({ id: c.id, lang: c.lang, set: c.set, file, ...(c.row != null ? { row: c.row } : {}) })
    else if (kind === 'new') list.failed.push({ id: c.id, lang: c.lang, set: c.set })
  }
}))
// keep the catalog's order (English first, sets in order): the chunk reads the same on every run
const order = new Map(cards.map((c, i) => [`${c.lang}:${c.id}`, i]))
list.new.sort((a, b) => order.get(`${a.lang}:${a.id}`) - order.get(`${b.lang}:${b.id}`))
writeFileSync(path.join(OUT, 'list.json'), JSON.stringify(list))
console.log(`downloaded ${list.parity.length} parity + ${list.new.length} new; ${list.failed.length} failed`)
