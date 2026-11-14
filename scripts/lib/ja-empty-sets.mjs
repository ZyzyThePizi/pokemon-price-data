// Cards for the Japanese sets TCGdex lists with no cards (53 on 2026-10-28: ADV1–5, PCG10, the LEGEND sets,
// most of XY, SM1+–SM5+, most of the early Sword & Shield sets). Without them those sets show empty.
//
// Sources, compared on 2026-10-28 (docs/dev/relay.md "Japanese sets TCGdex has no cards for"):
//   TCGplayer via tcgcsv.com  every set, every number including the top secret rares; English names, rarity,
//                             HP, type, stage, a picture. The card list: one row per number it lists.
//   Limitless TCG             42 of the sets (not ADV, PCG10, LEGEND); Japanese names, type, stage, rarity
//                             (often blank), a picture; it stops before the top secret rares.
//   Pokéllector JP            44 of the sets, English names: agreed with TCGplayer on every number. It is
//                             the cross-check (tests), not a source here.
// A Limitless card is used for a TCGplayer number only when both name the same Pokémon (by Pokédex number,
// from the Japanese and the English name), and a set's Limitless names only when at most 1 in 50 disagree.
//
// What each source answered is cached in catalog/v2/ja-empty-sets.json and asked again after 30 days, so a
// build makes no request most days (2 per set when it does: ~100 a month, 1.2 s apart).
import { readFile, writeFile } from 'node:fs/promises'
import { pokedexByName } from './tcgplayer-images.mjs'

const UA = 'CIAC-Catalog/2.0.0 (+https://github.com/ZyzyThePizi/pokemon-price-data)'
const MONTH = 30 * 864e5
const PAUSE_MS = 1200
const TCGCSV = 'https://tcgcsv.com/tcgplayer/85'
const LIMITLESS = 'https://limitlesstcg.com/cards/jp'

// TCGdex set id → TCGplayer group, where its abbreviation isn't the set id (or two groups have it)
export const TCGPLAYER_GROUP = {
  ADV1: 24129, ADV2: 24139, ADV3: 24128, ADV4: 24124, ADV5: 24119, PCG10: 24053,
  L1a: 24025, L1b: 24026, L2: 24021, LL: 24022, L3: 24024,
  XY1a: 23914, XY1b: 23915, XY5a: 23921, XY5b: 23922, XY8a: 23925, XY8b: 23926, XY11a: 23916, XY11b: 23917,
  'SM1+': 23880, // 23692 "SM1+: Sun & Moon" holds the booster box only
}
// TCGdex set id → Limitless code, where they differ; null: Limitless has no such set
export const LIMITLESS_CODE = {
  'SM1+': 'SM1p', 'sm2+': 'SM2p', 'SM3+': 'SM3p', 'SM4+': 'SM4p', 'SM5+': 'SM5p',
  XY1a: 'XY1x', XY1b: 'XY1y', XY5a: 'XY5g', XY5b: 'XY5t', XY8a: 'XY8b', XY8b: 'XY8r', XY11a: 'XY11b', XY11b: 'XY11r',
  ADV1: null, ADV2: null, ADV3: null, ADV4: null, ADV5: null, PCG10: null, L1a: null, L1b: null, L2: null, LL: null, L3: null,
}
// Sets printed in both a 1st Edition and an unlimited run: every card gets both prints. (The 1st-Edition-only
// sets are in set-marks.mjs; PCG10 follows PCG1–9, which TCGdex gives both.)
const BOTH_RUNS = new Set(['ADV1', 'ADV2', 'ADV3', 'ADV4', 'ADV5', 'PCG10', 'XY1a', 'XY1b', 'XY5a', 'XY5b', 'XY6', 'XY7'])
const OLD_ERA = /^(ADV|PCG|L)/ // a plain Rare is not holo before XY

// rarity words as TCGdex writes them for Japanese cards (matched on 10 sets both list, 2026-10-28)
const RARITY = {
  common: 'Common', uncommon: 'Uncommon', rare: 'Rare', 'holo rare': 'Holo Rare', 'rare holo': 'Holo Rare',
  'double rare': 'Double rare', 'triple rare': 'Triple Rare', 'super rare': 'Ultra Rare', 'hyper rare': 'Hyper rare',
  'ultra rare': 'Secret Rare', 'secret rare': 'Secret Rare', 'shiny rare': 'Ultra Rare', 'shiny secret rare': 'Ultra Rare',
  'shiny ultra rare': 'Ultra Rare', kagayaku: 'Radiant Rare', 'radiant rare': 'Radiant Rare', 'amazing rare': 'Amazing Rare',
  'prism rare': 'Holo Rare', shining: 'Holo Rare', 'rare holo legend': 'LEGEND', 'super rare holo': 'Ultra Rare',
  'art rare': 'Illustration rare', 'special art rare': 'Special illustration rare',
  'character rare': 'Character Rare', 'character super rare': 'Character Super Rare',
}
// TCGplayer's word for a rarity it knows as one; Limitless's "Secret Rare" lumps SR, HR and UR, so it comes second
const LIMITLESS_ONLY = new Set(['Ultra Rare']) // Limitless's "Ultra Rare" is not TCGplayer's
const TYPE = { G: 'Grass', R: 'Fire', W: 'Water', L: 'Lightning', P: 'Psychic', F: 'Fighting', D: 'Darkness', M: 'Metal', Y: 'Fairy', N: 'Dragon', C: 'Colorless' }
const TYPE_EN = Object.fromEntries(Object.values(TYPE).map(t => [t.toLowerCase(), t]))
const STAGE = { basic: 'Basic', 'stage 1': 'Stage1', 'stage 2': 'Stage2', 'mega evolution': 'MEGA', mega: 'MEGA', 'break evolution': 'BREAK', break: 'BREAK', vmax: 'VMAX', vstar: 'VSTAR', 'v-union': 'V-UNION', restored: 'Restored', 'level-up': 'LEVEL-UP', baby: 'Baby' }
const TRAINER = /^(item|supporter|stadium|tool|pok[eé]mon tool|technical machine|trainer|ace spec)/i
const ENERGY = /energy/i

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let lastRequest = 0
async function get(url, json) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wait = lastRequest + PAUSE_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequest = Date.now()
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': UA } })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return json ? await res.json() : await res.text()
    } catch (err) {
      if (attempt === 3) { console.warn(`  ja-empty-sets: ${url}: ${err.message}`); return undefined }
      await sleep(2000 * attempt)
    }
  }
}

const strip = (s) => String(s ?? '').replace(/<span class="ptcg-symbol">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()

/** Limitless's `?display=list` page → [{ number, name, stage, types, rarity, image, set }] */
export function parseLimitless(html) {
  const out = []
  for (const tr of String(html ?? '').split('<tr data-hover=').slice(1)) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1])
    if (tds.length < 5) continue
    out.push({
      number: strip(tds[1]), name: strip(tds[2]), stage: strip(tds[3]), rarity: strip(tds[4]),
      types: [...tds[3].matchAll(/ptcg-symbol">([^<]*)</g)].map(m => m[1]),
      image: (/^"([^"]+)"/.exec(tr)?.[1] ?? '').replace(/_XS\.png$/, '_LG.png') || null,
      set: /data-tooltip="([^"]*)"/.exec(tr)?.[1] ?? null,
    })
  }
  return out
}

/** TCGplayer's product list → one card per number: [{ number, name, rarity, type, hp, stage, id, mirror }] */
export function parseTcgplayer(json) {
  const byNumber = new Map()
  for (const p of json?.results ?? []) {
    const e = Object.fromEntries((p.extendedData ?? []).map(x => [x.name, x.value]))
    const n = /^0*(\d+)\s*\//.exec(e.Number ?? '')?.[1] ?? /^0*(\d+)$/.exec(e.Number ?? '')?.[1]
    if (!n) continue // sealed products and unnumbered basic energies
    const tag = /\(([^)]*)\)\s*$/.exec(String(p.name).replace(/\s+-\s+\S+$/, ''))?.[1] ?? ''
    const mirror = /mirror|reverse/i.test(tag)
    const prev = byNumber.get(n)
    if (mirror) { if (prev) prev.mirror = true; else byNumber.set(n, { number: n, mirrorOnly: true, mirror: true }); continue }
    const card = {
      number: n, id: p.productId, name: String(p.name).replace(/\s+-\s+\S+$/, '').trim(),
      rarity: e.Rarity && e.Rarity !== 'None' ? e.Rarity : null, type: e.CardType ?? null,
      hp: /^\d+$/.test(e.HP ?? '') ? Number(e.HP) : null, stage: e.Stage ?? null, mirror: prev?.mirror ?? false,
    }
    if (!prev || prev.mirrorOnly || card.id < prev.id) byNumber.set(n, card)
  }
  return [...byNumber.values()].filter(c => !c.mirrorOnly).sort((a, b) => a.number - b.number)
}

/** Japanese Pokémon name → Pokédex number, by the longest Pokédex name the card name holds ("リザードンex" → 6) */
export async function pokedexByJapaneseName(root) {
  let list = []
  try {
    const p = JSON.parse(await readFile(`${root}/catalog/pokedex-v2.json`, 'utf8'))
    const f = Object.fromEntries(p.fields.map((n, i) => [n, i]))
    // NFKC: the Pokédex writes ポリゴン２ / ポリゴンＺ full-width, the cards ポリゴン2 / ポリゴンZ
    list = p.rows.filter(r => r[f.formKind] === 'base' && r[f.nameJa]).map(r => [r[f.nameJa].normalize('NFKC'), r[f.dex]])
      .filter(([n]) => n.length >= 2).sort((a, b) => b[0].length - a[0].length)
  } catch { /* no Pokédex */ }
  return (name) => {
    const s = String(name ?? '').normalize('NFKC')
    for (const [n, dex] of list) if (s.includes(n)) return dex
    return null
  }
}

const words = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
const rarityOf = (t, l) => {
  const a = t?.rarity ? RARITY[words(t.rarity)] : null
  const b = l?.rarity ? RARITY[words(l.rarity)] : null
  if (b && LIMITLESS_ONLY.has(words(l.rarity)) && !a) return null
  return a ?? b ?? null
}
const suffixOf = (name, rarity) => {
  if (rarity === 'LEGEND') return 'Legend'
  if (/GX$/i.test(name)) return /&/.test(name) ? 'TAG TEAM-GX' : 'GX'
  if (/EX$/.test(name)) return 'EX'
  if (/\bV$|[^A-Z]V$/.test(name)) return 'V'
  return null
}

/**
 * Card rows (CARD_FIELDS order) for one set from what the sources answered.
 * @returns { rows, en: Map(card id → English name), limitless: how many names came from Limitless, disagree }
 */
export function buildSet(setId, tcg, lim, { dexEn, dexJa }) {
  const limBy = new Map()
  for (const l of lim ?? []) if (/^\d+$/.test(l.number) && !limBy.has(String(Number(l.number)))) limBy.set(String(Number(l.number)), l)
  // a set's Limitless names only when its numbers are TCGplayer's: the Pokémon agree
  let agree = 0, disagree = 0
  for (const t of tcg) {
    const l = limBy.get(t.number); if (!l) continue
    const a = dexEn(t.name), b = dexJa(l.name)
    if (a != null && b != null) (a === b ? agree++ : disagree++)
  }
  // (SM0 has 4 cards: a small set needs most of its Pokémon to agree, not 5)
  const useLim = agree >= Math.min(5, Math.ceil(tcg.length / 2)) && disagree <= agree / 50
  const rows = [], en = new Map()
  let fromLim = 0
  for (const t of tcg) {
    const l = useLim ? limBy.get(t.number) : null
    if (l) { const a = dexEn(t.name), b = dexJa(l.name); if (a != null && b != null && a !== b) continue }
    if (l) fromLim++
    const rarity = rarityOf(t, l)
    const stageWord = words(l?.stage?.replace(/^.*?\b(basic|stage \d|mega evolution|break evolution|vmax|vstar|v-union|restored)\b.*$/i, '$1') ?? t.stage)
    const trainer = TRAINER.test(l?.stage ?? '') || TRAINER.test(t.type ?? '') || /^(supporter|item|stadium|tool)/i.test(t.stage ?? '')
    const energy = !trainer && (ENERGY.test(l?.stage ?? '') || ENERGY.test(t.type ?? '') && !t.hp)
    const category = trainer ? 'Trainer' : energy ? 'Energy' : 'Pokemon'
    const pokemon = category === 'Pokemon'
    const name = l?.name ?? t.name
    const dex = pokemon ? (dexJa(l?.name) ?? dexEn(t.name)) : null
    const types = pokemon ? (l?.types?.length ? l.types.map(x => TYPE[x]).filter(Boolean) : (TYPE_EN[words(t.type)] ? [TYPE_EN[words(t.type)]] : null)) : null
    // the plain print: holo from Rare up (a plain Rare only from XY on), then the mirror holo, then the 1st Edition run
    const holo = rarity && !['Common', 'Uncommon', ...(OLD_ERA.test(setId) ? ['Rare'] : [])].includes(rarity)
    const code = holo ? 'h' : 'n'
    const variants = [[code, null]]
    if (t.mirror && code === 'n') variants.push(['r', null])
    if (BOTH_RUNS.has(setId)) variants.push([`${code}+1st edition`, null])
    const localId = t.number.padStart(3, '0')
    const id = `${setId}-${localId}`
    rows.push([
      id, setId, localId, name, rarity ?? 'None', category, null, dex != null ? [dex] : null,
      types?.length ? types : null, pokemon ? t.hp : null, pokemon ? (STAGE[stageWord] ?? null) : null,
      l?.image ?? (t.id ? `https://tcgplayer-cdn.tcgplayer.com/product/${t.id}_400w.jpg` : null),
      variants, [], [], null, pokemon ? suffixOf(t.name, rarity) : null,
    ])
    en.set(id, t.name)
  }
  return { rows, en, limitless: fromLim, disagree, useLim }
}

/**
 * Adds the cards of `emptySets` (TCGdex set ids, Japanese, with no cards from TCGdex) to `cards`, in place.
 * `setRows` are the Japanese sets.json rows (for the abbreviation and the name), `cacheFile` the sources'
 * cache. Returns { sets, cards, fromLimitless, en: Map(card id → English name), skipped: [set ids] }.
 */
export async function fillEmptySets(emptySets, cards, cacheFile, { root = '.', now = Date.now(), fetchSources = true } = {}) {
  let cache = { sets: {} }
  try { cache = JSON.parse(await readFile(cacheFile, 'utf8')) } catch { /* first run */ }
  cache.sets ??= {}
  const dexEn = await pokedexByName(root), dexJa = await pokedexByJapaneseName(root)
  let groups = null
  const out = { sets: 0, cards: 0, fromLimitless: 0, en: new Map(), skipped: [] }
  for (const setId of emptySets) {
    let c = cache.sets[setId]
    if (fetchSources && (!c || now - c.at > MONTH)) {
      groups ??= (await get(`${TCGCSV}/groups`, true))?.results ?? []
      const simple = (s) => String(s ?? '').toLowerCase().replace(/\+/g, 'p').replace(/[^a-z0-9]+/g, '')
      const byCode = groups.filter(g => simple(g.abbreviation) === simple(setId))
      const group = TCGPLAYER_GROUP[setId] ?? (byCode.length === 1 ? byCode[0].groupId : null)
      const code = setId in LIMITLESS_CODE ? LIMITLESS_CODE[setId] : setId
      const tjson = group ? await get(`${TCGCSV}/${group}/products`, true) : null
      const html = code ? await get(`${LIMITLESS}/${encodeURIComponent(code)}?display=list`, false) : null
      // a failed request keeps what the cache had
      const tcg = tjson === undefined ? c?.tcg : parseTcgplayer(tjson)
      const lim = html === undefined ? c?.lim : parseLimitless(html)
      if (tcg?.length || c) c = cache.sets[setId] = { at: now, group, limitless: code, tcg: tcg ?? [], lim: lim ?? [] }
    }
    if (!c?.tcg?.length) { out.skipped.push(setId); continue }
    const b = buildSet(setId, c.tcg, c.lim, { dexEn, dexJa })
    if (!b.rows.length) { out.skipped.push(setId); continue }
    cards.push(...b.rows)
    for (const [k, v] of b.en) out.en.set(k, v)
    out.sets++; out.cards += b.rows.length; out.fromLimitless += b.limitless
    if (c.lim?.length && !b.useLim) console.log(`  [ja] ${setId}: Limitless's numbers don't agree with TCGplayer's (${b.disagree} differ): English names`)
  }
  if (fetchSources) await writeFile(cacheFile, JSON.stringify(cache))
  return out
}
