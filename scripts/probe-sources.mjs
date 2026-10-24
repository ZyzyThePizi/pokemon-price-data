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
    return res.ok ? buf : null
  } catch (e) { log[name] = { url, error: String(e) } }
}
// WikiDex: every Logo_* file with its URL
const files = []
let cont = ''
for (let i = 0; i < 20; i++) {
  const u = 'https://www.wikidex.net/api.php?format=json&action=query&list=allimages&aiprefix=Logo_&ailimit=500&aiprop=url|size' + (cont ? '&aicontinue=' + encodeURIComponent(cont) : '')
  const res = await fetch(u, { headers: { 'user-agent': BROWSER } }); const j = await res.json()
  for (const x of j.query?.allimages ?? []) files.push([x.name, x.url, x.width, x.height])
  cont = j.continue?.aicontinue; if (!cont) break
}
await writeFile('probe/wikidex-logos.json', JSON.stringify(files))
for (const s of ['M6a', 'PCG3', 'E1', 'SVK'])
  await save(`limitless-${s}.png`, `https://s3.limitlesstcg.com/sets/jp/${s}.png`, true)
await save('limitless-en-30th.png', 'https://s3.limitlesstcg.com/sets/en/MFB.png', true)
await save('pc-console.html', 'https://www.pricecharting.com/console/pokemon-japanese-mask-of-change')
await save('pc-search.html', 'https://www.pricecharting.com/search-products?q=mask+of+change+booster+box&type=prices')
await save('pc-chinese.html', 'https://www.pricecharting.com/console/pokemon-chinese-gem-pack')
await writeFile('probe/log3.json', JSON.stringify(log, null, 1))
console.log(log, files.length)
