// A subset is a run of cards inside a set's own packs with its own numbering (TG01, GG01, SV001, CC001):
// Trainer Gallery, Galarian Gallery, Shiny Vault, Classic Collection. TCGdex lists each as a set of its own;
// the catalog keeps that (its own page, its own count, as Pokéllector, TCG Collector and pokemontcg.io do) and
// names the parent, so the app counts it in the parent's full set and master set (as the master-set guides
// do: Crown Zenith 159 + 70 Galarian Gallery). Subsets TCGdex already keeps inside the set (Legendary
// Treasures' and Generations' Radiant Collection) need nothing here.
export const SUBSET_PARENT = {
  sma: 'sm115', // Hidden Fates Shiny Vault
  'swsh4.5sv': 'swsh4.5', // Shining Fates Shiny Vault
  cel25cc: 'cel25', // Celebrations Classic Collection
  swsh9tg: 'swsh9', swsh10tg: 'swsh10', swsh11tg: 'swsh11', swsh12tg: 'swsh12', // Trainer Gallery
  'swsh12.5gg': 'swsh12.5', // Crown Zenith Galarian Gallery
  '30th-c': '30th', // 30th Celebration Classic Collection
}

/** The parent set of an English subset, or null (all of these are English sets). */
export const subsetParent = (setId, lang) => (lang === 'en' && SUBSET_PARENT[setId]) || null
