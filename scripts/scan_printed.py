"""CIAC scanner: what each card prints as its collector number, for the number reader (CIAC docs/dev/scanner.md).

python scripts/scan_printed.py          -> rewrites scan/v3/printed.json from catalog/v2 (scan_daily.py calls it too)

scan/v3/printed.json = {"count": N, "hash": "...", "rows": [...]}: one entry per index row, in the index's order
(ids.json "ids", then each chunk's "ids"). An entry is the canonical strip text, "" when the card prints no number
(old Japanese cards print only "No. 033"), or null when we can't derive it from the catalog (unnumbered promos...).

Canonical form, so print styles don't matter: leading zeros dropped in every digit run, no spaces, letters only where
the card prints them:
  056/108 -> 56/108     TG05/TG30 -> TG5/TG30    SWSH049 -> SWSH49    036/M-P -> 36/M-P    svp 036 -> 36

This is the one copy of the rule: CIAC's training (tools/scan-train/numread_data.py) imports printed_labels from here.
"""
import hashlib
import json
import os
import re

EN_PROMO = {"swshp", "smp", "xyp", "bwp", "dpp", "hgssp", "svp", "mep", "basep", "np"}   # number only, no total ("MEP EN 001"; Wizards "34", Nintendo "037")
EN_SUBSETS = {"TG", "GG", "RC", "H", "SV", "SL"}                      # TG05/TG30 ...
EN_BARE = {"AR", "RT", "SH"}                                           # Platinum era: "AR1 *", "SH4 *", no total
EN_SKIP = {"miscp"}                                                    # unknown promos
EN_NONE = {("hgss1", "ONE"), ("hgss2", "TWO"), ("hgss3", "THREE"), ("hgss4", "FOUR")}  # Alph lithographs: glyphs only
EN_LETTER_TOTAL = {"exu": 28, "30th": "RGB"}                           # Unown "A/28"; the RGB Mew "R/RGB"
# Classic Collections reprint old cards with their original numbers: localId -> (catalog name, printed). Sources
# (2026-11-05): cardmavin + serebii (cel25cc), cardrake + outof.games (30th-c). The two 30th-c Darkrai & Cresselia
# LEGEND halves (019/020: 99/102, 100/102) are left unknown: which id is which half is unconfirmed.
EN_REPRINTS = {
    "cel25cc": {"CC001": ("Blastoise", "2/102"), "CC002": ("Charizard", "4/102"), "CC003": ("Venusaur", "15/102"),
                "CC004": ("Imposter Professor Oak", "73/102"), "CC005": ("Dark Gyarados", "8/82"),
                "CC006": ("Here Comes Team Rocket", "15/82"), "CC007": ("Rocket's Zapdos", "15/132"),
                "CC008": ("_____'s Pikachu", "24"), "CC009": ("Cleffa", "20/111"), "CC010": ("Shining Magikarp", "66/64"),
                "CC011": ("Team Magma's Groudon", "9/95"), "CC012": ("Rocket's Admin", "86/109"), "CC013": ("Mew ex", "88/92"),
                "CC014": ("Gardevoir ex", "93/101"), "CC015": ("Umbreon", "17/17"), "CC016": ("Claydol", "15/106"),
                "CC017": ("Luxray GL", "109/111"), "CC018": ("Garchomp C", "145/147"), "CC019": ("Donphan", "107/123"),
                "CC020": ("Reshiram", "113/114"), "CC021": ("Zekrom", "114/114"), "CC022": ("Mewtwo EX", "54/99"),
                "CC023": ("Xerneas EX", "97/146"), "CC024": ("M Rayquaza EX", "76/108"), "CC025": ("Tapu Lele GX", "60/145")},
    "30th-c": {"001": ("Charizard", "4/102"), "002": ("Delcatty", "5/109"), "003": ("Metagross", "11/113"),
               "004": ("Genesect EX", "11/101"), "005": ("Misty", "18/132"), "006": ("Dark Tyranitar", "19/109"),
               "007": ("Sneasel", "25/111"), "008": ("Pikachu & Zekrom GX", "33/181"), "009": ("Greninja BREAK", "41/122"),
               "010": ("Uxie", "43/146"), "011": ("Crobat G", "47/127"), "012": ("Raikou", "50/185"),
               "013": ("Buzzwole GX", "57/111"), "014": ("Pikachu", "58/102"), "015": ("Erika's Jigglypuff", "69/132"),
               "016": ("Rayquaza EX", "85/124"), "017": ("Solgaleo GX", "89/149"), "018": ("Gengar", "94/102"),
               "021": ("N", "101/101"), "022": ("Palkia", "106/106"), "023": ("M Gardevoir EX", "106/160"),
               "024": ("Shining Celebi", "106/105"), "025": ("Scizor ex", "108/115"), "026": ("Mew VMAX", "114/264"),
               "027": ("Arceus VSTAR", "123/172"), "028": ("Zacian V", "138/202"), "029": ("Lugia", "149/147"),
               "030": ("Magikarp", "203/193")},
}
# Not derivable, left unknown (null): letter-suffixed prints ("50a/147" Aquapolis, "43a/124" XY alternate arts; the
# reader has no lowercase), Unown "?"/"!" and letters outside CHARSET, Japanese basic energies (print unconfirmed).
JA_PROMO = {"SV-P", "M-P", "S-P", "SM-P", "XY-P", "BW-P"}              # 036/M-P
JA_DEX = re.compile(r"^(PMCG\d|ja-neo\d)$")                            # "No. 033": no card number

CHARSET = "0123456789/-ABCDEGHLMPRSTVWXY"   # every character a canonical label uses (the reader's alphabet)


def canon(s: str) -> str:
    return re.sub(r"\d+", lambda m: str(int(m.group())), s)


def printed_labels(catalog_dir="catalog/v2"):
    """card id -> canonical strip text ('' = no card number printed), for every card whose print we know."""
    sets = {(r[0], r[1]): r for r in json.load(open(os.path.join(catalog_dir, "sets.json"), encoding="utf-8"))["rows"]}
    out = {}
    for lang in ("en", "ja"):
        c = json.load(open(os.path.join(catalog_dir, f"cards-{lang}.json"), encoding="utf-8"))
        f = {k: i for i, k in enumerate(c["fields"])}
        rows = [(r[f["id"]], r[f["setId"]], str(r[f["localId"]] or "")) for r in c["rows"]]
        names = {r[f["id"]]: r[f["name"]] or "" for r in c["rows"]}
        sub_total = {}
        for cid, sid, lid in rows:
            m = re.fullmatch(r"([A-Z]+)(\d+)", lid)
            if m:
                k = (sid, m.group(1))
                sub_total[k] = max(sub_total.get(k, 0), int(m.group(2)))
        for cid, sid, lid in rows:
            total = (sets.get((sid, lang)) or [0] * 8)[7] or 0     # "official": the number printed after the slash
            m = re.fullmatch(r"([A-Z]*)(\d+)", lid)
            if lang == "ja":
                if JA_DEX.match(sid):
                    out[cid] = ""
                elif m and not m.group(1):
                    n = int(m.group(2))
                    if sid in JA_PROMO:
                        out[cid] = f"{n}/{sid}"
                    elif total > 0:
                        out[cid] = f"{n}/{total}"
                continue
            if sid in EN_REPRINTS:
                name, label = EN_REPRINTS[sid].get(lid, ("", None))
                if label and names[cid].startswith(name):       # the catalog's card is the one the list means
                    out[cid] = label
                continue
            if (sid, lid) in EN_NONE:
                out[cid] = ""
                continue
            if sid in EN_LETTER_TOTAL and re.fullmatch(r"[A-Z]", lid):
                label = f"{lid}/{EN_LETTER_TOTAL[sid]}"
                if set(label) <= set(CHARSET):
                    out[cid] = label
                continue
            if sid in EN_SKIP or not m:
                continue
            pre, n = m.group(1), int(m.group(2))
            if sid in EN_PROMO:
                out[cid] = f"{pre}{n}"
            elif not pre and total > 0:
                out[cid] = f"{n}/{total}"
            elif pre in EN_BARE:
                out[cid] = f"{pre}{n}"
            elif pre in EN_SUBSETS:
                out[cid] = f"{pre}{n}/{pre}{sub_total[(sid, pre)]}"
    bad = {ch for v in out.values() for ch in v} - set(CHARSET)
    assert not bad, f"labels use characters the reader can't write: {bad}"
    return out


def write_table(v3="scan/v3", catalog_dir="catalog/v2"):
    """Rewrite v3/printed.json for every row the index has (base + chunks) and note its hash in ids.json "printed"
    (the app fetches printed.json?v=<hash>, like the chunks). Returns (rows, known)."""
    meta_path = os.path.join(v3, "ids.json")
    meta = json.load(open(meta_path, encoding="utf-8"))
    ids = list(meta["ids"]) + [i for c in meta.get("chunks", []) for i in c["ids"]]
    if len(ids) != meta.get("count", len(ids)):
        raise SystemExit(f"printed: the index lists {len(ids)} ids but says count {meta['count']}; nothing written")
    labels = printed_labels(catalog_dir)
    rows = [labels.get(i) for i in ids]
    h = hashlib.sha1(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()[:12]
    with open(os.path.join(v3, "printed.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump({"count": len(rows), "hash": h, "rows": rows}, fh, ensure_ascii=True, separators=(",", ":"))
    meta["printed"] = {"file": "printed.json", "hash": h, "count": len(rows)}
    json.dump(meta, open(meta_path, "w", encoding="utf-8"))
    known = sum(r is not None for r in rows)
    print(f"printed.json: {len(rows)} rows, {known} with a known print ({known * 100 // max(len(rows), 1)} %)")
    return len(rows), known


if __name__ == "__main__":
    write_table()
