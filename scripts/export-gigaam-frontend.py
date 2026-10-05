#!/usr/bin/env python3
"""Exports the GigaAM-v3 log-mel front-end to ONNX for the JS ASR engine (electron/src/asr/gigaam/).

The published GigaAM ONNX encoders (huggingface.co/istupakov/gigaam-v3-onnx) take log-mel
features, not audio, and torchaudio's MelSpectrogram does not export cleanly. This rebuilds
the exact same transform from exportable ops — the STFT is a strided Conv1d with Hann-windowed
DFT kernels — and checks it against gigaam's own FeatureExtractor before writing:

  MelSpectrogram(sr=16000, n_fft=320, win=320, hop=160, center=False, n_mels=64, htk, norm=None)
  → log(clamp(x, 1e-9, 1e9))

Inputs:  wav [B, N] float32 in [-1, 1), length [B] int64 (valid samples per row)
Outputs: features [B, 64, T] float32, feature_lengths [B] int64  (T = (N - 320) // 160 + 1)

One-off, needs a throwaway env with torch + torchaudio + gigaam. GigaAM's PyPI release pins an old
torch, so install it from source with the onnx pins relaxed:
  python3 -m venv .venv && git clone --depth 1 https://github.com/salute-developers/GigaAM.git
  sed -i '' -e 's/"onnx==1.19.\*"/"onnx"/' -e 's/"onnxruntime==1.23.\*"/"onnxruntime"/' GigaAM/pyproject.toml
  .venv/bin/pip install -e "./GigaAM[torch]"
  .venv/bin/python scripts/export-gigaam-frontend.py [out.onnx]
"""
import math
import sys
from pathlib import Path

import torch
import torchaudio
from torch import nn

SR, N_FFT, HOP, N_MELS = 16000, 320, 160, 64
N_BINS = N_FFT // 2 + 1
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else \
    Path(__file__).resolve().parent.parent / "electron" / "src" / "asr" / "gigaam" / "frontend.onnx"


class Frontend(nn.Module):
    def __init__(self):
        super().__init__()
        n = torch.arange(N_FFT, dtype=torch.float64)
        k = torch.arange(N_BINS, dtype=torch.float64)[:, None]
        win = torch.hann_window(N_FFT, periodic=True, dtype=torch.float64)
        ang = 2 * math.pi * k * n / N_FFT
        kernels = torch.cat([torch.cos(ang) * win, -torch.sin(ang) * win])  # [2*bins, n_fft]
        self.register_buffer("kernels", kernels.float().unsqueeze(1))
        fb = torchaudio.functional.melscale_fbanks(N_BINS, 0.0, SR / 2, N_MELS, SR, None, "htk")
        self.register_buffer("fb_t", fb.T.contiguous().float())  # [mels, bins]

    def forward(self, wav, length):
        x = nn.functional.conv1d(wav.unsqueeze(1), self.kernels, stride=HOP)  # [B, 2*bins, T]
        re, im = x[:, :N_BINS], x[:, N_BINS:]
        mel = torch.matmul(self.fb_t, re * re + im * im)                       # [B, mels, T]
        return torch.log(mel.clamp(1e-9, 1e9)), (length - N_FFT) // HOP + 1


def main():
    from gigaam.preprocess import FeatureExtractor

    ref = FeatureExtractor(SR, N_MELS, win_length=N_FFT, hop_length=HOP, n_fft=N_FFT, center=False)
    fe = Frontend().eval()

    torch.manual_seed(0)
    wav = (torch.randn(2, SR * 7) * 0.1).clamp(-1, 1)
    wav[1, SR * 3:] = 0  # padded row
    lens = torch.tensor([SR * 7, SR * 3])
    with torch.no_grad():
        got, got_len = fe(wav, lens)
        want, want_len = ref(wav, lens)
    diff = (got - want).abs().max().item()
    print(f"parity vs gigaam FeatureExtractor: max |Δlog-mel| = {diff:.2e}, lengths {got_len.tolist()} == {want_len.tolist()}")
    assert got.shape == want.shape and torch.equal(got_len, want_len) and diff < 1e-3, "front-end mismatch"

    OUT.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        fe, (wav, lens), str(OUT), dynamo=False, opset_version=17,
        input_names=["wav", "length"], output_names=["features", "feature_lengths"],
        dynamic_axes={"wav": {0: "batch", 1: "samples"}, "length": {0: "batch"},
                      "features": {0: "batch", 2: "frames"}, "feature_lengths": {0: "batch"}},
    )

    import numpy as np
    import onnxruntime as rt
    out = rt.InferenceSession(str(OUT)).run(None, {"wav": wav.numpy(), "length": lens.numpy()})
    odiff = np.abs(out[0] - want.numpy()).max()
    print(f"onnx vs gigaam: max |Δlog-mel| = {odiff:.2e}")
    assert odiff < 1e-3, "onnx front-end mismatch"
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
