/**
 * Playtest Automated In-Engine Frame Capture (Playwright / WebGL).
 *
 * Connects a live browser client to the running game server, enters First-Person
 * perspective ('V'), exercises coupled camera locomotion, weapon swinging, and
 * guard stances, and captures genuine WebGL raster frames directly from the canvas.
 */

import { chromium } from "playwright";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { encodeGif } from "./gif-encoder.mjs";

const ARTIFACT_DIR = "C:/Users/user/.gemini/antigravity/brain/c021e30a-f9c6-4441-a0ef-65078c03604f";

async function main() {
  if (!existsSync(ARTIFACT_DIR)) {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
  }

  console.log("[playtest] Launching Chromium with WebGL SwiftShader...");
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--no-sandbox",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });

  const page = await context.newPage();
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("[first-person]") || text.includes("[combat]") || text.includes("[world]")) {
      console.log(`[client] ${text}`);
    }
  });

  console.log("[playtest] Navigating to http://localhost:5173...");
  await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  // Register a unique test account
  console.log("[playtest] Registering test player...");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForTimeout(300);

  const uname = `player_${Date.now().toString(36)}`;
  await page.fill("#username", uname);
  await page.fill("#password", "Playtest123!");
  await page.fill("#confirm-password", "Playtest123!");
  await page.getByRole("button", { name: /connect/i }).click();

  // Character creation screen
  console.log("[playtest] Waiting for character creation screen...");
  await page.waitForSelector("#character-name", { timeout: 10000 });
  await page.fill("#character-name", "Valerius");
  await page.getByRole("button", { name: /Create & enter world/i }).click();

  // Wait for 3D world canvas and workers to mount
  console.log("[playtest] Entering authoritative world...");
  await page.waitForTimeout(6000);

  const canvas = page.locator("canvas").first();
  await canvas.waitFor({ state: "visible" });

  // Switch to First-Person perspective
  console.log("[playtest] Pressing 'V' to toggle into First-Person perspective...");
  await page.keyboard.press("KeyV");
  await page.waitForTimeout(2000);

  // 1. Capture Idle Stance
  console.log("[playtest] Capturing First-Person Idle Stance...");
  const idleBuf = await canvas.screenshot();
  writeFileSync(join(ARTIFACT_DIR, "fps-combat-view-idle.png"), idleBuf);
  console.log(`[playtest] Wrote ${join(ARTIFACT_DIR, "fps-combat-view-idle.png")} (${idleBuf.length} bytes)`);

  // 2. Perform Movement & Stride Bobbing
  console.log("[playtest] Exercising locomotion head-bobbing...");
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(600);
  const strideBuf = await canvas.screenshot();
  writeFileSync(join(ARTIFACT_DIR, "fps-combat-view-stride.png"), strideBuf);
  await page.waitForTimeout(600);
  await page.keyboard.up("KeyW");
  await page.waitForTimeout(300);

  // 3. Perform Slash Strike Attack
  console.log("[playtest] Executing slash attack strike...");
  const box = await canvas.boundingBox();
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.click(cx, cy);
  } else {
    await canvas.click();
  }
  await page.waitForTimeout(150); // Mid-strike frame
  const slashBuf = await canvas.screenshot();
  writeFileSync(join(ARTIFACT_DIR, "fps-combat-view-slash.png"), slashBuf);
  console.log(`[playtest] Wrote ${join(ARTIFACT_DIR, "fps-combat-view-slash.png")} (${slashBuf.length} bytes)`);

  // 4. Guard / Block Stance
  console.log("[playtest] Raising guard stance...");
  if (box) {
    await page.mouse.down({ button: "right" });
    await page.waitForTimeout(400);
    const guardBuf = await canvas.screenshot();
    writeFileSync(join(ARTIFACT_DIR, "fps-combat-view-guard.png"), guardBuf);
    await page.mouse.up({ button: "right" });
    console.log(`[playtest] Wrote ${join(ARTIFACT_DIR, "fps-combat-view-guard.png")} (${guardBuf.length} bytes)`);
  }

  // 5. Capture Animated GIF Sequence (10 frames)
  console.log("[playtest] Capturing 10-frame live action sequence for GIF...");
  const gifWidth = 640;
  const gifHeight = 360;

  // Function to extract downsampled RGBA pixels from canvas directly in browser context
  const frames = [];
  for (let f = 0; f < 10; f++) {
    // Alternate movement and attacks
    if (f === 2) await page.keyboard.down("KeyW");
    if (f === 4) {
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    if (f === 7) await page.keyboard.up("KeyW");

    await page.waitForTimeout(100);

    const frameRgba = await page.evaluate(
      ({ w, h }) => {
        const c = document.querySelector("canvas");
        if (!c) return null;
        const off = document.createElement("canvas");
        off.width = w;
        off.height = h;
        const ctx = off.getContext("2d");
        ctx.drawImage(c, 0, 0, w, h);
        const imgData = ctx.getImageData(0, 0, w, h);
        return Array.from(imgData.data);
      },
      { w: gifWidth, h: gifHeight },
    );

    if (frameRgba) {
      frames.push(new Uint8Array(frameRgba));
    }
  }

  if (frames.length > 0) {
    console.log(`[playtest] Encoding ${frames.length} frames to GIF (${gifWidth}x${gifHeight})...`);
    const gifBuffer = encodeGif(frames, gifWidth, gifHeight, 10);
    writeFileSync(join(ARTIFACT_DIR, "fps-combat-action.gif"), gifBuffer);
    console.log(`[playtest] Wrote ${join(ARTIFACT_DIR, "fps-combat-action.gif")} (${gifBuffer.length} bytes)`);
  }

  console.log("[playtest] All genuine in-engine playtest captures completed successfully!");
  await browser.close();
}

main().catch((err) => {
  console.error("[playtest] FAILED:", err);
  process.exit(1);
});
