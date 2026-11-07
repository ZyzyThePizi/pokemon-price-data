// Pokéllector set/card catalog scraper — a dependency-free copy of the app
// repo's server/scraper/pokellector.js (keep the two in sync). Pokéllector
// is plain server-rendered HTML with no bot challenge, so a bare fetch +
// targeted regex extraction is enough; the regexes are grounded in real
// fetched markup (see the app file's header for the sample fragments).

export const SOURCES = {
  pokellector_en: 'https://www.pokellector.com',
  pokellector_jp: 'http://jp.pokellector.com',
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.text()
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", eacute: 'é', egrave: 'è', uuml: 'ü' }
function decodeEntities(str) {
  return str.replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const cp = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return isNaN(cp) ? m : String.fromCodePoint(cp)
    }
    return ENTITIES[code.toLowerCase()] ?? m
  })
}

// Politeness delay between requests — someone else's small fan-run site.
export const REQUEST_DELAY_MS = 400
export const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Every set across every series on a source's /sets index, newest first
// (the array index is the sortOrder).
export async function listSets(source) {
  const base = SOURCES[source]
  if (!base) throw new Error(`Unknown source: ${source}`)
  const html = await fetchHtml(`${base}/sets`)
  const sets = []
  const seriesBlocks = html.split(/<h1 class="icon set">/).slice(1)
  for (const block of seriesBlocks) {
    const seriesNameMatch = block.match(/<img[^>]*>([^<]*)<\/h1>/)
    const seriesName = seriesNameMatch ? decodeEntities(seriesNameMatch[1]).trim() : null
    const buttonRe = /<a class="button" name="([^"]*)" href="\/([^"/]+)\/" title="[^"]*"><img[^>]*>(?:<img class="symbol" src="([^"]*)"[^>]*>)?(?:<span>([^<]*)<\/span>)?/g
    let m
    while ((m = buttonRe.exec(block))) {
      const [, setCode, slug, symbolUrl, displayName] = m
      sets.push({
        seriesName,
        setName: displayName ? decodeEntities(displayName).trim() : slug.replace(/-/g, ' '),
        setCode: setCode || null,
        slug,
        symbolUrl: symbolUrl || null,
      })
    }
  }
  return sets.map((s, i) => ({ ...s, sortOrder: i }))
}

// Full card list for one set: the thumb view (name + number + image), plus
// the list view's missing numbers for sparsely scanned sets (image null,
// never fabricated).
export async function scrapeSetCards(source, slug) {
  const base = SOURCES[source]
  if (!base) throw new Error(`Unknown source: ${source}`)
  const url = `${base}/${slug}/`
  const html = await fetchHtml(url)

  const cardsMetaMatch = html.match(/<div class="cards">\s*<span>Cards<\/span>\s*<span>(\d+)<\/span>/)
  const totalCards = cardsMetaMatch ? parseInt(cardsMetaMatch[1], 10) : null

  const cards = []
  const seenNumbers = new Set()
  const cardRe = /data-cardid="(\d+)"[\s\S]*?<a href="[^"]+" name="card\d+" title="([^"]+)">[\s\S]*?<img class="card lazyload" data-src="([^"]+)">[\s\S]*?<div class="plaque">#(\S+)\s*-\s*([^<]*)<\/div>/g
  let m
  while ((m = cardRe.exec(html))) {
    const [, , , thumbUrl, number, plaqueName] = m
    if (seenNumbers.has(number)) continue
    seenNumbers.add(number)
    cards.push({
      number,
      name: decodeEntities(plaqueName).trim(),
      imageUrl: thumbUrl.replace(/\.thumb(\.\w+)$/, '$1'),
    })
  }

  if (/less than \d+% of the scans/.test(html)) {
    await sleep(REQUEST_DELAY_MS)
    try {
      const listHtml = await fetchHtml(`${url}?list_display=list`)
      const listRe = /<span class="number">(\S+)<\/span>\s*<span class="checkbox"[^>]*data-cardid="(\d+)"[^>]*><\/span>\s*<span class="name"><a href="[^"]+" title="([^"]+)">([^<]*)<\/a><\/span>/g
      let lm
      while ((lm = listRe.exec(listHtml))) {
        const [, number, , , name] = lm
        if (seenNumbers.has(number)) continue
        seenNumbers.add(number)
        cards.push({ number, name: decodeEntities(name).trim(), imageUrl: null })
      }
    } catch (err) {
      console.warn(`list-view fallback failed for ${slug}: ${err.message}`)
    }
  }

  return { totalCards, cards }
}
