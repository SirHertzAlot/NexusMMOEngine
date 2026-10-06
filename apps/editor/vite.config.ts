import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { editorHost } from "./src/host.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
// apps/editor → repo root
const repoRoot = resolve(thisDir, "..", "..");

export default defineConfig({
  plugins: [react(), editorHost({ repoRoot })],
  resolve: {
    // Play mode's game view (E4) draws with the client's renderer, from its
    // source: one renderer, not a copy (types: tsconfig paths, the built client).
    alias: {
      "@mmo-engine/client/render": resolve(repoRoot, "apps/client/src/render/index.ts"),
      // The play-mode debugger's shared panels (E5).
      "@mmo-engine/client/debug": resolve(repoRoot, "apps/client/src/ui/debug.ts"),
    },
  },
  // The client's public files: the terrain surfaces (npm run surfaces:fetch).
  publicDir: resolve(repoRoot, "apps/client/public"),
  server: { port: 5174 },
  build: {
    outDir: "dist-app",
    sourcemap: true,
  },
});
