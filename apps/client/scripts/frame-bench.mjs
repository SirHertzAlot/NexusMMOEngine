/**
 * Client frame benchmark: what a frame costs the client's render loop, in
 * headless Chromium, on a scene of stand-in props.
 *
 *   npm run bench:client-frame                    run the default scene sizes
 *   npm run bench:client-frame -- 500 2000        run the given mesh counts
 *
 * Each scene is N meshes (box and cylinder, a material each, so the draw
 * count tracks N), lit by one ambient and one directional light, rendered
 * at 1280 x 720 by the same three.js build the client bundles. Per frame it
 * records two numbers:
 *
 * - CPU render time: the JS and driver time of renderer.render(), which is
 *   what the scene code costs the main thread;
 * - frame interval: the gap between animation frames, which includes the
 *   compositor and any rasterisation Chromium does.
 *
 * Browser: Playwright's Chromium, or CHROMIUM_PATH. Rendering uses
 * SwiftShader (software GL), so frame intervals are not a GPU figure. Read
 * the render-time column for scene cost, and compare runs on the same box.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const threeDir = resolve(repo, "node_modules", "three");
const FRAMES = 120;
const WARM = 20;
const W = 1280;
const H = 720;

const counts = process.argv.slice(2).filter((a) => !a.startsWith("--")).map(Number);
const sizes = counts.length ? counts : [500, 2000];

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="icon" href="data:,">
<script type="importmap">{"imports":{"three":"/three/build/three.module.js"}}</script>
</head><body style="margin:0"><canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
import * as THREE from "three";
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById("c"), antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(${W}, ${H}, false);
renderer.setClearColor(0x202020, 1);

function buildScene(n) {
  const scene = new THREE.Scene();
  const box = new THREE.BoxGeometry(0.8, 1.6, 0.8);
  const cyl = new THREE.CylinderGeometry(0.5, 0.5, 1.2, 8);
  let seed = 1337;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(rnd(), rnd(), rnd()), roughness: 0.7 });
    const mesh = new THREE.Mesh(i % 3 === 0 ? cyl : box, mat);
    mesh.position.set((rnd() - 0.5) * 200, 0, (rnd() - 0.5) * 200);
    scene.add(mesh);
  }
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(60, ${W} / ${H}, 0.1, 500);
  camera.position.set(0, 40, 90);
  camera.lookAt(0, 0, 0);
  return { scene, camera };
}

window.run = (n, frames, warm) =>
  new Promise((done) => {
    const { scene, camera } = buildScene(n);
    const renders = [];
    const gaps = [];
    const draws = [];
    let last = null;
    let i = 0;
    const tick = (now) => {
      const t0 = performance.now();
      renderer.render(scene, camera);
      const cpu = performance.now() - t0;
      if (i >= warm) {
        renders.push(cpu);
        draws.push(renderer.info.render.calls);
        if (last !== null) gaps.push(now - last);
      }
      last = now;
      i++;
      if (i < warm + frames) requestAnimationFrame(tick);
      else done({ renders, gaps, draws: draws[0] ?? 0 });
    };
    requestAnimationFrame(tick);
  });
window.gpu = (() => {
  const gl = renderer.getContext();
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "unknown";
})();
window.ready = true;
</script></body></html>`;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
    return;
  }
  const file = path.startsWith("/three/") ? resolve(threeDir, path.slice("/three/".length)) : null;
  if (!file || !file.startsWith(threeDir + sep)) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(origin + "/");
  await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });
  const gpu = await page.evaluate(() => window.gpu);
  console.log(`renderer: ${gpu}; ${W} x ${H}; ${FRAMES} frames after ${WARM} warm-up`);
  console.log("meshes | draws | render p50 ms | render p95 ms | frame p50 ms | frame p95 ms");
  for (const n of sizes) {
    const r = await page.evaluate(([n, f, w]) => window.run(n, f, w), [n, FRAMES, WARM]);
    console.log(
      `${String(n).padStart(6)} | ${String(r.draws).padStart(5)} | ${quantile(r.renders, 0.5).toFixed(2).padStart(13)} | ` +
        `${quantile(r.renders, 0.95).toFixed(2).padStart(13)} | ${quantile(r.gaps, 0.5).toFixed(2).padStart(12)} | ${quantile(r.gaps, 0.95).toFixed(2).padStart(12)}`,
    );
  }
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
} finally {
  await browser.close();
  server.close();
}
