// The Japanese sets TCGdex has no cards for, on made-up source answers, no network:
// `node scripts/test-ja-empty-sets.mjs` (reads catalog/pokedex-v2.json for the Pokédex names)
// - parseTcgplayer: one card per number, the mirror holo product marks the card, sealed products skipped;
// - parseLimitless: number, Japanese name, stage, type, rarity, the large picture;
// - buildSet: TCGplayer's list with Limitless's Japanese names where both name the same Pokémon, TCGdex's
//   rarity words and print codes, both runs in a 1st Edition + unlimited set, English names when the
//   numbering disagrees;
// - fillCardmarketIds: a Sword & Shield era Japanese set may use an expansion below 3700, an older one not.
import { parseTcgplayer, parseLimitless, buildSet, pokedexByJapaneseName } from './lib/ja-empty-sets.mjs'
import { pokedexByName } from './lib/tcgplayer-images.mjs'
import { fillCardmarketIds } from './lib/cm-match.mjs'

let failed = 0
const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) failed++ }
const ext = (o) => Object.entries(o).map(([name, value]) => ({ name, value }))
const prod = (id, name, e) => ({ productId: id, name, imageCount: 1, extendedData: ext(e) })

const tcg = parseTcgplayer({ results: [
  prod(10, 'Rowlet - 001/190', { Number: '001/190', Rarity: 'None', CardType: 'Grass', HP: '50', Stage: 'Basic' }),
  prod(11, 'Rowlet (Mirror Holofoil) - 001/190', { Number: '001/190', Rarity: 'None' }),
  prod(12, 'Charizard VMAX - 002/190', { Number: '002/190', Rarity: 'Super Rare', CardType: 'Fire', HP: '330', Stage: 'VMAX' }),
  prod(13, "Boss's Orders - 003/190", { Number: '003/190', Rarity: 'Uncommon', CardType: 'Supporter' }),
  prod(14, 'Pikachu - 330/190', { Number: '330/190', Rarity: 'Ultra Rare', CardType: 'Lightning', HP: '70', Stage: 'Basic' }),
  prod(15, 'Shiny Star V Booster Box', { }),
] })
ok(tcg.length === 4, `TCGplayer: one card per number, sealed skipped (${tcg.length})`)
ok(tcg[0].mirror === true && tcg[0].id === 10 && tcg[0].rarity === null, 'TCGplayer: the mirror product marks the card; "None" is no rarity')
ok(tcg[3].number === '330', 'TCGplayer: a secret rare above the total keeps its number')

const html = (n, name, stage, sym, rarity) => `<tr data-hover="https://cdn/tpc/S4a/S4a_${n}_R_JP_XS.png">
  <td><span class="card-set" data-tooltip="ハイクラスパック「シャイニースターV」">S4a</span></td><td><a>${n}</a></td><td><a>${name}</a></td>
  <td class="md-only"><a>${sym ? `<span class="ptcg-symbol">${sym}</span>` : ''} ${stage}</a></td><td class="md-only"><a> ${rarity} </a></td><td></td><td></td></tr>`
const lim = parseLimitless('<table>' + html(1, 'モクロー', 'Basic', 'G', '') + html(2, 'リザードンVMAX', 'VMAX', 'R', 'Secret Rare')
  + html(3, 'ボスの指令', 'Supporter', '', 'Uncommon') + '</table>')
ok(lim.length === 3 && lim[0].name === 'モクロー' && lim[0].types[0] === 'G' && lim[0].rarity === '', 'Limitless: name, type, blank rarity')
ok(lim[1].image.endsWith('_2_R_JP_LG.png'), 'Limitless: the large picture')

const dex = { dexEn: await pokedexByName('.'), dexJa: await pokedexByJapaneseName('.') }
ok(dex.dexJa('ポリゴン2') === 233 && dex.dexJa('ポリゴンZ') === 474 && dex.dexJa('リザードンVMAX') === 6, 'Pokédex: Japanese names, full-width forms folded')
// agreement needs 5 Pokémon (or half a small set): pad with 4 more that agree
const pad = (n, en, ja) => [{ number: String(n), id: 100 + n, name: en, rarity: 'Common', type: 'Water', hp: 60, stage: 'Basic' },
  { number: String(n), name: ja, stage: 'Basic', types: ['W'], rarity: 'Common', image: `https://cdn/${n}.png` }]
const extra = [pad(4, 'Squirtle', 'ゼニガメ'), pad(5, 'Psyduck', 'コダック'), pad(6, 'Lapras', 'ラプラス'), pad(7, 'Magikarp', 'コイキング')]
const b = buildSet('S4a', [...tcg, ...extra.map(e => e[0])], [...lim, ...extra.map(e => e[1])], dex)
const by = Object.fromEntries(b.rows.map(r => [r[0], r]))
ok(b.useLim && by['S4a-001'][3] === 'モクロー' && b.en.get('S4a-001') === 'Rowlet', 'S4a: the Japanese name, the English one kept for Cardmarket')
ok(JSON.stringify(by['S4a-001'][12]) === '[["n",null],["r",null]]' && by['S4a-001'][4] === 'None', 'S4a: a common with a mirror holo: n and r')
ok(by['S4a-002'][4] === 'Ultra Rare' && by['S4a-002'][12][0][0] === 'h' && by['S4a-002'][10] === 'VMAX' && by['S4a-002'][9] === 330,
  "S4a: TCGplayer's Super Rare is TCGdex's Ultra Rare, holo, VMAX, its HP")
ok(by['S4a-003'][5] === 'Trainer' && by['S4a-003'][7] === null && by['S4a-003'][3] === 'ボスの指令', 'S4a: a supporter is a Trainer, no Pokédex number')
ok(by['S4a-330'][3] === 'Pikachu' && by['S4a-330'][4] === 'Secret Rare' && /tcgplayer-cdn.*_400w\.jpg$/.test(by['S4a-330'][11]),
  'S4a: a secret rare Limitless lacks: English name, Secret Rare, TCGplayer picture')

const adv = buildSet('ADV1', [{ number: '1', id: 1, name: 'Treecko', rarity: 'Rare', type: 'Grass', hp: 50, stage: 'Basic' },
  { number: '2', id: 2, name: 'Sceptile ex', rarity: 'Holo Rare', type: 'Grass', hp: 150, stage: 'Stage 2' }], [], dex)
ok(JSON.stringify(adv.rows[0][12]) === '[["n",null],["n+1st edition",null]]', 'ADV1: a plain Rare is not holo before XY; both runs')
ok(adv.rows[1][12][0][0] === 'h' && adv.rows[1][7]?.[0] === 254 && adv.rows[1][10] === 'Stage2', 'ADV1: a Holo Rare is holo; Pokédex number from the English name')

const wrong = buildSet('XY2', extra.map(e => e[0]), extra.map((e, i) => ({ ...e[1], name: ['フシギダネ', 'ヒトカゲ', 'ピカチュウ', 'イーブイ'][i] })), dex)
ok(!wrong.useLim && wrong.rows.every(r => /^[A-Za-z]/.test(r[3])), 'XY2: numbering that disagrees keeps the English names')

// Cardmarket: expansion 3580 (below 3700) for a set from 2020, not for one from 2016
const products = { fields: ['idProduct', 'name', 'idExpansion', 'idCategory'], rows: [
  [900, 'Rowlet [Sky Circus | Wind Shard]', 3580, 51], [901, 'Charizard VMAX [G-Max Wildfire]', 3580, 51],
  [902, 'Squirtle [Bubble]', 3580, 51], [903, 'Psyduck [Headache]', 3580, 51], [904, 'Lapras [Sing]', 3580, 51]] }
const fields = ['id', 'setId', 'localId', 'name', 'rarity', 'category', 'illustrator', 'dexIds', 'types', 'hp', 'stage', 'image', 'variants']
const cmRows = (set) => ['Rowlet', 'Charizard VMAX', 'Squirtle', 'Psyduck', 'Lapras'].map((n, i) => [`${set}-00${i + 1}`, set, `00${i + 1}`, n, null, 'Pokemon', null, null, null, null, null, null, [['n', null]]])
const names = (r) => r[3]
const s4a = cmRows('S4a'), cp = cmRows('CP3')
fillCardmarketIds(s4a, fields, products, { lang: 'ja', release: () => '2020-11-20', enName: names })
fillCardmarketIds(cp, fields, products, { lang: 'ja', release: () => '2016-01-29', enName: names })
ok(s4a[0][12][0][1] === 900 && s4a[4][12][0][1] === 904, 'Cardmarket: a 2020 Japanese set takes its expansion 3580')
ok(cp.every(r => r[12][0][1] == null), 'Cardmarket: a 2016 Japanese set does not (below 3700)')

console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
