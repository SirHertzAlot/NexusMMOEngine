---
name: browser-use
description: >-
  Use for browser automation, web app inspection, UI testing, and raster/video frame capture using Playwright or headless Chrome. Supports WebGL canvas recording, DOM event synthesis, and browser-driven playtests.
---

# Browser Use Skill

Automate browser sessions, perform in-game visual playtests, inspect web-rendered DOM and WebGL components, and capture live screenshots and action animations.

## Capabilities

1. **Headless & Headed Browser Control**: Launch Chromium via Playwright (`playwright` / `playwright-core`) with custom viewport sizes, device scale factors, and flags (`--enable-webgl`, `--use-gl=angle`, `--use-angle=swiftshader` or GPU hardware acceleration).
2. **WebGL Frame Extraction**: Intercept and snapshot 3D `<canvas>` elements, extracting live pixel buffers via `toDataURL('image/png')`, `gl.readPixels`, or Playwright `.screenshot({ path })`.
3. **Player Simulation**:
   - Dispatch keyboard navigation (`KeyW`, `KeyA`, `KeyS`, `KeyD`, `Space`, `KeyV` for camera toggle, `ShiftLeft` for sprint).
   - Mouse lock and aim dispatch (`pointermove`, `movementX`, `movementY`, `click` for combat strikes, `contextmenu` for block/guard).
4. **Playback & Recording**: Capture sequences of frames over discrete time deltas and encode them into animated GIFs or PNG strips for playtest verification.

## Typical Playwright Session Pattern

```typescript
import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  args: [
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--use-gl=angle",
    "--use-angle=swiftshader", // fallback when running without display server
    "--no-sandbox"
  ]
});

const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1
});

const page = await context.newPage();
await page.goto("http://localhost:5173", { waitUntil: "networkidle" });

// Wait for WebGL canvas to mount and render
const canvas = page.locator("canvas");
await canvas.waitFor({ state: "visible" });

// Trigger user action (e.g. toggle first-person perspective)
await page.keyboard.press("KeyV");
await page.waitForTimeout(500);

// Capture raster screenshot
await page.screenshot({ path: "artifacts/playtest-first-person.png" });

await browser.close();
```

## Guidelines for Engine Playtests

- Always verify that the Vite dev server (`npm run dev`) or static build preview is running before initiating connection.
- Wait for shaders and asset catalogs to load (listen for canvas `webglcontextrestored` or look for engine ready state indicators).
- Store genuine captured PNG/GIF playtests in the active artifact directory and embed them with absolute paths in reports.
