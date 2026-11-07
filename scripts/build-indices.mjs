// Collector indices for CIAC, from the daily history shards: per set, per
// era (TCGdex serie), a market-wide top-1000 index, and a few themes.
// Chain-linked: each day's move is measured over the products priced on both
// days, so a card entering or leaving the basket doesn't jump the index.
// All values are Cardmarket's all-language trend price; base = 100.
//
// Output: indices/indices.json  { generatedAt, dates, series: [{ id, kind, name, n, values }] }
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const HIST = path.join(ROOT, 'history')
const TREND = 2 // index of trend in a history point [date, low, trend, …]

async function json(p) { return JSON.parse(await readFile(p, 'utf8')) }

async function main() {
  // product → facts, from the catalog (main variant + all variant ids)
  const facts = new Map()
  const sets = await json(path.join(ROOT, 'catalog', 'v2', 'sets.json'))
  const sf = Object.fromEntries(sets.fields.map((n, i) => [n, i]))
  const setInfo = new Map(sets.rows.map(r => [r[sf.id], { name: r[sf.name], serie: r[sf.serieName], lang: r[sf.lang] }]))
  for (const lang of ['en', 'ja']) {
    const f = await json(path.join(ROOT, 'catalog', 'v2', `cards-${lang}.json`))
    const ci = Object.fromEntries(f.fields.map((n, i) => [n, i]))
    for (const r of f.rows) {
      for (const [code, id] of r[ci.variants] ?? []) {
        if (!id || facts.has(id)) continue
        facts.set(id, { set: r[ci.setId], lang, rarity: (r[ci.rarity] || '').toLowerCase(), dex: r[ci.dexIds] ?? [], code })
      }
    }
  }
  const products = await json(path.join(ROOT, 'prices', 'products.json')).catch(() => null)
  const sealed = new Set()
  if (products) {
    const pf = Object.fromEntries(products.fields.map((n, i) => [n, i]))
    for (const r of products.rows) if (r[pf.idCategory] !== 51) sealed.add(r[pf.idProduct])
  }

  // all history: id → Map(date → trend)
  const series = new Map()
  const dateSet = new Set()
  for (const file of await readdir(HIST)) {
    if (!file.endsWith('.json')) continue
    const shard = await json(path.join(HIST, file))
    for (const [id, pts] of Object.entries(shard)) {
      const m = new Map()
      for (const p of pts) if (p[TREND] != null && p[TREND] > 0) { m.set(p[0], p[TREND]); dateSet.add(p[0]) }
      if (m.size) series.set(Number(id), m)
    }
  }
  const dates = [...dateSet].sort()
  const last = dates[dates.length - 1]

  const baskets = new Map() // key → { kind, name, ids: [] }
  const add = (key, kind, name, id) => { if (!baskets.has(key)) baskets.set(key, { kind, name, ids: [] }); baskets.get(key).ids.push(id) }
  const EEVEE = new Set([133, 134, 135, 136, 196, 197, 470, 471, 700])
  const ranked = []
  for (const [id, m] of series) {
    if (sealed.has(id)) { if ((m.get(last) ?? 0) >= 20) add('theme:sealed', 'theme', 'Sealed', id); continue }
    const f = facts.get(id)
    if (!f) continue
    const s = setInfo.get(f.set)
    add(`set:${f.set}`, 'set', s?.name ?? f.set, id)
    if (s?.serie) add(`era:${f.lang}:${s.serie}`, 'era', s.serie, id)
    if (f.lang === 'ja') add('theme:japan', 'theme', 'Japanese', id)
    if (f.dex.includes(6)) add('theme:charizard', 'theme', 'Charizard', id)
    if (f.dex.includes(25)) add('theme:pikachu', 'theme', 'Pikachu', id)
    if (f.dex.some(d => EEVEE.has(d))) add('theme:eevee', 'theme', 'Eeveelutions', id)
    if (f.rarity.includes('illustration')) add('theme:illustration', 'theme', 'Illustration rares', id)
    ranked.push([id, m.get(last) ?? 0])
  }
  ranked.sort((a, b) => b[1] - a[1])
  for (const [id] of ranked.slice(0, 1000)) add('market:top1000', 'market', 'CIAC 1000', id)

  const out = []
  for (const [id, b] of baskets) {
    if (b.ids.length < 5) continue
    const values = [100]
    for (let d = 1; d < dates.length; d++) {
      let a = 0, z = 0
      for (const pid of b.ids) {
        const m = series.get(pid)
        const p0 = m.get(dates[d - 1]), p1 = m.get(dates[d])
        if (p0 && p1) { a += p0; z += Math.min(2 * p0, Math.max(0.5 * p0, p1)) }
      }
      values.push(a > 0 ? +(values[d - 1] * (z / a)).toFixed(2) : values[d - 1])
    }
    out.push({ id, kind: b.kind, name: b.name, n: b.ids.length, values })
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  await mkdir(path.join(ROOT, 'indices'), { recursive: true })
  await writeFile(path.join(ROOT, 'indices', 'indices.json'), JSON.stringify({ generatedAt: new Date().toISOString(), base: 100, dates, series: out }))
  console.log(`${out.length} indices over ${dates.length} days`)
}

main().catch(e => { console.error(e); process.exit(1) })
