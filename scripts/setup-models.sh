#!/usr/bin/env bash
# One-shot setup for t-scriber's local AI tools (macOS / Apple Silicon).
# Builds whisper.cpp (whisper-cli) and llama.cpp (llama-completion) with Metal,
# and downloads the models. No daemon, no sudo required — uses Xcode's clang and
# a standalone cmake if the system one is missing.
#
#   ./scripts/setup-models.sh
#
# Re-running skips finished steps.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TP="$ROOT/third_party"
MODELS="$ROOT/models"
mkdir -p "$TP" "$MODELS"

WHISPER_MODEL="$MODELS/ggml-large-v3-turbo-q5_0.bin"
WHISPER_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
VAD_MODEL="$MODELS/ggml-silero-v5.1.2.bin"
VAD_URL="https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
# Text-only E4B gguf (the multimodal e4b bundle — e.g. `ollama pull gemma4:e4b` — won't load
# in llama.cpp's text loader; mmproj-*.gguf in the same repo is the separate vision/audio part).
GEMMA="$MODELS/gemma-4-E4B-it-Q4_K_M.gguf"
GEMMA_URL="https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf"

echo "==> repo root: $ROOT"

# --- cmake (standalone, no sudo) -------------------------------------------
ensure_cmake() {
  if command -v cmake >/dev/null 2>&1; then CMAKE="$(command -v cmake)"; return; fi
  CMAKE="$TP/cmake/CMake.app/Contents/bin/cmake"
  if [ -x "$CMAKE" ]; then return; fi
  echo "==> fetching standalone cmake"
  local TAG VER URL
  TAG=$(curl -sI https://github.com/Kitware/CMake/releases/latest | awk -F'/tag/' '/^location:/{print $2}' | tr -d '\r')
  VER=${TAG#v}
  URL="https://github.com/Kitware/CMake/releases/download/${TAG}/cmake-${VER}-macos-universal.tar.gz"
  curl -L --fail -o /tmp/cmake.tgz "$URL"
  rm -rf "$TP/cmake" && mkdir -p "$TP/cmake"
  tar xzf /tmp/cmake.tgz -C "$TP/cmake" --strip-components=1
}

# --- build a repo's Metal target -------------------------------------------
build_repo() { # <name> <git-url> <target> <built-binary>
  local name="$1" url="$2" target="$3" out="$4"
  if [ -x "$out" ]; then echo "==> $name already built"; return; fi
  ensure_cmake
  if [ ! -d "$TP/$name/.git" ]; then
    echo "==> cloning $name"
    git clone --depth 1 "$url" "$TP/$name"
  fi
  echo "==> building $name ($target, Metal)"
  "$CMAKE" -B "$TP/$name/build" -S "$TP/$name" -DGGML_METAL=ON -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release
  "$CMAKE" --build "$TP/$name/build" -j --config Release --target "$target"
}

download() { # <path> <url> <label>
  if [ -f "$1" ]; then echo "==> $3 already present"; return; fi
  echo "==> downloading $3"
  curl -L --fail -o "$1" "$2"
}

build_repo whisper.cpp https://github.com/ggml-org/whisper.cpp whisper-cli "$TP/whisper.cpp/build/bin/whisper-cli"
build_repo llama.cpp   https://github.com/ggml-org/llama.cpp     llama-completion "$TP/llama.cpp/build/bin/llama-completion"

download "$WHISPER_MODEL" "$WHISPER_URL" "whisper large-v3-turbo q5 (~547 MB)"
download "$VAD_MODEL"     "$VAD_URL"     "Silero VAD (~1 MB)"
download "$GEMMA"         "$GEMMA_URL"   "Gemma 4 E4B Q4_K_M (~5.3 GB, text-only)"

# Diarization needs no setup here: the voice-encoder.onnx model (~6 MB) is committed in
# electron/src/diarize/ and the onnxruntime-node addon comes in via `npm install`.

echo
echo "==> done. Install deps & run:"
echo "    cd electron && npm install && npm start"
