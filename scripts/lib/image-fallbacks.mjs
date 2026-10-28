// Card images TCGdex and Pokéllector don't have, from more sources, in this order:
//   English:  pokemontcg.io's image CDN (images.pokemontcg.io/<set>/<number>.png; its set ids spell
//             TCGdex's differently: swsh4.5sv → swsh45sv, swsh12.5gg → swsh12pt5gg), then Limitless
//             TCG (tpci/<ABBR>/<ABBR>_<001>_R_EN_LG.png, by the set's official abbreviation);
//   Japanese: Limitless TCG (tpc/<SET>/<SET>_<n>_R_JP_LG.png), Sun & Moon era onwards;
//   then both: TCGplayer's catalog (tcgplayer-images.mjs), which also has the Japanese sets of 1996–2006;
//   last, Japanese: Pokéllector's old sets under the codes it gives them (B02 = PMCG2…), when its numbering
//   is TCGdex's (every card whose Pokémon both name agrees);
//   last of all, both: cardcodex.com and pkmncards.com for the sets nobody else has (cardcodex.mjs).
// For each set the first source + number style that has one of its missing cards wins.
// What was found is remembered in catalog/v2/image-fallbacks.json, so a daily build only asks about
// new gaps; a miss is retried after a week.
import { readFile, writeFile } from 'node:fs/promises'
import { fillFromTcgplayer, pokedexByName, cardDex, rememberTcgplayerNames } from './tcgplayer-images.mjs'
import { fillFromCardcodex } from './cardcodex.mjs'

const WEEK = 7 * 864e5
const IMAGE = 11 // the image column of a card row (CARD_FIELDS in build-ciac-catalog.mjs)
const LIMITLESS = 'https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com'
// official abbreviations Limitless spells its own way
const LIMITLESS_EN = { 'CEL:CC': 'CEC' }

async function exists(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { method: 'HEAD' })
      if (r.status === 200) return true
      if (r.status === 403 || r.status === 404) return false
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500 * (i + 1)))
  }
  return false
}

// card numbers: as TCGdex writes them ("001", "SV001"), without leading zeros ("1"), or 3 digits ("001")
const NUMBER = {
  raw: (n) => n,
  int: (n) => n.replace(/^([A-Za-z]*)0+(\d)/, '$1$2'),
  pad3: (n) => (/^\d+$/.test(n) ? n.padStart(3, '0') : n),
}

/** The places a set's images might be, each with the number styles to try. */
function sourcesFor(lang, setId, abbr) {
  const uniq = (xs) => [...new Set(xs.filter(Boolean))]
  if (lang === 'ja') {
    return uniq([setId, setId.replace(/-/g, ''), setId.toUpperCase().replace(/-/g, '')])
      .map(code => ({ url: (n) => `${LIMITLESS}/tpc/${code}/${code}_${n}_R_JP_LG.png`, styles: ['int', 'raw'], name: `limitless:${code}` }))
  }
  const ptcg = uniq([setId, setId.replace(/\./g, ''), setId.replace(/\.5/, 'pt5'), setId.replace(/\./g, 'pt'), setId.toLowerCase()])
    .map(code => ({ url: (n) => `https://images.pokemontcg.io/${code}/${n}.png`, styles: ['raw', 'int'], name: `ptcg:${code}` }))
  const L = abbr ? (LIMITLESS_EN[abbr] ?? abbr).toUpperCase() : null
  const lim = L ? [{ url: (n) => `${LIMITLESS}/tpci/${L}/${L}_${n}_R_EN_LG.png`, styles: ['pad3', 'raw'], name: `limitless:${L}` }] : []
  return [...ptcg, ...lim]
}

// TCGdex Japanese set → Pokéllector set code, where the build's own matching (name, id) misses it
export const POKELLECTOR_JA = { PMCG2: 'B02', PMCG3: 'B03', PMCG4: 'B04', PMCG5: 'B05', PMCG6: 'B06', VS1: 'VS',
  neo1: 'NEO1', neo2: 'NEO2', neo3: 'NEO3', neo4: 'NEO4', SM1p: 'SM1+', SM2p: 'SM2+', SM3p: 'SM3+', SM4p: 'SM4+', SM5p: 'SM5+' }

async function fillFromPokellectorJa(cards, root) {
  let data
  try { data = JSON.parse(await readFile(`${root}/catalog/pokellector_jp.json`, 'utf8')) } catch { return 0 }
  const sf = Object.fromEntries(data.setFields.map((n, i) => [n, i]))
  const cf = Object.fromEntries(data.cardFields.map((n, i) => [n, i]))
  const abs = (v) => (v ? (/^https?:/.test(v) ? v : data.imageBase + v) : null)
  const dexOf = await pokedexByName(root)
  let filled = 0
  for (const [setId, code] of Object.entries(POKELLECTOR_JA)) {
    const rows = cards.filter(r => r[1] === setId)
    if (!rows.some(r => !r[IMAGE])) continue
    const slug = data.sets.find(x => x[sf.setCode] === code)?.[sf.slug]
    const byNumber = new Map((data.cards[slug] ?? []).map(c => [parseInt(c[cf.number], 10), c]))
    // same numbering? every card whose Pokémon is known on both sides must agree
    let agree = 0, disagree = 0
    for (const r of rows) {
      const c = byNumber.get(parseInt(r[2], 10)); const a = c && dexOf(c[cf.name]), b = cardDex(r)
      if (a != null && b != null) a === b ? agree++ : disagree++
    }
    if (agree < 10 || disagree > agree / 50) continue
    for (const r of rows) {
      if (r[IMAGE]) continue
      const c = byNumber.get(parseInt(r[2], 10)); const url = abs(c?.[cf.imageUrl])
      const a = c && dexOf(c[cf.name]), b = cardDex(r)
      if (url && !(a != null && b != null && a !== b)) { r[IMAGE] = url; filled++ }
    }
  }
  return filled
}

async function pool(items, fn, n = 8) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]) } }))
  return out
}

/**
 * Fills missing images in `cards` (rows with raw TCGdex set ids) in place.
 * `abbrOf(setId)` gives a set's official abbreviation (for Limitless' English images);
 * `opts.setName(setId)` its name and `opts.root` the repo root (for TCGplayer's matching).
 */
export async function fillImages(lang, cards, cacheFile, abbrOf = () => null, opts = {}) {
  let cache = { sets: {}, cards: {} }
  try { cache = JSON.parse(await readFile(cacheFile, 'utf8')) } catch { /* first run */ }
  cache.sets ??= {}; cache.cards ??= {}
  const now = Date.now()
  const missing = cards.filter(r => !r[IMAGE])
  const bySet = new Map()
  for (const r of missing) { if (!bySet.has(r[1])) bySet.set(r[1], []); bySet.get(r[1]).push(r) }
  const chosen = new Map()
  for (const [setId, rows] of bySet) {
    const key = `${lang}:${setId}`
    const sources = sourcesFor(lang, setId, abbrOf(setId))
    const known = cache.sets[key]
    if (known?.source) { const s = sources.find(x => x.name === known.source); if (s) { chosen.set(setId, { s, style: known.num }); continue } }
    if (known && !known.source && now - known.at < WEEK) continue
    let pick = null
    probe: for (const s of sources) {
      for (const style of s.styles) for (const r of rows.slice(0, 3)) if (await exists(s.url(NUMBER[style](r[2])))) { pick = { s, style }; break probe }
    }
    cache.sets[key] = { source: pick?.s.name ?? null, num: pick?.style ?? null, at: now }
    if (pick) chosen.set(setId, pick)
  }
  let filled = 0
  await pool(missing, async (r) => {
    const pick = chosen.get(r[1])
    if (!pick) return
    const u = pick.s.url(NUMBER[pick.style](r[2]))
    const known = cache.cards[r[0]]
    if (known?.url === u) { r[IMAGE] = u; filled++; return }
    if (known && !known.url && known.tried === u && now - known.at < WEEK) return
    const ok = await exists(u)
    cache.cards[r[0]] = ok ? { url: u, at: now } : { url: null, tried: u, at: now }
    if (ok) { r[IMAGE] = u; filled++ }
  })
  const tp = await fillFromTcgplayer(lang, missing.filter(r => !r[IMAGE]), cache, opts)
  filled += tp.filled
  if (lang === 'ja') filled += await fillFromPokellectorJa(cards, opts.root ?? '.')
  filled += await fillFromCardcodex(lang, cards, cache, opts.root ?? '.')
  // English names of the TCGplayer products behind Japanese pictures, for Cardmarket matching
  if (lang === 'ja') await rememberTcgplayerNames(lang, cards, cache)
  await writeFile(cacheFile, JSON.stringify(cache))
  const left = cards.filter(r => !r[IMAGE]).length
  return { filled, missing: missing.length, left, coverage: `${(100 * (cards.length - left) / cards.length).toFixed(2)}%` }
}
