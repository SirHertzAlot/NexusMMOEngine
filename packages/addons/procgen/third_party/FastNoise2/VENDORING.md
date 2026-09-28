# Vendored FastNoise2

- **Source:** https://github.com/Auburn/FastNoise2
- **Commit:** `06969a19061d9a5c3892d300412f37fc21d8efe1` (vendored 2026-09-27)
- **License:** MIT, Copyright (c) 2020 Jordan Peck — full text in `LICENSE`
  (verified against the upstream LICENSE file, not from memory).
- **What was copied:** `include/`, `src/` (minus CMake files), `LICENSE`.
  The `.git` history was intentionally left behind.

## Why vendored, not fetch-at-build

1. **Reproducible builds:** the exact commit is pinned in the repo; a
   `git clone` at build time could silently move under us.
2. **Repo convention:** `third_party/flatc/flatc` is already vendored for
   the same reason.
3. **Size:** ~576 KB — cheap to carry.

If upstream ever needs updating: replace `include/` + `src/`, update the
commit hash above, re-run the determinism tests (expected fingerprints
may legitimately change with a library update — record the new ones).
