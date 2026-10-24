// CIAC catalog v2: every Pokémon TCG card TCGdex knows (English + Japanese),
// with the facts the CIAC app needs and the Pokéllector catalog lacks:
// rarity, illustrator, Pokédex numbers, attacks (for Cardmarket wants
// lists), and above all the Cardmarket idProduct of EACH printing variant
// (normal / reverse / holo / 1st edition, and the special prints: Poké Ball / Master Ball
// patterns, cosmos, stamps), so a card's daily price can be
// joined from prices/latest.json without any scraping.
//
// Output (catalog/v2/):
//   manifest.json            what's here, counts, when
//   sets.json                { fields, rows }   one row per set, both languages
//   cards-en.json            { fields, rows }   one row per English card
//   cards-ja.json            { fields, rows }   one row per Japanese card
//   set-logos.json           what each logo source answered per set (scripts/lib/set-logos.mjs)
//
// Incremental: a card already in the previous output is only fetched again
// when its set is recent (prices/variants still settling) or it has no
// Cardmarket id from TCGdex yet. `--force` refetches everything.
//
// English cards TCGdex has no Cardmarket id for get one matched from
// Cardmarket's product list (scripts/lib/cm-match.mjs), marked [code, id, 'm'].
// `--match-only` redoes just that step on the current output.
import { createHash } from 'node:crypto'
import { JA_SET_NAMES, JA_TITLE_FIXES } from './lib/ja-set-names.mjs'
import { formIndex, cardForms } from './lib/card-forms.mjs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fillCardmarketIds, expansionLanguages } from './lib/cm-match.mjs'
import { fillImages, POKELLECTOR_JA } from './lib/image-fallbacks.mjs'
import { japaneseEnglishNames } from './lib/ja-english-names.mjs'
import { fillSetLogos } from './lib/set-logos.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const OUT = path.join(ROOT, 'catalog', 'v2')
const API = 'https://api.tcgdex.net/v2'
const ASSETS = 'https://assets.tcgdex.net/'
const LANGS = ['en', 'ja']
const SKIP_SERIES = new Set(['tcgp']) // Pokémon TCG Pocket: digital only
const CONCURRENCY = 12
const RECENT_DAYS = 120
const FORCE = process.argv.includes('--force')
const MATCH_ONLY = process.argv.includes('--match-only')
const IMAGES_ONLY = process.argv.includes('--images-only') // fill missing images in the existing files, nothing else
const LOGOS_ONLY = process.argv.includes('--logos-only') // fill missing set logos in the existing sets.json, nothing else
const LIMIT_SETS = Number(process.env.LIMIT_SETS || 0) // for test runs

const SET_FIELDS = ['id', 'lang', 'name', 'serieId', 'serieName', 'releaseDate', 'total', 'official',
  'logo', 'symbol', 'abbr', 'pokellector', 'nameEn']
const CARD_FIELDS = ['id', 'setId', 'localId', 'name', 'rarity', 'category', 'illustrator', 'dexIds',
  'types', 'hp', 'stage', 'image', 'variants', 'attacks', 'abilities', 'regulationMark', 'suffix', 'forms']
const FORMS = CARD_FIELDS.indexOf('forms')
// Variant codes: n normal, r reverse, h holo, f 1st edition, p W promo stamp, x unknown
const VARIANT_CODE = { normal: 'n', reverse: 'r', holo: 'h', firstEdition: 'f', wPromo: 'p' }

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function getJson(url, { allow404 = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (res.status === 404 && allow404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      if (attempt >= 5) throw new Error(`${url}: ${err.message}`)
      await sleep(500 * attempt * attempt)
    }
  }
}

async function pool(items, worker, n = CONCURRENCY) {
  const results = new Array(items.length)
  let next = 0, done = 0
  const total = items.length
  await Promise.all(Array.from({ length: Math.min(n, total) }, async () => {
    while (next < total) {
      const i = next++
      results[i] = await worker(items[i], i)
      done++
      if (done % 500 === 0) console.log(`  ${done}/${total}`)
    }
  }))
  return results
}

const stripAssets = (url) => (url && url.startsWith(ASSETS) ? url.slice(ASSETS.length) : url ?? null)
const norm = (s) => String(s ?? '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

async function readJson(file) {
  if (!existsSync(file)) return null
  return JSON.parse(await readFile(file, 'utf8'))
}

// Pokéllector set slug per TCGdex set, so a CIAC import of an old
// CardMarket-tracker backup (which keys cards on Pokéllector slugs) can find
// the same card. English: exact (normalised) name or the official code;
// Japanese: Pokéllector's set code is TCGdex's set id for modern sets.
async function pokellectorIndex(lang) {
  const file = path.join(ROOT, 'catalog', lang === 'en' ? 'pokellector_en.json' : 'pokellector_jp.json')
  const data = await readJson(file)
  if (!data) return { byName: new Map(), byCode: new Map(), bySlug: new Map(), bySetCode: () => null }
  const f = Object.fromEntries(data.setFields.map((n, i) => [n, i]))
  const cf = Object.fromEntries(data.cardFields.map((n, i) => [n, i]))
  const byName = new Map(), byCode = new Map(), bySlug = new Map(), codeSets = new Map()
  const abs = (base, v) => (v ? (/^https?:/.test(v) ? v : base + v) : null)
  for (const s of data.sets) {
    byName.set(norm(s[f.setName]), s[f.slug])
    if (s[f.setCode]) {
      const code = String(s[f.setCode]).toLowerCase()
      byCode.set(code, s[f.slug])
      if (!codeSets.has(code)) codeSets.set(code, [])
      codeSets.get(code).push({ slug: s[f.slug], total: s[f.totalCards] })
    }
    // Pokéllector's images and set symbols, for cards/sets TCGdex has none of
    const cards = new Map()
    for (const c of data.cards[s[f.slug]] ?? []) {
      const n = parseInt(c[cf.number], 10)
      if (Number.isFinite(n) && !cards.has(n)) cards.set(n, abs(data.imageBase, c[cf.imageUrl]))
    }
    bySlug.set(s[f.slug], { name: s[f.setName], symbol: abs(data.symbolBase, s[f.symbolUrl]), cards })
  }
  // Pokéllector gives some pairs one code (S12 = Paradigm Trigger and Lost Abyss,
  // SV4K, the XY halves): a shared code only counts when the card count tells them apart
  const bySetCode = (code, official) => {
    const list = codeSets.get(String(code).toLowerCase()) ?? []
    if (list.length === 1) return list[0].slug
    const hit = list.filter(x => x.total === official)
    return hit.length === 1 ? hit[0].slug : null
  }
  return { byName, byCode, bySlug, bySetCode }
}

// TCGdex reuses a few set ids across languages (the Japanese Neo sets are neo1–neo4,
// like the English ones), and some card ids with them: one would overwrite the
// other in CIAC. The Japanese copy gets "ja-" on its set id and its card ids.
const sha1 = (text) => createHash('sha1').update(text).digest('hex')

function namespaceJa(sets, cards, taken) {
  const moved = new Set()
  for (const r of sets) if (taken.has(r[0])) { moved.add(r[0]); r[0] = 'ja-' + r[0] }
  for (const c of cards) {
    const base = String(c[1]).replace(/^ja-/, '')
    if (!moved.has(base)) continue
    c[1] = 'ja-' + base
    c[0] = 'ja-' + String(c[0]).replace(/^ja-/, '')
  }
}

function cardRow(c, setId, fallbackImage) {
  const variants = []
  // The card as most people own it: standard size, no event/promo stamp.
  // Jumbo and stamped printings are separate Cardmarket products.
  const detailed = c.variants_detailed ?? []
  const plain = detailed.filter(v => (!v.size || v.size === 'standard') && !(v.stamp?.length) && !v.foil)
  for (const v of plain.length ? plain : detailed) {
    const id = v.thirdParty?.cardmarket ?? v.pricing?.cardmarket?.idProduct ?? null
    const code = VARIANT_CODE[v.type] ?? 'x'
    if (!variants.some(([k]) => k === code)) variants.push([code, id])
  }
  // Then every special print as its own entry with its own Cardmarket product (priced
  // apart): pattern foils (r:pokeball, r:masterball, h:cosmos…) and stamps (h+staff,
  // n+pokemon-center…). Codes are read by the app's src/lib/variants.ts. Jumbo skipped.
  for (const v of detailed) {
    if (v.size && v.size !== 'standard') continue
    if (!v.foil && !(v.stamp?.length)) continue
    const code = (VARIANT_CODE[v.type] ?? v.type ?? 'x') + (v.foil ? ':' + v.foil : '') + (v.stamp?.length ? '+' + v.stamp.join(',') : '')
    const id = v.thirdParty?.cardmarket ?? v.pricing?.cardmarket?.idProduct ?? null
    if (!variants.some(([k]) => k === code)) variants.push([code, id])
  }
  if (!variants.length && c.pricing?.cardmarket?.idProduct) variants.push(['x', c.pricing.cardmarket.idProduct])
  if (!variants.length && c.variants) {
    for (const [k, on] of Object.entries(c.variants)) if (on && VARIANT_CODE[k]) variants.push([VARIANT_CODE[k], null])
  }
  return [
    c.id, setId, c.localId, c.name, c.rarity ?? null, c.category ?? null, c.illustrator ?? null,
    Array.isArray(c.dexId) && c.dexId.length ? c.dexId : null,
    Array.isArray(c.types) && c.types.length ? c.types : null,
    c.hp ?? null, c.stage ?? null, stripAssets(c.image) ?? fallbackImage ?? null,
    variants,
    (c.attacks ?? []).map(a => a.name).filter(Boolean),
    (c.abilities ?? []).map(a => a.name).filter(Boolean),
    c.regulationMark ?? null, c.suffix ?? null,
  ]
}

async function buildLang(lang, previousCards) {
  console.log(`[${lang}] set list`)
  const brief = await getJson(`${API}/${lang}/sets`)
  let setIds = brief.map(s => s.id)
  if (LIMIT_SETS) setIds = setIds.slice(-LIMIT_SETS)
  const details = (await pool(setIds, (id) => getJson(`${API}/${lang}/sets/${encodeURIComponent(id)}`, { allow404: true }), 8))
    .filter(Boolean)
    .filter(d => !SKIP_SERIES.has(d.serie?.id))
  const pk = await pokellectorIndex(lang)

  // keyed by TCGdex's own id (a namespaced Japanese id drops its "ja-", see namespaceJa)
  const prevById = new Map((previousCards ?? []).map(r => [r[0].replace(/^ja-/, ''), r]))
  const now = Date.now()
  const sets = []
  const todo = []
  const keep = []
  // An official code shared by two TCGdex sets (a main set and its
  // sub-collection) can't pick one Pokéllector set, so it's not used.
  const abbrCount = new Map()
  for (const d of details) {
    const a = d.abbreviation?.official
    if (a) abbrCount.set(a, (abbrCount.get(a) ?? 0) + 1)
  }
  const uniqueAbbr = (d) => (abbrCount.get(d.abbreviation?.official) === 1 ? d.abbreviation.official.toLowerCase() : null)
  for (const d of details) {
    // TCGdex lists the Traditional Chinese "CS" sets under Japanese as empty
    // shells (all named Triplet Beat): they are not Japanese sets.
    if (lang === 'ja' && /^CS/i.test(d.id) && !d.cards?.length) continue
    const released = d.releaseDate ? Date.parse(d.releaseDate) : NaN
    const recent = !Number.isFinite(released) || now - released < RECENT_DAYS * 864e5
    const young = !Number.isFinite(released) || now - released < 2 * 365 * 864e5
    const pkSlug = pk.byName.get(norm(d.name)) ?? (uniqueAbbr(d) ? pk.byCode.get(uniqueAbbr(d)) : null)
      ?? pk.bySetCode(d.id, d.cardCount?.official)
      // a hand-named Japanese set finds its Pokéllector set by that English name
      ?? (lang === 'ja' && JA_SET_NAMES[d.id] ? pk.byName.get(norm(JA_SET_NAMES[d.id])) : null) ?? null
    const pkSet = pkSlug ? pk.bySlug.get(pkSlug) : null
    // Japanese sets get their official English name: Pokéllector's by set code
    // (its code is TCGdex's id), else the hand-made table.
    const pkByCode = lang === 'ja' ? pk.bySlug.get(pk.bySetCode(d.id, d.cardCount?.official)) : null
    const nameEn = lang === 'ja' ? (JA_SET_NAMES[d.id] ?? pkByCode?.name?.replace(/\s*\(Japanese\)$/i, '').replace(/\bPokemon\b/g, 'Pokémon') ?? null) : null
    sets.push([
      d.id, lang, (lang === 'ja' && JA_TITLE_FIXES[d.id]) || d.name, d.serie?.id ?? null, d.serie?.name ?? null, d.releaseDate ?? null,
      d.cardCount?.total ?? null, d.cardCount?.official ?? null,
      // TCGdex's symbol assets don't resolve (400), Pokéllector's do
      stripAssets(d.logo), pkSet?.symbol ?? null, d.abbreviation?.official ?? null, pkSlug, nameEn,
    ])
    for (const c of d.cards ?? []) {
      const prev = prevById.get(c.id)
      const hasCm = prev && prev[12].some(([, id, how]) => id && how !== 'm') // a matched id still asks TCGdex again
      const fallback = pkSet?.cards.get(parseInt(c.localId, 10)) ?? null
      if (!FORCE && prev && !recent && (hasCm || !young)) keep.push(prev)
      else todo.push({ id: c.id, setId: d.id, fallback })
    }
  }
  console.log(`[${lang}] ${sets.length} sets, ${keep.length} cards kept, ${todo.length} to fetch`)
  const fetched = await pool(todo, async ({ id, setId, fallback }) => {
    const c = await getJson(`${API}/${lang}/cards/${encodeURIComponent(id)}`, { allow404: true })
    return c ? cardRow(c, setId, fallback) : (prevById.get(id) ?? null)
  })
  const cards = [...keep, ...fetched.filter(Boolean)]
  // Stable order: by set release order, then number
  const setOrder = new Map(sets.map((s, i) => [s[0], i]))
  cards.sort((a, b) => (setOrder.get(a[1]) - setOrder.get(b[1])) ||
    (parseInt(a[2], 10) - parseInt(b[2], 10)) || String(a[2]).localeCompare(String(b[2])))
  return { sets, cards }
}

/** Cardmarket ids from the product list for cards TCGdex has none for (scripts/lib/cm-match.mjs). */
async function matchCardmarket(lang, cards, setRows) {
  const products = await readJson(path.join(ROOT, 'prices', 'products.json'))
  if (!products) { console.log('  no prices/products.json: matching skipped'); return 0 }
  // which Cardmarket expansions are English / Japanese, from TCGdex's own ids in both files
  const rowsByLang = {}
  for (const l of LANGS) rowsByLang[l] = l === lang ? cards : ((await readJson(path.join(OUT, `cards-${l}.json`)))?.rows ?? [])
  const expLang = expansionLanguages(products, rowsByLang, CARD_FIELDS, lang === 'ja' ? 'en' : null)
  const release = new Map(setRows.map(r => [r[0], r[5]]))
  const opts = { lang, release: id => release.get(id), otherLang: expLang[lang === 'en' ? 'ja' : 'en'] ?? new Set() }
  if (lang === 'ja') {
    const names = await japaneseEnglishNames(ROOT, setRows, cards, POKELLECTOR_JA)
    opts.enName = names.name
    console.log(`[ja] English names: Pokéllector for ${names.sets} sets, TCGplayer for ${names.fromTcgplayer} more cards`)
  }
  const n = fillCardmarketIds(cards, CARD_FIELDS, products, opts)
  console.log(`[${lang}] ${n} Cardmarket ids matched from the product list`)
  return n
}

async function main() {
  await mkdir(OUT, { recursive: true })
  if (MATCH_ONLY) {
    const manifest = await readJson(path.join(OUT, 'manifest.json'))
    for (const lang of LANGS) {
      const file = path.join(OUT, `cards-${lang}.json`)
      const data = await readJson(file)
      const setRows = (await readJson(path.join(OUT, 'sets.json'))).rows.filter(r => r[1] === lang)
      const matched = await matchCardmarket(lang, data.rows, setRows)
      const json = JSON.stringify(data)
      await writeFile(file, json)
      const m = manifest.files[`cards-${lang}`]
      m.sha1 = sha1(json)
      m.withCardmarketId = data.rows.filter(r => r[12].some(([, id]) => id)).length
      m.cardmarketMatched = matched
    }
    manifest.generatedAt = new Date().toISOString()
    await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    console.log('done (match only)')
    return
  }
  if (LOGOS_ONLY) {
    const manifest = await readJson(path.join(OUT, 'manifest.json'))
    const data = await readJson(path.join(OUT, 'sets.json'))
    await fillSetLogos(data.rows, path.join(OUT, 'set-logos.json'))
    const json = JSON.stringify(data)
    await writeFile(path.join(OUT, 'sets.json'), json)
    if (manifest.files.sets.sha1 !== sha1(json)) {
      manifest.files.sets.sha1 = sha1(json)
      manifest.generatedAt = new Date().toISOString()
      await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    }
    console.log('done (logos only)')
    return
  }
  if (IMAGES_ONLY) {
    const manifest = await readJson(path.join(OUT, 'manifest.json'))
    const setRows = (await readJson(path.join(OUT, 'sets.json'))).rows
    const abbr = new Map(setRows.map(r => [String(r[0]).replace(/^ja-/, ''), r[10]]))
    const names = new Map(setRows.map(r => [String(r[0]).replace(/^ja-/, ''), r[2]]))
    for (const lang of LANGS) {
      const file = path.join(OUT, `cards-${lang}.json`)
      const data = await readJson(file)
      // Japanese ids may be namespaced ("ja-neo1"): the sources know the plain id
      const rows = data.rows.map(r => (r[1].startsWith('ja-') ? Object.assign([...r], { 1: r[1].slice(3) }) : r))
      const res = await fillImages(lang, rows, path.join(OUT, 'image-fallbacks.json'), id => abbr.get(id), { setName: id => names.get(id), root: ROOT })
      rows.forEach((r, i) => { data.rows[i][11] = r[11] })
      console.log(`[${lang}] images: ${res.filled} of ${res.missing} missing filled, ${res.left} left, ${res.coverage} have one`)
      const json = JSON.stringify(data)
      await writeFile(file, json)
      manifest.files[`cards-${lang}`].sha1 = sha1(json)
    }
    manifest.generatedAt = new Date().toISOString()
    await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    console.log('done (images only)')
    return
  }
  const prevManifest = await readJson(path.join(OUT, 'manifest.json'))
  const allSets = []
  const manifest = { version: 2, generatedAt: new Date().toISOString(), source: 'TCGdex (tcgdex.dev, MIT)', imageBase: ASSETS, files: {} }
  const enSetIds = new Set()
  // the Pokémon form each card shows (scripts/build-pokedex.mjs writes the Pokédex first)
  const pokedex = await readJson(path.join(ROOT, 'catalog', 'pokedex-v2.json'))
  const byDex = pokedex ? formIndex(pokedex) : null
  for (const lang of LANGS) {
    const prev = await readJson(path.join(OUT, `cards-${lang}.json`))
    const { sets, cards } = await buildLang(lang, prev?.rows)
    const abbrOf = new Map(sets.map(r => [r[0], r[10]]))
    const nameOf = new Map(sets.map(r => [r[0], r[2]]))
    const img = await fillImages(lang, cards, path.join(OUT, 'image-fallbacks.json'), id => abbrOf.get(id), { setName: id => nameOf.get(id), root: ROOT })
    console.log(`[${lang}] images: ${img.filled} of ${img.missing} missing filled (pokemontcg.io, Limitless, TCGplayer), ${img.left} left, ${img.coverage} have one`)
    if (lang === 'en') for (const r of sets) enSetIds.add(r[0])
    else namespaceJa(sets, cards, enSetIds)
    for (const r of cards) r[FORMS] = byDex ? cardForms({ name: r[3], types: r[8], dexIds: r[7] }, lang, byDex) : null
    allSets.push(...sets)
    const matched = await matchCardmarket(lang, cards, sets)
    const withCm = cards.filter(r => r[12].some(([, id]) => id)).length
    const cardsJson = JSON.stringify({ fields: CARD_FIELDS, variantCodes: VARIANT_CODE, rows: cards })
    await writeFile(path.join(OUT, `cards-${lang}.json`), cardsJson)
    manifest.files[`cards-${lang}`] = { file: `cards-${lang}.json`, cards: cards.length, withCardmarketId: withCm, cardmarketMatched: matched, sha1: sha1(cardsJson) }
    console.log(`[${lang}] ${cards.length} cards, ${withCm} with a Cardmarket id`)
  }
  // real logos for the sets TCGdex has none for (pokemontcg.io, Pokéllector), checked once and cached
  await fillSetLogos(allSets, path.join(OUT, 'set-logos.json'))
  const setsJson = JSON.stringify({ fields: SET_FIELDS, rows: allSets })
  await writeFile(path.join(OUT, 'sets.json'), setsJson)
  // the hashes make any change a new generatedAt (apps re-import on that), not only a new count
  manifest.files.sets = { file: 'sets.json', sets: allSets.length, sha1: sha1(setsJson) }
  if (prevManifest && JSON.stringify(prevManifest.files) === JSON.stringify(manifest.files)) manifest.generatedAt = prevManifest.generatedAt
  await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log('done')
}

main().catch((err) => { console.error(err); process.exit(1) })
