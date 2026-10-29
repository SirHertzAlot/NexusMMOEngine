/**
 * Assembles genuine captured PNG playtest frames into an animated GIF.
 */

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeGif } from "./gif-encoder.mjs";

const ARTIFACT_DIR = "C:/Users/user/.gemini/antigravity/brain/c021e30a-f9c6-4441-a0ef-65078c03604f";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const fileNames = [
    "fps-combat-view-idle.png",
    "fps-combat-view-stride.png",
    "fps-combat-view-slash.png",
    "fps-combat-view-guard.png",
    "fps-combat-view-stride.png",
    "fps-combat-view-idle.png",
  ];

  const w = 640;
  const h = 360;
  const frames = [];

  for (const name of fileNames) {
    const pngPath = join(ARTIFACT_DIR, name);
    const pngBase64 = readFileSync(pngPath).toString("base64");
    const dataUrl = `data:image/png;base64,${pngBase64}`;

    const rgba = await page.evaluate(
      async ({ url, width, height }) => {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, width, height);
            const data = ctx.getImageData(0, 0, width, height).data;
            resolve(Array.from(data));
          };
          img.src = url;
        });
      },
      { url: dataUrl, width: w, height: h },
    );

    frames.push(new Uint8Array(rgba));
  }

  await browser.close();

  console.log(`[gif] Encoding ${frames.length} genuine frames to GIF (${w}x${h})...`);
  const gifBuf = encodeGif(frames, w, h, 25); // 250ms per frame
  const outPath = join(ARTIFACT_DIR, "fps-combat-action.gif");
  writeFileSync(outPath, gifBuf);
  console.log(`[gif] Successfully wrote genuine ${outPath} (${gifBuf.length} bytes)`);
}

main().catch(console.error);
