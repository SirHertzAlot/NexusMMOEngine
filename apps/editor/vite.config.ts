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
  server: { port: 5174 },
  build: {
    outDir: "dist-app",
    sourcemap: true,
  },
});
