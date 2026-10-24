// Pairs Cardmarket's sealed products (prices/products.json, every category but 51 singles) with TCGplayer's,
// by name, for their pictures (scripts/lib/sealed-images.mjs). Pure: no network.
//
// A pair is only taken when both names say the same kind of product: the "kind" words (box, case, display,
// blister, tin, bundle, booster, collection, deck…) and every number must agree exactly, so a booster box
// never gets a case's picture or a booster's. The other words (set name, Pokémon, "Pokémon Center") are
// compared as sets: the best TCGplayer product must cover the Cardmarket name's words and be the only one
// that does as well. Cardmarket's bracketed initials ("[LUJF]") match the Pokémon in TCGplayer's brackets
// ("[Flareon/Jolteon/Umbreon/Leafeon]").

const KIND = new Set(['box', 'boxes', 'case', 'display', 'blister', 'tin', 'tins', 'mini', 'bundle', 'booster', 'collection',
  'deck', 'decks', 'theme', 'battle', 'build', 'stadium', 'trainer', 'elite', 'premium', 'checklane', 'sleeved',
  'half', 'kit', 'starter', 'set', 'pack', 'binder', 'portfolio', 'album', 'sleeves', 'coin', 'pin', 'pins', 'figure',
  'poster', 'playmat', 'mat', 'dice', 'marker', 'tech', 'sticker', 'stickers', 'lunchbox', 'chest', 'gift',
  'special', 'enhanced', 'expansion', 'fun', 'code', 'live', 'jumbo', 'oversized', 'card', 'cards', 'single',
  'v', 'ex', 'gx', 'vmax', 'vstar', 'world', 'championships', 'league', 'battle', 'academy', 'trading', 'game',
  'blisters', 'packs', 'boosters', 'tower', 'stack', 'super', 'ultra', 'surprise', 'treasure', 'calendar', 'advent',
  'holiday', 'costco', 'sam', 'sams', 'walmart', 'target', 'bj', 'exclusive', 'center', 'pokemon', 'eu', 'us', 'english'])
// words that only say where it was sold, or nothing: dropped before comparing
const NOISE = new Set(['the', 'of', 'a', 'and', 'tcg', 'pokemon', 'exclusive', 'english', 'version', 'edition', 'product',
  'with', 'for', 'in', 'x', 'jp', 'japanese', 'new', 'unlimited', 'edition'])
// kind words that must agree (a subset of KIND: what it physically is)
const STRICT = ['box', 'case', 'display', 'blister', 'tin', 'mini', 'bundle', 'booster', 'collection', 'deck', 'elite',
  'premium', 'checklane', 'sleeved', 'half', 'kit', 'binder', 'portfolio', 'album', 'sleeves', 'coin', 'pin', 'figure',
  'poster', 'playmat', 'dice', 'tech', 'sticker', 'build', 'stadium', 'fun', 'code', 'jumbo', 'special', 'enhanced',
  'center', 'tower', 'stack', 'surprise', 'calendar', 'chest', 'lunchbox', 'gift', 'ultra']

const STEM = { boxes: 'box', tins: 'tin', decks: 'deck', pins: 'pin', blisters: 'blister', packs: 'pack', boosters: 'booster',
  stickers: 'sticker', cards: 'card', sams: 'sam', oversized: 'jumbo', mat: 'playmat', 'pokémon': 'pokemon' }

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, ten: 10, twelve: 12, eighteen: 18, twenty: 20, 'thirty-six': 36 }

const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** "Evolving Skies Elite Trainer Box [LUJF]" → { words: Set, initials: 'fjlu' } */
export function tokens(name, { setName = '' } = {}) {
  let initials = null
  // Cardmarket's initials of the Pokémon on a variant: [LUJF], [SEGV]
  let s = plain(String(name ?? '').replace(/\[([A-Z]{3,6})\]/g, (m, x) => { initials = [...x.toLowerCase()].sort().join(''); return ' ' }))
  // TCGplayer's bracketed Pokémon lists: [Flareon/Jolteon/Umbreon/Leafeon]
  let listInitials = null
  const list = /\[([^\]]*\/[^\]]*)\]/.exec(s)
  if (list) listInitials = list[1].split('/').map(w => w.trim()[0]).filter(Boolean).sort().join('')
  s = s.replace(/[&+]/g, ' and ').replace(/'s\b/g, '').replace(/[^a-z0-9]+/g, ' ')
  const words = []
  for (let w of s.split(' ')) {
    if (!w) continue
    w = STEM[w] ?? w
    if (NUMBER_WORDS[w]) w = String(NUMBER_WORDS[w])
    words.push(w)
  }
  // "booster pack" is a booster; "3 pack blister" keeps its number
  const out = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === 'pack' && words[i - 1] === 'booster') continue
    if (w === 'pack' && /^\d+$/.test(words[i - 1] ?? '')) { out.push('pack'); continue }
    out.push(w)
  }
  // "POP Series 1 Pack": a booster by another name
  if (out.at(-1) === 'pack' && !out.some(w => /^(booster|blister|pin|sticker|fun|partner|collection|code|promo|trainer|sampling)$/.test(w))) out.push('booster')
  const japanese = out.includes('jp') || out.includes('japanese')
  const set = new Set(out.filter(w => !NOISE.has(w)))
  // the set's own name is implied when a product name leaves it out
  for (const w of plain(setName).replace(/[&+]/g, ' and ').replace(/'s\b/g, '').replace(/[^a-z0-9]+/g, ' ').split(' '))
    if (w && !NOISE.has(w) && !/^[a-z]*\d+[a-z]*$/.test(w)) set.add(STEM[w] ?? w)
  return { words: set, initials: initials ?? listInitials, ownInitials: initials, japanese }
}

const strictOf = (words) => STRICT.filter(k => words.has(k)).join(' ')
const numbersOf = (words) => [...words].filter(w => /^\d+$/.test(w)).sort().join(' ')

/** TCGplayer group name → the set name inside it: "SV05: Temporal Forces" → "Temporal Forces" */
export const groupSetName = (g) => String(g ?? '').replace(/^[A-Za-z0-9.\- ]{1,10}:\s*/, '').replace(/^High Class Pack:\s*/i, '')

/**
 * cm: [[idProduct, name]], tcg: [[productId, name, groupName, lang]] → Map idProduct → productId.
 * Only unambiguous pairs: the best candidate must beat the second best.
 */
export function matchSealed(cm, tcg, { minScore = 0.75 } = {}) {
  const prepared = tcg.map(([id, name, group, lang]) => {
    const t = tokens(name, { setName: groupSetName(group) })
    return { id, ...t, strict: strictOf(t.words), nums: numbersOf(t.words), lang }
  })
  // inverted index on the rarer words
  const index = new Map()
  for (const p of prepared) for (const w of p.words) { if (!index.has(w)) index.set(w, []); index.get(w).push(p) }
  const out = new Map()
  for (const [idProduct, name] of cm) {
    const t = tokens(name)
    const strict = strictOf(t.words), nums = numbersOf(t.words)
    const rare = [...t.words].filter(w => !KIND.has(w)).sort((a, b) => (index.get(a)?.length ?? 0) - (index.get(b)?.length ?? 0))
    if (!rare.length) continue
    const cands = new Set()
    for (const w of rare.slice(0, 2)) for (const p of index.get(w) ?? []) cands.add(p)
    let best = null, second = 0
    for (const p of cands) {
      if (p.strict !== strict || p.nums !== nums) continue
      if (t.ownInitials && p.initials && t.ownInitials !== p.initials) continue
      if (t.japanese && p.lang !== 'ja') continue
      let inter = 0, missRare = 0
      for (const w of t.words) if (p.words.has(w)) inter++; else if (!KIND.has(w)) missRare++
      // a distinctive word may be spelled differently ("Explosive Flame Walker"), one in three at most
      if (missRare > Math.floor(rare.length / 3)) continue
      // every Cardmarket word should be there; TCGplayer's extra words (its bracketed Pokémon) count less
      let extra = 0
      for (const w of p.words) if (!t.words.has(w)) extra += KIND.has(w) ? 0.02 : 0.08
      // the same name in both languages (Black Bolt): Cardmarket says "JP" on the Japanese one, so the other is English
      const score = inter / t.words.size - extra + (!t.japanese && p.lang === 'en' ? 0.06 : 0) + (t.ownInitials && p.initials === t.ownInitials ? 0.3 : 0)
      if (!best || score > best.score) { second = best?.score ?? second; best = { p, score } }
      else if (score > second) second = score
    }
    if (best && best.score >= minScore && best.score - second >= 0.05) out.set(idProduct, best.p.id)
  }
  return out
}

/**
 * The same name without what only changes the count inside, for a second pass: a box of 18 boosters looks
 * like the box of 36, an empty tin like the full one, a case of 6 boxes like TCGplayer's "Booster Box Case".
 */
export const looser = (name) => String(name).replace(/\s*\((\d+)\s+(cards|boosters)\)/ig, '').replace(/^empty\s+/i, '')
  .replace(/\bempty\s+/i, '').replace(/\b\d+\s+(?=(booster box|sleeved booster|elite trainer box|booster bundle|build & battle box)[\w\s]*case\b)/i, '')

/** matchSealed, then a looser second pass for what it left */
export function matchSealedAll(cm, tcg, opts) {
  const first = matchSealed(cm, tcg, opts)
  const rest = cm.filter(([id, name]) => !first.has(id) && looser(name) !== name).map(([id, name]) => [id, looser(name)])
  for (const [id, p] of matchSealed(rest, tcg, opts)) first.set(id, p)
  return first
}
