// TCGplayer's daily market prices for every catalog card, the app's second price source (CIAC
// docs/decisions.md "Prices": a Cardmarket price and an other-source price on every card, each with its badge).
// Source: tcgcsv.com, TCGplayer's own price data mirrored daily (USD; English category 3, Japanese 85).
//
//   prices/tcgplayer-map.json  { at, cards: { cardId: [groupId, productId] } }   rebuilt weekly (or --remap):
//                              set → group and number + name, as the TCGplayer pictures (lib/tcgplayer-images.mjs)
//   prices/tcgplayer.json      { generatedAt, source, currency: 'USD', fields: [id, sub, market, low, product], rows }
//                              product: TCGplayer's product id (the app links tcgplayer.com/product/<id>)
//                              sub: n normal, h holofoil, r reverse holofoil, 1n / 1h first edition, else TCGplayer's name
//
// A check against Cardmarket goes to the log and the file's `check`: the median of TCGplayer market ÷ the
// Cardmarket trend (in USD) over cards that have both, and how many differ more than 5× (a wrong pair).
// Run: node scripts/tcgplayer-prices.mjs [--remap]   (about 1 request a second; ~10 minutes a day)
import { readFile, writeFile } from 'node:fs/promises'
import { mapToTcgplayer, tcgplayerPrices } from './lib/tcgplayer-images.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const MAP = `${ROOT}/prices/tcgplayer-map.json`
const OUT = `${ROOT}/prices/tcgplayer.json`
const WEEK = 7 * 864e5
const SUB = { Normal: 'n', Unlimited: 'n', Holofoil: 'h', 'Unlimited Holofoil': 'h', 'Reverse Holofoil': 'r',
  '1st Edition': '1n', '1st Edition Normal': '1n', '1st Edition Holofoil': '1h' }
const r2 = (x) => (Number.isFinite(x) && x > 0 ? Math.round(x * 100) / 100 : null)

const readJson = async (p, fallback) => { try { return JSON.parse(await readFile(p, 'utf8')) } catch { return fallback } }

async function buildMap() {
  const sets = await readJson(`${ROOT}/catalog/v2/sets.json`)
  const sf = Object.fromEntries(sets.fields.map((n, i) => [n, i]))
  const setName = new Map(sets.rows.map(r => [r[sf.id], r[sf.nameEn] || r[sf.name]]))
  const setAbbr = new Map(sets.rows.map(r => [r[sf.id], r[sf.abbr]]))
  const cards = {}
  for (const lang of ['en', 'ja']) {
    const { rows } = await readJson(`${ROOT}/catalog/v2/cards-${lang}.json`)
    const m = await mapToTcgplayer(lang, rows, { setName: id => setName.get(id) ?? null, setAbbr: id => setAbbr.get(id) ?? null, root: ROOT })
    for (const [id, v] of m) cards[id] = lang === 'ja' ? [...v, 'ja'] : v
    console.log(`map ${lang}: ${m.size} of ${rows.length} cards`)
  }
  const map = { at: Date.now(), cards }
  await writeFile(MAP, JSON.stringify(map))
  return map
}

let map = await readJson(MAP, null)
if (!map || process.argv.includes('--remap') || Date.now() - map.at > WEEK) map = await buildMap()

// products → cards (a Japanese product can be two cards: TCGdex keeps some Japanese sets twice)
const byGroup = new Map() // "lang:group" → Map(productId → [cardId])
for (const [id, [g, p, lang = 'en']] of Object.entries(map.cards)) {
  const k = `${lang}:${g}`
  if (!byGroup.has(k)) byGroup.set(k, new Map())
  const m = byGroup.get(k)
  m.set(p, [...(m.get(p) ?? []), id])
}
const rows = []
let groupsOk = 0
for (const [k, products] of byGroup) {
  const [lang, g] = k.split(':')
  let prices
  try { prices = await tcgplayerPrices(lang, Number(g)) } catch (e) { console.warn(`prices ${k}: ${e.message}`); continue }
  groupsOk++
  for (const p of prices) {
    const ids = products.get(p.productId)
    const market = r2(p.marketPrice), low = r2(p.lowPrice)
    if (!ids || (market == null && low == null)) continue
    for (const id of ids) rows.push([id, SUB[p.subTypeName] ?? String(p.subTypeName || '').toLowerCase(), market, low, p.productId])
  }
}
if (groupsOk * 2 < byGroup.size) throw new Error(`only ${groupsOk} of ${byGroup.size} groups answered: keeping yesterday's file`)
rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))

// the check against Cardmarket: a card's main print (normal, else holofoil) against its main product's trend
const check = await (async () => {
  const guide = await readJson(`${ROOT}/prices/latest.json`, null)
  if (!guide) return null
  const gi = guide.fields.indexOf('trend'), trend = new Map(guide.rows.map(r => [r[0], r[gi]]))
  const usd = 1.08 // EUR → USD, a rough rate: only the spread matters here
  const main = new Map()
  for (const lang of ['en', 'ja']) {
    const { fields, rows: cs } = await readJson(`${ROOT}/catalog/v2/cards-${lang}.json`)
    const vi = fields.indexOf('variants')
    for (const r of cs) { const v = (r[vi] ?? []).find(x => x[1]); if (v) main.set(r[0], v[1]) }
  }
  // a card's normal print, else its holofoil (as the app shows it)
  const pick = new Map()
  for (const [id, sub, market] of rows) {
    if (market == null || !(sub === 'n' || sub === 'h') || (pick.has(id) && pick.get(id)[0] === 'n')) continue
    pick.set(id, [sub, market])
  }
  const ratios = []
  for (const [id, [, market]] of pick) {
    const t = trend.get(main.get(id))
    if (market < 1 || !t || t < 1) continue
    ratios.push(market / (t * usd))
  }
  ratios.sort((a, b) => a - b)
  const median = ratios.length ? Math.round(ratios[ratios.length >> 1] * 100) / 100 : null
  return { cards: ratios.length, median, over5x: ratios.filter(x => x > 5 || x < 0.2).length }
})()

const cardsPriced = new Set(rows.map(r => r[0])).size
await writeFile(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(), source: 'TCGplayer market price (tcgcsv.com)', currency: 'USD',
  fields: ['id', 'sub', 'market', 'low', 'product'], count: rows.length, cards: cardsPriced, check, rows,
}))
console.log(`tcgplayer: ${rows.length} prices, ${cardsPriced} cards, ${groupsOk} groups; check vs Cardmarket`, check)
