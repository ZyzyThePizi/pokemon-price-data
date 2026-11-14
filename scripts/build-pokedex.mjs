// CIAC Pokédex v2: every Pokémon and its forms (regional, Mega/Primal,
// Gigantamax/Eternamax, other), with real artwork.
//
// Data: PokeAPI's published CSVs (github.com/PokeAPI/pokeapi, data/v2/csv),
// six downloads instead of 1,351 API calls. Artwork: PokeAPI's sprite repo,
// the Pokémon HOME render (one consistent 3D style), official artwork where
// HOME has none; normal and shiny, resized to 144 px WebP.
//
// Writes:
//   catalog/pokedex-v2.json      { fields, rows } one row per Pokémon entry (base or form)
//   catalog/pokedex-art/{id}.webp, catalog/pokedex-art/shiny/{id}.webp
// The old catalog/pokedex.json stays for app versions that still read it.
//
// Usage: node scripts/build-pokedex.mjs [--force-art]
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const CSV = 'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv'
const SPRITES = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon'
const OUT = path.join(ROOT, 'catalog')
const ART = path.join(OUT, 'pokedex-art')
const FORCE_ART = process.argv.includes('--force-art')
const SIZE = 144
const UA = { 'user-agent': 'CIAC-relay (https://ciac-tcg.com)' }

const REGION_BY_GEN = { 1: 'Kanto', 2: 'Johto', 3: 'Hoenn', 4: 'Sinnoh', 5: 'Unova', 6: 'Kalos', 7: 'Alola', 8: 'Galar', 9: 'Paldea' }
const FORM_REGION = { alola: 'Alola', galar: 'Galar', hisui: 'Hisui', paldea: 'Paldea' }
const TYPE_COLOR = {
  normal: '#9FA19F', fighting: '#FF8000', flying: '#81B9EF', poison: '#9141CB', ground: '#915121', rock: '#AFA981',
  bug: '#91A119', ghost: '#704170', steel: '#60A1B8', fire: '#E62829', water: '#2980EF', grass: '#3FA129',
  electric: '#FAC000', psychic: '#EF4179', ice: '#3DCEF3', dragon: '#5060E1', dark: '#624D4E', fairy: '#EF70EF',
}
// forms left out: event costumes and caps, totem-sized battle forms, ride forms with no artwork
const SKIP = /totem|-cap$|-cap-|cosplay|rock-star|belle|pop-star|-phd|libre|-starter|koraidon-.*-build|miraidon-.*-mode/

async function csv(name) {
  const res = await fetch(`${CSV}/${name}.csv`, { headers: UA })
  if (!res.ok) throw new Error(`${name}: ${res.status}`)
  const [head, ...lines] = (await res.text()).trim().split(/\r?\n/)
  const cols = head.split(',')
  return lines.map(line => {
    // the CSVs quote fields that contain commas
    const cells = []; let cur = '', q = false
    for (const ch of line) {
      if (ch === '"') q = !q
      else if (ch === ',' && !q) { cells.push(cur); cur = '' }
      else cur += ch
    }
    cells.push(cur)
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']))
  })
}

function kindOf(identifier, formId, isMega) {
  if (isMega || /-primal$/.test(identifier)) return 'mega'
  if (formId === 'gmax' || /-gmax$/.test(identifier) || identifier === 'eternatus-eternamax') return 'gigantamax'
  const head = formId.split('-')[0]
  if (FORM_REGION[head]) return 'regional'
  return 'other'
}

async function pool(items, fn, n = 8) {
  const out = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k) } }))
  return out
}

async function art(id, shiny) {
  const file = path.join(ART, shiny ? 'shiny' : '', `${id}.webp`)
  if (!FORCE_ART && existsSync(file)) return true
  const sub = shiny ? '/shiny' : ''
  for (const url of [`${SPRITES}/other/home${sub}/${id}.png`, `${SPRITES}/other/official-artwork${sub}/${id}.png`]) {
    const res = await fetch(url, { headers: UA })
    if (!res.ok) continue
    const buf = Buffer.from(await res.arrayBuffer())
    await sharp(buf).resize(SIZE, SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 82, alphaQuality: 90 }).toFile(file)
    return true
  }
  return false
}

async function main() {
  const [pokemon, forms, species, ptypes, types, spNames, formNames] = await Promise.all(
    ['pokemon', 'pokemon_forms', 'pokemon_species', 'pokemon_types', 'types', 'pokemon_species_names', 'pokemon_form_names'].map(csv))
  const typeName = new Map(types.map(t => [t.id, t.identifier]))
  const typesOf = new Map()
  for (const t of ptypes) {
    if (!typesOf.has(t.pokemon_id)) typesOf.set(t.pokemon_id, [])
    typesOf.get(t.pokemon_id)[Number(t.slot) - 1] = typeName.get(t.type_id)
  }
  const sp = new Map(species.map(s => [s.id, s]))
  const nameOf = new Map(), jaOf = new Map()
  for (const n of spNames) {
    if (n.local_language_id === '9') nameOf.set(n.pokemon_species_id, n.name)
    if (n.local_language_id === '1') jaOf.set(n.pokemon_species_id, n.name) // katakana, as printed on cards
  }
  const defaultForm = new Map()
  for (const f of forms) if (f.is_default === '1') defaultForm.set(f.pokemon_id, f)
  const formEn = new Map()
  for (const n of formNames) if (n.local_language_id === '9') formEn.set(n.pokemon_form_id, n)

  const rows = []
  for (const p of pokemon) {
    const id = Number(p.id)
    if (SKIP.test(p.identifier)) continue
    const s = sp.get(p.species_id)
    const dex = Number(p.species_id)
    const base = p.is_default === '1'
    const f = defaultForm.get(p.id)
    const formId = f?.form_identifier ?? ''
    const kind = base ? 'base' : kindOf(p.identifier, formId, f?.is_mega === '1')
    const fn = f ? formEn.get(f.id) : null
    const speciesName = nameOf.get(p.species_id) ?? p.identifier
    const name = base ? speciesName : (fn?.pokemon_name || `${speciesName} (${fn?.form_name || formId})`)
    const t = typesOf.get(p.id) ?? []
    const region = REGION_BY_GEN[Number(s?.generation_id)] ?? null
    rows.push([
      id, dex, p.identifier, name, base ? null : (fn?.form_name || formId || null), kind, jaOf.get(p.species_id) ?? null,
      region, kind === 'regional' ? FORM_REGION[formId.split('-')[0]] : null,
      t[0] ?? null, TYPE_COLOR[t[0]] ?? null, t[1] ?? null, TYPE_COLOR[t[1]] ?? null, Number(p.order) || id,
    ])
  }
  rows.sort((a, b) => a[1] - b[1] || (a[5] === 'base' ? -1 : b[5] === 'base' ? 1 : a[13] - b[13]))

  await mkdir(path.join(ART, 'shiny'), { recursive: true })
  let missing = 0, missingShiny = 0
  await pool(rows, async (r) => {
    if (!(await art(r[0], false))) { missing++; r.push(0) } else r.push(1)
    if (!(await art(r[0], true))) { missingShiny++; r.push(0) } else r.push(1)
  })
  const fields = ['id', 'dex', 'slug', 'name', 'formName', 'formKind', 'nameJa', 'region', 'formRegion', 'type1', 'type1Color',
    'type2', 'type2Color', 'order', 'art', 'shinyArt']
  await writeFile(path.join(OUT, 'pokedex-v2.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'PokeAPI (pokeapi.co, data and sprites); artwork © The Pokémon Company, Nintendo, Game Freak, Creatures',
    art: 'pokedex-art/{id}.webp', shiny: 'pokedex-art/shiny/{id}.webp', fields, rows,
  }))
  const kinds = {}
  for (const r of rows) kinds[r[5]] = (kinds[r[5]] ?? 0) + 1
  console.log(`${rows.length} entries`, kinds, `art missing ${missing}, shiny missing ${missingShiny}`)
}

main().catch(e => { console.error(e); process.exit(1) })
