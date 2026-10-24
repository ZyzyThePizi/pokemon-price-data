// Cardmarket ids for cards TCGdex has none for (English: a sixth of the catalog; Japanese: a quarter, whole
// sets like White Flare, Black Bolt, MEGA Dream ex).
//
// Cardmarket names Pokémon singles "Name [ability | attack | …]" in English, Japanese cards too.
//   English cards: TCGdex lists each card's abilities and attacks, so the key is that signature.
//   Japanese cards: TCGdex's names and attacks are Japanese, so the key is the card's English name
//   (`opts.enName`, from Pokéllector's Japanese catalog by set and number), without attacks.
// Then:
//   1. Each set's Cardmarket expansion: the expansion most of the set's cards already point at, or else
//      the one most of its keys appear in (rarer keys weigh more), when it clearly wins. Only expansions
//      of the card's language count: never one that TCGdex's own ids place in the other language
//      (`opts.otherLang`), never one below 3700 for Japanese (Cardmarket's Japanese expansions all start
//      there), and for English sets before mid-2019 the old ones first (their Japanese twins came later).
//   2. Inside that expansion, cards and products with the same key are paired in number / product-id
//      order, only when both sides have the same count. An English card without attack text only
//      matches a unique name.
// Names are compared without spaces and level ("Dialga Lv.68" = Dialga, "MCharizard EX" = M Charizard EX,
// "Blastoise δ Delta Species" = Blastoise δ); Ancient Traits (δ Plus, θ Stop…) that Cardmarket leaves
// out of the signature are tried without.
// Measured against the cards TCGdex does map: see docs/dev/relay.md, "Cardmarket ids".
//
// Matched ids are marked: variants become [code, idProduct, 'm'], so the next build still prefers an id
// TCGdex adds later, and the matching starts afresh each time against Cardmarket's current product list.
// Only the plain printings get the id (n, h, r, x, p): a 1st edition or a special print (r:pokeball,
// h+stamp…) is its own product.

const JA_FIRST_EXPANSION = 3700
const OLD_EN_BEFORE = '2019-06'

const norm = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[’'`]/g, '').replace(/[^a-z0-9δ★]+/g, ' ').trim()
/** a name without spaces, level or "Delta Species" */
const nameKey = (s) => norm(String(s ?? '').replace(/\bLv\.?\s*\d+\b/gi, '').replace(/\bDelta Species\b/gi, '')).replace(/\s+/g, '')
const ANCIENT_TRAIT = /^\s*([αωθδΔΩ]\s|\{?title\}?:?$)/i
// rule marks Cardmarket writes as a move ("Heat Factory ◇ [Prism]")
const RULE_MOVE = new Set(['prism'])

function parseProduct(name) {
  const m = String(name).match(/^(.*?)\s*\[(.*)\]\s*$/)
  return m ? { base: nameKey(m[1]), moves: m[2].split('|').map(norm).filter(x => x && !RULE_MOVE.has(x)) } : { base: nameKey(name), moves: [] }
}
const sigOf = (base, moves) => `${base}|${moves.join('|')}`
const num = (id) => { const n = parseInt(id, 10); return Number.isFinite(n) ? n : 1e9 }
const PLAIN = /^[nhrxp]$/

/**
 * @param rows     card rows (CARD_FIELDS order) of one language, changed in place
 * @param fields   CARD_FIELDS
 * @param products { fields, rows } of prices/products.json
 * @param opts     { lang: 'en'|'ja', release(setId), otherLang: Set of idExpansion, enName(row) }
 * @returns how many cards got an id
 */
export function fillCardmarketIds(rows, fields, products, opts = {}) {
  const { lang = 'en', release = () => null, otherLang = new Set(), enName = () => null } = opts
  const F = Object.fromEntries(fields.map((k, i) => [k, i]))
  const P = Object.fromEntries(products.fields.map((k, i) => [k, i]))
  const eligible = (e) => !otherLang.has(e) && (lang !== 'ja' || e >= JA_FIRST_EXPANSION)
  const prodById = new Map()
  const byKey = new Map()
  const expSize = new Map() // products per expansion
  const expSingles = new Map() // expansion → its products that are cards (English: with moves)
  for (const r of products.rows) {
    if (r[P.idCategory] !== 51) continue // Pokémon singles
    const p = { id: r[P.idProduct], exp: r[P.idExpansion], ...parseProduct(r[P.name]) }
    prodById.set(p.id, p)
    if (!eligible(p.exp)) continue
    expSize.set(p.exp, (expSize.get(p.exp) ?? 0) + 1)
    if (p.moves.length || lang === 'ja') { if (!expSingles.has(p.exp)) expSingles.set(p.exp, []); expSingles.get(p.exp).push(p) }
    p.key = lang === 'ja' ? p.base : sigOf(p.base, p.moves)
    if (!byKey.has(p.key)) byKey.set(p.key, [])
    byKey.get(p.key).push(p)
  }

  // drop last run's matches: they are made again from today's product list
  for (const r of rows) r[F.variants] = (r[F.variants] ?? []).map(v => (v[2] === 'm' ? [v[0], null] : v))
  const known = (r) => (r[F.variants] ?? []).find(v => v[1])?.[1] ?? null
  const cardKey = (r) => {
    if (lang === 'ja') { const n = enName(r); return n ? nameKey(n) : null }
    const base = nameKey(r[F.name])
    const abilities = r[F.abilities] ?? [], attacks = r[F.attacks] ?? []
    const full = sigOf(base, [...abilities, ...attacks].map(norm))
    if (byKey.has(full)) return full
    const noTraits = sigOf(base, [...abilities.filter(a => !ANCIENT_TRAIT.test(a)), ...attacks].map(norm))
    return byKey.has(noTraits) ? noTraits : full
  }

  const bySet = new Map()
  for (const r of rows) { if (!bySet.has(r[F.setId])) bySet.set(r[F.setId], []); bySet.get(r[F.setId]).push(r) }

  let filled = 0
  for (const [setId, cards] of bySet) {
    const missing = cards.filter(r => !known(r))
    if (!missing.length) continue
    const keys = new Map(cards.map(r => [r, cardKey(r)]))
    // 1. the expansion
    const tally = new Map()
    for (const r of cards) {
      const p = prodById.get(known(r))
      if (p && eligible(p.exp)) tally.set(p.exp, (tally.get(p.exp) ?? 0) + 1)
    }
    let exp = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    if (exp == null) {
      let votes = new Map()
      for (const r of cards) {
        const exps = new Set((byKey.get(keys.get(r)) ?? []).map(p => p.exp))
        for (const e of exps) votes.set(e, (votes.get(e) ?? 0) + 1 / exps.size ** 0.5)
      }
      const rel = release(setId)
      if (lang === 'en' && rel && rel < OLD_EN_BEFORE && [...votes.keys()].some(e => e < JA_FIRST_EXPANSION)) {
        votes = new Map([...votes].filter(([e]) => e < JA_FIRST_EXPANSION))
      }
      const ranked = [...votes].sort((a, b) => b[1] - a[1])
      const [best, second] = ranked
      // enough of the set must point there: a quarter, or 15% when it is twice the runner-up (old sets of
      // common names weigh little: E1 26.9 of 128 against 12.5)
      const enough = best && (best[1] >= Math.max(3, cards.length * 0.25)
        || (best[1] >= Math.max(3, cards.length * 0.15) && (!second || best[1] >= second[1] * 2)))
      if (enough) {
        if (!(second && second[1] > best[1] * 0.8)) exp = best[0]
        else {
          // Close. First: how much of each expansion is this set (an Indonesian "Black & White" set holds
          // White Flare's names too, but half its cards are Black Bolt's); one must be clearly purer.
          const setKeys = new Set(cards.map(r => keys.get(r)).filter(Boolean))
          const close = ranked.filter(([, v]) => v > best[1] * 0.8).map(([e]) => e)
          const purity = (e) => { const own = expSingles.get(e) ?? []; return own.length ? own.filter(p => setKeys.has(p.key)).length / own.length : 0 }
          const top = Math.max(...close.map(purity))
          const pure = top >= 0.8 ? close.filter(e => purity(e) >= top * 0.8) : []
          if (pure.length === 1) exp = pure[0]
          else if (pure.length) {
            // then among the pure ones: as many cards as the set, when the others are clearly off
            // (White Flare JP, 174 cards: 6131 with 174 against a 152-card subset)
            const off = (e) => Math.abs((expSingles.get(e)?.length ?? 0) - cards.length) / cards.length
            const bySize = [...pure].sort((a, b) => off(a) - off(b))
            if (off(bySize[0]) <= 0.05 && bySize.slice(1).every(e => off(e) > 0.1)) exp = bySize[0]
          }
        }
      }
    }
    if (exp == null) continue
    // 2. the cards
    const groups = new Map()
    for (const r of missing) {
      const k = keys.get(r)
      if (!k) continue
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(r)
    }
    const used = new Set(cards.map(known).filter(Boolean))
    for (const [key, rs] of groups) {
      const ps = (byKey.get(key) ?? []).filter(p => p.exp === exp && !used.has(p.id)).sort((a, b) => a.id - b.id)
      // equal counts only: more products than cards (extra printings) or several name-only cards were
      // measured at 10–13% wrong pairs (2026-10-23), so they stay without an id
      if (!ps.length || ps.length !== rs.length) continue
      if (lang === 'en' && key.endsWith('|') && ps.length !== 1) continue
      rs.sort((a, b) => num(a[F.localId]) - num(b[F.localId]) || String(a[F.localId]).localeCompare(String(b[F.localId])))
      rs.forEach((r, i) => {
        const id = ps[i].id
        const vs = r[F.variants]?.length ? r[F.variants] : [['x', null]]
        // Cardmarket has one product per card (reverse holo is a price column, not a product)
        r[F.variants] = vs.map(v => (v[1] || !PLAIN.test(v[0]) ? v : [v[0], id, 'm']))
        filled++
      })
    }
  }
  return filled
}

/**
 * Cardmarket expansions placed in a language by its cards' ids: lang → Set. `withMatches` (a language)
 * also counts that language's own matches (the English run comes first, so the Japanese run knows which
 * expansions are White Flare's and Black Bolt's English twins even when TCGdex has no ids for them).
 */
export function expansionLanguages(products, rowsByLang, fields, withMatches = null) {
  const P = Object.fromEntries(products.fields.map((k, i) => [k, i]))
  const F = Object.fromEntries(fields.map((k, i) => [k, i]))
  const exp = new Map(products.rows.map(r => [r[P.idProduct], r[P.idExpansion]]))
  const out = {}
  for (const [lang, rows] of Object.entries(rowsByLang)) {
    out[lang] = new Set()
    for (const r of rows) for (const v of r[F.variants] ?? []) {
      if (v[1] && (v[2] !== 'm' || lang === withMatches) && exp.has(v[1])) out[lang].add(exp.get(v[1]))
    }
  }
  return out
}
