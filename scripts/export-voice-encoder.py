#!/usr/bin/env python3
"""
Build tool — regenerates the committed diarization model artifacts. Run only if you need
to rebuild them; both outputs are checked into the repo, so normal use never needs this.

Requires a throwaway env with torch + librosa + resemblyzer + onnx, e.g.:

  python3 -m venv /tmp/ve && /tmp/ve/bin/pip install resemblyzer librosa torch onnx
  /tmp/ve/bin/python scripts/export-voice-encoder.py

Produces:
  electron/src/diarize/voice-encoder.onnx         — LSTM+linear+relu, NO L2 norm (~6 MB)
  electron/src/diarize/mel-filterbank.json        — exact librosa Slaney mel matrix

The L2 normalisation that resemblyzer applies in forward() is intentionally left
OUT of the ONNX graph: it is done in JS (per-partial L2 → mean → L2), which is
easier to verify and keeps the graph to the parts that actually need the weights.
"""

import json
import os

import numpy as np
import torch
import librosa
from torch import nn
from resemblyzer import VoiceEncoder

# Mirror resemblyzer.hparams — kept local so this script documents what it assumes.
SAMPLE_RATE = 16000
N_FFT = int(SAMPLE_RATE * 25 / 1000)   # 400
N_MELS = 40

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIARIZE_DIR = os.path.join(ROOT, 'electron', 'src', 'diarize')
ONNX_OUT = os.path.join(DIARIZE_DIR, 'voice-encoder.onnx')
MEL_OUT = os.path.join(DIARIZE_DIR, 'mel-filterbank.json')


class RawVoiceEncoder(nn.Module):
    """VoiceEncoder forward up to (but not including) the L2 normalisation."""

    def __init__(self, src: VoiceEncoder):
        super().__init__()
        self.lstm = src.lstm
        self.linear = src.linear
        self.relu = src.relu

    def forward(self, mels: torch.FloatTensor):
        _, (hidden, _) = self.lstm(mels)
        return self.relu(self.linear(hidden[-1]))  # (batch, 256), un-normalised


def export_onnx():
    src = VoiceEncoder(device='cpu', verbose=False)
    model = RawVoiceEncoder(src).eval()

    # (batch, n_frames, n_mels). We pin batch=1 and feed partials one at a time in JS:
    # ONNX's TorchScript LSTM export bakes the initial h0/c0 to the dummy batch size, so a
    # variable batch would silently break. Per-partial inference sidesteps that entirely and
    # the partial count per segment is tiny. n_frames is partials_n_frames=160 in practice
    # but kept dynamic so the graph is not brittle.
    dummy = torch.randn(1, 160, N_MELS, dtype=torch.float32)

    with torch.no_grad():
        ref = model(dummy)

    os.makedirs(os.path.dirname(ONNX_OUT), exist_ok=True)
    torch.onnx.export(
        model, dummy, ONNX_OUT,
        input_names=['mels'], output_names=['embeds'],
        dynamic_axes={'mels': {1: 'frames'}},
        opset_version=17,
        dynamo=False,
    )
    print(f'wrote {ONNX_OUT}  (ref output shape {tuple(ref.shape)})')
    return model


def dump_mel_filterbank():
    # Exact librosa Slaney filterbank — reproduced verbatim in JS would be error-prone,
    # so we ship the matrix. norm='slaney', htk=False, fmin=0, fmax=sr/2 (all defaults).
    fb = librosa.filters.mel(sr=SAMPLE_RATE, n_fft=N_FFT, n_mels=N_MELS)
    fb = np.asarray(fb, dtype=np.float64)  # JSON in float64; JS casts to Float32 on load
    os.makedirs(os.path.dirname(MEL_OUT), exist_ok=True)
    with open(MEL_OUT, 'w') as f:
        json.dump({
            'sr': SAMPLE_RATE,
            'n_fft': N_FFT,
            'n_mels': N_MELS,
            'shape': list(fb.shape),       # [40, 201]
            'filters': fb.tolist(),
        }, f)
    print(f'wrote {MEL_OUT}  (shape {fb.shape})')


def main():
    dump_mel_filterbank()
    export_onnx()


if __name__ == '__main__':
    main()
