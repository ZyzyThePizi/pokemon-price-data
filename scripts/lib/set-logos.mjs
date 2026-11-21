// Real logos for the sets TCGdex has none for (2026-10-23: 60 of 205 English sets, all 171 Japanese ones).
// Sources, in order:
//   1. pokemontcg.io (English): its logo files sit at images.pokemontcg.io/<id>/logo.png. Its set ids are
//      spelled differently (sm3.5 → sm35, McDonald's 2011bw → mcd11): the set's own id, a short alias table and
//      the usual respellings are tried. (Its sets API answered 500 on 2026-10-24, so it isn't used.)
//   2. Pokéllector (both languages): its logo sits next to the symbol the catalog already stores,
//      …/logos/<Name>.symbol.<id>.png → …/<Name>.logo.<id>.png.
//   3. A copy kept in this repository (catalog/set-logos/<id>.png, at most 600 px wide, served by GitHub Pages)
//      of a fan site's logo, for the sets neither source has. Listed by hand in MIRROR, paired by name and
//      release date: Serebii's set lists (serebii.net/card/japanese.shtml), WikiDex's "Logo_…" files, Bill's
//      Archive's Japanese logos (billsarchive.com/assets/logos/japanese/jp-<name>.webp: the 1998–2006 sets) and
//      the official site's product pages (pokemon-card.com/ex/<code>/, cropped). Every copy was checked by eye
//      against the set's Japanese title. Bulbapedia challenges every automated request (Cloudflare), so it is
//      not a source. Fan sites may refuse pictures shown on other sites, hence the copy (256 colours, ≤600 px).
// Every URL is fetched once and kept only when it answers with a picture (200, image/*, more than 1 KB).
// The answers are cached in catalog/v2/set-logos.json: a found logo is checked again after 90 days, a set
// with none after 30 (a source may add it). A network error caches nothing.
// The app draws its own logo for whatever is still missing (src/components/SetLogo.tsx in ciac-app).
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const HIT_DAYS = 90
const MISS_DAYS = 30
const CONCURRENCY = 6
// our id → pokemontcg.io's, where neither the id nor the name pairs them
export const PTCG_ALIAS = {
  'sm3.5': 'sm35', 'sm7.5': 'sm75', 'swsh4.5sv': 'swsh45sv', 'swsh12.5gg': 'swsh12pt5gg', cel25cc: 'cel25c',
  sv05: 'sv5', bog: 'bp', '30th-c': 'me55c', '2023sv': 'mcd23', '2024sv': 'mcd24',
  '2011bw': 'mcd11', '2012bw': 'mcd12', '2014xy': 'mcd14', '2015xy': 'mcd15', '2016xy': 'mcd16', '2017sm': 'mcd17',
  '2018sm': 'mcd18', '2019sm': 'mcd19', '2021swsh': 'mcd21', '2022swsh': 'mcd22',
  'tk-ex-latia': 'tk1a', 'tk-ex-latio': 'tk1b', 'tk-ex-p': 'tk2a', 'tk-ex-m': 'tk2b',
}

const WIKIDEX = 'https://images.wikidexcdn.net/mwuploads/wikidex/'
const BILLS = 'https://billsarchive.com/assets/logos/japanese/jp-'
export const MIRROR = {
  // Japanese
  PMCG2: `${WIKIDEX}7/7e/latest/20220924221845/Logo_Jungla_Pok%C3%A9mon_%28JTCG%29.png`,
  VS1: `${WIKIDEX}6/62/latest/20220923193401/Logo_Pok%C3%A9mon_VS_%28JTCG%29.png`,
  web1: `${WIKIDEX}6/6b/latest/20220420182637/Logo_Pok%C3%A9mon_Web_%28JTCG%29.png`,
  XY8a: 'https://www.serebii.net/card/logo/blueshock.png',
  XY11a: 'https://www.serebii.net/card/logo/feverburstfighter.png', // Explosive (Fever-Burst) Fighter, 2016-06
  XY11b: 'https://www.serebii.net/card/logo/crueltraitor.png',
  SM1p: 'https://www.serebii.net/card/logo/sunmoonstrengtheningpack.png', // 2017-01-27
  SM2p: 'https://www.serebii.net/card/logo/beyondanewchallenge.png',
  SM3p: 'https://www.serebii.net/card/logo/shininglegend.png',
  S1a: 'https://www.serebii.net/card/logo/vmaxrising.png',
  // (WikiDex's McDonald's 2023/2024 files are promo photos, not logos: left out)
  PMCG5: `${BILLS}leaders-stadium.webp`,
  E1: `${BILLS}base-expansion-pack.webp`,
  E3: `${BILLS}wind-from-the-sea.webp`,
  E4: `${BILLS}split-earth.webp`,
  E5: `${BILLS}mysterious-mountains.webp`,
  ADV2: `${BILLS}miracle-of-the-desert.webp`,
  ADV3: `${BILLS}rulers-of-the-heavens.webp`,
  ADV4: `${BILLS}magma-vs-aqua-two-ambitions.webp`,
  ADV5: `${BILLS}undone-seal.webp`,
  PCG1: `${BILLS}flight-of-legends.webp`,
  PCG2: `${BILLS}clash-of-the-blue-sky.webp`,
  PCG3: `${BILLS}team-rocket-s-strikes-back.webp`,
  PCG4: `${BILLS}golden-sky-silvery-ocean.webp`,
  PCG6: `${BILLS}holon-research-tower.webp`,
  PCG8: `${BILLS}miracle-crystal.webp`,
  PCG9: `${BILLS}offense-and-defense-of-the-furthest-ends.webp`,
  // the official page's logo without its release-date line
  MC: 'https://www.pokemon-card.com/ex/mc/assets/images/top/kv/logo_pc.png',
  // Deck Build Box Stellar Miracle: its box carries the expansion's logo
  SVK: 'https://den-media.pokellector.com/logos/Stella-Miracle.logo.401.png',
  // not found anywhere yet (2026-10-24): ADV1, PCG5, PCG7, PCG10; SVLN and SVLS only on a banner photo
  // (pokemon-card.com/products/2024/images/svl_1.jpg)
}
const PAGES = 'https://zyzythepizi.github.io/pokemon-price-data/catalog/set-logos/'
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** The copy of a MIRROR logo: already here, or fetched now (resized when sharp is installed). true when there is one. */
async function mirrored(id, dir) {
  const file = path.join(dir, `${id}.png`)
  if (existsSync(file)) return true
  try {
    const res = await fetch(MIRROR[id], { headers: { 'user-agent': BROWSER }, signal: AbortSignal.timeout(30000) })
    if (!res.ok || !(res.headers.get('content-type') || '').startsWith('image/')) { await res.body?.cancel(); return false }
    let buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1024) return false
    try {
      const sharp = (await import('sharp')).default
      buf = await sharp(buf).resize({ width: 600, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer()
    } catch { /* no sharp: as it came */ }
    await mkdir(dir, { recursive: true })
    await writeFile(file, buf)
    return true
  } catch { return false }
}

// sets.json columns (scripts/build-ciac-catalog.mjs SET_FIELDS)
const ID = 0, LANG = 1, LOGO = 8, SYMBOL = 9

/** pokemontcg.io's logo URLs to try for one of our English set rows, most likely first. */
export function ptcgLogos(row) {
  const id = String(row[ID])
  const codes = [PTCG_ALIAS[id], id, id.replace(/\./g, ''), id.replace(/\.5/, 'pt5'), id.replace(/\./g, 'pt')]
    .filter(Boolean).map(c => c.toLowerCase())
  // its newer sets' logos are on Scrydex (the API's images.logo, 2026-10: 30th Classic Collection)
  return [...new Set(codes)].flatMap(c => [`https://images.pokemontcg.io/${c}/logo.png`, `https://images.scrydex.com/pokemon/${c}-logo/logo`])
}

/** Pokéllector's logo next to its symbol, or null. */
export const pokellectorLogo = (symbol) =>
  typeof symbol === 'string' && /\.symbol\.\d+\.png$/.test(symbol) ? symbol.replace(/\.symbol\.(\d+)\.png$/, '.logo.$1.png') : null

const sha1 = (buf) => createHash('sha1').update(Buffer.from(buf)).digest('hex')
// Scrydex answers any unknown set with the same placeholder picture (200, 12.8 KB): its hash, fetched once
let scrydexStub = null
async function scrydexPlaceholder() {
  scrydexStub ??= fetch('https://images.scrydex.com/pokemon/no-such-set-ciac-logo/logo', { signal: AbortSignal.timeout(20000) })
    .then(async r => (r.ok ? sha1(await r.arrayBuffer()) : '')).catch(() => null)
  return scrydexStub
}

/** true: a picture; false: not one (404, a page, a stub); null: couldn't tell (network). */
async function isImage(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'pokemon-price-data catalog (set logos)' }, signal: AbortSignal.timeout(20000) })
    const type = res.headers.get('content-type') || ''
    if (!res.ok) { await res.body?.cancel(); return res.status >= 500 || res.status === 429 ? null : false }
    if (!type.startsWith('image/')) { await res.body?.cancel(); return false }
    const body = await res.arrayBuffer()
    if (body.byteLength <= 1024) return false
    if (url.includes('images.scrydex.com')) {
      const stub = await scrydexPlaceholder()
      if (stub === null) return null
      if (stub && sha1(body) === stub) return false
    }
    return true
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
  const mirrorDir = path.join(path.dirname(cacheFile), '..', 'set-logos')
  const todo = rows.filter(r => !r[LOGO])
  const counts = { missing: todo.length, cached: 0, found: 0, none: 0, unknown: 0, bySource: {} }
  await pool(todo, async (r) => {
    const id = String(r[ID])
    if (MIRROR[id] && await mirrored(id, mirrorDir)) {
      r[LOGO] = PAGES + id + '.png'
      cache.sets[id] = { url: r[LOGO], source: 'mirror', from: MIRROR[id], at: new Date(now).toISOString() }
      counts.found++
      counts.bySource.mirror = (counts.bySource.mirror || 0) + 1
      return
    }
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
