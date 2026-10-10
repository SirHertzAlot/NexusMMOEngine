import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localAssets } from "./vite-local-assets.js";
import { gpuBenchmarks } from "./vite-gpu-benchmarks.js";
import { animationDoc, audioEvents, combatMoves, gameFlow, materialsDoc } from "./vite-game-flow.js";
import { gameStrings } from "./vite-game-strings.js";

export default defineConfig({
  // localAssets: dev server only — the licensed art never enters a build.
  plugins: [react(), gameFlow(fileURLToPath(new URL("../../content/flow/game.flow.json", import.meta.url))), audioEvents(fileURLToPath(new URL("../../content/audio/events.json", import.meta.url))), combatMoves(fileURLToPath(new URL("../../content/combat/moves.json", import.meta.url))), animationDoc(fileURLToPath(new URL("../../content/animation/animations.json", import.meta.url))), materialsDoc(fileURLToPath(new URL("../../content/materials/materials.json", import.meta.url))), gameStrings(fileURLToPath(new URL("../../content/strings", import.meta.url))), localAssets(fileURLToPath(new URL("../../assets", import.meta.url))), gpuBenchmarks()],
  server: { port: 5173 },
  build: {
    outDir: "dist-app",
    sourcemap: true,
  },
});
