import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { editorHost } from "./src/host.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
// apps/editor → repo root
const repoRoot = resolve(thisDir, "..", "..");

export default defineConfig(() => {
  return {
    plugins: [react(), editorHost({ repoRoot })],
    resolve: {
      // Play mode's game view (E4) draws with the client's renderer, from its
      // source: one renderer, not a copy (types: tsconfig paths, the built client).
      alias: {
        "@mmo-engine/client/render": resolve(repoRoot, "apps/client/src/render/index.ts"),
        // The play-mode debugger's shared panels (E5).
        "@mmo-engine/client/debug": resolve(repoRoot, "apps/client/src/ui/debug.ts"),
        // The Audio panel auditions events with the client's own engine (EA24).
        "@mmo-engine/client/audio": resolve(repoRoot, "apps/client/src/audio/index.ts"),
      },
    },
    // The client's public files: the terrain surfaces (npm run surfaces:fetch).
    publicDir: resolve(repoRoot, "apps/client/public"),
    server: { port: 5174 },
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
            // Animation/Three.js extras
            "anim-vendor": ["animouse", "three.quarks"],
            // Utility
            "utils-vendor": ["zod", "meshoptimizer"],
            // Editor-specific heavy deps
            "editor-ui": ["lil-gui"],
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
