// An English name for every Japanese card (cards-ja.json "nameEn"), so the app finds a Japanese card by its
// English name ("Pikachu", "Battle Compressor") and shows it under the Japanese one. Measured 2026-10-28 on
// 17,394 cards: Cardmarket names 16,547, Pokéllector/TCGplayer 16,383; where both name a card they agree on
// 98% (the rest: Pokéllector's own translations, "Port Town" for the official "Po Town").
//
// In order, the first that fits:
//  1. Cardmarket's product name of the card's main product, without its attacks ("Hoppip [Continuous
//     Spin]" → "Hoppip"): the official English name where one exists. A Pokémon card's name must contain one
//     of its Pokémon's English names, so a wrong product link (SM4A Kakuna/Beedrill swapped) isn't used.
//  2. Pokéllector by set and number, else the TCGplayer product behind its picture (ja-english-names.mjs),
//     with the same Pokémon check.
//  3. A Pokémon card: the Japanese Pokémon name in it swapped for the English one ("ピカチュウex" →
//     "Pikachu ex"); with anything Japanese left over, the Pokémon's name and the card's Latin ending.
//  4. Any card: the English name most cards with the same Japanese name got above (2 in 3 of them at least).
import { readFile } from 'node:fs/promises'

const NON_LATIN = /[぀-ヿ㐀-鿿＀-￯]/
// the old naming words around a Pokémon's name, as the English cards print them
const AFFIXES = [
  [/^暗い/, 'Dark '], [/^明るい/, 'Light '], [/^ロケット団の/, "Rocket's "], [/^かがやく/, 'Radiant '], [/^ひかる/, 'Shining '],
  [/^(.+)の星$/, '$1 Star'], [/\s*[（(]デルタ種[）)]/, ' δ'],
]
// Japanese Trainers with no English name in any source (Cardmarket lists them without a link to the card,
// Pokéllector and TCGplayer skip the 1996 set): the names of their English prints (Base Set, Neo Discovery's
// Ruin Wall, Dragon Frontiers' Holon Legacy; Bulbapedia's set lists), measured missing 2026-10-28
const OLD_TRAINERS = {
  'エネルギー・リムーブ': 'Energy Removal', '突風': 'Gust of Wind', 'マサキ': 'Bill', 'オーキドはかせ': 'Professor Oak',
  'ディフェンダー': 'Defender', 'プラスパワー': 'PlusPower', 'ポケモンセンター': 'Pokémon Center', 'ポケモンの笛': 'Pokémon Flute',
  'ダウジングマシーン': 'Item Finder', '超エネルギーリムーブ': 'Super Energy Removal', '詐欺師オーク教授': 'Impostor Professor Oak',
  'ピッピ人形': 'Clefairy Doll', 'ポケモン回収': 'Scoop Up', 'ポケモン交換おじさん': 'Pokémon Trader', 'ポケモン育て屋さん': 'Pokémon Breeder',
  'ミニスカート': 'Lass', '壁を台無しにする[aerodactyl]': 'Ruin Wall', 'ホロンの遺産': 'Holon Legacy',
}
const ENERGY = { 草: 'Grass', 炎: 'Fire', 水: 'Water', 雷: 'Lightning', 超: 'Psychic', 闘: 'Fighting', 悪: 'Darkness', 鋼: 'Metal', フェアリー: 'Fairy' }
const ENERGY_RE = new RegExp(`^基本(${Object.keys(ENERGY).join('|')})エネルギー$`)
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/♀/g, 'f').replace(/♂/g, 'm')
  .toLowerCase().replace(/[^a-z0-9]/g, '')
/** "Hoppip [Continuous Spin]", "Pikachu (Pokémon Center)" → "Hoppip", "Pikachu" */
export const cardmarketBase = (n) => String(n ?? '').replace(/\s*\[.*$/, '').replace(/\s*\(.*$/, '').trim()

/**
 * @param cards    Japanese card rows
 * @param F        field index ({ name, category, dexIds, variants })
 * @param opts     { root, productName(idProduct) → name | null, otherName(row) → English name | null }
 * @returns { name(row) → English name | null, counts }
 */
export async function englishNames(cards, F, { root, productName, otherName }) {
  const dex = new Map() // dex → { en, ja }
  try {
    const p = JSON.parse(await readFile(`${root}/catalog/pokedex-v2.json`, 'utf8'))
    const f = Object.fromEntries(p.fields.map((n, i) => [n, i]))
    for (const r of p.rows) if (r[f.formKind] === 'base' && !dex.has(r[f.dex])) dex.set(r[f.dex], { en: r[f.name], ja: r[f.nameJa] })
  } catch { /* no Pokédex: steps 1, 2 and 4 only */ }
  const species = (r) => [...new Set((r[F.dexIds] ?? []).map(Math.floor))].map(d => dex.get(d)).filter(Boolean)
  // a Pokémon card's English name must name one of its Pokémon; other cards can't be checked
  const fits = (r, en) => {
    if (!en || NON_LATIN.test(en)) return false
    const sp = species(r)
    return r[F.category] !== 'Pokemon' || !sp.length || sp.some(s => norm(en).includes(norm(s.en)))
  }
  const out = new Map()
  const counts = { cardmarket: 0, other: 0, pokemon: 0, sameName: 0, none: 0 }
  for (const r of cards) {
    const main = (r[F.variants] ?? []).find(v => v[1])?.[1]
    const cm = main ? cardmarketBase(productName(main)) : null
    if (fits(r, cm)) { out.set(r[0], cm); counts.cardmarket++; continue }
    const other = otherName(r)
    if (fits(r, other)) { out.set(r[0], other); counts.other++; continue }
    const energy = ENERGY_RE.exec(String(r[F.name] ?? '').trim())
    if (energy) { out.set(r[0], `${ENERGY[energy[1]]} Energy`); counts.pokemon++; continue }
    const sp = species(r)
    if (r[F.category] === 'Pokemon' && sp.length) {
      let s = String(r[F.name] ?? '').trim()
      for (const [re, en] of AFFIXES) s = s.replace(re, en)
      for (const x of sp) {
        if (x.ja) s = s.split(x.ja).join(` ${x.en} `)
        // a Latin name TCGdex wrote in lower case ("quagsire")
        s = s.replace(new RegExp(`\\b${x.en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), x.en)
      }
      s = s.replace(/\s+/g, ' ').trim()
      if (NON_LATIN.test(s) || !s) {
        const tail = /([A-Za-z][A-Za-z0-9.\s-]*)$/.exec(String(r[F.name] ?? ''))?.[1]?.trim()
        s = sp.length === 1 ? [sp[0].en, tail && norm(tail) !== norm(sp[0].en) ? tail : null].filter(Boolean).join(' ') : ''
      }
      if (s) { out.set(r[0], s); counts.pokemon++; continue }
    }
  }
  // 4. the same Japanese name elsewhere; a Trainer's name without Cardmarket's person after it ("Professor's
  //    Research - Professor Sada", "Boss's Orders - Ghetsis"), so the prints agree on "Professor's Research"
  const byJa = new Map()
  for (const r of cards) {
    const got = out.get(r[0])
    const en = got && r[F.category] !== 'Pokemon' ? got.replace(/\s+-\s+.*$/, '') : got
    if (!en) continue
    const k = String(r[F.name]).trim(), m = byJa.get(k) ?? new Map()
    m.set(en, (m.get(en) ?? 0) + 1)
    byJa.set(k, m)
  }
  for (const r of cards) {
    if (out.has(r[0])) continue
    const m = byJa.get(String(r[F.name]).trim())
    const total = m ? [...m.values()].reduce((a, b) => a + b, 0) : 0
    const [best, n] = m ? [...m].sort((a, b) => b[1] - a[1])[0] : [null, 0]
    if (best && n * 3 >= total * 2) { out.set(r[0], best); counts.sameName++; continue }
    // 5. the old Trainers no source names (the 1996 Expansion Pack, neo2, PCG9), as their English prints are called
    const old = OLD_TRAINERS[String(r[F.name] ?? '').trim()]
    if (old) { out.set(r[0], old); counts.old = (counts.old ?? 0) + 1 } else counts.none++
  }
  return { name: (r) => out.get(r[0]) ?? null, counts }
}
