// Card pictures for sets no other source has: cardcodex.com (the XY/SM/HGSS trainer kits, the Poké Card
// Creator Pack, Japanese PMCG1, PCG3, PCG9) and pkmncards.com (the six Yellow A Alternate prints).
// Neither sends a CORS header; the app shows them through wsrv.nl like Pokéllector's (src/lib/cards.ts `slim`).
//
// A cardcodex set page lists every card as
//   /wp-content/uploads/<yyyy>/<mm>/<name>-<code>-<number>[-<rarity>]-from-<set>-set_small.png
// (the full size is the same name without `_small`). The upload month and rarity are in the name, so the
// page is read, not guessed. A card is taken when its number matches and
//   - English: its name matches ours;
//   - Japanese: the set's numbering is ours (every Pokémon card known on both sides agrees, as for Pokéllector).
// What was found is remembered per card in the image-fallbacks cache, so a page is only read again for new gaps.
import { pokedexByName, cardDex } from './tcgplayer-images.mjs'

const IMAGE = 11
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; CIAC catalog builder; +https://ciac-tcg.com)' }
const WEEK = 7 * 864e5

// TCGdex set id → [cardcodex page under /pokemon/, the set code in its file names]
export const CARDCODEX = {
  en: {
    'tk-xy-b': ['xy/xy-trainer-kit-bisharp', 'tk7b'],
    'tk-xy-w': ['xy/xy-trainer-kit-wigglytuff', 'tk7a'],
    'tk-xy-latia': ['xy/xy-trainer-kit-latias', 'tk8b'],
    'tk-xy-latio': ['xy/xy-trainer-kit-latios', 'tk8a'],
    'tk-xy-n': ['xy/xy-trainer-kit-noivern', 'tk6b'],
    'tk-sm-r': ['sun-moon/sm-trainer-kit-alolan-raichu', 'tk10b'],
    'tk-sm-l': ['sun-moon/sm-trainer-kit-lycanroc', 'tk10a'],
    'tk-hs-g': ['heartgold-soulsilver/hgss-trainer-kit-gyarados', 'tk4b'],
    'ex5.5': ['other/poke-card-creator-pack', 'wb1'],
  },
  ja: {
    PMCG1: ['original/expansion-pack-ja', 'base1_ja'],
    PCG3: ['pcg/rocket-gang-strikes-back-ja', 'pcg3_ja'],
    PCG9: ['pcg/offense-and-defense-of-the-furthest-ends-ja', 'pcg9_ja'],
  },
}

// Yellow A Alternate (TCGdex `xya`): each print is filed under the set it reprints
const PKMNCARDS = 'https://pkmncards.com/wp-content/uploads/'
export const PKMNCARDS_EN = {
  'xya-24a': 'en_US-XY4-24a-m_manectric_ex-yaa.jpg',
  'xya-28a': 'en_US-TwentiethAnn-28a-jolteon_ex-yaa.jpg',
  'xya-54a': 'en_US-XY10-54a-zygarde_ex-yaa.jpg',
  'xya-55a': 'en_US-XY3-55a-m_lucario_ex-yaa.jpg',
  'xya-92a': 'en_US-XY6-92a-trainers_mail-yaa.jpg',
  'xya-107a': 'en_US-XY9-107a-professor_sycamore-yaa.jpg',
}

async function ok(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { method: 'HEAD', headers: UA })
      if (r.status === 200) return true
      if (r.status === 403 || r.status === 404) return false
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500 * (i + 1)))
  }
  return false
}

const slug = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const num = (n) => String(n).replace(/^0+(?=\d)/, '').toLowerCase()

/** The cards on one cardcodex set page: number → { name slug, full-size URL, small URL } */
export async function readCardcodexSet(page, code) {
  const r = await fetch(`https://cardcodex.com/pokemon/${page}/`, { headers: UA })
  if (!r.ok) throw new Error(`cardcodex ${page}: ${r.status}`)
  const html = await r.text()
  const re = new RegExp(`(https://cardcodex\\.com)?/wp-content/uploads/(\\d{4}/\\d{2})/([a-z0-9-]+?)-${code}-(\\d+[a-z]?)((?:-[a-z0-9-]+)?-from-[a-z0-9-]+-set)_small\\.png`, 'g')
  const out = new Map()
  for (const m of html.matchAll(re)) {
    const n = num(m[4])
    if (out.has(n)) continue
    const base = `https://cardcodex.com/wp-content/uploads/${m[2]}/${m[3]}-${code}-${m[4]}${m[5]}`
    out.set(n, { name: m[3], full: `${base}.png`, small: `${base}_small.png` })
  }
  return out
}

/** Fills missing pictures in `rows` (raw TCGdex set ids) in place from cardcodex and pkmncards. */
export async function fillFromCardcodex(lang, rows, cache, root = '.') {
  const now = Date.now()
  let filled = 0
  cache.cards ??= {}
  // a card found before: no page read
  for (const r of rows) {
    if (r[IMAGE]) continue
    const k = cache.cards[r[0]]
    if (k?.url && /cardcodex\.com|pkmncards\.com/.test(k.url)) { r[IMAGE] = k.url; filled++ }
  }
  if (lang === 'en') {
    for (const r of rows) {
      const file = PKMNCARDS_EN[r[0]]
      if (r[IMAGE] || !file) continue
      const k = cache.cards[r[0]]
      if (k && !k.url && now - k.at < WEEK) continue
      const url = PKMNCARDS + file
      const yes = await ok(url)
      cache.cards[r[0]] = yes ? { url, at: now } : { url: null, tried: url, at: now }
      if (yes) { r[IMAGE] = url; filled++ }
    }
  }
  const dexOf = lang === 'ja' ? await pokedexByName(root) : null
  for (const [setId, [page, code]] of Object.entries(CARDCODEX[lang] ?? {})) {
    const inSet = rows.filter(r => r[1] === setId)
    const want = inSet.filter(r => !r[IMAGE] && !(cache.cards[r[0]] && !cache.cards[r[0]].url && now - cache.cards[r[0]].at < WEEK))
    if (!want.length) continue
    let cards
    try { cards = await readCardcodexSet(page, code) } catch (e) { console.warn(String(e.message ?? e)); continue }
    if (lang === 'ja') {
      // the same numbering? every card whose Pokémon is known on both sides must agree
      let agree = 0, disagree = 0
      for (const r of inSet) {
        const c = cards.get(num(r[2])); const a = c && dexOf(c.name), b = cardDex(r)
        if (a != null && b != null) a === b ? agree++ : disagree++
      }
      if (agree < 10 || disagree > agree / 50) { console.warn(`cardcodex ${setId}: numbering differs (${agree} agree, ${disagree} not)`); continue }
    }
    for (const r of want) {
      const c = cards.get(num(r[2]))
      const nameOk = c && (lang === 'ja'
        ? !(dexOf(c.name) != null && cardDex(r) != null && dexOf(c.name) !== cardDex(r))
        : slug(r[3]) === c.name || slug(r[3]).replace(/-?(ex|gx)$/, '') === c.name.replace(/-?(ex|gx)$/, ''))
      if (!nameOk) { cache.cards[r[0]] = { url: null, tried: c?.full ?? `cardcodex:${setId}`, at: now }; continue }
      const url = (await ok(c.full)) ? c.full : (await ok(c.small)) ? c.small : null
      cache.cards[r[0]] = url ? { url, at: now } : { url: null, tried: c.full, at: now }
      if (url) { r[IMAGE] = url; filled++ }
    }
  }
  return filled
}
