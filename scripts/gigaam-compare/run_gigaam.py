#!/usr/bin/env python3
"""Prototype: transcribe a t-scriber session track (16 kHz mono s16le PCM) with GigaAM-v3.

Long audio is split with Silero VAD into chunks of <= MAX_CHUNK_S (GigaAM's .transcribe is
limited to ~25 s), then decoded in batches. Output mirrors transcribe.js segments:
[{startMs, endMs, text, words:[{text,startMs,endMs}]}].

Usage: run_gigaam.py <track.pcm> <out.json> [--model v3_e2e_rnnt] [--device mps|cpu]
"""
import argparse
import json
import time

import numpy as np
import torch
from silero_vad import get_speech_timestamps, load_silero_vad

import gigaam
from gigaam.timestamps_utils import compute_frame_shift, frames_to_words

SR = 16000
MAX_CHUNK_S = 20.0   # stay well under GigaAM's 25 s limit
MAX_GAP_S = 0.6      # merge VAD regions separated by less than this
PAD_S = 0.15


def vad_chunks(wav: torch.Tensor):
    vad = load_silero_vad()
    ts = get_speech_timestamps(wav, vad, sampling_rate=SR, min_silence_duration_ms=300,
                               speech_pad_ms=int(PAD_S * 1000))
    chunks = []
    for t in ts:
        s, e = t["start"], t["end"]
        # split over-long regions
        while (e - s) / SR > MAX_CHUNK_S:
            chunks.append([s, s + int(MAX_CHUNK_S * SR)])
            s += int(MAX_CHUNK_S * SR)
        if chunks and (s - chunks[-1][1]) / SR < MAX_GAP_S and (e - chunks[-1][0]) / SR <= MAX_CHUNK_S:
            chunks[-1][1] = e
        else:
            chunks.append([s, e])
    return chunks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pcm")
    ap.add_argument("out")
    ap.add_argument("--model", default="v3_e2e_rnnt")
    ap.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cpu")
    ap.add_argument("--batch", type=int, default=8)
    a = ap.parse_args()

    raw = np.fromfile(a.pcm, dtype=np.int16)
    wav = torch.from_numpy(raw.astype(np.float32) / 32768.0)
    dur = len(wav) / SR

    t0 = time.time()
    chunks = vad_chunks(wav)
    t_vad = time.time() - t0

    t0 = time.time()
    model = gigaam.load_model(a.model, device=a.device, fp16_encoder=(a.device != "cpu"))
    model.eval()
    t_load = time.time() - t0

    t0 = time.time()
    segs = []
    with torch.inference_mode():
        for i in range(0, len(chunks), a.batch):
            batch = chunks[i:i + a.batch]
            pieces = [wav[s:e] for s, e in batch]
            lens = torch.tensor([len(p) for p in pieces])
            pad = torch.zeros(len(pieces), int(lens.max()))
            for j, p in enumerate(pieces):
                pad[j, :len(p)] = p
            pad = pad.to(model._device).to(model._dtype)
            lens = lens.to(model._device)
            enc, enc_len = model.forward(pad, lens)
            decoded = model.decoding.decode(model.head, enc, enc_len)
            for j, (text, tok_ids, tok_frames) in enumerate(decoded):
                s, e = batch[j]
                text = text.strip()
                if not text:
                    continue
                fs = compute_frame_shift(int(lens[j].item()), int(enc_len[j].item()))
                words = frames_to_words(model.decoding.tokenizer, tok_ids, tok_frames, fs)
                off = s / SR
                segs.append({
                    "startMs": round(s / SR * 1000),
                    "endMs": round(e / SR * 1000),
                    "text": text,
                    "words": [{"text": w.text, "startMs": round((w.start + off) * 1000),
                               "endMs": round((w.end + off) * 1000)} for w in words],
                })
    t_asr = time.time() - t0

    stats = {"audio_s": round(dur, 1), "chunks": len(chunks), "vad_s": round(t_vad, 1),
             "load_s": round(t_load, 1), "asr_s": round(t_asr, 1), "device": a.device,
             "model": a.model, "rtf": round((t_vad + t_asr) / dur, 4)}
    with open(a.out, "w") as f:
        json.dump({"stats": stats, "segments": segs}, f, ensure_ascii=False, indent=1)
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
