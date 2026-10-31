// Card images from TCGplayer's catalog, for the cards no other source has (the last step of
// image-fallbacks.mjs). The catalog is read from tcgcsv.com, a free daily mirror of TCGplayer's API:
//   https://tcgcsv.com/tcgplayer/<category>/groups               every set ("group") of a category
//   https://tcgcsv.com/tcgplayer/<category>/<groupId>/products   every product of a set, with its image
// Category 3 is Pokémon (English), 85 Pokémon Japan. Images are on TCGplayer's CDN
// (tcgplayer-cdn.tcgplayer.com/product/<productId>_400w.jpg, also _200w; no CORS header).
//
// Requests: the two group lists, then one product list per set that still has gaps, at most once a
// week per set (the result is cached in image-fallbacks.json), one request at a time with a pause.
// That is about 70 requests a week today, nothing near a load tcgcsv asks people to avoid.
//
// A card is matched to a product by its number (TCGdex "051" = TCGplayer "051/182"); English cards
// with no usable number by name; old Japanese sets, which TCGplayer lists without numbers, by the
// Pokémon's Pokédex number when that Pokémon is on one card only in the set.
import { readFile } from 'node:fs/promises'

const TCGCSV = 'https://tcgcsv.com/tcgplayer'
const CDN = 'https://tcgplayer-cdn.tcgplayer.com/product/'
const CATEGORY = { en: 3, ja: 85 }
const WEEK = 7 * 864e5
const PAUSE_MS = 1000
// tcgcsv asks for an "App/X.Y.Z" User-Agent and blocks generic ones
const UA = 'CIAC-Catalog/2.0.0 (+https://github.com/ZyzyThePizi/pokemon-price-data)'

// TCGdex set → TCGplayer group(s), where the names don't line up. Trainer kits are one TCGplayer
// group for both decks of a kit.
const GROUPS = {
  en: {
    'tk-ex-latia': [1543], 'tk-ex-latio': [1543], 'tk-ex-p': [1542], 'tk-ex-m': [1542],
    'tk-dp-m': [1541], 'tk-dp-l': [1541], 'tk-hs-r': [1540], 'tk-hs-g': [1540],
    'tk-bw-e': [1538], 'tk-bw-z': [1538], 'tk-xy-sy': [1532], 'tk-xy-n': [1532],
    'tk-xy-b': [1533], 'tk-xy-w': [1533], 'tk-xy-latia': [1536], 'tk-xy-latio': [1536],
    'tk-xy-su': [1796], 'tk-xy-p': [1796], 'tk-sm-l': [2069], 'tk-sm-r': [2069],
    '2011bw': [1401], '2012bw': [1427], '2014xy': [1692], '2015xy': [1694], '2016xy': [3087],
    '2017sm': [2148], '2018sm': [2364], '2019sm': [2555], '2023sv': [23306], '2024sv': [24163],
    exu: [1398], cel25cc: [2931], mfb: [23330],
    swshp: [2545], svp: [22872], hgssp: [1453], mep: [24451],
  },
  ja: {
    // groups are tried one after another: the base set's second group is its print without rarity marks
    PMCG1: [23721, 23740], PMCG2: [23722], PMCG3: [23723], PMCG4: [23724], PMCG5: [23725], PMCG6: [23726],
    VS1: [24180], web1: [24141],
    E1: [23730], E2: [23731], E3: [23732], E4: [23733], E5: [23734],
    PCG1: [24117], PCG2: [24114], PCG3: [24135], PCG4: [24103], PCG5: [24101], PCG6: [24085],
    PCG7: [24084], PCG8: [24099], PCG9: [24090], neo4: [23729],
    MC: [24567],
  },
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let lastRequest = 0
async function getJson(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const wait = lastRequest + PAUSE_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequest = Date.now()
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': UA } })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      if (attempt === 4) { console.warn(`  tcgplayer: ${url}: ${err.message}`); return null }
      await sleep(2000 * attempt)
    }
  }
}

/** "Pokémon Collector", "Nidoran♂" → "pokemoncollector", "nidoranm" */
const simple = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/♂/g, 'm').replace(/♀/g, 'f').toLowerCase().replace(/[^a-z0-9]+/g, '')
const codeOf = (s) => simple(String(s ?? '').replace(/\+/g, 'p'))
/** "051/182" → "51", "SWSH074" → "SWSH74", "TG01/TG30" → "TG1" */
const decode = (s) => { try { return decodeURIComponent(s) } catch { return s } }
const numKey = (s) => decode(String(s ?? '')).toUpperCase().split('/')[0].trim().replace(/^([A-Z]*)0*(\d)/, '$1$2')
const digits = (s) => (/\d+/.exec(String(s ?? ''))?.[0] ?? '').replace(/^0+(?=\d)/, '')
/** "Alolan Exeggutor - 002/103" / "Switch (Sylveon)" → "alolanexeggutor" / "switch" */
const baseName = (s) => simple(String(s ?? '').replace(/\s+-\s+[A-Z]*\d+(\/[A-Z]*\d+)?\s*$/i, '').replace(/\([^)]*\)|\[[^\]]*\]/g, ''))
const paren = (s) => /\(([^)]*)\)/.exec(String(s ?? ''))?.[1] ?? null


/**
 * The Pokédex number an English card name is about ("Brock's Onix" → 95, "Nidoran M" → 32), by whole
 * words, so "Dark Raichu" is Raichu and not Darkrai. null for trainers and energies.
 */
export async function pokedexByName(root) {
  const words = (s) => ` ${String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/♂/g, ' m').replace(/♀/g, ' f').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `
  let list = []
  try {
    const p = JSON.parse(await readFile(`${root}/catalog/pokedex-v2.json`, 'utf8'))
    // rows: [id, dex, slug, English name, …, kind, …]; base forms only
    list = p.rows.filter(r => r[5] === 'base').map(r => [words(r[3]), r[1]]).filter(([n]) => n.length >= 5)
      .sort((a, b) => b[0].length - a[0].length)
  } catch { /* no Pokédex: no Pokédex matching */ }
  return (name) => {
    const s = words(name)
    for (const [n, dex] of list) if (s.includes(n)) return dex
    return null
  }
}
/** A TCGdex card's Pokédex number (its first; Rayquaza δ is 384.1 → 384) */
export const cardDex = (r) => (r[7]?.length ? Math.floor(r[7][0]) : null)
const counts = (xs) => { const m = new Map(); for (const x of xs) if (x != null) m.set(x, (m.get(x) ?? 0) + 1); return m }

/** Whether TCGplayer's CDN has a real picture there (a missing one answers 403 with XML) */
async function servesImage(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000), headers: { 'user-agent': UA } })
    return res.ok && /^image\//.test(res.headers.get('content-type') ?? '') && Number(res.headers.get('content-length') ?? 1e4) > 5000
  } catch { return false }
}

function productsOf(json, { imageless = false } = {}) {
  const out = []
  for (const p of json?.results ?? []) {
    const ext = Object.fromEntries((p.extendedData ?? []).map(e => [e.name, e.value]))
    // imageless: only the products TCGplayer says have no picture (often wrong: 2019 McDonald's Onix has one)
    if (!p.imageCount !== imageless) continue
    if (!ext.Number && !ext.Rarity) continue // sealed product, not a card
    out.push({ id: p.productId, name: p.name, number: ext.Number ?? null })
  }
  return out
}

/** Matches `missing` cards of one set against one TCGplayer group's products; returns [row, product] pairs. */
function match(lang, missing, products, setName, dexOf) {
  const sName = simple(setName)
  const score = (p, r) => (lang === 'en' && baseName(p.name) === baseName(r[3]) ? 4 : 0)
    + (paren(p.name) && sName.includes(simple(paren(p.name))) ? 2 : 0) + (paren(p.name) ? 0 : 1)
  // A product is only taken when it is the same card: English names must agree (two decks of a trainer
  // kit share numbers), and a Japanese card's Pokémon must not contradict the product's.
  const fits = (p, r) => {
    if (lang === 'en') return baseName(p.name) === baseName(r[3])
    const a = dexOf(p.name), all = (r[7] ?? []).map(Math.floor)
    return a == null || !all.length || all.includes(a) // LEGEND halves show two Pokémon
  }
  // Pokédex numbers on exactly one card of the set / one unnumbered product of the group
  const setDex = counts(missing.map(cardDex))
  const prodDex = new Map(products.filter(p => !p.number).map(p => [p, dexOf(p.name)]))
  const groupDex = counts([...prodDex.values()])
  const out = []
  for (const r of missing) {
    let cands = products.filter(p => p.number && numKey(p.number) === numKey(r[2]))
    if (!cands.length && /^\d+$/.test(r[2])) {
      const d = products.filter(p => p.number && digits(p.number) === digits(r[2]))
      if (d.length === 1) cands = d
    }
    const numbered = cands.length > 0
    cands = cands.filter(p => fits(p, r))
    // no product with this number at all (sets TCGplayer numbers differently): by name / Pokédex number
    if (!numbered && lang === 'en') cands = products.filter(p => fits(p, r))
    if (!numbered && lang === 'ja') {
      const dex = cardDex(r)
      if (dex != null && setDex.get(dex) === 1 && groupDex.get(dex) === 1) cands = products.filter(p => prodDex.get(p) === dex)
    }
    if (!cands.length) continue
    cands.sort((a, b) => (score(b, r) - score(a, r)) || (a.id - b.id))
    // by name alone, one product must clearly win (not "Unown (!)" for every Unown)
    if (!numbered && cands.length > 1 && score(cands[0], r) === score(cands[1], r)) continue
    out.push([r, cands[0]])
  }
  return out
}

/**
 * Fills `rows` (cards still without an image, raw TCGdex set ids) from TCGplayer, in place.
 * `cache` is image-fallbacks.json's object; `setName(setId)` gives TCGdex's set name.
 */
export async function fillFromTcgplayer(lang, rows, cache, { setName = () => null, root = '.' } = {}) {
  const now = Date.now()
  cache.tcgplayer ??= {}
  let filled = 0
  const todo = []
  for (const r of rows) {
    const known = cache.cards[r[0]]
    if (known?.url?.startsWith(CDN)) { r[11] = known.url; filled++ } else todo.push(r)
  }
  const bySet = new Map()
  for (const r of todo) {
    if (now - (cache.tcgplayer[`${lang}:${r[1]}`]?.at ?? 0) < WEEK) continue
    if (!bySet.has(r[1])) bySet.set(r[1], [])
    bySet.get(r[1]).push(r)
  }
  if (!bySet.size) return { filled }

  const groups = (await getJson(`${TCGCSV}/${CATEGORY[lang]}/groups`))?.results ?? []
  if (!groups.length) return { filled }
  const dexOf = lang === 'ja' ? await pokedexByName(root) : () => null

  for (const [setId, missing] of bySet) {
    const key = `${lang}:${setId}`
    let ids = GROUPS[lang][setId]
    if (!ids) {
      const name = simple(setName(setId))
      ids = groups.filter(g => (lang === 'ja' ? codeOf(g.abbreviation) === codeOf(setId)
        : name && simple(String(g.name).replace(/^[^:]+:\s*/, '')) === name)).map(g => g.groupId)
    }
    let n = 0
    for (const g of ids) {
      const left = missing.filter(r => !r[11])
      if (!left.length) break
      const json = await getJson(`${TCGCSV}/${CATEGORY[lang]}/${g}/products`)
      for (const [r, p] of match(lang, left, productsOf(json), setName(setId), dexOf)) {
        const url = `${CDN}${p.id}_400w.jpg`
        r[11] = url
        cache.cards[r[0]] = { url, at: now }
        filled++; n++
      }
      // then the products marked without a picture, taken only when the CDN serves one
      const still = left.filter(r => !r[11])
      if (still.length) for (const [r, p] of match(lang, still, productsOf(json, { imageless: true }), setName(setId), dexOf)) {
        const url = `${CDN}${p.id}_400w.jpg`
        if (!await servesImage(url)) continue
        r[11] = url
        cache.cards[r[0]] = { url, at: now }
        filled++; n++
      }
    }
    cache.tcgplayer[key] = { groups: ids, matched: n, of: missing.length, at: now }
  }
  return { filled }
}

/**
 * TCGplayer's English names of the products behind cards' TCGplayer pictures, kept in the cache
 * (`cache.tcgplayerNames`: productId → name) for matching Japanese cards to Cardmarket, which names
 * them in English (ja-english-names.mjs). Names don't change: each set's product list is asked for once.
 */
export async function rememberTcgplayerNames(lang, rows, cache) {
  cache.tcgplayerNames ??= {}
  const names = cache.tcgplayerNames
  const want = new Map() // set → product ids without a name
  for (const r of rows) {
    const m = /tcgplayer\.com\/product\/(\d+)_/.exec(r[11] ?? '')
    if (!m || names[m[1]]) continue
    if (!want.has(r[1])) want.set(r[1], new Set())
    want.get(r[1]).add(m[1])
  }
  let added = 0
  for (const [setId] of want) {
    for (const g of cache.tcgplayer?.[`${lang}:${setId}`]?.groups ?? []) {
      const json = await getJson(`${TCGCSV}/${CATEGORY[lang]}/${g}/products`)
      for (const p of json?.results ?? []) if (!names[p.productId]) { names[p.productId] = p.name; added++ }
    }
  }
  return added
}

/**
 * Every card of `rows` (one language) paired with its TCGplayer product, for prices (tcgplayer-prices.mjs):
 * the same set → group(s) and number + name matching as the pictures, on every card, products without a
 * picture included. Returns Map(cardId → [groupId, productId]).
 */
/** A set name as TCGplayer's and TCGdex's agree on: no "SM - " / "SWSH01: " code, no "Base Set", & = and */
const looseSetName = (s) => simple(String(s ?? '').toLowerCase().replace(/&/g, ' and ')
  .replace(/^[a-z]{1,5}\d*(\.\d+)?\s*(:|\s-)\s*/, '')
  .replace(/\bbase set\b/, '').replace(/\b(black star )?promo(s| cards)?\b/, 'promos').replace(/^ex\s+/, '').replace(/^pokemon\s+/, ''))
// for prices only (the pictures keep their own): sets whose TCGplayer group no name rule finds (2026-10-28)
const PRICE_GROUPS = {
  en: { basep: [1418], dpp: [1421], bwp: [1407], sm1: [1863], ru1: [1433], bog: [1455], '2021swsh': [2782],
    '2022swsh': [3150], '30th-c': [24837], miscp: [2374], xya: [1938] },
  // TCGplayer's codes differ (XY5-Bg for XY5a) or the group has none (the neo and ADV sets)
  ja: { XY5a: [23921], XY5b: [23922], XY8a: [23925], XY8b: [23926], XY1a: [23914], XY1b: [23915], XY11a: [23916],
    XY11b: [23917], L1a: [24025], L1b: [24026], 'ja-neo1': [23727], 'ja-neo2': [23728], 'ja-neo3': [23720],
    'ja-neo4': [23729], ADV1: [24129], ADV2: [24139], ADV3: [24128], ADV4: [24124], ADV5: [24119], PCG10: [24053], SVLS: [23793] },
}

export async function mapToTcgplayer(lang, rows, { setName = () => null, setAbbr = () => null, root = '.' } = {}) {
  const groups = (await getJson(`${TCGCSV}/${CATEGORY[lang]}/groups`))?.results ?? []
  if (!groups.length) throw new Error(`no TCGplayer groups for ${lang}`)
  const dexOf = lang === 'ja' ? await pokedexByName(root) : () => null
  const bySet = new Map()
  for (const r of rows) bySet.set(r[1], [...(bySet.get(r[1]) ?? []), r])
  const products = new Map() // groupId → products
  const out = new Map()
  for (const [setId, cards] of bySet) {
    let ids = GROUPS[lang][setId] ?? PRICE_GROUPS[lang]?.[setId]
    if (!ids) {
      const name = simple(setName(setId))
      ids = groups.filter(g => (lang === 'ja' ? codeOf(g.abbreviation) === codeOf(setId)
        : name && simple(String(g.name).replace(/^[^:]+:\s*/, '')) === name)).map(g => g.groupId)
      // TCGplayer's own naming ("SM - Cosmic Eclipse", "SWSH01: Sword & Shield Base Set"), then the set code ("MEW")
      if (!ids.length && lang === 'en') {
        const want = looseSetName(setName(setId))
        ids = want ? groups.filter(g => looseSetName(g.name) === want).map(g => g.groupId) : []
        const abbr = simple(setAbbr(setId))
        if (!ids.length && abbr) ids = groups.filter(g => simple(g.abbreviation) === abbr).map(g => g.groupId)
        if (ids.length > 1) ids = []
      }
    }
    for (const g of ids) {
      const left = cards.filter(r => !out.has(r[0]))
      if (!left.length) break
      if (!products.has(g)) {
        const json = await getJson(`${TCGCSV}/${CATEGORY[lang]}/${g}/products`)
        products.set(g, (json?.results ?? []).flatMap(p => {
          const ext = Object.fromEntries((p.extendedData ?? []).map(e => [e.name, e.value]))
          return ext.Number || ext.Rarity ? [{ id: p.productId, name: p.name, number: ext.Number ?? null }] : []
        }))
      }
      // a product goes to one card only (a trainer kit's two decks share a group); Japanese: within the set,
      // since TCGdex keeps some Japanese sets twice (SM4+ and SM4p, sm2+ and SM2p) and both copies want it
      const mine = new Set(cards.map(c => c[0]))
      const used = new Set([...out].filter(([id]) => lang !== 'ja' || mine.has(id)).map(([, v]) => v[1]))
      for (const [r, p] of match(lang, left, products.get(g).filter(p => !used.has(p.id)), setName(setId), dexOf)) {
        if (used.has(p.id)) continue
        used.add(p.id)
        out.set(r[0], [g, p.id])
      }
    }
  }
  return out
}

/** One TCGplayer group's prices: [{ productId, subTypeName, marketPrice, lowPrice, midPrice }] */
export async function tcgplayerPrices(lang, groupId) {
  return (await getJson(`${TCGCSV}/${CATEGORY[lang]}/${groupId}/prices`))?.results ?? []
}
