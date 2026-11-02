/**
 * TL0 art baselines: load time and screenshot hash for the three fixtures in
 * packages/art/test/fixtures/baselines, measured in Chromium with the same
 * three.js build and GLTFLoader the client uses.
 *
 *   npm run bench:art-baselines                   record loadMs and screenshotSha256 in the manifest
 *   npm run bench:art-baselines -- --check        fail if a screenshot hash differs from the manifest
 *   npm run bench:art-baselines -- --png <dir>    also write each render to <dir> as a PNG
 *
 * Browser: Playwright's Chromium, or CHROMIUM_PATH=/path/to/chrome when that
 * build is not installed.
 * Load time: fetch, parse and scene build, median of 5 runs after one warmup.
 * Screenshot: a 256 x 256 render with a fixed camera and lights; sha256 of the RGBA pixels.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const fixtures = join(repo, "packages", "art", "test", "fixtures", "baselines");
const manifestPath = join(fixtures, "manifest.json");
const threeDir = join(repo, "node_modules", "three");
const RUNS = 5;
const SIZE = 256;

const args = process.argv.slice(2);
const check = args.includes("--check");
const pngAt = args.indexOf("--png");
const pngDir = pngAt >= 0 ? args[pngAt + 1] : null;

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// The page loads three.js through an import map, so GLTFLoader's bare "three"
// import resolves to the same build the client uses.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="icon" href="data:,">
<script type="importmap">{"imports":{"three":"/three/build/three.module.js"}}</script>
</head><body style="margin:0"><canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "/three/examples/jsm/loaders/GLTFLoader.js";
const SIZE = ${SIZE};
const loader = new GLTFLoader();
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById("c"), antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE, false);
renderer.setClearColor(0x202020, 1);
const gl = renderer.getContext();
const dbg = gl.getExtension("WEBGL_debug_renderer_info");
window.gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "unknown";

async function loadOnce(url) {
  const t0 = performance.now();
  const bytes = await (await fetch(url)).arrayBuffer();
  const gltf = await loader.parseAsync(bytes, "");
  return { gltf, ms: performance.now() - t0 };
}

window.measure = async (file, runs) => {
  const url = "/fixtures/" + file;
  await loadOnce(url);
  const times = [];
  for (let i = 0; i < runs; i++) times.push((await loadOnce(url)).ms);
  const { gltf } = await loadOnce(url);

  const scene = new THREE.Scene();
  scene.add(gltf.scene);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(3, 5, 4);
  scene.add(sun);

  const box = new THREE.Box3().setFromObject(gltf.scene);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  const camera = new THREE.PerspectiveCamera(35, 1, size * 0.01, size * 20);
  camera.position.copy(center).add(new THREE.Vector3(1, 0.8, 1.2).normalize().multiplyScalar(size * 1.6));
  camera.lookAt(center);

  renderer.render(scene, camera);
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return { times, pixels: Array.from(pixels), png: renderer.domElement.toDataURL("image/png") };
};
window.ready = true;
</script></body></html>`;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".glb": "model/gltf-binary" };

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
    return;
  }
  let file = null;
  if (path.startsWith("/three/")) file = resolve(threeDir, path.slice("/three/".length));
  else if (path.startsWith("/fixtures/")) file = resolve(fixtures, path.slice("/fixtures/".length));
  const allowed = file && (file.startsWith(threeDir + sep) || file.startsWith(fixtures + sep));
  if (!allowed) {
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

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const results = [];
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(origin + "/");
  await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });
  const gpu = await page.evaluate(() => window.gpu);

  for (const asset of manifest.assets) {
    const r = await page.evaluate(([file, runs]) => window.measure(file, runs), [asset.file, RUNS]);
    const sorted = [...r.times].sort((a, b) => a - b);
    results.push({
      file: asset.file,
      loadMs: sorted[Math.floor(sorted.length / 2)],
      sha: createHash("sha256").update(Buffer.from(r.pixels)).digest("hex"),
      png: r.png,
    });
  }
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);

  const environment = {
    browser: `Chromium ${browser.version()}`,
    gpu,
    node: process.version,
    three: JSON.parse(readFileSync(join(threeDir, "package.json"), "utf8")).version,
    render: `${SIZE}x${SIZE}`,
    runs: RUNS,
  };

  if (!check) {
    manifest.assets = manifest.assets.map((a) => {
      const r = results.find((x) => x.file === a.file);
      return { ...a, loadMs: Math.round(r.loadMs * 10) / 10, screenshotSha256: r.sha };
    });
    manifest.environment = { ...environment, measuredOn: new Date().toISOString().slice(0, 10) };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`recorded ${results.length} baselines in ${manifestPath}`);
  }

  let failed = 0;
  for (const r of results) {
    const a = manifest.assets.find((x) => x.file === r.file);
    const same = a.screenshotSha256 === r.sha;
    if (check && !same) failed++;
    const verdict = check ? (same ? "ok   " : "FAIL ") : "";
    console.log(
      `${verdict}${r.file}: load ${r.loadMs.toFixed(1)} ms (recorded ${a.loadMs} ms), screenshot ${r.sha.slice(0, 16)}`,
    );
  }
  if (pngDir) {
    mkdirSync(pngDir, { recursive: true });
    for (const r of results) {
      writeFileSync(join(pngDir, r.file.replace(/\.glb$/, ".png")), Buffer.from(r.png.split(",")[1], "base64"));
    }
    console.log(`wrote ${results.length} PNGs to ${pngDir}`);
  }
  if (failed) {
    console.error(`${failed} screenshot hash(es) differ from the manifest`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  server.close();
}
