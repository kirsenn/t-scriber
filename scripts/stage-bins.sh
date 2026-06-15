#!/usr/bin/env bash
# Copies native binaries + their dylibs into dist/staged/bin/,
# fixing all hardcoded build-dir @rpath entries to @loader_path
# so the bundle is portable across machines.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/dist/staged"
WHISPER_BUILD="$ROOT/third_party/whisper.cpp/build"
LLAMA_BUILD="$ROOT/third_party/llama.cpp/build"

# ── helpers ──────────────────────────────────────────────────────────────────

fix_rpath() {
    local f="$1"
    chmod u+w "$f"
    # Remove all absolute rpaths (leave any existing @-relative ones).
    while IFS= read -r rp; do
        [[ "$rp" == @* ]] && continue
        install_name_tool -delete_rpath "$rp" "$f" 2>/dev/null || true
    done < <(otool -l "$f" | awk '/LC_RPATH/{found=1} found && /path /{print $2; found=0}')
    # Ensure @loader_path is present so siblings in the same dir are found.
    if ! otool -l "$f" | grep -q '@loader_path'; then
        install_name_tool -add_rpath "@loader_path" "$f"
    fi
}

# Copy a binary and all of its direct @rpath dylib dependencies.
# Usage: stage_with_deps <binary> <dest_dir> <search_dir>...
stage_with_deps() {
    local binary="$1"
    local dest="$2"
    shift 2
    local search_dirs=("$@")

    local name
    name="$(basename "$binary")"
    cp -fL "$binary" "$dest/$name"
    chmod u+x "$dest/$name"

    while IFS= read -r dep; do
        local lib="${dep#@rpath/}"
        for sd in "${search_dirs[@]}"; do
            local src
            src="$(find "$sd" -maxdepth 1 -name "$lib" 2>/dev/null | head -1)"
            if [[ -n "$src" ]]; then
                cp -fL "$src" "$dest/$lib"
                break
            fi
        done
    done < <(otool -L "$binary" | awk '/@rpath\//{print $1}')

    for f in "$dest"/*; do
        fix_rpath "$f"
    done
}

# ── whisper ──────────────────────────────────────────────────────────────────

WSP="$STAGE/bin/whisper"
mkdir -p "$WSP"
echo "Staging whisper-cli…"
stage_with_deps \
    "$WHISPER_BUILD/bin/whisper-cli" "$WSP" \
    "$WHISPER_BUILD/src" \
    "$WHISPER_BUILD/ggml/src" \
    "$WHISPER_BUILD/ggml/src/ggml-blas" \
    "$WHISPER_BUILD/ggml/src/ggml-metal"

# ── llama ─────────────────────────────────────────────────────────────────────

LM="$STAGE/bin/llama"
mkdir -p "$LM"
echo "Staging llama-completion…"
stage_with_deps \
    "$LLAMA_BUILD/bin/llama-completion" "$LM" \
    "$LLAMA_BUILD/bin"

echo "✓ Staged binaries under $STAGE/bin"
