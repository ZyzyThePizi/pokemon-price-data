#!/usr/bin/env node
// Keeps catalog/ fresh: the Pokéllector set/card catalog the app's no-PC
// build downloads on first run (the app's ROADMAP.md, 2.7), in the same
// shape the app's scripts/export-relay-catalog.mjs seeded it with.
//
// Incremental, like the desktop app's own catalog job: every run refreshes
// every set's metadata (one index page per source), but only scrapes the
// card list of a set that's new or hasn't been checked for STALE_DAYS.
// `--force` re-scrapes everything. The existing files are the state, so a
// card's cmProductId (resolved by the app via TCGdex, seeded from the
// desktop) is never dropped, and a card Pokéllector stops listing is kept.
//
// A failed index fetch throws (the run fails loudly); a single failed set is
// logged and keeps its previous cards.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { SOURCES, listSets, scrapeSetCards, sleep, REQUEST_DELAY_MS } from './lib/pokellector.mjs'

const OUT_DIR = path.join(process.cwd(), 'catalog')
const MANIFEST_PATH = path.join(OUT_DIR, 'manifest.json')
const STALE_DAYS = 7
const FORCE = process.argv.includes('--force')

const IMAGE_BASE = 'https://den-cards.pokellector.com/'
const SYMBOL_BASE = 'https://den-media.pokellector.com/logos/'
const strip = (url, base) => (url && url.startsWith(base) ? url.slice(base.length) : url)

const SET_FIELDS = ['slug', 'seriesName', 'setName', 'setCode', 'symbolUrl', 'sortOrder', 'totalCards', 'lastScrapedAt']
const CARD_FIELDS = ['number', 'name', 'imageUrl', 'cmProductId']

async function readJsonIfExists(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

// Same order as the app's SQL (`CAST(card_number AS INTEGER), card_number`):
// a non-numeric number ("FIR") counts as 0, ties compare as plain text.
const numOf = (n) => parseInt(n, 10) || 0
const cardSort = (a, b) => (numOf(a[0]) - numOf(b[0])) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)

async function refreshSource(source, generatedAt) {
  const file = `${source}.json`
  const prev = await readJsonIfExists(path.join(OUT_DIR, file))
  const prevSets = new Map((prev?.sets ?? []).map(r => [r[0], r]))
  const cards = { ...(prev?.cards ?? {}) }
  const staleCutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000

  const sets = await listSets(source)
  let scraped = 0, failed = 0
  const setRows = []
  for (const s of sets) {
    const old = prevSets.get(s.slug)
    let totalCards = old?.[6] ?? null
    let lastScrapedAt = old?.[7] ?? null
    const stale = FORCE || !lastScrapedAt || new Date(lastScrapedAt).getTime() < staleCutoff
    if (stale) {
      try {
        await sleep(REQUEST_DELAY_MS)
        const result = await scrapeSetCards(source, s.slug)
        totalCards = result.totalCards
        lastScrapedAt = new Date().toISOString()
        // Merge by card number: new names/images win, a missing image keeps
        // the old one, cmProductId is carried over, unseen old cards stay.
        const byNumber = new Map((cards[s.slug] ?? []).map(c => [c[0], c]))
        for (const c of result.cards) {
          const was = byNumber.get(c.number)
          byNumber.set(c.number, [c.number, c.name, strip(c.imageUrl, IMAGE_BASE) ?? was?.[2] ?? null, was?.[3] ?? null])
        }
        cards[s.slug] = [...byNumber.values()].sort(cardSort)
        scraped++
      } catch (err) {
        failed++
        console.warn(`⚠️  ${source}/${s.slug}: ${err.message} (keeping previous cards)`)
      }
    }
    setRows.push([s.slug, s.seriesName, s.setName, s.setCode, strip(s.symbolUrl, SYMBOL_BASE), s.sortOrder, totalCards, lastScrapedAt])
  }
  // Sets no longer on the index are kept (at the end), like vanished cards.
  const listed = new Set(sets.map(s => s.slug))
  for (const [slug, row] of prevSets) if (!listed.has(slug)) setRows.push(row)

  const payload = {
    source, generatedAt, imageBase: IMAGE_BASE, symbolBase: SYMBOL_BASE,
    setFields: SET_FIELDS, cardFields: CARD_FIELDS, sets: setRows, cards,
  }
  await writeFile(path.join(OUT_DIR, file), JSON.stringify(payload))
  const cardCount = Object.values(cards).reduce((n, list) => n + list.length, 0)
  console.log(`📚 ${source}: ${setRows.length} sets (${scraped} scraped, ${failed} failed), ${cardCount} cards`)
  return { file, sets: setRows.length, cards: cardCount, updatedAt: generatedAt }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const generatedAt = new Date().toISOString()
  const manifest = (await readJsonIfExists(MANIFEST_PATH)) ?? { version: 1, files: {} }
  for (const source of Object.keys(SOURCES)) {
    manifest.files[source] = await refreshSource(source, generatedAt)
  }
  manifest.generatedAt = generatedAt
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
