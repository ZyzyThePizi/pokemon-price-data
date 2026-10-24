// Real logos for the sets TCGdex has none for (2026-10-23: 60 of 205 English sets, all 171 Japanese ones).
// Sources, in order:
//   1. pokemontcg.io (English): its logo files sit at images.pokemontcg.io/<id>/logo.png. Its set ids are
//      spelled differently (sm3.5 → sm35, McDonald's 2011bw → mcd11): the set's own id, a short alias table and
//      the usual respellings are tried. (Its sets API answered 500 on 2026-10-24, so it isn't used.)
//   2. Pokéllector (both languages): its logo sits next to the symbol the catalog already stores,
//      …/logos/<Name>.symbol.<id>.png → …/<Name>.logo.<id>.png.
// Every URL is fetched once and kept only when it answers with a picture (200, image/*, more than 1 KB).
// The answers are cached in catalog/v2/set-logos.json: a found logo is checked again after 90 days, a set
// with none after 30 (a source may add it). A network error caches nothing.
// The app draws its own logo for whatever is still missing (src/components/SetLogo.tsx in ciac-app).
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const HIT_DAYS = 90
const MISS_DAYS = 30
const CONCURRENCY = 6
// our id → pokemontcg.io's, where neither the id nor the name pairs them
export const PTCG_ALIAS = {
  'sm3.5': 'sm35', 'sm7.5': 'sm75', 'swsh4.5sv': 'swsh45sv', 'swsh12.5gg': 'swsh12pt5gg', cel25cc: 'cel25c',
  sv05: 'sv5', bog: 'bp', '2023sv': 'mcd23', '2024sv': 'mcd24',
  '2011bw': 'mcd11', '2012bw': 'mcd12', '2014xy': 'mcd14', '2015xy': 'mcd15', '2016xy': 'mcd16', '2017sm': 'mcd17',
  '2018sm': 'mcd18', '2019sm': 'mcd19', '2021swsh': 'mcd21', '2022swsh': 'mcd22',
  'tk-ex-latia': 'tk1a', 'tk-ex-latio': 'tk1b', 'tk-ex-p': 'tk2a', 'tk-ex-m': 'tk2b',
}

// sets.json columns (scripts/build-ciac-catalog.mjs SET_FIELDS)
const ID = 0, LANG = 1, LOGO = 8, SYMBOL = 9

/** pokemontcg.io's logo URLs to try for one of our English set rows, most likely first. */
export function ptcgLogos(row) {
  const id = String(row[ID])
  const codes = [PTCG_ALIAS[id], id, id.replace(/\./g, ''), id.replace(/\.5/, 'pt5'), id.replace(/\./g, 'pt')]
    .filter(Boolean).map(c => c.toLowerCase())
  return [...new Set(codes)].map(c => `https://images.pokemontcg.io/${c}/logo.png`)
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
    if (r[LANG] === 'en') for (const url of ptcgLogos(r)) candidates.push({ url, source: 'pokemontcg.io' })
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
