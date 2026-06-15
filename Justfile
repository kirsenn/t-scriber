ELECTRON_DIR  := "electron"
WHISPER_SRC   := "third_party/whisper.cpp"
LLAMA_SRC     := "third_party/llama.cpp"

# ── dev ──────────────────────────────────────────────────────────────────────

# Run the app in development mode
dev:
    cd {{ELECTRON_DIR}} && npm start

# Run unit tests
test:
    cd {{ELECTRON_DIR}} && npm test

# ── build from source ─────────────────────────────────────────────────────────

# Compile whisper.cpp (whisper-cli + dylibs)
build-whisper:
    cmake -S {{WHISPER_SRC}} -B {{WHISPER_SRC}}/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DWHISPER_BUILD_TESTS=OFF \
        -DWHISPER_BUILD_EXAMPLES=ON \
        -DBUILD_SHARED_LIBS=ON
    cmake --build {{WHISPER_SRC}}/build --config Release -j$(sysctl -n hw.logicalcpu)

# Compile llama.cpp (llama-completion + dylibs)
build-llama:
    cmake -S {{LLAMA_SRC}} -B {{LLAMA_SRC}}/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DLLAMA_BUILD_TESTS=OFF \
        -DBUILD_SHARED_LIBS=ON
    cmake --build {{LLAMA_SRC}}/build --config Release \
        -j$(sysctl -n hw.logicalcpu) \
        --target llama-completion

# ── packaging ─────────────────────────────────────────────────────────────────

# Copy binaries + dylibs to dist/staged/, fixing rpaths for portability
stage:
    bash scripts/stage-bins.sh

# Install npm dependencies in the electron dir
deps:
    cd {{ELECTRON_DIR}} && npm install

# Build .dmg (requires stage + deps to have run)
_package:
    cd {{ELECTRON_DIR}} && npx electron-builder --mac dmg

# Stage binaries + install deps, then produce the .dmg
package: stage deps _package

# Full build from source through to .dmg (takes a while)
build: build-whisper build-llama package

# ── benchmarking ─────────────────────────────────────────────────────────────

# Run E2E suite and measure peak CPU/RAM of whisper + llama + node
bench-e2e:
    bash scripts/measure-e2e.sh /tmp/tscriber-bench

# Start Electron and measure idle CPU/RAM for 30 s
bench-ui:
    bash scripts/measure-ui.sh /tmp/tscriber-bench 30

# ── housekeeping ──────────────────────────────────────────────────────────────

# Remove all build artefacts
clean:
    rm -rf dist/staged
    rm -rf {{ELECTRON_DIR}}/dist
    rm -rf {{WHISPER_SRC}}/build
    rm -rf {{LLAMA_SRC}}/build
