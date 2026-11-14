// The print fixes on made-up rows, no network: `node scripts/test-print-fixes.mjs`
// - dropSetMarks: a 1st-Edition-only set (VS1) keeps one print per card, with the Cardmarket product;
// - fillReverseHolos: adds a reverse holo where pokemontcg.io lists one and the card has none, on the card's own
//   product; leaves cards with a reverse, cards without one, and sets whose names don't agree.
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dropSetMarks } from './lib/set-marks.mjs'
import { fillReverseHolos } from './lib/reverse-holos.mjs'

let failed = 0
const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) failed++ }
// id, setId, localId, name, … variants at 12
const row = (id, set, num, name, variants) => { const r = Array(17).fill(null); Object.assign(r, { 0: id, 1: set, 2: num, 3: name, 12: variants }); return r }

const vs = [
  row('VS1-001', 'VS1', '001', 'A', [['h', 554288, 'm'], ['h+1st-edition', null]]),
  row('VS1-002', 'VS1', '002', 'B', [['n', null], ['n+1st-edition', 777]]),
  row('VS1-021', 'VS1', '021', 'C', [['n', 554345, 'm']]),
  row('VS1-030', 'VS1', '030', 'D', [['n+1st edition', 888]]),
  row('neo1-1', 'neo1', '1', 'E', [['h', 1], ['h+1st-edition', 2]]),
]
const marks = dropSetMarks(vs)
ok(JSON.stringify(vs[0][12]) === JSON.stringify([['h', 554288, 'm']]), 'VS1: the 1st Edition entry goes, the plain one with its product stays')
ok(JSON.stringify(vs[1][12]) === JSON.stringify([['n', 777]]), 'VS1: a plain entry with no product takes the edition\'s')
ok(JSON.stringify(vs[3][12]) === JSON.stringify([['n', 888]]), 'VS1: only the edition listed (Japanese spelling): it becomes the plain entry')
ok(vs[4][12].length === 2, 'another set keeps its 1st Edition print')
ok(marks['VS1 +1st-edition (1st Edition only)'] === 3, 'the build log counts the dropped entries')

const dir = await mkdtemp(path.join(tmpdir(), 'rev-'))
const cache = path.join(dir, 'reverse-holos.json')
const now = Date.now()
await writeFile(cache, JSON.stringify({
  ptcgSets: { at: now, ids: ['sm115', 'ex11', 'xx1'] },
  sets: {
    sm115: { ptcg: 'sm115', at: now, cards: { 1: ['Caterpie', 1], 6: ['Tentacruel-GX', 0], 8: ['Weedle', 1], 30: ['Pikachu', 1] } },
    ex11: { ptcg: 'ex11', at: now, cards: { 1: ['Bellossom', 1] } },
    xx1: { ptcg: 'xx1', at: now, cards: { 1: ['Someone Else', 1], 2: ['Another', 1] } },
  },
}))
const cards = [
  row('sm115-1', 'sm115', '1', 'Caterpie', [['n', 394607, 'm']]),
  row('sm115-6', 'sm115', '6', 'Tentacruel GX', [['h', 394787]]),
  row('sm115-8', 'sm115', '8', 'Weedle', [['n', null]]),
  row('sm115-30', 'sm115', '30', 'Pikachu', [['n', 5], ['r', 5]]),
  row('ex11-1', 'ex11', '1', 'Bellossom', [['h', 9], ['h+1st-edition', null]]),
  row('xx1-1', 'xx1', '1', 'Caterpie', [['n', 3]]),
  row('xx1-2', 'xx1', '2', 'Weedle', [['n', 4]]),
]
const guide = [[394607, 0.1, 0.2, null, null, null, 0.15, 0.3, null]]
const res = await fillReverseHolos(cards, () => '2019-08-23', cache, guide)
ok(JSON.stringify(cards[0][12]) === JSON.stringify([['n', 394607, 'm'], ['r', 394607, 'p']]), 'Hidden Fates Caterpie: a reverse holo on its own product, marked p')
ok(cards[1][12].length === 1, 'a GX with no reverse holo stays as it is')
ok(JSON.stringify(cards[2][12]) === JSON.stringify([['n', null], ['r', null, 'p']]), 'a card with no product yet still gets the print')
ok(cards[3][12].length === 2, 'a card that already has a reverse holo is left alone')
ok(JSON.stringify(cards[4][12].at(-1)) === JSON.stringify(['r', 9, 'p']), 'a holo card: the reverse on the holo\'s product')
ok(cards[5][12].length === 1 && cards[6][12].length === 1, 'a set whose names don\'t agree by number gets nothing')
ok(res.added === 3 && res.cmAgree === 1 && res.fetched === 0, `counts: ${JSON.stringify(res)}`)

process.exit(failed ? 1 : 0)
