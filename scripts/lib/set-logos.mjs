// Real logos for the sets TCGdex has none for (2026-10-23: 60 of 205 English sets, all 171 Japanese ones).
// Sources, in order:
//   1. pokemontcg.io (English): one request lists every set with its logo. Its set ids are spelled
//      differently (sm3.5 → sm35, McDonald's 2011bw → mcd11), so a set is paired by id, by a short alias
//      table, then by name (one match, released within about a year).
//   2. Pokéllector (both languages): its logo sits next to the symbol the catalog already stores,
//      …/logos/<Name>.symbol.<id>.png → …/<Name>.logo.<id>.png.
// Every URL is fetched once and kept only when it answers with a picture (200, image/*, more than 1 KB).
// The answers are cached in catalog/v2/set-logos.json: a found logo is checked again after 90 days, a set
// with none after 30 (a source may add it). A network error caches nothing.
// The app draws its own logo for whatever is still missing (src/components/SetLogo.tsx in ciac-app).
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const PTCG_SETS = 'https://api.pokemontcg.io/v2/sets?pageSize=250&select=id,name,releaseDate,images'
const HIT_DAYS = 90
const MISS_DAYS = 30
const CONCURRENCY = 6
// our id → pokemontcg.io's, where neither the id nor the name pairs them
export const PTCG_ALIAS = {
  'sm3.5': 'sm35', 'sm7.5': 'sm75', 'swsh4.5sv': 'swsh45sv', 'swsh12.5gg': 'swsh12pt5gg', cel25cc: 'cel25c',
  sv05: 'sv5', sve: 'sve', bog: 'bp',
  '2011bw': 'mcd11', '2012bw': 'mcd12', '2014xy': 'mcd14', '2015xy': 'mcd15', '2016xy': 'mcd16', '2017sm': 'mcd17',
  '2018sm': 'mcd18', '2019sm': 'mcd19', '2021swsh': 'mcd21', '2022swsh': 'mcd22',
  'tk-ex-latia': 'tk1a', 'tk-ex-latio': 'tk1b', 'tk-ex-p': 'tk2a', 'tk-ex-m': 'tk2b',
}

// sets.json columns (scripts/build-ciac-catalog.mjs SET_FIELDS)
const ID = 0, LANG = 1, NAME = 2, RELEASED = 5, LOGO = 8, SYMBOL = 9

export const normName = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, 'and').replace(/[^a-z0-9]/g, '')
const days = (a, b) => Math.abs(Date.parse(String(a).replace(/\//g, '-')) - Date.parse(String(b).replace(/\//g, '-'))) / 864e5

/** pokemontcg.io's set for one of our English set rows, or null. */
export function ptcgSetFor(row, ptcg) {
  const byId = new Map(ptcg.map(s => [s.id.toLowerCase(), s]))
  const id = String(row[ID])
  for (const code of [PTCG_ALIAS[id], id, id.replace(/\./g, ''), id.replace(/\.5/, 'pt5')]) {
    const s = code && byId.get(code.toLowerCase())
    if (s) return s
  }
  const name = normName(row[NAME])
  const same = ptcg.filter(s => normName(s.name) === name && (!row[RELEASED] || !s.releaseDate || days(row[RELEASED], s.releaseDate) < 400))
  return same.length === 1 ? same[0] : null
}

/** Pokéllector's logo next to its symbol, or null. */
export const pokellectorLogo = (symbol) =>
  typeof symbol === 'string' && /\.symbol\.\d+\.png$/.test(symbol) ? symbol.replace(/\.symbol\.(\d+)\.png$/, '.logo.$1.png') : null

/** true: a picture; false: not one (404, a page, a stub); null: couldn't tell (network). */
async function isImage(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'pokemon-price-data catalog (set logos)' }, signal: AbortSignal.timeout(20000) })
    const type = res.headers.get('content-type') || ''
    if (!res.ok) { await res.body?.cancel(); return res.status >= 500 || res.status === 429 ? null : false }
    if (!type.startsWith('image/')) { await res.body?.cancel(); return false }
    const size = (await res.arrayBuffer()).byteLength
    return size > 1024
  } catch {
    return null
  }
}

async function pool(items, fn, n = CONCURRENCY) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item) }
  }))
}

/**
 * Fills the logo column of every set row without one, in place. `cacheFile` keeps what each set's sources
 * answered. Returns counts for the log, and per source.
 */
export async function fillSetLogos(rows, cacheFile, { now = Date.now(), log = console.log } = {}) {
  const cache = existsSync(cacheFile) ? JSON.parse(await readFile(cacheFile, 'utf8')) : { sets: {} }
  const todo = rows.filter(r => !r[LOGO])
  let ptcg = null
  const ptcgList = async () => {
    if (ptcg) return ptcg
    try {
      const res = await fetch(PTCG_SETS, { signal: AbortSignal.timeout(60000) })
      ptcg = res.ok ? (await res.json()).data ?? [] : []
      if (!res.ok) log(`set logos: pokemontcg.io answered ${res.status}`)
    } catch (e) { log(`set logos: pokemontcg.io unreachable (${e.message})`); ptcg = [] }
    return ptcg
  }
  const counts = { missing: todo.length, cached: 0, found: 0, none: 0, unknown: 0, bySource: {} }
  await pool(todo, async (r) => {
    const id = String(r[ID])
    const hit = cache.sets[id]
    const fresh = hit && now - Date.parse(hit.at) < (hit.url ? HIT_DAYS : MISS_DAYS) * 864e5
    if (fresh) {
      if (hit.url) { r[LOGO] = hit.url; counts.bySource[hit.source] = (counts.bySource[hit.source] || 0) + 1 }
      counts.cached++
      return
    }
    const candidates = []
    if (r[LANG] === 'en') {
      const s = ptcgSetFor(r, await ptcgList())
      if (s?.images?.logo) candidates.push({ url: s.images.logo, source: 'pokemontcg.io' })
    }
    const pk = pokellectorLogo(r[SYMBOL])
    if (pk) candidates.push({ url: pk, source: 'pokellector' })
    let unsure = false
    for (const c of candidates) {
      const ok = await isImage(c.url)
      if (ok) {
        r[LOGO] = c.url
        cache.sets[id] = { url: c.url, source: c.source, at: new Date(now).toISOString() }
        counts.found++
        counts.bySource[c.source] = (counts.bySource[c.source] || 0) + 1
        return
      }
      if (ok === null) unsure = true
    }
    if (unsure) { counts.unknown++; if (hit?.url) r[LOGO] = hit.url; return }
    cache.sets[id] = { url: null, tried: candidates.map(c => c.url), at: new Date(now).toISOString() }
    counts.none++
  })
  await writeFile(cacheFile, JSON.stringify(cache, null, 1) + '\n')
  const left = rows.filter(r => !r[LOGO])
  log(`set logos: ${counts.missing} without a TCGdex logo; ${counts.found} found now, ${counts.cached} from the cache,`
    + ` ${counts.none} none anywhere, ${counts.unknown} unreachable; by source ${JSON.stringify(counts.bySource)};`
    + ` still none: ${left.length} (${left.slice(0, 40).map(r => r[ID]).join(' ')}${left.length > 40 ? ' …' : ''})`)
  return { ...counts, left: left.length }
}
