"""CIAC scanner, daily: appends the cards the neural index doesn't know yet as a small chunk in scan/v3.

python scripts/scan_daily.py <tmpDir>      (after node scripts/scan-prep.mjs <tmpDir>)

- scan/v3 is created from scan/v2 the first time (same models: no model change; the app tries v3, then v2).
- Same preprocessing as the index (CIAC tools/scan-train/export.py): the 315 x 440 picture resized to 224 x 320
  (OpenCV INTER_AREA), RGB, ImageNet mean/std, through the shipped embed.onnx, int8 (x 127).
- Parity first: 50 cards the index already has are embedded again; if any differs from its index row (cosine below
  PARITY), nothing is written and the job fails. A wrong index never ships.
- The new rows go to scan/v3/chunks/<date>.bin, listed in ids.json "chunks" with their ids and languages ("e"/"j"
  per card). The base files keep their hash, so phones download only the chunk (kilobytes).
- scan/v3/printed.json: each row's printed collector number for the number reader (scripts/scan_printed.py).
- scan/v3/coverage.json: how many cards the scanner knows, what was added when, what has no picture yet.
"""
import datetime
import hashlib
import json
import os
import shutil
import sys

import cv2
import numpy as np
import onnxruntime as ort

from scan_printed import write_table

PARITY = 0.998          # measured 2026-11-05: re-embedded rows 0.9992-0.9994 (fp16 ONNX vs the fp32 build, int8)
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
V2, V3 = "scan/v2", "scan/v3"


def tensor(path):
    img = cv2.resize(cv2.imread(path), (224, 320), interpolation=cv2.INTER_AREA)
    rgb = img[..., ::-1].astype(np.float32) / 255.0
    return ((rgb - MEAN) / STD).transpose(2, 0, 1)


def embed(sess, tmp, items):
    if not items:
        return np.zeros((0, 256), np.float32)
    x = np.stack([tensor(os.path.join(tmp, it["file"])) for it in items])
    v = np.concatenate([sess.run(None, {"input": x[i:i + 32]})[0] for i in range(0, len(x), 32)])
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def main():
    tmp = sys.argv[1]
    lst = json.load(open(os.path.join(tmp, "list.json"), encoding="utf-8"))
    if not os.path.exists(os.path.join(V3, "ids.json")):
        os.makedirs(V3, exist_ok=True)
        for f in os.listdir(V2):
            shutil.copy(os.path.join(V2, f), os.path.join(V3, f))
        meta = json.load(open(os.path.join(V3, "ids.json"), encoding="utf-8"))
        meta.update(version=3, chunks=[])
        json.dump(meta, open(os.path.join(V3, "ids.json"), "w", encoding="utf-8"))
        print("scan/v3 created from scan/v2")
    meta = json.load(open(os.path.join(V3, "ids.json"), encoding="utf-8"))
    dim = meta["dim"]
    sess = ort.InferenceSession(os.path.join(V3, "embed.onnx"), providers=["CPUExecutionProvider"])

    # parity: the shipped model on fresh downloads must reproduce the index
    base = np.fromfile(os.path.join(V3, "index.bin"), dtype=np.int8).reshape(-1, dim).astype(np.float32)
    par = [p for p in lst["parity"] if p["row"] < len(base) and meta["ids"][p["row"]] == p["id"]]
    if len(par) < 30:
        sys.exit(f"parity: only {len(par)} reference cards downloaded, need 30")
    ref = base[[p["row"] for p in par]]
    ref /= np.linalg.norm(ref, axis=1, keepdims=True)
    cos = (embed(sess, tmp, par) * ref).sum(1)
    print(f"parity: {len(par)} cards, cosine min {cos.min():.5f}, median {np.median(cos):.5f}")
    if cos.min() < PARITY:
        worst = par[int(cos.argmin())]
        sys.exit(f"parity FAILED: {worst['lang']}:{worst['id']} cosine {cos.min():.5f} < {PARITY}; nothing written")

    new = lst["new"]
    today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    meta.setdefault("chunks", [])
    if new:
        q = np.clip(np.round(embed(sess, tmp, new) * 127), -127, 127).astype(np.int8)
        os.makedirs(os.path.join(V3, "chunks"), exist_ok=True)
        name, k = f"chunks/{today}.bin", 2
        while os.path.exists(os.path.join(V3, name)):
            name, k = f"chunks/{today}-{k}.bin", k + 1
        data = q.tobytes()
        open(os.path.join(V3, name), "wb").write(data)
        meta["chunks"].append({"file": name, "hash": hashlib.sha1(data).hexdigest()[:12], "date": today,
                               "ids": [c["id"] for c in new], "langs": "".join("j" if c["lang"] == "ja" else "e" for c in new)})
        print(f"added {len(new)} cards in {name} ({len(data) // 1024} KB)")
    else:
        print("no new cards")
    total = len(meta["ids"]) + sum(len(c["ids"]) for c in meta["chunks"])
    meta["count"] = total
    meta["updated"] = today
    json.dump(meta, open(os.path.join(V3, "ids.json"), "w", encoding="utf-8"))

    # the printed-number table, one entry per index row (rebuilt whole: print rules can change)
    write_table(V3)

    # coverage: what the scanner knows, for the app's info sheet and the roadmap
    added = {}
    for c in meta["chunks"]:
        for cid, g in zip(c["ids"], c["langs"]):
            added.setdefault(c["date"], {}).setdefault("ja" if g == "j" else "en", 0)
            added[c["date"]]["ja" if g == "j" else "en"] += 1
    sets = {}
    for c in new:
        sets[f"{c['lang']}:{c['set']}"] = sets.get(f"{c['lang']}:{c['set']}", 0) + 1
    no_pic = {}
    for c in lst["failed"]:
        no_pic[f"{c['lang']}:{c['set']}"] = no_pic.get(f"{c['lang']}:{c['set']}", 0) + 1
    cov = {"updated": today, "count": total, "base": len(meta["ids"]), "added": added,
           "today": sets, "noPictureYet": len(lst["failed"]), "noPictureSets": no_pic, "parity": round(float(cos.min()), 5)}
    json.dump(cov, open(os.path.join(V3, "coverage.json"), "w", encoding="utf-8"), indent=1)


if __name__ == "__main__":
    main()
