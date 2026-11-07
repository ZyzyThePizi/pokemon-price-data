// English names for Japanese cards, for matching them to Cardmarket (which names Japanese cards in
// English): Pokéllector's Japanese catalog (catalog/pokellector_jp.json) by set and number. A set is only
// used when Pokéllector's numbering is TCGdex's: on every number whose Pokémon both sides name, the
// Pokémon agree (at most 1 in 50 may differ, at least 5 must agree).
import { readFile } from 'node:fs/promises'
import { pokedexByName, cardDex } from './tcgplayer-images.mjs'

/**
 * @param root     repo root
 * @param setRows  sets.json rows (SET_FIELDS) of the Japanese sets: [id, lang, name, …, pokellector slug (11)]
 * @param cards    Japanese card rows (CARD_FIELDS)
 * @param aliases  TCGdex set id (without "ja-") → Pokéllector set code, for sets the build did not match
 * @returns { name(row) → English name | null, sets: how many sets have names }
 */
export async function japaneseEnglishNames(root, setRows, cards, aliases = {}) {
  let data
  try { data = JSON.parse(await readFile(`${root}/catalog/pokellector_jp.json`, 'utf8')) } catch { return { name: () => null, sets: 0 } }
  const sf = Object.fromEntries(data.setFields.map((n, i) => [n, i]))
  const cf = Object.fromEntries(data.cardFields.map((n, i) => [n, i]))
  const slugByCode = new Map()
  for (const s of data.sets) if (!slugByCode.has(s[sf.setCode])) slugByCode.set(s[sf.setCode], s[sf.slug])
  const dexOf = await pokedexByName(root)
  const bySet = new Map()
  for (const r of cards) { if (!bySet.has(r[1])) bySet.set(r[1], []); bySet.get(r[1]).push(r) }
  const names = new Map() // card id → English name
  let sets = 0
  for (const s of setRows) {
    const id = s[0], plain = String(id).replace(/^ja-/, '')
    const slug = s[11] ?? (aliases[plain] ? slugByCode.get(aliases[plain]) : null)
    const pk = data.cards[slug]
    if (!pk?.length) continue
    const byNumber = new Map()
    for (const c of pk) { const n = parseInt(c[cf.number], 10); if (Number.isFinite(n) && !byNumber.has(n)) byNumber.set(n, c[cf.name]) }
    const rows = bySet.get(id) ?? []
    let agree = 0, disagree = 0
    for (const r of rows) {
      const n = byNumber.get(parseInt(r[2], 10)); const a = n ? dexOf(n) : null, b = cardDex(r)
      if (a != null && b != null) (r[7] ?? []).map(Math.floor).includes(a) ? agree++ : disagree++
    }
    if (agree < 5 || disagree > agree / 50) continue
    sets++
    for (const r of rows) { const n = byNumber.get(parseInt(r[2], 10)); if (n) names.set(r[0], n) }
  }
  // then: the sets TCGdex has no cards for, which were built from TCGplayer's list (ja-empty-sets.mjs):
  // its English name for that number
  let empty = {}
  try { empty = JSON.parse(await readFile(`${root}/catalog/v2/ja-empty-sets.json`, 'utf8')).sets ?? {} } catch { /* none */ }
  for (const r of cards) {
    if (names.has(r[0])) continue
    const t = empty[String(r[1]).replace(/^ja-/, '')]?.tcg?.find(c => c.number === String(parseInt(r[2], 10)))
    if (t?.name) names.set(r[0], t.name.replace(/\s*\([^)]*\)/g, '').trim())
  }
  // then: the TCGplayer product behind the card's picture (old sets Pokéllector lacks; that match was
  // checked by number and Pokémon when the picture was chosen, tcgplayer-images.mjs)
  let tcgp = {}
  try { tcgp = JSON.parse(await readFile(`${root}/catalog/v2/image-fallbacks.json`, 'utf8')).tcgplayerNames ?? {} } catch { /* none */ }
  const clean = (n) => String(n).replace(/\s+-\s+[A-Z]*\d+(\/[A-Z]*\d+)?\s*$/i, '').replace(/\s*\([^)]*\)/g, '').trim()
  let fromTcgplayer = 0
  for (const r of cards) {
    if (names.has(r[0])) continue
    const m = /tcgplayer\.com\/product\/(\d+)_/.exec(r[11] ?? '')
    if (m && tcgp[m[1]]) { names.set(r[0], clean(tcgp[m[1]])); fromTcgplayer++ }
  }
  return { name: (r) => names.get(r[0]) ?? null, sets, fromTcgplayer }
}
