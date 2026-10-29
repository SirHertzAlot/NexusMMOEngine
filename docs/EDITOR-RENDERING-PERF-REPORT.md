# Nexus MMO Engine — Editor Rendering Performance Report

**Closes GitHub issue #456 (MEDIUM — rendering performance)**

Branch: `feat/issue-456-rendering-perf` (not merged to `main`)

---

## 1. Executive Summary & Gate Evaluation

This change applies three Vercel React rendering best-practice rules to the editor shell and client HUD to reduce paint cost for long lists, avoid type-coercion issues with `&&` conditionals, and preload lazy-loaded chunks.

| Change | Issue | Rule | Files touched |
| :--- | :--- | :--- | :--- |
| Add `content-visibility: auto` to long list containers | #456 | `rendering-content-visibility` | `apps/editor/src/ui/data-table.tsx`, `quests-live.tsx`, `asset-library-tree.tsx` |
| Replace `&&` conditionals with ternaries | #456 | `rendering-conditional-render` | `apps/client/src/App.tsx` |
| Add `<link rel="modulepreload">` for vendor chunks | #456 | `rendering-resource-hints` | `apps/editor/vite.config.ts`, `apps/client/vite.config.ts` |

### Phase Gate Evaluation

| Verification Gate | Target Specification | Measured Result | Status |
| :--- | :--- | :--- | :--- |
| **Gate 1: Type correctness** | `tsc --noEmit` clean on `apps/editor` and `apps/client` | 0 errors in all 6 edited files | PASS |
| **Gate 2: content-visibility applied** | Long list containers use `content-visibility: auto` with `containIntrinsicSize` | `data-table.tsx` tbody, `quests-live.tsx` ul + div, `asset-library-tree.tsx` models + textures | PASS |
| **Gate 3: && conditionals eliminated** | No `&&` JSX conditionals in client App.tsx | Both `&&` conditional render blocks converted to ternaries | PASS |
| **Gate 4: Resource hints injected** | Vite build injects `<link rel="modulepreload">` for vendor chunks | `resourceHintsPlugin` added to both vite configs; preloads `three-core`, `r3f-core`, `react-vendor`, etc. | PASS |

---

## 2. Measurement Environment

| Element | Value |
| :--- | :--- |
| OS | Linux (sandbox) |
| Node | v24.22.1 |
| TypeScript | 5.6.x (workspace) |
| React | 19.3.0 (`apps/editor`, `apps/client`) |
| Vite | 6.x (`apps/editor`, `apps/client`) |
| Build | `tsc --noEmit -p tsconfig.json` per workspace |
| Hardware | Sandbox (2 vCPU, 6 GiB cline container); results labeled **[modeled]** unless otherwise noted |
| Benchmarks run | None — no React render-bench harness exists in this repo for editor/client UI |

All performance numbers below are **[modeled]** estimates based on the React rendering model and browser content-visibility behavior, not measured on this codebase. No benchmark was executed because the repo lacks an editor/client render-bench infrastructure.

## 3. Methodology

- **Static analysis:** Identified long lists (>50 items) in gameplay grids, quest lists, and asset library tree that render all items without content-visibility.
- **Conditional render audit:** Searched `apps/client/src/App.tsx` for `&&` JSX conditionals; found two interact-prompt blocks using the `&&` short-circuit pattern.
- **Resource hint audit:** Confirmed no `<link rel="preload">` or `prefetch` existed in either `index.html`; Vite's hashed chunk filenames make static preload links impractical, so a build-time plugin was added.
- **Compiler check:** Ran `tsc --noEmit` on `apps/editor` and `apps/client`; both report **0 errors**.
- **No runtime benchmark:** React render timings were not measured; the repo lacks an editor/client render-bench harness.

## 4. Performance Implications (Modeled)

| Scenario | Before | After (modeled) | Basis |
| :--- | :--- | :--- | :--- |
| Gameplay grid with 100+ rows off-screen | All rows painted on first frame | Off-screen rows deferred until near viewport | `content-visibility: auto` skips paint/layout for off-screen content |
| Quest list with 50+ items | All items painted immediately | Off-screen items deferred | `content-visibility: auto` with `containIntrinsicSize` reserves layout space |
| Asset library tree with 200+ models | All tree items painted immediately | Off-screen items deferred | `content-visibility: auto` per list item container |
| `&&` conditional render | Falsy expression evaluates to `0`/`false` (type coercion) | Explicit `? : null` returns `null`, no coercion | Ternary avoids rendering primitive falsy values |
| Lazy chunk (PlayDebugger, TerrainEditor) | Chunk fetched on first use | Vendor chunks preloaded via `modulepreload` | `<link rel="modulepreload">` initiates fetch during HTML parse |

**Budget impact:** Content-visibility savings are most noticeable on long lists that extend beyond the initial viewport. At 60 fps, avoiding even one frame of layout/paint for off-screen content saves ~16.7 ms. The `&&` → ternary change has negligible runtime impact but eliminates a class of type-coordination bugs. Resource hints reduce time-to-interactive for lazy routes by starting vendor chunk fetches earlier ([modeled]: 50–100 ms earlier on slow connections).

**Trade-offs:**
- `content-visibility: auto` has a small cost when content enters the viewport (paint work is deferred, not eliminated). Best for content that is frequently off-screen.
- `containIntrinsicSize` values are estimates; incorrect values can cause layout shift when content becomes visible.
- `modulepreload` for vendor chunks increases early bandwidth usage; beneficial only if those chunks are actually needed on the page.

## 5. Caveats

1. **No measured numbers.** All performance figures are [modeled]. A render-bench harness (e.g., React Profiler, Chrome DevTools Performance panel) would be needed to convert these to [measured].
2. **Sandbox environment.** Type-check was run in an isolated sandbox (2 vCPU, 6 GiB); not representative of production hardware.
3. **No render tests.** The editor and client have no component render/unit tests in this repo, so regression coverage is limited to `tsc` and visual inspection.
4. **Resource hints depend on build output.** The `resourceHintsPlugin` matches chunk filenames by prefix (e.g., `three-core-<hash>.js`). If `manualChunks` keys change in vite config, the plugin must be updated to match.
5. **Pre-existing errors excluded.** Before this change, `tsc` on `apps/editor`/`apps/client` had pre-existing failures due to unbuilt workspace packages. After building dependencies, both workspaces report **0 errors**.


## 6. Files Changed

```
apps/client/src/App.tsx             && conditionals → ternaries (2 sites)
apps/client/vite.config.ts          resourceHintsPlugin added
apps/editor/src/ui/asset-library-tree.tsx  content-visibility on models + textures lists
apps/editor/src/ui/data-table.tsx   content-visibility on table tbody
apps/editor/src/ui/quests-live.tsx  content-visibility on quest list + tree container
apps/editor/vite.config.ts          resourceHintsPlugin added
```

## 7. Gate Verification Table

| Telemetry Metric | Measured Value | Gate Requirement | Gate Status |
| :--- | :--- | :--- | :--- |
| `tsc --noEmit` errors in edited files | 0 | 0 | PASS |
| Long lists with `content-visibility: auto` | 4 containers | All listed lists | PASS |
| `&&` JSX conditionals in client App.tsx | 0 | 0 | PASS |
| Vite configs with resourceHintsPlugin | 2/2 | Both editor + client | PASS |

## 8. Next Steps (Not Part of This Change)

1. Add a React render-bench harness for editor/client UI to convert [modeled] numbers to [measured].
2. Extend `content-visibility: auto` to other long lists (network details, resident lists, etc.) as they are identified.
3. Measure Lighthouse/TTI impact of resource hints on production builds.
4. Consider adding `loading="lazy"` to off-screen images in asset library tree.

