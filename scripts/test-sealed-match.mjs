// Regression cases for scripts/lib/sealed-match.mjs: node scripts/test-sealed-match.mjs
// Each Cardmarket name must get the expected TCGplayer product (or none, null) out of the candidates.
import assert from 'node:assert/strict'
import { matchSealedAll } from './lib/sealed-match.mjs'

const tcg = [
  [1, 'Celestial Storm Theme Deck - "Leaf Charge" [Sceptile]', 'SM - Celestial Storm', 'en'],
  [2, '2016 World Championship Deck: Shintaro Ito (Magical Symphony)', 'World Championship Decks', 'en'],
  [3, 'Mega Blaziken EX Premium Collection', 'XY - BREAKthrough', 'en'],
  [4, 'Flareon VMAX Premium Collection', 'Miscellaneous Cards & Products', 'en'],
  [5, 'Flareon VMAX Premium Collection (EU Exclusive)', 'Miscellaneous Cards & Products', 'en'],
  [6, 'Evolving Skies Build & Battle Stadium', 'SWSH07: Evolving Skies', 'en'],
  [7, 'Evolving Skies Build & Battle Box', 'SWSH07: Evolving Skies', 'en'],
  [8, 'Mega Tyranitar EX Premium Collection', 'SM - Guardians Rising', 'en'],
  [9, 'Azure Legends Tin [Xerneas ex]', 'Miscellaneous Cards & Products', 'en'],
  [10, 'Reshiram & Charizard GX Premium Collection', 'Miscellaneous Cards & Products', 'en'],
  [11, 'Charizard GX Premium Collection', 'SM - Burning Shadows', 'en'],
  [12, 'Paldea Friends Mini Tin [Sprigatito & Fidough]', 'Miscellaneous Cards & Products', 'en'],
  [13, 'Pokemon Card 151 Booster Pack', 'SV2a: Pokemon Card 151', 'ja'],
  [14, '151 Booster Pack', 'SV: Scarlet & Violet 151', 'en'],
  [15, 'Pokemon TCG: EX Collector\'s Box [Rayquaza]', 'Miscellaneous Cards & Products', 'en'],
  [16, 'Rayquaza EX Box', 'XY - Roaring Skies', 'en'],
  [17, 'Pokemon TCG: EX Collector\'s Box [Deoxys]', 'Miscellaneous Cards & Products', 'en'],
  [18, 'MEGA Expansion 30th Celebration Booster Pack', 'M6a: MEGA Expansion 30th Celebration', 'ja'],
  [19, 'Elite Trainer Box [Mewtwo X]', 'XY - BREAKthrough', 'en'],
  [20, 'McDonald\'s 2022 Match & Battle Pack', 'McDonald\'s Promos 2022', 'en'],
  [21, 'Mega Evolution: Ascended Heroes Collection - Erika (3-Tab)', 'ME: Ascended Heroes', 'en'],
  [22, 'Mega Evolution: Ascended Heroes Collection - Larry (3-Tab)', 'ME: Ascended Heroes', 'en'],
]
const cases = [
  ['Leaf Charge Theme Deck', 1], // the era prefix "SM - " is no word of the set
  ['WCD 2016: Magical Symphony', 2],
  ['MBlaziken EX Premium Collection', 3],
  ['Flareon VMAX Premium Collection US Version', 4],
  ['Evolving Skies Build & Battle Stadium Box', 6],
  ['Tyranitar ex Premium Collection', null], // not the Mega one
  ['Legends of Kalos Tins: Xerneas EX Tin', null], // 2014, not 2025's Azure Legends
  ['Charizard GX Premium Collection', 11], // not the tag team's
  ['Paldea Friends Mini Tins: Sprigatito Tin', 12], // a tin's bracketed Pokémon are no tag team
  ['151 Booster', 14, 'en'], // an English expansion takes the English pack
  ['Rayquaza EX Box', 16],
  ['EX Collector\'s Box: Deoxys Box', 17],
  ['30th Celebration JP Booster', 18],
  ['BREAKthrough Elite Trainer Box (Mega Mewtwo X)', 19], // Mega on Cardmarket's side only is fine
  ['McDonald\'s Match Battle 2022 Booster', 20],
  ['Ascended Heroes: Erika\'s Tangela 2-Pack Blister', 21],
  ['Ascended Heroes: Larry\'s Komala 2-Pack Blister', 22],
]
let failed = 0
for (const [name, want, lang] of cases) {
  const got = matchSealedAll([[1000, name, lang ?? null]], tcg).get(1000) ?? null
  try { assert.equal(got, want) } catch { failed++; console.log(`FAIL ${name}: got ${got}, want ${want}`) }
}
console.log(failed ? `${failed} of ${cases.length} failed` : `all ${cases.length} pass`)
process.exit(failed ? 1 : 0)
