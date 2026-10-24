// Temporary (branch only): dumps what more picture sources answer. Delete before anything merges.
import { mkdir, writeFile } from 'node:fs/promises'
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
await mkdir('probe/img', { recursive: true })
const log = {}
async function save(name, url, bin = false) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': BROWSER }, signal: AbortSignal.timeout(30000) })
    const buf = Buffer.from(await res.arrayBuffer())
    log[name] = { url, status: res.status, type: res.headers.get('content-type'), size: buf.length }
    if (res.ok) await writeFile(bin ? `probe/img/${name}` : `probe/${name}`, buf)
  } catch (e) { log[name] = { url, error: String(e) } }
}
for (const s of ['vs', 'blueshock', 'temporalforces', '30thcelebration', 'feverburstfighter'])
  await save(`serebii-${s}.png`, `https://www.serebii.net/card/logo/${s}.png`, true)
await save('tcg-668496_400w.jpg', 'https://tcgplayer-cdn.tcgplayer.com/product/668496_400w.jpg', true)
await save('tcg-672434_200w.jpg', 'https://tcgplayer-cdn.tcgplayer.com/product/672434_200w.jpg', true)
await save('tcg-702496_400w.jpg', 'https://tcgplayer-cdn.tcgplayer.com/product/702496_400w.jpg', true)
await save('tcgcollector-intl.html', 'https://www.tcgcollector.com/expansions/intl')
await save('tcgcollector-jp.html', 'https://www.tcgcollector.com/expansions/jp')
await save('limitless-jp.html', 'https://limitlesstcg.com/cards/jp')
await save('limitless-en.html', 'https://limitlesstcg.com/cards')
await save('pkmncards-sets.html', 'https://pkmncards.com/sets/')
await save('wikidex.json', 'https://www.wikidex.net/api.php?format=json&action=query&list=search&srnamespace=6&srlimit=30&srsearch=' + encodeURIComponent('Logo Leaders Stadium'))
await save('wikidex2.json', 'https://www.wikidex.net/api.php?format=json&action=query&list=allimages&aiprefix=Logo_&ailimit=500')
await save('pokumon.html', 'https://pokumon.com/series/')
await writeFile('probe/log2.json', JSON.stringify(log, null, 1))
console.log(log)
