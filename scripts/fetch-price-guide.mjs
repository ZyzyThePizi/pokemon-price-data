#!/usr/bin/env node
// Downloads Cardmarket's public price guide + product catalogue for Pokémon
// (idGame 6), slims them, and writes the files this repo publishes over
// GitHub Pages — a free CORS+gzip relay for data a browser can't fetch
// directly from Cardmarket itself (see the app's ROADMAP.md, 2.3).
//
// Re-run-safe: an unchanged source (by ETag) is a no-op, and a source that's
// changed but produces the same rows for a day already written just
// overwrites that day's file with itself. Any real fetch failure (a moved
// URL, a network error) throws and exits non-zero, so the workflow run fails
// loudly instead of silently leaving stale data marked current.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const BASE = 'https://downloads.s3.cardmarket.com/productCatalog'
const PRICE_GUIDE_URL = `${BASE}/priceGuide/price_guide_6.json`
const SINGLES_URL = `${BASE}/productList/products_singles_6.json`
const NONSINGLES_URL = `${BASE}/productList/products_nonsingles_6.json`

const OUT_DIR = path.join(process.cwd(), 'prices')
const HISTORY_DIR = path.join(process.cwd(), 'history')
const MANIFEST_PATH = path.join(OUT_DIR, 'manifest.json')
const SHARD_COUNT = 1000
// Full-catalogue dated snapshots (prices/YYYY/MM/DD.json) are ~3.7MB
// uncompressed each — kept only for this long. Older days aren't lost: the
// per-product history shards already carry every product's full history
// forward, at a small fraction of the size (measured 2026-09-16: a full
// day's dated snapshot is ~3.7MB / ~875KB gz; that same day's worth of
// history-shard growth, spread across all 1000 shards, is ~8MB uncompressed
// total — see ROADMAP.md 2.3 for the repo-growth math this bounds).
const KEEP_DATED_SNAPSHOTS_DAYS = 14

const PRICE_FIELDS = ['idProduct', 'low', 'trend', 'avg1', 'avg7', 'avg30', 'lowHolo', 'trendHolo', 'avg30Holo']
// Same as PRICE_FIELDS minus idProduct (that's the object key in a shard).
const HISTORY_FIELDS = ['date', 'low', 'trend', 'avg1', 'avg7', 'avg30', 'lowHolo', 'trendHolo', 'avg30Holo']

async function readJsonIfExists(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

async function headMeta(url) {
  const res = await fetch(url, { method: 'HEAD' })
  if (!res.ok) throw new Error(`${url} -> HEAD HTTP ${res.status}`)
  return { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') }
}

async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res.json()
}

function slimPriceRow(p) {
  return [
    p.idProduct,
    p.low ?? null,
    p.trend ?? null,
    p.avg1 ?? null,
    p.avg7 ?? null,
    p.avg30 ?? null,
    p['low-holo'] ?? null,
    p['trend-holo'] ?? null,
    p['avg30-holo'] ?? null,
  ]
}

function slimProductRow(p) {
  return [p.idProduct, p.name, p.idExpansion ?? null, p.idCategory]
}

// Deletes dated snapshots (prices/YYYY/MM/DD.json) older than the retention
// window and any year/month directory left empty by that. Safe: every
// product's history from a deleted day already lives in its history shard.
async function pruneOldSnapshots(todayUTC) {
  const cutoff = new Date(todayUTC)
  cutoff.setUTCDate(cutoff.getUTCDate() - KEEP_DATED_SNAPSHOTS_DAYS)
  let removed = 0
  let years
  try {
    years = await readdir(OUT_DIR, { withFileTypes: true })
  } catch {
    return removed
  }
  for (const yearEnt of years) {
    if (!yearEnt.isDirectory() || !/^\d{4}$/.test(yearEnt.name)) continue
    const yearPath = path.join(OUT_DIR, yearEnt.name)
    const months = await readdir(yearPath, { withFileTypes: true })
    for (const monthEnt of months) {
      if (!monthEnt.isDirectory() || !/^\d{2}$/.test(monthEnt.name)) continue
      const monthPath = path.join(yearPath, monthEnt.name)
      const days = await readdir(monthPath)
      for (const dayFile of days) {
        const m = dayFile.match(/^(\d{2})\.json$/)
        if (!m) continue
        const fileDate = new Date(`${yearEnt.name}-${monthEnt.name}-${m[1]}T00:00:00Z`)
        if (fileDate < cutoff) {
          await rm(path.join(monthPath, dayFile))
          removed++
        }
      }
      if ((await readdir(monthPath)).length === 0) await rm(monthPath, { recursive: true })
    }
    if ((await readdir(yearPath)).length === 0) await rm(yearPath, { recursive: true })
  }
  return removed
}

async function updateHistoryShards(priceRows, todayUTC) {
  await mkdir(HISTORY_DIR, { recursive: true })
  // Group today's rows by shard so each shard file is read and written
  // exactly once, not once per product.
  const byShard = new Map()
  for (const row of priceRows) {
    const idProduct = row[0]
    const shard = idProduct % SHARD_COUNT
    if (!byShard.has(shard)) byShard.set(shard, [])
    byShard.get(shard).push(row)
  }

  for (const [shard, rows] of byShard) {
    const shardPath = path.join(HISTORY_DIR, `${shard}.json`)
    const existing = (await readJsonIfExists(shardPath)) || {}
    for (const [idProduct, low, trend, avg1, avg7, avg30, lowHolo, trendHolo, avg30Holo] of rows) {
      const key = String(idProduct)
      const series = existing[key] || []
      const point = [todayUTC, low, trend, avg1, avg7, avg30, lowHolo, trendHolo, avg30Holo]
      // Idempotent re-run: replace today's point instead of duplicating it.
      if (series.length && series[series.length - 1][0] === todayUTC) series[series.length - 1] = point
      else series.push(point)
      existing[key] = series
    }
    await writeFile(shardPath, JSON.stringify(existing))
  }
  return byShard.size
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const manifest = (await readJsonIfExists(MANIFEST_PATH)) || {}
  const todayUTC = new Date().toISOString().slice(0, 10)

  const priceHead = await headMeta(PRICE_GUIDE_URL)
  const priceUnchanged = Boolean(priceHead.etag) && priceHead.etag === manifest.priceGuideEtag
  if (priceUnchanged) {
    console.log(`Price guide unchanged since last run (ETag ${priceHead.etag}) — nothing to do.`)
    return
  }

  console.log('Fetching price guide…')
  const priceGuide = await getJson(PRICE_GUIDE_URL)
  const priceRows = priceGuide.priceGuides.map(slimPriceRow)
  console.log(`  ${priceRows.length} products`)

  const latest = {
    generatedAt: new Date().toISOString(),
    sourceCreatedAt: priceGuide.createdAt,
    fields: PRICE_FIELDS,
    count: priceRows.length,
    rows: priceRows,
  }
  await writeFile(path.join(OUT_DIR, 'latest.json'), JSON.stringify(latest))

  const dayDir = path.join(OUT_DIR, todayUTC.slice(0, 4), todayUTC.slice(5, 7))
  await mkdir(dayDir, { recursive: true })
  await writeFile(path.join(dayDir, `${todayUTC.slice(8, 10)}.json`), JSON.stringify(latest))

  console.log('Updating per-product history shards…')
  const touchedShards = await updateHistoryShards(priceRows, todayUTC)
  console.log(`  touched ${touchedShards} shard files`)

  const prunedCount = await pruneOldSnapshots(todayUTC)
  if (prunedCount) console.log(`Pruned ${prunedCount} dated snapshot(s) older than ${KEEP_DATED_SNAPSHOTS_DAYS} days.`)

  manifest.priceGuideEtag = priceHead.etag
  manifest.priceGuideLastModified = priceHead.lastModified
  manifest.sourceCreatedAt = priceGuide.createdAt
  manifest.lastRunAt = latest.generatedAt
  manifest.rowCount = priceRows.length
  manifest.shardCount = SHARD_COUNT
  manifest.historyFields = HISTORY_FIELDS

  // The product index (name/expansion/category — for matching, not prices)
  // changes far less often than daily prices, so it's only rebuilt when
  // either source list's ETag actually changes.
  const [singlesHead, nonsinglesHead] = await Promise.all([headMeta(SINGLES_URL), headMeta(NONSINGLES_URL)])
  const singlesUnchanged = Boolean(singlesHead.etag) && singlesHead.etag === manifest.singlesEtag
  const nonsinglesUnchanged = Boolean(nonsinglesHead.etag) && nonsinglesHead.etag === manifest.nonsinglesEtag
  if (!singlesUnchanged || !nonsinglesUnchanged) {
    console.log('Product catalogue changed — rebuilding products.json…')
    const [singles, nonsingles] = await Promise.all([getJson(SINGLES_URL), getJson(NONSINGLES_URL)])
    const productRows = [...singles.products.map(slimProductRow), ...nonsingles.products.map(slimProductRow)]
    await writeFile(path.join(OUT_DIR, 'products.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      fields: ['idProduct', 'name', 'idExpansion', 'idCategory'],
      count: productRows.length,
      rows: productRows,
    }))
    manifest.singlesEtag = singlesHead.etag
    manifest.nonsinglesEtag = nonsinglesHead.etag
    manifest.productRowCount = productRows.length
  } else {
    console.log('Product catalogue unchanged — keeping existing products.json.')
  }

  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
  console.log('Done.')
}

main().catch((err) => {
  console.error('FAILED:', err.stack || err.message)
  process.exit(1)
})
