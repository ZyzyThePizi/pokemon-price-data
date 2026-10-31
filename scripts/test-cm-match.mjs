// node scripts/test-cm-match.mjs: pairing cards that share a name and attacks (scripts/lib/cm-match.mjs)
import assert from 'node:assert/strict'
import { fillCardmarketIds, pairProducts, rarityTier } from './lib/cm-match.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('ok', name) }

const FIELDS = ['id', 'setId', 'localId', 'name', 'rarity', 'variants', 'attacks', 'abilities']
const card = (localId, name, rarity, attacks, variants = [['n', null], ['r', null]]) =>
  [`sm12-${localId}`, 'sm12', localId, name, rarity, variants, attacks, []]
const products = (rows) => ({ fields: ['idProduct', 'name', 'idExpansion', 'idCategory'], rows: rows.map(([id, name]) => [id, name, 2644, 51]) })
// Cosmic Eclipse on 2026-10-28: the Character Rares are the older products
const PRODUCTS = products([
  [398504, 'Piplup [Bubble Hold]'], [407919, 'Piplup [Bubble Hold]'],
  [398534, 'Pikachu [Nuzzle | Volt Tackle]'], [407979, 'Pikachu [Nuzzle | Volt Tackle]'],
  [398524, 'Torkoal [Fire Fling | Kindle]'], [407794, 'Torkoal [Fire Fling | Kindle]'],
  [400001, 'Oddish [Absorb]'], [400002, 'Oddish [Absorb]'],
])
const PRICE = new Map([[398504, 40.57], [407919, 0.1], [398534, 166.06], [407979, 1.97], [398524, 9.23], [407794, 0.1], [400001, 0.1], [400002, 0.2]])
const rows = () => [
  card('29', 'Torkoal', 'Uncommon', ['Fire Fling', 'Kindle']),
  card('54', 'Piplup', 'Common', ['Bubble Hold']),
  card('66', 'Pikachu', 'Common', ['Nuzzle', 'Volt Tackle']),
  card('238', 'Torkoal', 'Secret Rare', ['Fire Fling', 'Kindle'], [['n', null]]),
  card('239', 'Piplup', 'Secret Rare', ['Bubble Hold'], [['n', null]]),
  card('241', 'Pikachu', 'Secret Rare', ['Nuzzle', 'Volt Tackle'], [['n', null]]),
  card('10', 'Oddish', 'Common', ['Absorb']),
  card('11', 'Oddish', 'Common', ['Absorb']),
]
const ids = (rs) => Object.fromEntries(rs.map(r => [r[2] + ' ' + r[3], r[5].map(v => v[1])]))

t('tiers', () => {
  assert.equal(rarityTier('Common'), 0); assert.equal(rarityTier('Uncommon'), 0)
  assert.equal(rarityTier('Holo Rare'), 1); assert.equal(rarityTier('Secret Rare'), 2)
  assert.equal(rarityTier('Ultra Rare'), 2); assert.equal(rarityTier('None'), null); assert.equal(rarityTier('Promo'), null)
})

t('a common gets the cheap product even when its Character Rare is the older one', () => {
  const rs = rows()
  fillCardmarketIds(rs, FIELDS, PRODUCTS, { price: id => PRICE.get(id) })
  const got = ids(rs)
  assert.deepEqual(got['54 Piplup'], [407919, 407919]); assert.deepEqual(got['239 Piplup'], [398504])
  assert.deepEqual(got['66 Pikachu'], [407979, 407979]); assert.deepEqual(got['241 Pikachu'], [398534])
  assert.deepEqual(got['29 Torkoal'], [407794, 407794]); assert.deepEqual(got['238 Torkoal'], [398524])
})

t('same rarity: id order, whatever the price', () => {
  const rs = rows()
  fillCardmarketIds(rs, FIELDS, PRODUCTS, { price: id => PRICE.get(id) })
  assert.deepEqual(ids(rs)['10 Oddish'], [400001, 400001]); assert.deepEqual(ids(rs)['11 Oddish'], [400002, 400002])
})

t('without prices (or in Japanese): id order, as before', () => {
  const rs = rows()
  fillCardmarketIds(rs, FIELDS, PRODUCTS, {})
  assert.deepEqual(ids(rs)['54 Piplup'], [398504, 398504])
  const one = (id) => id === 407919 ? null : PRICE.get(id) // a product without a price
  const rs2 = rows()
  fillCardmarketIds(rs2, FIELDS, PRODUCTS, { price: one })
  assert.deepEqual(ids(rs2)['54 Piplup'], [398504, 398504])
  assert.deepEqual(ids(rs2)['66 Pikachu'], [407979, 407979])
})

t('a reverse holo copied from an old match follows the new one', () => {
  const rs = rows()
  rs[1][5] = [['n', 398504, 'm'], ['r', 398504, 'p']] // Piplup 54, as the last build left it
  rs[4][5] = [['n', 407919, 'm']] // Piplup 239
  fillCardmarketIds(rs, FIELDS, PRODUCTS, { price: id => PRICE.get(id) })
  assert.deepEqual(rs[1][5], [['n', 407919, 'm'], ['r', 407919, 'p']])
  assert.deepEqual(rs[4][5], [['n', 398504, 'm']])
})

t("a TCGdex id and its reverse copy stay", () => {
  const rs = [card('54', 'Piplup', 'Common', ['Bubble Hold'], [['n', 398504], ['r', 398504, 'p']])]
  fillCardmarketIds(rs, FIELDS, PRODUCTS, { price: id => PRICE.get(id) })
  assert.deepEqual(rs[0][5], [['n', 398504], ['r', 398504, 'p']])
})

t('three tiers: holo rare, full art, secret', () => {
  const rs = [{ t: 1 }, { t: 2 }, { t: 2 }]
  const ps = [{ id: 1 }, { id: 2 }, { id: 3 }]
  const price = (id) => ({ 1: 200, 2: 30, 3: 250 })[id]
  assert.deepEqual(pairProducts(rs, ps, { tier: r => r.t, price }).map(p => p.id), [2, 1, 3])
})

console.log(`${n} passed`)
