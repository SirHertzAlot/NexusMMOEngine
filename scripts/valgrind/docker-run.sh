set -e
mkdir -p /work && cd /work
tar -C /src --exclude=./node_modules --exclude='*/node_modules' --exclude=./assets --exclude=./.git --exclude=./valgrind-out --exclude=./data --exclude=./docs/kb --exclude='*/build' --exclude='*/dist' -cf - . | tar -xf -
if ! cmp -s package-lock.json .lock-installed; then npm ci --ignore-scripts >/dev/null 2>&1 || npm install --ignore-scripts >/dev/null 2>&1; cp package-lock.json .lock-installed; fi
for d in packages/addons/*/; do [ -f "$d/binding.gyp" ] && (cd $d && npx node-gyp rebuild >/dev/null 2>&1 || echo "addon build failed: $d"); done
npm run build:deps >/dev/null 2>&1 || npm run build >/dev/null 2>&1 || true
cd /work && "$@"
