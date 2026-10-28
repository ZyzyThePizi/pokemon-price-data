// Reverse holos TCGdex doesn't list. TCGdex has none at all for some sets (EX Holon Phantoms to EX Power
// Keepers, Hidden Fates: 2026-10-28) and misses a few cards in others, so the app's master set came out short
// (Hidden Fates 163 instead of 219). English sets only.
//
// Source: pokemontcg.io, whose cards carry TCGplayer's price per print; a `reverseHolofoil` price means
// TCGplayer lists that card as a reverse holo. Checked against an independent one, Cardmarket's price guide:
// a product with a lowest reverse-holo listing (`lowHolo`) has the print. On Hidden Fates the two agree on all
// 63 cards both know (52 yes, 11 no); Cardmarket's reverse-holo *trend* is no signal (it is filled for GX
// cards that have no reverse). The build logs where Cardmarket disagrees.
//
// A card gains ['r', <its main print's Cardmarket product>, 'p'] only when it has no reverse print yet
// (Cardmarket sells a reverse holo on the card's own product, priced in the guide's holo columns; 'p' says
// where it came from). A set is used only when most of its card names agree with pokemontcg.io's by number,
// so a mismatched set id can't add prints to the wrong cards.
//
// pokemontcg.io is slow (seconds a request, 500s under load): what it said is kept in
// catalog/v2/reverse-holos.json and asked again after a month (a year for sets older than two years), at most
// MAX_FETCH sets per build, so the first fill spreads over a few builds.
import { readFile, writeFile } from 'node:fs/promises'

const API = 'https://api.pokemontcg.io/v2'
const DAY = 864e5
const MAX_FETCH = Number(process.env.REVERSE_MAX_FETCH || 60)
const VARIANTS = 12, NAME = 3, LOCAL_ID = 2, SET = 1 // card row columns (CARD_FIELDS in build-ciac-catalog.mjs)

const norm = (n) => String(n).toLowerCase().replace(/^([a-z]*)0+(\d)/, '$1$2')
const nameKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '')
// TCGdex set id → the ids pokemontcg.io may use for it (sv03.5 → sv3pt5, swsh12.5gg → swsh12pt5gg, sv01 → sv1)
const candidates = (id) => {
  const z = id.replace(/([a-z])0+(\d)/, '$1$2')
  return [...new Set([id, z, id.replace(/\./g, ''), z.replace(/\./g, ''), id.replace(/\./g, 'pt'), z.replace(/\./g, 'pt')])]
}

async function get(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) })
      if (r.ok) return await r.json()
      if (r.status === 404) return null
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 2000 * (i + 1)))
  }
  throw new Error(`pokemontcg.io: no answer for ${url}`)
}

/**
 * Adds the missing reverse holos to the English card rows, in place. `release` gives a set's release date.
 * Returns { added, sets, fetched, cmAgree, cmDisagree, left }.
 */
export async function fillReverseHolos(cards, release, cacheFile, guideRows = null) {
  const cache = JSON.parse(await readFile(cacheFile, 'utf8').catch(() => '{}'))
  cache.sets ??= {}
  const now = Date.now()
  if (!cache.ptcgSets || now - cache.ptcgSets.at > 7 * DAY) {
    try { cache.ptcgSets = { at: now, ids: (await get(`${API}/sets?pageSize=250&select=id`)).data.map(s => s.id) } }
    catch (err) { if (!cache.ptcgSets) { console.log(`  reverse holos: ${err.message}, skipped`); return { added: 0 } } }
  }
  const ptcgIds = new Set(cache.ptcgSets.ids)
  const bySet = new Map()
  for (const r of cards) {
    if (!bySet.has(r[SET])) bySet.set(r[SET], [])
    bySet.get(r[SET]).push(r)
  }

  // ask again: unknown sets first, then the stalest
  const stale = []
  for (const setId of bySet.keys()) {
    const ptcg = candidates(setId).find(c => ptcgIds.has(c))
    if (!ptcg) continue
    const old = (now - Date.parse(release(setId) || '2000-01-01')) > 2 * 365 * DAY
    const hit = cache.sets[setId]
    if (!hit || hit.ptcg !== ptcg || now - hit.at > (old ? 365 : 30) * DAY) stale.push([setId, ptcg, hit?.at ?? 0])
  }
  stale.sort((a, b) => a[2] - b[2])
  let fetched = 0
  for (const [setId, ptcg] of stale.slice(0, MAX_FETCH)) {
    try {
      const data = await get(`${API}/cards?q=set.id:${ptcg}&pageSize=250&select=number,name,tcgplayer`)
      if (!data) continue
      // number → [name, 1 when TCGplayer lists a reverse holo]
      cache.sets[setId] = { ptcg, at: now, cards: Object.fromEntries((data.data ?? []).map(c => [norm(c.number), [c.name, c.tcgplayer?.prices?.reverseHolofoil ? 1 : 0]])) }
      // kept as it goes: a build cut short keeps what it asked
      if (++fetched % 10 === 0) await writeFile(cacheFile, JSON.stringify(cache))
    } catch (err) { console.log(`  reverse holos: ${setId} (${ptcg}): ${err.message}`) }
  }

  const guide = guideRows ? new Map(guideRows.map(g => [g[0], g])) : null
  let added = 0, sets = 0, cmAgree = 0, cmDisagree = 0
  const disagree = []
  for (const [setId, rows] of bySet) {
    const hit = cache.sets[setId]
    if (!hit?.cards) continue
    const pairs = rows.map(r => [r, hit.cards[norm(r[LOCAL_ID])]]).filter(([, p]) => p)
    const same = pairs.filter(([r, p]) => nameKey(r[NAME]) === nameKey(p[0]) || nameKey(p[0]).startsWith(nameKey(r[NAME]))).length
    if (!pairs.length || same < 0.85 * pairs.length) continue
    let n = 0
    for (const [r, [, rev]] of pairs) {
      const vs = r[VARIANTS]
      if (!rev || vs.some(([code]) => code.startsWith('r'))) continue
      const main = vs.find(([code]) => code === 'n' || code === 'h') ?? vs.find(([, id]) => id) ?? null
      vs.push(['r', main?.[1] ?? null, 'p'])
      n++
      const g = main?.[1] && guide?.get(main[1])
      if (g) { if (g[6] != null) cmAgree++; else { cmDisagree++; disagree.push(r[0]) } }
    }
    if (n) { added += n; sets++ }
  }
  if (disagree.length) console.log(`  reverse holos with no Cardmarket reverse listing today (kept): ${disagree.slice(0, 20).join(' ')}${disagree.length > 20 ? ' …' : ''}`)
  await writeFile(cacheFile, JSON.stringify(cache))
  return { added, sets, fetched, cmAgree, cmDisagree, left: Math.max(0, stale.length - MAX_FETCH) }
}
