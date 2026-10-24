// Pictures for Cardmarket's sealed products (prices/products.json, every category but 51 singles).
// Cardmarket's own product pictures refuse requests from outside its site, so each product is paired by
// name (scripts/lib/sealed-match.mjs) with the same product on:
//   1. TCGplayer, read from tcgcsv.com (a free daily mirror of TCGplayer's catalog; the same source as
//      scripts/lib/tcgplayer-images.mjs): categories 3 (Pokémon) and 85 (Pokémon Japan). A sealed product is
//      one without a card number or rarity. Picture: tcgplayer-cdn.tcgplayer.com/product/<id>_400w.jpg.
//   2. PriceCharting, for what TCGplayer doesn't list (most Japanese and Chinese products): one page per
//      set ("console"), its rows without a card number. Picture: storage.googleapis.com/images.pricecharting.com/<key>/240.jpg
//      (also 60 and 1600).
//
// Output: catalog/v2/sealed-images.json  { generatedAt, fields: [idProduct, image, source], rows }
// Cache:  catalog/v2/sealed-sources.json what each source listed, per TCGplayer group / PriceCharting set
//
// Requests, one at a time with a pause: TCGplayer's two group lists and the groups not read for a week
// (sets from the last year) or two months (older); PriceCharting's set list weekly and at most 120 set pages
// a run, the longest unread first (all of them on the first run, about 20 minutes).
//
// Run: node scripts/build-sealed-images.mjs [--offline]   (--offline: match from the cache only)
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { matchSealedAll } from './lib/sealed-match.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const OUT = path.join(ROOT, 'catalog', 'v2')
const OFFLINE = process.argv.includes('--offline')
const DAY = 864e5
const UA = 'CIAC-Catalog/2.0.0 (+https://github.com/ZyzyThePizi/pokemon-price-data)'
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const TCGCSV = 'https://tcgcsv.com/tcgplayer'
const TCG_CDN = 'https://tcgplayer-cdn.tcgplayer.com/product/'
const PC = 'https://www.pricecharting.com'
const PC_PAGES_PER_RUN = Number(process.env.PC_PAGES || 120)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const readJson = async (f) => { try { return JSON.parse(await readFile(f, 'utf8')) } catch { return null } }

let last = 0
async function get(url, { json = true, ua = UA, pause = 600 } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wait = last + pause - Date.now()
    if (wait > 0) await sleep(wait)
    last = Date.now()
    try {
      const res = await fetch(url, { headers: { 'user-agent': ua }, signal: AbortSignal.timeout(30000) })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return json ? await res.json() : await res.text()
    } catch (err) {
      if (attempt === 3) { console.warn(`  ${url}: ${err.message}`); return undefined }
      await sleep(3000 * attempt)
    }
  }
}

/** TCGplayer: every sealed product of both Pokémon categories, from the cache where it is fresh enough. */
async function tcgplayer(cache) {
  cache.groups ??= {}
  if (OFFLINE) return
  let read = 0
  for (const [lang, cat] of [['en', 3], ['ja', 85]]) {
    const list = await get(`${TCGCSV}/${cat}/groups`)
    if (!list?.results) { console.warn(`  tcgplayer: no group list for ${lang}`); continue }
    for (const g of list.results) {
      const c = cache.groups[g.groupId]
      const recent = g.publishedOn && Date.now() - Date.parse(g.publishedOn) < 400 * DAY
      if (c && Date.now() - c.at < (recent ? 7 : 60) * DAY) { c.name = g.name; continue }
      const p = await get(`${TCGCSV}/${cat}/${g.groupId}/products`, { pause: 400 })
      if (p === undefined) continue // network: keep what we had
      const items = []
      for (const x of p?.results ?? []) {
        const ext = Object.fromEntries((x.extendedData ?? []).map(e => [e.name, e.value]))
        if (ext.Number || ext.Rarity || !x.imageCount) continue
        items.push([x.productId, x.name])
      }
      cache.groups[g.groupId] = { at: Date.now(), lang, name: g.name, items }
      read++
    }
  }
  console.log(`  tcgplayer: ${read} groups read, ${Object.keys(cache.groups).length} cached`)
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()

/** PriceCharting: the sealed rows of every Pokémon set page, a few pages a run. */
async function pricecharting(cache) {
  cache.consoles ??= {}
  if (OFFLINE) return
  if (!cache.listAt || Date.now() - cache.listAt > 7 * DAY) {
    const html = await get(`${PC}/category/pokemon-cards`, { json: false, ua: BROWSER, pause: 1500 })
    if (html) {
      const slugs = new Map()
      for (const m of html.matchAll(/href="\/console\/(pokemon-[a-z0-9-]+)"[^>]*>([^<]+)</g)) slugs.set(m[1], decode(m[2]))
      for (const [slug, name] of slugs) cache.consoles[slug] ??= { at: 0, name, items: [] }
      if (slugs.size) cache.listAt = Date.now()
      console.log(`  pricecharting: ${slugs.size} sets listed`)
    }
  }
  const due = Object.entries(cache.consoles).filter(([, c]) => Date.now() - c.at > 30 * DAY).sort((a, b) => a[1].at - b[1].at)
  let read = 0
  for (const [slug, c] of due.slice(0, PC_PAGES_PER_RUN)) {
    const html = await get(`${PC}/console/${slug}`, { json: false, ua: BROWSER, pause: 1500 })
    if (html === undefined) continue
    const items = []
    for (const row of (html ?? '').split('<tr id="product-').slice(1)) {
      const img = /src="(https:\/\/storage\.googleapis\.com\/images\.pricecharting\.com\/[^"]+?)\/60\.jpg"/.exec(row)?.[1]
      const title = /<td class="title"[\s\S]*?<a [^>]*>([\s\S]*?)<\/a>/.exec(row)?.[1]
      if (!img || !title || /#\s*\w/.test(title)) continue // a card ("Pikachu #25"), or no picture
      items.push([decode(title), img])
    }
    cache.consoles[slug] = { ...c, at: Date.now(), items }
    read++
  }
  console.log(`  pricecharting: ${read} set pages read, ${due.length - read} still due`)
}

/** "pokemon-japanese-mask-of-change" / "Pokemon Japanese Mask of Change" → "Mask of Change" */
const consoleSet = (name) => String(name).replace(/^Pokemon\s+(Japanese|Chinese|Korean|German|French|Italian|Spanish|Portuguese)?\s*/i, '')

async function main() {
  const products = await readJson(path.join(ROOT, 'prices', 'products.json'))
  if (!products) throw new Error('prices/products.json missing')
  const f = Object.fromEntries(products.fields.map((k, i) => [k, i]))
  // Live Code Cards are a code, not a box
  const cm = products.rows.filter(r => r[f.idCategory] !== 51 && !/live code/i.test(r[f.name])).map(r => [r[f.idProduct], r[f.name]])

  const cacheFile = path.join(OUT, 'sealed-sources.json')
  const cache = (await readJson(cacheFile)) ?? {}
  cache.tcgplayer ??= {}
  cache.pricecharting ??= {}
  await tcgplayer(cache.tcgplayer)
  await pricecharting(cache.pricecharting)
  await writeFile(cacheFile, JSON.stringify(cache))

  const tcg = Object.values(cache.tcgplayer.groups ?? {}).flatMap(g => g.items.map(([id, name]) => [id, name, g.name]))
  const byTcg = matchSealedAll(cm, tcg)
  const pcItems = Object.values(cache.pricecharting.consoles ?? {}).flatMap(c => c.items.map(([title, img]) => [img, title, consoleSet(c.name)]))
  const left = cm.filter(([id]) => !byTcg.has(id))
  const byPc = matchSealedAll(left, pcItems)

  const rows = []
  for (const [id] of cm) {
    if (byTcg.has(id)) rows.push([id, `${TCG_CDN}${byTcg.get(id)}_400w.jpg`, 'tcgplayer'])
    else if (byPc.has(id)) rows.push([id, `${byPc.get(id)}/240.jpg`, 'pricecharting'])
  }
  const outFile = path.join(OUT, 'sealed-images.json')
  const prev = await readJson(outFile)
  const same = prev && JSON.stringify(prev.rows) === JSON.stringify(rows)
  await writeFile(outFile, JSON.stringify({ generatedAt: same ? prev.generatedAt : new Date().toISOString(), fields: ['idProduct', 'image', 'source'], rows }))
  console.log(`sealed images: ${rows.length} of ${cm.length} sealed products (TCGplayer ${byTcg.size}, PriceCharting ${byPc.size})${same ? ', unchanged' : ''}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
