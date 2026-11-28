// A stamp every card of a set carries is the set's own mark, not a print of its own: 30th Celebration's
// "30th-anniversary" logo, the McDonald's sets' McDonald's stamp. TCGdex lists it as a second printing
// (n and n+30th-anniversary) with the same Cardmarket product, so the app showed the whole set twice: as its
// cards and again as special prints (2026-10-24). Such stamped entries are dropped.
// Kept: editions ("1st Edition" is on every card of the old sets too, and is a printing of its own; except in
// the sets printed only in 1st Edition, below), and a
// stamp whose entries have another product or none (EX Delta Species' set logo, the player-rewards energies).
const VARIANTS = 12

// Sets printed only in 1st Edition, where TCGdex still lists an unlimited printing next to each 1st Edition
// one. There the 1st Edition entry is the card itself: it is dropped and the plain entry stands for it (it has
// the Cardmarket product; the app moves copies saved on the stamp to it, foldDroppedStamps). Sources, checked
// 2026-10-28: Japanese Pokémon Card ★VS, "only printed 1st edition" (elitefourum.com/t/vs-unlimited/10592,
// /t/pryces-lapras-vs-set-unlimited/16959); the one unlimited VS card, Pryce's Lapras, came in Information
// Pack Vol. 3, a promo outside the set.
// The LEGEND and XY ones (no cards in TCGdex yet, 2026-10-28: listed so they come out right when they arrive) are
// where TCGplayer's printings (tcgcsv.com prices, subTypeName) show 1st Edition on 54–100% of the cards and
// unlimited on 0–20%, against 44–89% in the sets that had both runs (XY1, XY5–7, ADV, PCG1–9), and the
// collectors' lists agree (elitefourum.com/t/japanese-xy-unlimited-cards/15689, /t/japanese-1st-edition-and-
// unlimited-sets/16856): XY2–4 and XY8–11 1st only, Double Crisis, PokéKyun and the 20th Anniversary pack 1st only,
// L1 1st only (L2/L3 unlimited "very hard to find", 3% on TCGplayer).
const FIRST_EDITION_ONLY = new Set(['VS1', 'L1a', 'L1b', 'L2', 'L3', 'XY2', 'XY3', 'XY4', 'CP1', 'CP2', 'CP3',
  'XY8a', 'XY8b', 'XY9', 'XY10', 'XY11a', 'XY11b', 'CP5', 'CP6'])
const EDITION = /^1st[- ]edition$/i

export function dropSetMarks(cards) {
  const bySet = new Map()
  for (const r of cards) { if (!bySet.has(r[1])) bySet.set(r[1], []); bySet.get(r[1]).push(r) }
  const dropped = {}
  for (const [setId, rows] of bySet) {
    if (!FIRST_EDITION_ONLY.has(String(setId).replace(/^ja-/, ''))) continue
    let n = 0
    for (const r of rows) {
      const out = []
      for (const v of r[VARIANTS]) {
        const [base, stamp] = v[0].split('+')
        if (!stamp || !EDITION.test(stamp)) { out.push(v); continue }
        n++
        const plain = r[VARIANTS].find(p => p[0] === base)
        if (!plain) out.push([base, v[1]]) // only the edition listed: it becomes the plain entry
        else if (plain[1] == null && v[1] != null) plain[1] = v[1]
      }
      r[VARIANTS] = out
    }
    if (n) dropped[`${setId} +1st-edition (1st Edition only)`] = n
  }
  for (const [setId, rows] of bySet) {
    const count = new Map()
    for (const r of rows) for (const stamp of new Set(r[VARIANTS].filter(v => v[0].includes('+')).map(v => v[0].split('+')[1])))
      count.set(stamp, (count.get(stamp) ?? 0) + 1)
    for (const [stamp, n] of count) {
      if (n < rows.length * 0.9 || /edition|shadowless/i.test(stamp)) continue
      // every entry with this stamp has its plain printing's product
      const entries = rows.flatMap(r => r[VARIANTS].filter(v => v[0].split('+')[1] === stamp).map(v => [r, v]))
      const same = entries.every(([r, v]) => v[1] != null && r[VARIANTS].some(p => p[0] === v[0].split('+')[0] && p[1] === v[1]))
      if (!same) continue
      for (const r of rows) r[VARIANTS] = r[VARIANTS].filter(v => v[0].split('+')[1] !== stamp)
      dropped[`${setId} +${stamp}`] = entries.length
    }
  }
  return dropped
}
