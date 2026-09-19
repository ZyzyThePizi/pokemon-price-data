# pokemon-price-data

A free daily mirror of [Cardmarket](https://www.cardmarket.com/)'s public
Pokémon price guide, republished so a browser can actually fetch it.

## Why this exists

Cardmarket publishes a
[daily price guide and product catalogue](https://news.cardmarket.com/en/Magic/were-making-the-price-guide-and-product-catalogue-available-for-download)
as public JSON files. They're real and free, but served without CORS or
gzip headers, so a web app can't `fetch()` them directly — only a native app
or a server-side relay can. This repo is that relay: a scheduled
[GitHub Actions](.github/workflows/price-guide.yml) job downloads the source
files once a day, slims them, and commits the result here. GitHub Pages
(and `raw.githubusercontent.com`) serve everything in this repo with
`Access-Control-Allow-Origin: *` and gzip, so any browser can read it for
free — the same pattern as Simon Willison's
["git scraping"](https://simonwillison.net/tags/git-scraping/).

This is one piece of a larger project: see that app's `ROADMAP.md`
(section 2.3) for the full design this repo fits into.

## What's here

| Path | Contents |
|---|---|
| `prices/latest.json` | Every tracked product's current price fields — the file most consumers want |
| `prices/products.json` | Product index: id → name, expansion, category (rebuilt only when the catalogue changes) |
| `prices/YYYY/MM/DD.json` | Full snapshot for one day, same shape as `latest.json`. Kept for 14 days, then pruned — see history shards below |
| `history/<idProduct % 1000>.json` | Per-product daily history, sharded so a client only downloads shards for the ~handful of products it actually tracks, not one huge file per day |
| `prices/manifest.json` | Source ETags, row counts, last run time — used by the fetch script to skip unchanged sources, also useful for consumers to check freshness |

All price files are **all-languages, all-conditions** — Cardmarket's price
guide doesn't break prices down by language. Anything built on this data
must never label or total these numbers as a specific language's price;
exact-language prices need a real per-listing scrape (see the app's own
`server/scraper/` for that side of it).

### `prices/latest.json` / `prices/YYYY/MM/DD.json`

```json
{
  "generatedAt": "2026-09-16T20:26:00.000Z",
  "sourceCreatedAt": "2026-09-16T02:45:15+0200",
  "fields": ["idProduct", "low", "trend", "avg1", "avg7", "avg30", "lowHolo", "trendHolo", "avg30Holo"],
  "count": 79070,
  "rows": [[271439, 130, 304.25, null, null, null, null, 3.93, null], ...]
}
```

Rows are arrays, not objects, to keep the file small — match each row
against `fields` by index. `low`/`trend`/`avg1`/`avg7`/`avg30` are the
regular (non-holo) print; the `*Holo` fields are the holo/reverse-holo
print of the same product, when Cardmarket has one. `null` means Cardmarket
had no data for that field that day (usually too few recent listings).

### `prices/products.json`

```json
{ "fields": ["idProduct", "name", "idExpansion", "idCategory"], "rows": [[273532, "Weedle [Multiply]", 1585, 51], ...] }
```

### `history/<shard>.json`

```json
{ "271439": [["2026-09-16", 130, 304.25, null, null, null, null, 3.93, null], ...], "271440": [...] }
```

Object keyed by `idProduct` (as a string); each value is an array of rows
using `manifest.json`'s `historyFields` order (same as above, with `date`
in place of `idProduct`, and no per-day file needed). `idProduct % 1000`
picks the shard — e.g. product 271439 is in `history/439.json`.

## Using it

```js
const res = await fetch('https://<user>.github.io/pokemon-price-data/prices/latest.json')
const { fields, rows } = await res.json()
const idx = Object.fromEntries(fields.map((f, i) => [f, i]))
const row = rows.find(r => r[idx.idProduct] === 271439)
console.log(row[idx.trend]) // 304.25
```

Or read history for one product without downloading every day:

```js
const shard = 271439 % 1000
const res = await fetch(`https://<user>.github.io/pokemon-price-data/history/${shard}.json`)
const series = (await res.json())['271439']
```

`raw.githubusercontent.com/<user>/pokemon-price-data/main/...` works the
same way and needs no Pages setup, if that's simpler for a given consumer.

## Running it yourself

```
node scripts/fetch-price-guide.mjs
```

No dependencies beyond Node 20+ (uses the built-in `fetch`). Safe to
re-run: an unchanged source (checked by ETag) is a no-op, and re-running on
a day already written just overwrites that day's files with themselves.

## Known limits

- **Daily, not live.** For a price right now, a real scrape is still
  necessary — this only ever reflects Cardmarket's last daily guide run.
- **Repo growth.** Each day's run adds roughly 3-4 MB across the history
  shards (measured 2026-09-16: ~8 MB uncompressed spread across all 1000
  shard files) — dated snapshots are pruned after 14 days, and the
  workflow resets `main` to a single orphan commit after every run, so
  `.git` history doesn't grow either. The working tree (what actually
  gets served) is the only thing that grows over time, at roughly the
  shard rate above — still worth watching over a long enough timescale,
  but not the runaway-history problem this would otherwise be.
- If Cardmarket moves or changes these files, the workflow run fails
  loudly (an Actions failure, emailed to whoever owns this repo) instead of
  silently serving stale data as current.

## License

The code in this repo (the fetch script, the workflow) is [MIT](LICENSE).
That covers this repo's own code, not any rights to Cardmarket's
underlying data — the published `prices/` and `history/` files are derived
from Cardmarket's own [public price guide](https://news.cardmarket.com/en/Magic/were-making-the-price-guide-and-product-catalogue-available-for-download),
and any use of that data is still subject to Cardmarket's own terms.
