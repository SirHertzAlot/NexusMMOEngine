import { chromium } from "playwright";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { encodeGif } from "./gif-encoder.mjs";

const ARTIFACT_DIR = "C:/Users/user/.gemini/antigravity/brain/c021e30a-f9c6-4441-a0ef-65078c03604f";

async function main() {
  if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true });

  console.log("[playtest] Launching Chromium...");
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

  const u = "hero_" + Math.random().toString(36).slice(2, 8);
  await page.fill("#username", u);
  await page.fill("#password", "Playtest123!");
  await page.fill("#confirm-password", "Playtest123!");
  await page.getByRole("button", { name: /connect/i }).click();

  // Character creation
  await page.waitForSelector("#character-name", { timeout: 8000 });
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let cname = "Aero";
  for (let i = 0; i < 4; i++) cname += letters[(Math.random() * letters.length) | 0];
  await page.fill("#character-name", cname);
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: /create & enter world/i }).click();

  console.log("[playtest] Waiting for authoritative world load...");
  await page.waitForTimeout(5000);

  console.log("[playtest] Toggling into First-Person perspective (KeyV)...");
  await page.keyboard.press("KeyV");
  await page.waitForTimeout(1000);

  const grabPng = async () => {
    const dataUrl = await page.evaluate(() => document.querySelector("canvas")?.toDataURL("image/png"));
    if (!dataUrl) throw new Error("Canvas toDataURL returned empty");
    return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
  };

  // 1. Idle Stance
  console.log("[playtest] 1. Capturing First-Person Idle Stance...");
  const idle = await grabPng();
  writeFileSync(join(ARTIFACT_DIR, "fps-combat-view-idle.png"), idle);
  console.log(`[playtest] Wrote fps-combat-view-idle.png (${idle.length} bytes)`);

  // 2. Locomotion Stride Bobbing
  console.log("[playtest] 2. Capturing Locomotion Stride Bobbing...");
  await page.evaluate(() => {
    const dbg = window.__mmoDebug;
    if (dbg && dbg.layer && dbg.layer.player) {
      dbg.layer.player.vx = 4.2;
      dbg.layer.player.mode = "run";
      dbg.layer.player.grounded = true;
    }
  });
  await page.waitForTimeout(120);
  const stride = await grabPng();
  writeFileSync(join(ARTIFACT_DIR, "fps-combat-view-stride.png"), stride);
  console.log(`[playtest] Wrote fps-combat-view-stride.png (${stride.length} bytes)`);

  // 3. Slash Attack Strike
  console.log("[playtest] 3. Capturing Slash Attack Strike...");
  await page.evaluate(() => {
    const dbg = window.__mmoDebug;
    if (dbg && dbg.layer && dbg.layer.player) {
      dbg.layer.player.vx = 0;
      dbg.layer.player.mode = "combat";
      dbg.layer.player.move = 1; // Move.SwordA
      dbg.layer.player.moveElapsed = 0.20; // Hit frame with swing trail
    }
  });
  await page.waitForTimeout(120);
  const slash = await grabPng();
  writeFileSync(join(ARTIFACT_DIR, "fps-combat-view-slash.png"), slash);
  console.log(`[playtest] Wrote fps-combat-view-slash.png (${slash.length} bytes)`);

  // 4. Defensive Guard Stance
  console.log("[playtest] 4. Capturing Defensive Guard Stance...");
  await page.evaluate(() => {
    const dbg = window.__mmoDebug;
    if (dbg && dbg.layer && dbg.layer.player) {
      dbg.layer.player.move = 6; // Move.Guard
      dbg.layer.player.moveElapsed = 0.25; // Raised guard posture
    }
  });
  await page.waitForTimeout(120);
  const guard = await grabPng();
  writeFileSync(join(ARTIFACT_DIR, "fps-combat-view-guard.png"), guard);
  console.log(`[playtest] Wrote fps-combat-view-guard.png (${guard.length} bytes)`);

  // 5. Animated GIF Action Sequence
  console.log("[playtest] 5. Capturing action sequence frames for GIF...");
  const gifW = 480;
  const gifH = 270;
  const frames = [];

  const grabFrame = async () => {
    const b64 = await page.evaluate(({ w, h }) => {
      const c = document.querySelector("canvas");
      if (!c) return null;
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const ctx = off.getContext("2d");
      ctx.drawImage(c, 0, 0, w, h);
      const imgData = ctx.getImageData(0, 0, w, h);
      let bin = "";
      const d = imgData.data;
      for (let i = 0; i < d.length; i++) bin += String.fromCharCode(d[i]);
      return btoa(bin);
    }, { w: gifW, h: gifH });
    return b64 ? Buffer.from(b64, "base64") : null;
  };

  const seq = [
    { move: 0, el: 0, vx: 0 },
    { move: 0, el: 0.3, vx: 4.2 },
    { move: 1, el: 0.15, vx: 0 },
    { move: 1, el: 0.25, vx: 0 },
    { move: 6, el: 0.20, vx: 0 },
    { move: 0, el: 0, vx: 0 },
  ];

  for (const s of seq) {
    await page.evaluate(({ move, el, vx }) => {
      const dbg = window.__mmoDebug;
      if (dbg && dbg.layer && dbg.layer.player) {
        dbg.layer.player.move = move;
        dbg.layer.player.moveElapsed = el;
        dbg.layer.player.vx = vx;
        dbg.layer.player.mode = vx > 0 ? "run" : "idle";
      }
    }, s);
    await page.waitForTimeout(80);
    const f = await grabFrame();
    if (f) frames.push(f);
  }

  if (frames.length > 0) {
    console.log(`[playtest] Encoding ${frames.length} frames into animated GIF...`);
    const gif = encodeGif(frames, gifW, gifH, 15);
    writeFileSync(join(ARTIFACT_DIR, "fps-combat-action.gif"), gif);
    console.log(`[playtest] Wrote fps-combat-action.gif (${gif.length} bytes)`);
  }

  console.log("[playtest] ALL 5 DELIVERABLES COMPLETED SUCCESSFULLY!");
  await browser.close();
}

main().catch((e) => {
  console.error("[playtest] Failed:", e);
  process.exit(1);
});
