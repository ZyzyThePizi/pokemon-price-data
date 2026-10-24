// Temporary (branch only): dumps what the picture sources answer, so matching can be designed offline.
// Writes probe/*.json|html. Delete with the workflow before anything merges.
import { mkdir, writeFile } from 'node:fs/promises'

const UA = 'CIAC-Catalog/2.0.0 (+https://github.com/ZyzyThePizi/pokemon-price-data)'
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
await mkdir('probe', { recursive: true })

async function get(url, { json = true, ua = UA } = {}) {
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': ua }, signal: AbortSignal.timeout(30000) })
      const body = json ? await res.json().catch(() => null) : await res.text()
      return { status: res.status, type: res.headers.get('content-type'), body }
    } catch (e) { if (i === 3) return { status: 0, error: String(e) }; await sleep(2000 * i) }
  }
}

// 1. TCGplayer (tcgcsv): every sealed product of both Pokémon categories
const groups = {}, sealed = []
for (const [lang, cat] of [['en', 3], ['ja', 85]]) {
  const g = await get(`https://tcgcsv.com/tcgplayer/${cat}/groups`)
  groups[lang] = (g.body?.results ?? []).map(x => ({ id: x.groupId, name: x.name, abbr: x.abbreviation, date: x.publishedOn?.slice(0, 10) }))
  for (const grp of groups[lang]) {
    await sleep(300)
    const p = await get(`https://tcgcsv.com/tcgplayer/${cat}/${grp.id}/products`)
    for (const x of p.body?.results ?? []) {
      const ext = Object.fromEntries((x.extendedData ?? []).map(e => [e.name, e.value]))
      if (ext.Number || ext.Rarity) continue
      sealed.push([lang, grp.id, x.productId, x.name, x.imageCount ?? 0, x.presaleInfo?.releasedOn?.slice(0, 10) ?? null])
    }
  }
  console.log(lang, groups[lang].length, 'groups;', sealed.length, 'sealed so far')
}
await writeFile('probe/tcg-groups.json', JSON.stringify(groups))
await writeFile('probe/tcg-sealed.json', JSON.stringify(sealed))

// 2. Bulbapedia archives (MediaWiki): how set logos are named
const BULBA = 'https://archives.bulbagarden.net/w/api.php?format=json&action=query'
const bulba = {}
for (const q of ['Temporal Forces logo', 'Legend Maker logo', 'Rocket Gang Strikes Back logo', 'Pokémon Jungle logo',
  'Expansion Pack 20th Anniversary logo', 'Trainer Kit logo', 'McDonald\'s Collection 2023 logo', 'My First Battle logo',
  'Classic Collection logo', 'Unseen Forces Unown logo', 'Pokémon Card web logo', 'Japanese logo expansion']) {
  bulba[q] = (await get(`${BULBA}&list=search&srnamespace=6&srlimit=20&srsearch=${encodeURIComponent(q)}`, { ua: BROWSER }))
  await sleep(500)
}
bulba._cats = await get(`${BULBA}&list=allcategories&acprefix=TCG&aclimit=500`, { ua: BROWSER })
bulba._logoCats = await get(`${BULBA}&list=allcategories&acprefix=Logo&aclimit=500`, { ua: BROWSER })
await writeFile('probe/bulba.json', JSON.stringify(bulba))

// 3. Serebii set lists (logos per set)
for (const [k, u] of [['en', 'https://www.serebii.net/card/english.shtml'], ['ja', 'https://www.serebii.net/card/japanese.shtml'],
  ['tef', 'https://www.serebii.net/card/temporalforces/']]) {
  const r = await get(u, { json: false, ua: BROWSER })
  await writeFile(`probe/serebii-${k}.html`, `<!-- ${r.status} -->\n` + (r.body ?? r.error ?? ''))
}

// 4. Cardmarket product image guesses, TCGplayer CDN
const heads = {}
for (const u of ['https://product-images.s3.cardmarket.com/1016/ASC/860574/860574.jpg',
  'https://product-images.s3.cardmarket.com/1016/ASH/860574/860574.jpg',
  'https://product-images.s3.cardmarket.com/51/ASC/860574/860574.jpg',
  'https://www.cardmarket.com/en/Pokemon/Products/Elite-Trainer-Boxes/Ascended-Heroes-Elite-Trainer-Box']) {
  const r = await get(u, { json: false, ua: BROWSER })
  heads[u] = { status: r.status, type: r.type, img: /product-images[^"' ]+/.exec(r.body ?? '')?.[0] ?? null }
}
await writeFile('probe/heads.json', JSON.stringify(heads, null, 1))
console.log('done')
