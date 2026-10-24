// A stamp every card of a set carries is the set's own mark, not a print of its own: 30th Celebration's
// "30th-anniversary" logo, the McDonald's sets' McDonald's stamp. TCGdex lists it as a second printing
// (n and n+30th-anniversary) with the same Cardmarket product, so the app showed the whole set twice: as its
// cards and again as special prints (2026-10-24). Such stamped entries are dropped.
// Kept: editions ("1st Edition" is on every card of the old sets too, and is a printing of its own), and a
// stamp whose entries have another product or none (EX Delta Species' set logo, the player-rewards energies).
const VARIANTS = 12

export function dropSetMarks(cards) {
  const bySet = new Map()
  for (const r of cards) { if (!bySet.has(r[1])) bySet.set(r[1], []); bySet.get(r[1]).push(r) }
  const dropped = {}
  for (const [setId, rows] of bySet) {
    const count = new Map()
    for (const r of rows) for (const stamp of new Set(r[VARIANTS].filter(v => v[0].includes('+')).map(v => v[0].split('+')[1])))
      count.set(stamp, (count.get(stamp) ?? 0) + 1)
    for (const [stamp, n] of count) {
      if (n < rows.length * 0.9 || /edition/i.test(stamp)) continue
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
