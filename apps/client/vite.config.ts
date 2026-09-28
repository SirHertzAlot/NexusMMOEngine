import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localAssets } from "./vite-local-assets.js";

export default defineConfig({
  // localAssets: dev server only — the licensed art never enters a build.
  plugins: [react(), localAssets(fileURLToPath(new URL("../../assets", import.meta.url)))],
  server: { port: 5173 },
  build: {
    outDir: "dist-app",
    sourcemap: true,
  },
});
