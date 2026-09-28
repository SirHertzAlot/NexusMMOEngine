#!/usr/bin/env bash
# Packages the built addon into a platform-tagged tarball under prebuilds/.
# (Local artifact packaging only; prebuild-install style distribution is
# future work.)
set -euo pipefail
cd "$(dirname "$0")/.."
PLATFORM="$(node -p "process.platform")"
ARCH="$(node -p "process.arch")"
NODE_ABI="$(node -p "process.versions.modules")"
OUT_DIR="prebuilds"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/procgen-$PLATFORM-$ARCH-abi$NODE_ABI.tar.gz"
tar -czf "$OUT" build/Release/procgen.node index.js index.d.ts package.json README.md
echo "prebuild: wrote $OUT"
