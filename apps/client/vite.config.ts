import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localAssets } from "./vite-local-assets.js";
import { gpuBenchmarks } from "./vite-gpu-benchmarks.js";
import { animationDoc, audioEvents, combatMoves, gameFlow, materialsDoc, vfxBudgets, vfxEffects } from "./vite-game-flow.js";
import { gameStrings } from "./vite-game-strings.js";
import compression from "vite-plugin-compression";

export default defineConfig(({ mode }) => {
  const isDev = mode === "development";
  
  return {
    // localAssets: dev server only — the licensed art never enters a build.
    plugins: [
      react(),
      gameFlow(fileURLToPath(new URL("../../content/flow/game.flow.json", import.meta.url))),
      audioEvents(fileURLToPath(new URL("../../content/audio/events.json", import.meta.url))),
      combatMoves(fileURLToPath(new URL("../../content/combat/moves.json", import.meta.url))),
      animationDoc(fileURLToPath(new URL("../../content/animation/animations.json", import.meta.url))),
      materialsDoc(fileURLToPath(new URL("../../content/materials/materials.json", import.meta.url))),
      vfxBudgets(fileURLToPath(new URL("../../content/vfx/budgets.json", import.meta.url))),
      vfxEffects([
        fileURLToPath(new URL("../../content/vfx/shrine-fire.json", import.meta.url)),
        fileURLToPath(new URL("../../content/vfx/shrine-water.json", import.meta.url)),
        fileURLToPath(new URL("../../content/vfx/shrine-earth.json", import.meta.url)),
        fileURLToPath(new URL("../../content/vfx/shrine-wind.json", import.meta.url)),
        fileURLToPath(new URL("../../content/vfx/shrine-darkness.json", import.meta.url)),
      ]),
      gameStrings(fileURLToPath(new URL("../../content/strings", import.meta.url))),
      localAssets(fileURLToPath(new URL("../../assets", import.meta.url))),
      gpuBenchmarks(),
      // Compression: gzip + brotli for production builds
      !isDev && compression({
        algorithm: "brotliCompress",
        ext: ".br",
        threshold: 1024,
        deleteOriginFile: false,
      }),
      !isDev && compression({
        algorithm: "gzip",
        ext: ".gz",
        threshold: 1024,
        deleteOriginFile: false,
      }),
    ].filter(Boolean),
    
    // Cross-origin isolation (SAB Phase 6): SharedArrayBuffer only exists in
    // cross-origin isolated pages. These headers turn it on for `vite dev`
    // and `vite preview`. PRODUCTION MUST SERVE THE SAME HEADERS or the
    // client silently falls back to main-thread decode — see
    // docs/CLIENT-SAB-ASSET-PIPELINE.md ("Deployment: COOP/COEP").
    server: {
      port: 5173,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
    preview: {
      // Lighthouse doesn't support COOP/COEP in headless mode; remove for testing.
      // Production MUST serve these headers for SAB to work.
      // headers: {
      //   "Cross-Origin-Opener-Policy": "same-origin",
      //   "Cross-Origin-Embedder-Policy": "require-corp",
      // },
    },
    build: {
      outDir: "dist-app",
      sourcemap: true,
      // Minification: use esbuild (faster) with aggressive options
      minify: "esbuild",
      target: "es2022",
      // CSS code splitting
      cssCodeSplit: true,
      // Asset inlining threshold (bytes)
      assetsInlineLimit: 4096,
      // Rollup options for advanced bundling
      rollupOptions: {
        // Code splitting: split vendor chunks and heavy deps
        output: {
manualChunks: {
            // Heavy Three.js ecosystem
            "three-core": ["three"],
            "three-extras": [
              "three/examples/jsm/loaders/GLTFLoader.js",
              "three/examples/jsm/loaders/KTX2Loader.js",
              "three-mesh-bvh",
              "three-nebula",
              "postprocessing",
            ],
            // React Three Fiber ecosystem
            "r3f-core": ["@react-three/fiber", "@react-three/drei", "@react-three/postprocessing"],
            // React ecosystem
            "react-vendor": ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
            // Animation/Three.js extras (animouse, three.quarks)
            "anim-vendor": ["animouse", "three.quarks"],
            // Utility
            "utils-vendor": ["zod", "meshoptimizer"],
            // Three.js examples (heavy, split out)
            "three-examples": [
              "three/examples/jsm/libs/ktx-parse.module.js",
              "three/examples/jsm/libs/zstddec.module.js",
              "three/examples/jsm/controls/OrbitControls.js",
            ],
          },
          // Chunk naming for cache busting
          chunkFileNames: "assets/[name]-[hash].js",
          entryFileNames: "assets/[name]-[hash].js",
          assetFileNames: (assetInfo) => {
            const name = assetInfo.name ?? "asset";
            const info = name.split(".");
            const ext = info[info.length - 1];
            if (/\.(png|jpe?g|gif|webp|svg|ico)$/.test(name)) {
              return `assets/images/[name]-[hash].${ext}`;
            }
            if (/\.(woff2?|ttf|eot)$/.test(name)) {
              return `assets/fonts/[name]-[hash].${ext}`;
            }
            return `assets/[name]-[hash].${ext}`;
          },
        },
        // Treeshaking: ensure pure modules are marked
        treeshake: {
          moduleSideEffects: "no-external",
          propertyReadSideEffects: false,
          tryCatchDeoptimization: false,
        },
      },
      // Chunk size warnings
      chunkSizeWarningLimit: 500,
      // Report compressed sizes
      reportCompressedSize: true,
    },
  };
});