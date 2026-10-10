import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localAssets } from "./vite-local-assets.js";
import { gpuBenchmarks } from "./vite-gpu-benchmarks.js";
import { gameFlow } from "./vite-game-flow.js";
import { gameStrings } from "./vite-game-strings.js";

export default defineConfig({
  // localAssets: dev server only — the licensed art never enters a build.
  plugins: [react(), gameFlow(fileURLToPath(new URL("../../content/flow/game.flow.json", import.meta.url))), gameStrings(fileURLToPath(new URL("../../content/strings", import.meta.url))), localAssets(fileURLToPath(new URL("../../assets", import.meta.url))), gpuBenchmarks()],
  server: { port: 5173 },
  build: {
    outDir: "dist-app",
    sourcemap: true,
  },
});
