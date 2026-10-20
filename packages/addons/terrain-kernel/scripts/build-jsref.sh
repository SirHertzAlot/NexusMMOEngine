#!/bin/bash
# Build the JS reference for parity testing: compile the ACTUAL
# terrain/erosion.ts + hydrology.ts + grid-ops.ts (not a copy) to
# test/jsref/ so test/parity.test.js can run the real JS operators.
#
# Usage: bash scripts/build-jsref.sh
# Requires: typescript (uses the repo's if installed, else npx cache).

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$HERE/.."
TERRAIN="$PKG/../../engine-core/src/terrain"
OUT="$PKG/test/jsref"

mkdir -p "$OUT"

# The three files form a closed unit: erosion.ts imports type-only from
# survey.js (erased) and values from hydrology.js; hydrology.ts imports
# values from grid-ops.js. commonjs output rewrites the .js-suffixed
# relative imports to requires of the compiled siblings.
TSC=""
if [ -x "$PKG/node_modules/.bin/tsc" ]; then
  TSC="$PKG/node_modules/.bin/tsc"
elif [ -x "$PKG/../../engine-core/node_modules/.bin/tsc" ]; then
  TSC="$PKG/../../engine-core/node_modules/.bin/tsc"
fi

if [ -n "$TSC" ]; then
  "$TSC" --module commonjs --target es2020 --moduleResolution node \
    --types node --noCheck --skipLibCheck --outDir "$OUT" \
    "$TERRAIN/erosion.ts" "$TERRAIN/hydrology.ts" "$TERRAIN/grid-ops.ts"
else
  npx -y -p typescript@5 tsc --module commonjs --target es2020 \
    --moduleResolution node --types node --noCheck --skipLibCheck \
    --outDir "$OUT" \
    "$TERRAIN/erosion.ts" "$TERRAIN/hydrology.ts" "$TERRAIN/grid-ops.ts"
fi

echo "jsref built at $OUT"
# tsc nests output under terrain/ (common root follows the import chain);
# the three reference files are a closed runtime unit, so hoist them flat
# where the tests require them, and drop the cascade.
for f in erosion.js hydrology.js grid-ops.js; do
  cp "$OUT/terrain/$f" "$OUT/$f"
done
rm -rf "$OUT/terrain" "$OUT/procgen" "$OUT/stats" \
  "$OUT"/sab-store.js "$OUT"/snapshot.js "$OUT"/world.js \
  "$OUT"/components.js "$OUT"/entity-id.js
ls "$OUT"
