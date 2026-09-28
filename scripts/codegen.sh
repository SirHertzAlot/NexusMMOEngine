#!/usr/bin/env bash
# Regenerate FlatBuffers bindings from the single source of truth.
#
# Usage:
#   npm run codegen              # writes packages/schema/generated/{cpp,ts}
#   OUT_DIR=/tmp/gen npm run codegen   # reproducibility check target
#
# flatc source: vendored at third_party/flatc/flatc (official
# google/flatbuffers release binary, Linux x86_64). A system flatc on PATH
# is used as a fallback. Generated code is gitignored and never hand-edited.
#
# Note: modern flatc removed the plain `--js` generator; `--ts` is the
# supported JavaScript/TypeScript path.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

if [ -x third_party/flatc/flatc ]; then
  FLATC=third_party/flatc/flatc
elif command -v flatc >/dev/null 2>&1; then
  FLATC=flatc
else
  echo "error: no flatc found." >&2
  echo "Expected vendored binary at third_party/flatc/flatc, or install:" >&2
  echo "  sudo apt-get install flatbuffers-compiler   # Ubuntu/Debian" >&2
  exit 1
fi

OUT="${OUT_DIR:-packages/schema/generated}"
mkdir -p "$OUT/cpp" "$OUT/ts"

"$FLATC" --cpp -o "$OUT/cpp" packages/schema/mmo_engine.fbs
"$FLATC" --ts  -o "$OUT/ts"  packages/schema/mmo_engine.fbs

echo "codegen OK (flatc: $FLATC):"
find "$OUT" -type f | sort
