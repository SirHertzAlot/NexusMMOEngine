set -e
mkdir -p /work && cd /work
# One run at a time: two containers building in the same volume corrupt it.
exec 9>/work/.lock && flock 9
echo "[valgrind] syncing the tree"
tar -C /src --exclude=./node_modules --exclude='*/node_modules' --exclude=./assets --exclude=./.git --exclude=./valgrind-out --exclude=./data --exclude=./docs/kb --exclude='*/build' --exclude='*/dist' -cf - . | tar -xf -
if ! cmp -s package-lock.json .lock-installed; then
  echo "[valgrind] installing dependencies"
  npm ci --ignore-scripts >/dev/null 2>&1 || npm install --ignore-scripts >/dev/null 2>&1
  cp package-lock.json .lock-installed
fi
# Rebuild an addon only when its sources changed (a clean Jolt build takes
# minutes); the build/ folders live in the volume between runs.
export JOBS=max
for d in packages/addons/*/; do
  [ -f "$d/binding.gyp" ] || continue
  sum=$(cd "$d" && find . -path ./build -prune -o -type f ! -name .built-hash -print0 | sort -z | xargs -0 sha1sum | sha1sum | cut -d' ' -f1)
  if [ -f "$d/build/Release/.ok" ] && [ "$(cat "$d/.built-hash" 2>/dev/null)" = "$sum" ]; then continue; fi
  echo "[valgrind] building addon $d"
  rm -f "$d/build/Release/.ok"
  if (cd "$d" && npx node-gyp rebuild >/work/.gyp.log 2>&1); then
    echo "$sum" > "$d/.built-hash"; touch "$d/build/Release/.ok"
  else
    echo "addon build failed: $d"; tail -20 /work/.gyp.log
  fi
done
npm run build:deps >/dev/null 2>&1 || npm run build >/dev/null 2>&1 || true
cd /work && "$@"
