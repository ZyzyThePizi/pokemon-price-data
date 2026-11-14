// Card images TCGdex and Pokéllector don't have, from more sources, in this order:
//   English:  pokemontcg.io's image CDN (images.pokemontcg.io/<set>/<number>.png; its set ids spell
//             TCGdex's differently: swsh4.5sv → swsh45sv, swsh12.5gg → swsh12pt5gg), then Limitless
//             TCG (tpci/<ABBR>/<ABBR>_<001>_R_EN_LG.png, by the set's official abbreviation);
//   Japanese: Limitless TCG (tpc/<SET>/<SET>_<n>_R_JP_LG.png), Sun & Moon era onwards;
//   then both: TCGplayer's catalog (tcgplayer-images.mjs), which also has the Japanese sets of 1996–2006;
//   last, Japanese: Pokéllector's old sets under the codes it gives them (B02 = PMCG2…), when its numbering
//   is TCGdex's (every card whose Pokémon both name agrees).
// Before all of these, the sets in BY_NAME: pokemontcg.io numbers their cards another way, so its API's
// cards are paired with ours by name (all or nothing).
// For each set the first source + number style that has one of its missing cards wins.
// What was found is remembered in catalog/v2/image-fallbacks.json, so a daily build only asks about
// new gaps; a miss is retried after a week.
import { readFile, writeFile } from 'node:fs/promises'
import { fillFromTcgplayer, pokedexByName, cardDex, rememberTcgplayerNames } from './tcgplayer-images.mjs'

const WEEK = 7 * 864e5
const IMAGE = 11 // the image column of a card row (CARD_FIELDS in build-ciac-catalog.mjs)
const LIMITLESS = 'https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com'
// official abbreviations Limitless spells its own way
const LIMITLESS_EN = { 'CEL:CC': 'CEC' }

// TCGdex set → pokemontcg.io set whose cards keep their original numbers (Charizard is 4 there, 001 here).
// 30th-c shares its official code 30C with the main 30th Celebration set, and Limitless's 30C pictures are
// the main set's (Exeggcute where Charizard belongs, 2026-10-24).
const BY_NAME = { '30th-c': 'me55c' }
// TCGdex set → pokemontcg.io set with the same numbers, for the cards with no picture at all: 30th Celebration's
// RGB Mew (B, G, R), which TCGdex deleted with their pictures (2026-10-24)
const BY_NUMBER = { '30th': 'me55' }
const nameKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim()

/** pokemontcg.io's pictures for a BY_NAME set: card id → URL (the small one; the app asks /large for big). */
async function ptcgCards(ptcgSet) {
  let data = null
  for (let i = 0; i < 3 && !data; i++) {
    try {
      const r = await fetch(`https://api.pokemontcg.io/v2/cards?q=set.id:${ptcgSet}&pageSize=250&select=id,name,number,images`)
      if (r.ok) data = (await r.json()).data
    } catch { /* retry */ }
    if (!data) await new Promise(r => setTimeout(r, 1000 * (i + 1)))
  }
  return data?.length ? data : null
}

async function picturesByName(rows, ptcgSet) {
  const data = await ptcgCards(ptcgSet)
  if (!data) return null
  // theirs in number order (99 before 100, 106 before 106m), ours in ours: two cards of one name pair in order
  const num = (n) => [parseInt(n, 10) || 0, String(n)]
  const theirs = [...data].sort((a, b) => num(a.number)[0] - num(b.number)[0] || num(a.number)[1].localeCompare(num(b.number)[1]))
  const ours = [...rows].sort((a, b) => String(a[2]).localeCompare(String(b[2]), undefined, { numeric: true }))
  const out = new Map()
  const left = new Set(theirs)
  // exact name first ("Genesect-EX" = "Genesect EX"), then a name theirs extends by one word ("Palkia LV.X")
  for (const pass of [(a, b) => a === b, (a, b) => b.startsWith(a + ' ') && b.split(' ').length - a.split(' ').length <= 2]) {
    for (const r of ours) {
      if (out.has(r[0])) continue
      const hits = [...left].filter(t => pass(nameKey(r[3]), nameKey(t.name)))
      // two different names fit: not this pass (two cards of one name: the first in number order)
      if (!hits.length || new Set(hits.map(h => nameKey(h.name))).size > 1) continue
      out.set(r[0], hits[0].images.small); left.delete(hits[0])
    }
  }
  return out.size === rows.length ? out : null
}

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

// Pokéllector's stand-ins that are not card pictures (2026-11-09):
//  - its placeholder URL;
//  - grey "NO IMAGE" squares (570×570) under real card names (SM5S/SM5M 076–078): a card picture is portrait,
//    so a square or wide PNG is not a card;
//  - one picture under several cards of a set (the GX Battle Boost pack under SM4+ 115–117 and 121–125): its
//    files differ by a few bytes, so pictures of one set whose sizes are that close, under two or more card
//    names, are compared pixel by pixel (a 12 × 16 thumbnail) and a group of 3 or more that match is dropped.
// Each picture's PNG header (64 bytes, which also gives the file size) is read once: cache.pkShape (path →
// 1 card, 0 not a card), cache.pkSize (bytes), cache.pkSame (paths already compared).
const PK_PLACEHOLDER = /pokellector\.com\/images\/card-placeholder/
const PK_HOST = /^https?:\/\/den-cards\.pokellector\.com\//
const pkPath = (u) => u.replace(PK_HOST, '')

async function pngShape(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { Range: 'bytes=0-63' } })
      if (r.status === 404 || r.status === 403) return { shape: 0 }
      const b = Buffer.from(await r.arrayBuffer())
      const size = Number(/\/(\d+)$/.exec(r.headers.get('content-range') ?? '')?.[1]) || null
      if (r.ok && b.length >= 24 && b.subarray(1, 4).toString() === 'PNG') return { shape: b.readUInt32BE(20) > b.readUInt32BE(16) ? 1 : 0, size }
      if (r.ok && b[0] === 0xff && b[1] === 0xd8) return { shape: 1, size } // a JPEG: Pokéllector's stand-ins are PNGs
    } catch { /* retry */ }
    await new Promise(res => setTimeout(res, 1000 * (i + 1)))
  }
  return null // Pokéllector busy (504): keep the picture, ask again next build
}

async function thumb(url, sharp) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return await sharp(Buffer.from(await r.arrayBuffer())).resize(12, 16, { fit: 'fill' }).removeAlpha().raw().toBuffer()
    } catch { /* retry */ }
    await new Promise(res => setTimeout(res, 1000 * (i + 1)))
  }
  return null
}

const SIZE_GAP = 256 // bytes: one picture saved again under another name
const SAME = 4 // mean difference per channel (0–255) of two thumbnails of one picture

/** Pictures shared by 3+ cards of 2+ names in one set → pkShape 0. */
async function sharedPictures(cards, cache) {
  let sharp
  try { sharp = (await import('sharp')).default } catch { console.log('  (sharp missing: shared Pokéllector pictures not checked)'); return }
  const bySet = new Map()
  for (const r of cards) {
    const u = r[IMAGE]
    if (!u || !PK_HOST.test(u) || cache.pkShape[pkPath(u)] !== 1 || !cache.pkSize[pkPath(u)]) continue
    if (!bySet.has(r[1])) bySet.set(r[1], [])
    bySet.get(r[1]).push(r)
  }
  for (const rows of bySet.values()) {
    rows.sort((a, b) => cache.pkSize[pkPath(a[IMAGE])] - cache.pkSize[pkPath(b[IMAGE])])
    const runs = [[]]
    for (const r of rows) {
      const last = runs.at(-1).at(-1)
      if (last && cache.pkSize[pkPath(r[IMAGE])] - cache.pkSize[pkPath(last[IMAGE])] > SIZE_GAP) runs.push([])
      runs.at(-1).push(r)
    }
    for (const run of runs) {
      const urls = [...new Set(run.map(r => r[IMAGE]))]
      if (urls.length < 3 || new Set(run.map(r => r[3])).size < 2 || urls.every(u => cache.pkSame[pkPath(u)])) continue
      const th = await pool(urls, (u) => thumb(u, sharp), 4)
      if (th.some(t => !t)) continue // not all read: next build
      const near = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length < SAME }
      const group = new Map(urls.map(u => [u, u]))
      const find = (u) => (group.get(u) === u ? u : find(group.get(u)))
      for (let i = 0; i < urls.length; i++) for (let j = i + 1; j < urls.length; j++) if (near(th[i], th[j])) group.set(find(urls[j]), find(urls[i]))
      const members = new Map()
      for (const u of urls) { const g = find(u); if (!members.has(g)) members.set(g, []); members.get(g).push(u) }
      for (const m of members.values()) {
        const names = new Set(run.filter(r => m.includes(r[IMAGE])).map(r => r[3]))
        if (m.length >= 3 && names.size >= 2) {
          console.log(`  one Pokéllector picture under ${m.length} cards: ${run.filter(r => m.includes(r[IMAGE])).map(r => r[0]).join(' ')}`)
          for (const u of m) cache.pkShape[pkPath(u)] = 0
        }
      }
      for (const u of urls) cache.pkSame[pkPath(u)] = 1
    }
  }
}

/** Blanks Pokéllector stand-ins in `cards`, so the other sources look for the real picture. */
export async function dropStandIns(cards, cache) {
  cache.pkShape ??= {}; cache.pkSize ??= {}; cache.pkSame ??= {}
  const ask = new Set()
  for (const r of cards) {
    const u = r[IMAGE]
    if (u && PK_HOST.test(u) && (!(pkPath(u) in cache.pkShape) || (cache.pkShape[pkPath(u)] === 1 && !cache.pkSize[pkPath(u)]))) ask.add(u)
  }
  await pool([...ask], async (u) => {
    const s = await pngShape(u)
    if (s) { cache.pkShape[pkPath(u)] = s.shape; if (s.size) cache.pkSize[pkPath(u)] = s.size }
  }, 6)
  await sharedPictures(cards, cache)
  let dropped = 0
  for (const r of cards) {
    const u = r[IMAGE]
    if (u && (PK_PLACEHOLDER.test(u) || (PK_HOST.test(u) && cache.pkShape[pkPath(u)] === 0))) { r[IMAGE] = null; dropped++ }
  }
  return dropped
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
  const standIns = await dropStandIns(cards, cache)
  if (standIns) console.log(`  [${lang}] ${standIns} Pokéllector stand-in pictures dropped (placeholder, NO IMAGE)`)
  const now = Date.now()
  const now0 = Date.now()
  for (const [setId, ptcgSet] of Object.entries(BY_NAME)) {
    const rows = cards.filter(r => String(r[1]).replace(/^ja-/, '') === setId)
    if (lang !== 'en' || !rows.length) continue
    const got = await picturesByName(rows, ptcgSet)
    for (const r of rows) {
      const url = got?.get(r[0]) ?? (cache.cards[r[0]]?.by === ptcgSet ? cache.cards[r[0]].url : null)
      // a TCGdex picture (a relative path) stays; a guessed one from another source is replaced
      if (url && (!r[IMAGE] || /^https?:/.test(r[IMAGE]))) { r[IMAGE] = url; cache.cards[r[0]] = { url, by: ptcgSet, at: now0 } }
    }
    if (!got) console.log(`  ${setId}: pokemontcg.io ${ptcgSet} did not pair every card by name`)
  }
  for (const [setId, ptcgSet] of Object.entries(BY_NUMBER)) {
    const rows = cards.filter(r => String(r[1]).replace(/^ja-/, '') === setId && !r[IMAGE])
    if (lang !== 'en' || !rows.length) continue
    const data = await ptcgCards(ptcgSet)
    const key = (n) => (/^\d+$/.test(String(n)) ? String(parseInt(n, 10)) : String(n).toUpperCase())
    const byNum = new Map((data ?? []).map(c => [key(c.number), c.images.small]))
    for (const r of rows) {
      const url = byNum.get(key(r[2])) ?? (cache.cards[r[0]]?.by === ptcgSet ? cache.cards[r[0]].url : null)
      if (url) { r[IMAGE] = url; cache.cards[r[0]] = { url, by: ptcgSet, at: now0 } }
    }
  }
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
    // a picture found before, here or by a later source (TCGplayer), stays: probing this one again and missing
    // used to overwrite it, and the card went blank until TCGplayer was asked again a week later (M6a, MF: 40 cards)
    if (known?.url) { r[IMAGE] = known.url; filled++; return }
    if (known && !known.url && known.tried === u && now - known.at < WEEK) return
    const ok = await exists(u)
    cache.cards[r[0]] = ok ? { url: u, at: now } : { url: null, tried: u, at: now }
    if (ok) { r[IMAGE] = u; filled++ }
  })
  const tp = await fillFromTcgplayer(lang, missing.filter(r => !r[IMAGE]), cache, opts)
  filled += tp.filled
  if (lang === 'ja') filled += await fillFromPokellectorJa(cards, opts.root ?? '.') - await dropStandIns(cards, cache)
  // English names of the TCGplayer products behind Japanese pictures, for Cardmarket matching
  if (lang === 'ja') await rememberTcgplayerNames(lang, cards, cache)
  await writeFile(cacheFile, JSON.stringify(cache))
  const left = cards.filter(r => !r[IMAGE]).length
  return { filled, missing: missing.length, left, coverage: `${(100 * (cards.length - left) / cards.length).toFixed(2)}%` }
}
