// Which Pokémon form a card shows, from its printed name, its type and the
// Pokédex (catalog/pokedex-v2.json). One PokeAPI Pokémon id per entry of the
// card's dexIds; a card with only base forms gets null.
//
// Rules (docs/data-plan.md step 7):
// - Mega: XY "M Charizard-EX", "Mega Lucario ex", TAG TEAM "Mega Sableye & Tyranitar-GX",
//   Japanese "MリザードンEX" / "メガリザードンXex" (メガ only counts when the species'
//   own name follows: メガニウム is Meganium). Two Megas (X/Y, Z): the letter in the
//   name, else the one whose type matches the card's;
// - Primal: "Primal Groudon-EX", "ゲンシグラードン";
// - VMAX: the Gigantamax form when the species has one (Urshifu by style),
//   Eternatus → Eternamax; otherwise the base form;
// - regional: Alolan/Galarian/Hisuian/Paldean (アローラ/ガラル/ヒスイ/パルデア),
//   Paldean Tauros breed by type (Fire → Blaze, Water → Aqua, else Combat);
// - named forms (Origin Forme, Ice Rider, Rapid Strike, Dusk Mane, Wash Rotom,
//   Bloodmoon, Wellspring Mask …): the form's name in the card's name;
// - everything else (owner prefixes, δ, Radiant, Shining, Dark/Light): base.

const TCG_TYPE = {
  fire: 'Fire', water: 'Water', ice: 'Water', grass: 'Grass', bug: 'Grass', electric: 'Lightning', psychic: 'Psychic',
  ghost: 'Psychic', poison: 'Psychic', fairy: 'Fairy', fighting: 'Fighting', rock: 'Fighting', ground: 'Fighting',
  dark: 'Darkness', steel: 'Metal', dragon: 'Dragon', normal: 'Colorless', flying: 'Colorless',
}
const REGION_WORD = { Alolan: 'alola', Galarian: 'galar', Hisuian: 'hisui', Paldean: 'paldea' }
const REGION_JA = { アローラ: 'alola', ガラル: 'galar', ヒスイ: 'hisui', パルデア: 'paldea' }
// two Megas of one species with no letter on the card: the TCG type that means X
const XY_BY_TYPE = { 6: { x: 'Dragon' }, 150: { x: 'Fighting' } }
// form names that are not printed on cards
const UNNAMED = /^(female|male|.*core|.*meteor|.*cloak|zen mode|gulping|gorging|hangry mode|noice face|school form|busted form|hero form|family of three|three-segment form)$/i

export function formIndex(pokedex) {
  const f = Object.fromEntries(pokedex.fields.map((n, i) => [n, i]))
  const byDex = new Map()
  for (const r of pokedex.rows) {
    const e = { id: r[f.id], dex: r[f.dex], slug: r[f.slug], name: r[f.name], formName: r[f.formName], kind: r[f.formKind],
      ja: r[f.nameJa], t1: r[f.type1], t2: r[f.type2] }
    if (!byDex.has(e.dex)) byDex.set(e.dex, [])
    byDex.get(e.dex).push(e)
  }
  return byDex
}

const lower = (s) => String(s ?? '').toLowerCase()
const stripForm = (s) => lower(s).replace(/\s+(forme?|style|mode|breed)$/, '').trim()

function pickByType(list, types) {
  const want = new Set(types ?? [])
  return list.find(e => want.has(TCG_TYPE[e.t1])) ?? list.find(e => want.has(TCG_TYPE[e.t2])) ?? list[0]
}

/** The form one species shows on this card. */
function formFor(dex, card, lang, byDex) {
  const all = byDex.get(dex)
  if (!all) return null
  const base = all.find(e => e.kind === 'base')
  const name = String(card.name ?? '')
  const ja = base?.ja ?? ''
  const forms = (k) => all.filter(e => e.kind === k)

  // Mega / Primal
  const megas = forms('mega')
  if (megas.length) {
    const primal = megas.find(e => /-primal$/.test(e.slug))
    if (primal && (/^Primal\s/i.test(name) || (lang === 'ja' && ja && name.startsWith('ゲンシ' + ja)))) return primal.id
    const isMega = lang === 'ja'
      ? !!ja && (name.startsWith('メガ' + ja) || name.startsWith('M' + ja))
      : /^M\s/.test(name) || /^Mega\s/i.test(name)
    if (isMega) {
      const plain = megas.filter(e => !/-primal$/.test(e.slug))
      if (plain.length === 1) return plain[0].id
      const letter = (lang === 'ja' ? name.slice(('メガ' + ja).length).match(/^([XYZ])/) : name.match(/\bMega\s+[^&]*?\s([XYZ])(?:\s|$|-)/i))?.[1]?.toUpperCase()
      if (letter) {
        const hit = plain.find(e => new RegExp(`-mega-${letter.toLowerCase()}$`).test(e.slug))
        if (hit) return hit.id
      }
      // XY's "M Charizard-EX" / "M Mewtwo-EX" carry no letter: both Charizard Megas are Fire,
      // so the card's type is read as the data plan says (Dragon → X, else Y; Fighting → X, else Y)
      const xy = XY_BY_TYPE[dex]
      if (xy) {
        const letter2 = (card.types ?? []).includes(xy.x) ? 'x' : 'y'
        const hit = plain.find(e => e.slug.endsWith(`-mega-${letter2}`))
        if (hit) return hit.id
      }
      // otherwise plain "-mega" if there is one, else the type decides
      return (plain.find(e => /-mega$/.test(e.slug)) ?? pickByType(plain, card.types))?.id ?? null
    }
  }
  // VMAX → Gigantamax when the species has one
  if (/VMAX\b/.test(name)) {
    const gmax = forms('gigantamax')
    if (gmax.length === 1) return gmax[0].id
    if (gmax.length > 1) {
      if (/rapid strike|れんげき/i.test(name)) return (gmax.find(e => /rapid/.test(e.slug)) ?? gmax[0]).id
      if (/single strike|いちげき/i.test(name)) return (gmax.find(e => /single/.test(e.slug)) ?? gmax[0]).id
      return (gmax.find(e => !/low-key|rapid/.test(e.slug)) ?? gmax[0]).id
    }
  }
  // regional
  const regional = forms('regional')
  if (regional.length) {
    const word = lang === 'ja'
      ? Object.entries(REGION_JA).find(([w]) => name.startsWith(w))?.[1]
      : Object.entries(REGION_WORD).find(([w]) => new RegExp(`\\b${w}\\s`).test(name))?.[1]
    if (word) {
      const list = regional.filter(e => e.slug.includes(`-${word}`))
      if (list.length === 1) return list[0].id
      if (list.length > 1) {
        // Paldean Tauros: the breed by type; Galarian Darmanitan: Standard unless "Zen"
        const t = new Set(card.types ?? [])
        if (dex === 128) return (list.find(e => (t.has('Fire') && /blaze/.test(e.slug)) || (t.has('Water') && /aqua/.test(e.slug))) ?? list.find(e => /combat/.test(e.slug)) ?? list[0]).id
        return (list.find(e => /zen/.test(e.slug) && /zen/i.test(name)) ?? list.find(e => !/zen/.test(e.slug)) ?? list[0]).id
      }
    }
  }
  // named forms, English names only
  if (lang !== 'ja') {
    const n = lower(name)
    for (const e of forms('other')) {
      if (!e.formName || UNNAMED.test(e.formName)) continue
      const keys = [lower(e.name), stripForm(e.formName)].filter(k => k.length >= 3)
      if (keys.some(k => n.includes(k))) return e.id
    }
  }
  return base?.id ?? dex
}

/** PokeAPI ids for the card's dexIds, or null when every one is its base form. */
export function cardForms(card, lang, byDex) {
  const dexIds = card.dexIds ?? []
  if (!dexIds.length) return null
  // TAG TEAM and other multi-Pokémon names: each part of "A & B" speaks for its own
  // Pokémon ("Mega Sableye & Tyranitar-GX" is Mega Sableye with an ordinary Tyranitar)
  // TCGdex sorts dexIds, so each part goes to the Pokémon whose name it contains
  const parts = dexIds.length > 1 ? String(card.name ?? '').split(/\s*[&＆]\s*/) : []
  const partFor = (d) => {
    if (parts.length < 2) return card.name
    const base = byDex.get(d)?.find(e => e.kind === 'base')
    const hit = parts.find(p => (base?.name && lower(p).includes(lower(base.name))) || (base?.ja && p.includes(base.ja)))
    return hit ?? card.name
  }
  const ids = dexIds.map(d => formFor(d, { ...card, name: partFor(d) }, lang, byDex) ?? d)
  return ids.some((id, i) => id !== dexIds[i]) ? ids : null
}
