#!/usr/bin/env python3
"""Compare GigaAM vs whisper.cpp transcripts of the same track (no ground truth available).

Reports: word counts, cross-WER (one vs the other), Latin-script term usage, Whisper-style
hallucination markers, and the N largest disagreement regions after word alignment (side by side).

Usage: compare.py <whisper.json> <gigaam.json> [--windows 12]
"""
import argparse
import json
import re
from collections import Counter

import jiwer

HALLU = [r"продолжение следует", r"субтитр", r"спасибо за просмотр", r"редактор субтитров",
         r"подписывайтесь", r"dimatorzok"]


def load_whisper(p):
    d = json.load(open(p))
    if "transcription" in d:  # raw whisper-cli JSON
        return [{"startMs": t["offsets"]["from"], "endMs": t["offsets"]["to"], "text": t["text"].strip()}
                for t in d["transcription"] if t["text"].strip()]
    return d


def norm(t):
    t = t.lower().replace("ё", "е")
    t = re.sub(r"[^\w\s]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def repeats(segs):
    c = Counter(norm(s["text"]) for s in segs if len(norm(s["text"]).split()) >= 3)
    return sum(n - 1 for n in c.values() if n > 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("whisper")
    ap.add_argument("gigaam")
    ap.add_argument("--windows", type=int, default=12)
    a = ap.parse_args()

    w = load_whisper(a.whisper)
    gd = json.load(open(a.gigaam))
    g, stats = gd["segments"], gd["stats"]

    wt, gt = norm(" ".join(s["text"] for s in w)), norm(" ".join(s["text"] for s in g))
    out = {
        "gigaam_stats": stats,
        "words": {"whisper": len(wt.split()), "gigaam": len(gt.split())},
        "cross_wer_whisper_as_ref": round(jiwer.wer(wt, gt), 3),
        "latin_words": {
            "whisper": Counter(re.findall(r"[a-z][a-z0-9\-]+", wt)).most_common(25),
            "gigaam": Counter(re.findall(r"[a-z][a-z0-9\-]+", gt)).most_common(25),
        },
        "hallucination_markers": {
            "whisper": sum(len(re.findall(h, wt)) for h in HALLU),
            "gigaam": sum(len(re.findall(h, gt)) for h in HALLU),
        },
        "repeated_segments": {"whisper": repeats(w), "gigaam": repeats(g)},
    }

    # Align the two word sequences globally and surface the largest disagreement regions,
    # with a few words of shared context, located in time via GigaAM's word timestamps.
    ww, gw = wt.split(), gt.split()
    gtimes = [wd["startMs"] for sg in g for wd in sg["words"] for _ in norm(wd["text"]).split()]
    chunks = jiwer.process_words(wt, gt).alignments[0]
    regions = []  # merge diff chunks separated by <= 2 equal words
    for c in chunks:
        if c.type == "equal":
            continue
        if regions and c.ref_start_idx - regions[-1][1] <= 2 and c.hyp_start_idx - regions[-1][3] <= 2:
            regions[-1][1], regions[-1][3] = c.ref_end_idx, c.hyp_end_idx
        else:
            regions.append([c.ref_start_idx, c.ref_end_idx, c.hyp_start_idx, c.hyp_end_idx])
    regions.sort(key=lambda r: -max(r[1] - r[0], r[3] - r[2]))
    ctx = 4
    picked = []
    for r0, r1, h0, h1 in sorted(regions[:a.windows], key=lambda r: r[2]):
        ms = gtimes[min(h0, len(gtimes) - 1)] if gtimes else 0
        picked.append({
            "at": f"{ms // 60000:02d}:{ms // 1000 % 60:02d}",
            "whisper": " ".join(ww[max(0, r0 - ctx):r0]) + " [" + " ".join(ww[r0:r1]) + "] " + " ".join(ww[r1:r1 + ctx]),
            "gigaam": " ".join(gw[max(0, h0 - ctx):h0]) + " [" + " ".join(gw[h0:h1]) + "] " + " ".join(gw[h1:h1 + ctx]),
        })
    out["largest_diffs"] = picked
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
