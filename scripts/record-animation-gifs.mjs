import { chromium } from "playwright";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { encodeGif } from "./gif-encoder.mjs";

const ARTIFACT_DIR = "C:/Users/user/.gemini/antigravity/brain/c021e30a-f9c6-4441-a0ef-65078c03604f";

async function main() {
  if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true });

  console.log("[record] Launching Chromium with WebGL SwiftShader...");
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

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto("http://localhost:5173");
  await page.waitForTimeout(1000);

  // Register account
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForTimeout(300);

  const u = "anim_" + Math.random().toString(36).slice(2, 8);
  await page.fill("#username", u);
  await page.fill("#password", "Playtest123!");
  await page.fill("#confirm-password", "Playtest123!");
  await page.getByRole("button", { name: /connect/i }).click();

  // Character creation
  await page.waitForSelector("#character-name", { timeout: 10000 });
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let cname = "Vesper";
  for (let i = 0; i < 4; i++) cname += letters[(Math.random() * letters.length) | 0];
  await page.fill("#character-name", cname);
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: /create & enter world/i }).click();

  console.log("[record] Waiting for world and appearance sync (6s)...");
  await page.waitForTimeout(6000);

  console.log("[record] Toggling First-Person perspective (KeyV)...");
  await page.keyboard.press("KeyV");
  await page.waitForTimeout(1500);

  const gifW = 480;
  const gifH = 270;

  // Capture current canvas as a raw RGBA buffer via offscreen JPEG
  const captureFrame = async () => {
    const dataUrl = await page.evaluate(({ w, h }) => {
      const c = document.querySelector("canvas");
      if (!c) return null;
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const ctx = off.getContext("2d");
      ctx.drawImage(c, 0, 0, w, h);
      return off.toDataURL("image/jpeg", 0.88);
    }, { w: gifW, h: gifH });

    if (!dataUrl) throw new Error("Frame capture returned null");
    const b64 = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
    const rawBuf = await sharp(Buffer.from(b64, "base64")).raw().toBuffer();
    return new Uint8Array(rawBuf);
  };

  // Helper to compile and save a GIF
  const saveGif = (frames, name, delay100ths) => {
    console.log(`[record] Encoding ${name} (${frames.length} frames)...`);
    const gif = encodeGif(frames, gifW, gifH, delay100ths);
    writeFileSync(join(ARTIFACT_DIR, name), gif);
    console.log(`[record] Wrote ${name} (${gif.length} bytes)`);
  };

  // =========================================================================
  // 1. Idle Breathing Sway Animation (Player standing completely still)
  // =========================================================================
  console.log("[record] Recording 1: Idle Breathing Animation (standing still)...");
  const idleFrames = [];
  // Reset any motion/moves
  await page.evaluate(() => {
    const dbg = window.__mmoDebug;
    if (dbg && dbg.layer && dbg.layer.player) {
      dbg.layer.player.vx = 0;
      dbg.layer.player.vy = 0;
      dbg.layer.player.vz = 0;
      dbg.layer.player.mode = "idle";
      dbg.layer.player.move = 0;
      dbg.layer.player.moveElapsed = 0;
    }
  });

  // Record 16 frames across natural breathing cycle (~2 seconds, 120ms intervals)
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(120);
    const frame = await captureFrame();
    idleFrames.push(frame);
  }
  saveGif(idleFrames, "fps-combat-idle.gif", 12);

  // =========================================================================
  // 2. Slash Attack Strike Animation (Windup -> Strike with Trail -> Recover)
  // =========================================================================
  console.log("[record] Recording 2: Slash Attack Strike Animation...");
  const slashFrames = [];
  // SwordA duration is ~0.43s. We step through from t=0.00 to t=0.42 in 14 steps
  const slashSteps = [
    0.00, 0.04, 0.08, 0.12, 0.16, 0.20, 0.24, 0.28, 0.32, 0.36, 0.40, 0.44
  ];

  for (const el of slashSteps) {
    await page.evaluate((elapsed) => {
      const dbg = window.__mmoDebug;
      if (dbg && dbg.layer && dbg.layer.player) {
        dbg.layer.player.vx = 0;
        dbg.layer.player.mode = "combat";
        dbg.layer.player.move = 1; // Move.SwordA
        dbg.layer.player.moveElapsed = elapsed;
      }
    }, el);
    await page.waitForTimeout(60);
    const frame = await captureFrame();
    slashFrames.push(frame);
  }
  saveGif(slashFrames, "fps-combat-slash.gif", 7);

  // =========================================================================
  // 3. Defensive Guard Block Animation (Raise -> Hold Block -> Lower)
  // =========================================================================
  console.log("[record] Recording 3: Defensive Guard Block Animation...");
  const guardFrames = [];
  // Guard steps: raise forearm (0.0 to 0.2), hold high guard (0.25 to 0.35), release
  const guardSteps = [
    { move: 0, el: 0 },
    { move: 6, el: 0.05 },
    { move: 6, el: 0.10 },
    { move: 6, el: 0.18 },
    { move: 6, el: 0.25 },
    { move: 6, el: 0.30 },
    { move: 6, el: 0.35 },
    { move: 6, el: 0.15 },
    { move: 6, el: 0.05 },
    { move: 0, el: 0 },
  ];

  for (const step of guardSteps) {
    await page.evaluate(({ move, el }) => {
      const dbg = window.__mmoDebug;
      if (dbg && dbg.layer && dbg.layer.player) {
        dbg.layer.player.vx = 0;
        dbg.layer.player.mode = "combat";
        dbg.layer.player.move = move;
        dbg.layer.player.moveElapsed = el;
      }
    }, step);
    await page.waitForTimeout(70);
    const frame = await captureFrame();
    guardFrames.push(frame);
  }
  saveGif(guardFrames, "fps-combat-guard.gif", 8);

  // =========================================================================
  // 4. Locomotion Stride Bobbing Animation (Walking/Running head-bob & counter-swing)
  // =========================================================================
  console.log("[record] Recording 4: Locomotion Stride Bobbing Animation...");
  const strideFrames = [];
  await page.evaluate(() => {
    const dbg = window.__mmoDebug;
    if (dbg && dbg.layer && dbg.layer.player) {
      dbg.layer.player.mode = "run";
      dbg.layer.player.vx = 4.5;
      dbg.layer.player.grounded = true;
      dbg.layer.player.move = 0;
      dbg.layer.player.moveElapsed = 0;
    }
  });

  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(90);
    const frame = await captureFrame();
    strideFrames.push(frame);
  }
  saveGif(strideFrames, "fps-combat-stride.gif", 9);

  // =========================================================================
  // 5. Complete Combined Action Sequence
  // =========================================================================
  console.log("[record] Recording 5: Full Action Sequence (Idle -> Stride -> Slash -> Guard -> Idle)...");
  // Combine 4 idle frames, 5 stride frames, 6 slash frames, 4 guard frames
  const actionFrames = [
    ...idleFrames.slice(0, 4),
    ...strideFrames.slice(0, 5),
    ...slashFrames.slice(0, 7),
    ...guardFrames.slice(2, 6),
    ...idleFrames.slice(4, 7),
  ];
  saveGif(actionFrames, "fps-combat-action.gif", 10);

  console.log("[record] ALL 5 ANIMATED GIFS RECORDED AND ENCODED SUCCESSFULLY!");
  await browser.close();
}

main().catch((err) => {
  console.error("[record] FAILED:", err);
  process.exit(1);
});
