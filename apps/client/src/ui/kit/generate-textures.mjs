/**
 * The style kit's textures, generated.
 *
 * Every texture the UI uses is produced here, from code, with a seeded
 * PRNG. Nothing is painted by hand and nothing is a one-off picture. That
 * is the whole point: a painted panel cannot tile, cannot stretch to an
 * unknown size, and drifts in palette and light direction from the panel
 * beside it. A generated texture tiles by construction, takes its colours
 * from one palette, and takes its light from one angle.
 *
 * Two rules every texture here obeys, both taken from the engine's cel
 * shading DNA (docs/CEL-SHADING-AUDIT.md, docs/library/mmo-engine-shader-rnd/
 * STYLIZED-RENDERING-DNA.md):
 *
 *   1. Shading is BANDED. Values are quantised to a small number of flat
 *      steps (D1 allows <= 8), never a smooth gradient. The UI reads as the
 *      same material as the world because it is shaded the same way.
 *   2. Shadow colour comes from a RAMP, not from multiplying toward black.
 *      Shadows get darker and cooler at once, so parchment shades to a cool
 *      brown and bronze shades to a green-grey.
 *
 * Run: node apps/client/src/ui/kit/generate-textures.mjs
 * Output: apps/client/src/ui/kit/textures/*.png (committed; this file is the
 * source of truth for them).
 *
 * No dependencies: the PNG encoder below is ~40 lines of zlib + CRC.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "textures");

// ---------------------------------------------------------------- PNG out

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA pixel buffer -> PNG bytes. Deterministic (fixed deflate level). */
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none, so output is byte-stable
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- helpers

/** mulberry32: small, seeded, reproducible. Same seed, same texture, always. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value noise on a wrapping lattice, so the result tiles exactly. */
function tileNoise(w, h, cells, seed) {
  const r = rng(seed);
  const g = new Float64Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const at = (x, y) => g[((y % cells) + cells) % cells * cells + (((x % cells) + cells) % cells)];
  const sm = (t) => t * t * (3 - 2 * t);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = (x / w) * cells;
      const fy = (y / h) * cells;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = sm(fx - x0);
      const ty = sm(fy - y0);
      const a = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
      const b = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
      out[y * w + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/** Several octaves of tiling noise, still tiling. */
function fbm(w, h, seed, octaves = 4, base = 4) {
  const out = new Float64Array(w * h);
  let amp = 1;
  let sum = 0;
  for (let o = 0; o < octaves; o++) {
    const n = tileNoise(w, h, base * 2 ** o, seed + o * 7919);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    sum += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Smear a field along X with a wrapping box blur. Noise blurred far more in
 * one axis than the other is how a brushed surface reads; isotropic noise
 * tinted grey just looks like camouflage.
 */
function smearX(src, w, h, radius) {
  const out = new Float64Array(w * h);
  const n = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) acc += src[y * w + ((k % w) + w) % w];
    for (let x = 0; x < w; x++) {
      out[y * w + x] = acc / n;
      acc -= src[y * w + ((x - radius) % w + w) % w];
      acc += src[y * w + ((x + radius + 1) % w + w) % w];
    }
  }
  return out;
}

/** Quantise to flat bands. This is rule 1: no smooth gradients anywhere. */
const band = (v, bands) => Math.round(clamp01(v) * (bands - 1)) / (bands - 1);

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

/**
 * Rule 2: a material's shade at `t` (0 dark .. 1 lit) read off a 3-stop
 * ramp, quantised to `bands` flat steps. The dark stop is a cooler, more
 * saturated hue rather than black, exactly as the D1 ramp does in 3D.
 */
function ramp(mat, t, bands) {
  const q = band(t, bands);
  const [lo, mid, hi] = [hex(mat.shadow), hex(mat.base), hex(mat.light)];
  const [a, b, k] = q < 0.5 ? [lo, mid, q * 2] : [mid, hi, (q - 0.5) * 2];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function image(w, h) {
  const buf = Buffer.alloc(w * h * 4);
  return {
    w,
    h,
    buf,
    set(x, y, r, g, b, a = 255) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      buf[i] = Math.round(clamp01(r / 255) * 255);
      buf[i + 1] = Math.round(clamp01(g / 255) * 255);
      buf[i + 2] = Math.round(clamp01(b / 255) * 255);
      buf[i + 3] = Math.round(a);
    },
    save(name) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(resolve(OUT, name), encodePng(w, h, buf));
      return name;
    },
  };
}

// ------------------------------------------------------------- the palette
//
// One palette, used by every texture and mirrored in tokens.css. Each
// material is a 3-stop ramp: shadow (cool, never black), base, light.
// The named hues are what makes two panels drawn a month apart match.

const MAT = {
  // Aged paper. Shades to a cool grey-brown, not to grey.
  parchment: { shadow: "#4a3b2d", base: "#c8ab82", light: "#e9d9b6" },
  // Dark oiled leather, the panel's ground. Shades toward cold umber.
  leather: { shadow: "#161112", base: "#2e2420", light: "#4a3a31" },
  // Aged bronze, the frame metal. Shades to a green-grey (verdigris side),
  // lights to a pale warm gold. Never pure yellow: that is what reads cheap.
  bronze: { shadow: "#3b3526", base: "#8a7342", light: "#d8bd7d" },
  // Cold forged iron for secondary frames and slot wells.
  iron: { shadow: "#17191c", base: "#3a4049", light: "#697482" },
};

// Light comes from the top-left, always. One angle for the whole UI.
const LIGHT = { x: -0.7071, y: -0.7071 };

// ---------------------------------------------------------------- grains
//
// Tiling material grains. These are backgrounds, so they are low contrast:
// text sits on them and must stay readable. The contrast budget lives in
// tokens.css; these stay within it by construction.

function grainParchment() {
  const w = 256;
  const h = 256;
  const im = image(w, h);
  const fibre = fbm(w, h, 1337, 5, 3);
  const blot = fbm(w, h, 24601, 3, 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // Fibres pull along the sheet; blotches are slower and broader.
      // Fibre carries most of it; blotching stays light so the sheet reads
      // as aged paper rather than as a stain someone painted on.
      const v = 0.6 + (fibre[i] - 0.5) * 0.26 + (blot[i] - 0.5) * 0.1;
      const [r, g, b] = ramp(MAT.parchment, v, 6);
      im.set(x, y, r, g, b, 255);
    }
  }
  return im.save("parchment.png");
}

function grainLeather() {
  const w = 256;
  const h = 256;
  const im = image(w, h);
  const pebble = fbm(w, h, 777, 4, 10);
  const broad = fbm(w, h, 991, 3, 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // Pebbling is a height field; light it from the fixed direction so
      // the grain catches light the same way the frame bevels do.
      const dx = pebble[y * w + ((x + 1) % w)] - pebble[y * w + ((x - 1 + w) % w)];
      const dy = pebble[((y + 1) % h) * w + x] - pebble[((y - 1 + h) % h) * w + x];
      const lit = -(dx * LIGHT.x + dy * LIGHT.y) * 3.2;
      const v = 0.48 + lit * 0.3 + (broad[i] - 0.5) * 0.1;
      const [r, g, b] = ramp(MAT.leather, v, 5);
      im.set(x, y, r, g, b, 255);
    }
  }
  return im.save("leather.png");
}

function grainIron() {
  const w = 256;
  const h = 256;
  const im = image(w, h);
  // Fine noise smeared hard along X: many cells vertically, blurred
  // horizontally, so the grain runs in one direction like a brushed bar.
  const fine = tileNoise(w, h, 128, 5150);
  const brush = smearX(fine, w, h, 5);
  const r2 = rng(8128);
  // Brushed metal: stretched noise plus sparse scratches, all wrapping.
  const scratch = new Float64Array(w * h);
  for (let s = 0; s < 70; s++) {
    const y0 = Math.floor(r2() * h);
    const len = 40 + Math.floor(r2() * 160);
    const x0 = Math.floor(r2() * w);
    const bright = r2() < 0.5 ? -1 : 1;
    for (let k = 0; k < len; k++) {
      const x = (x0 + k) % w;
      const y = (y0 + Math.floor(Math.sin(k * 0.06) * 1.5)) % h;
      scratch[((y % h) + h) % h * w + x] += bright * 0.4;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // Smearing narrows the range, so lift the contrast back up.
      const v = 0.5 + (brush[i] - 0.5) * 0.5 + scratch[i] * 0.1;
      const [r, g, b] = ramp(MAT.iron, v, 6);
      im.set(x, y, r, g, b, 255);
    }
  }
  return im.save("iron.png");
}

// ------------------------------------------------------------ 9-slice frame
//
// One frame, cut as a 9-slice: corners fixed, edges repeat. This is what
// lets a panel be any size without stretching ornament or smearing bevels.
// The slice inset is SLICE px on every side; CSS border-image uses the same
// number, and kit.css reads it from a token so the two cannot drift.

const SLICE = 14;

/**
 * Signed distance from the frame's outer edge, in px, for a point in a
 * tile of size `size`. Negative inside the opening, positive in the band.
 */
function frameProfile(x, y, size, inset) {
  const d = Math.min(x, y, size - 1 - x, size - 1 - y);
  return d - inset;
}

function nineSlice({ name, mat, size = SLICE * 3, bandPx = 10, bands = 5, studs = true }) {
  const im = image(size, size);
  const grain = fbm(size, size, 4242, 4, 6);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.min(x, y, size - 1 - x, size - 1 - y);
      if (d >= bandPx) {
        im.set(x, y, 0, 0, 0, 0); // the opening: the panel fill shows through
        continue;
      }
      // Across the band, build a rounded moulding: rises from the outer
      // edge to a crest, falls to the inner edge. One bevel depth, set here
      // and nowhere else.
      const t = d / bandPx; // 0 outer .. 1 inner
      const crest = 0.42;
      const height = t < crest ? t / crest : 1 - (t - crest) / (1 - crest);
      // Surface normal of that moulding, in the plane, pointing outward
      // from the crest toward whichever edge we are on.
      const nx = x < size / 2 ? -1 : 1;
      const ny = y < size / 2 ? -1 : 1;
      const onVertical = Math.min(x, size - 1 - x) < Math.min(y, size - 1 - y);
      const slopeSign = t < crest ? 1 : -1;
      const sx = onVertical ? nx * slopeSign : 0;
      const sy = onVertical ? 0 : ny * slopeSign;
      // Fixed light direction, same as every other texture here.
      const lit = -(sx * LIGHT.x + sy * LIGHT.y);
      let v = 0.5 + lit * 0.34 + height * 0.16 + (grain[y * size + x] - 0.5) * 0.1;
      // A dark line at the outer and inner edge reads as a crisp lip and
      // keeps the frame legible against any background.
      if (d <= 0 || d >= bandPx - 1) v -= 0.45;
      // Corner studs: one repeated motif, not a drawn flourish.
      if (studs) {
        const cs = 7;
        const near = (a, b) => Math.hypot(x - a, y - b);
        const r = Math.min(near(cs, cs), near(size - 1 - cs, cs), near(cs, size - 1 - cs), near(size - 1 - cs, size - 1 - cs));
        if (r < 3.0) {
          const dome = Math.sqrt(Math.max(0, 1 - (r / 3.0) ** 2));
          const slit = -((x - (x < size / 2 ? cs : size - 1 - cs)) / 3.0 * LIGHT.x + (y - (y < size / 2 ? cs : size - 1 - cs)) / 3.0 * LIGHT.y);
          v = 0.52 + slit * 0.42 + dome * 0.1;
        }
      }
      const [r, g, b] = ramp(mat, v, bands);
      im.set(x, y, r, g, b, 255);
    }
  }
  return im.save(name);
}

// ----------------------------------------------------------- slot + divider

/** An inset well for an inventory slot: the bevel runs the other way. */
function slotWell() {
  const size = 24;
  const im = image(size, size);
  const inset = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.min(x, y, size - 1 - x, size - 1 - y);
      if (d >= inset) {
        im.set(x, y, 0, 0, 0, 0);
        continue;
      }
      // Inset: the TOP-LEFT is in shadow and the bottom-right catches light,
      // the exact inverse of a raised frame. That inversion is what makes a
      // slot read as a hole rather than a tile.
      const onVertical = Math.min(x, size - 1 - x) < Math.min(y, size - 1 - y);
      const sx = onVertical ? (x < size / 2 ? 1 : -1) : 0;
      const sy = onVertical ? 0 : y < size / 2 ? 1 : -1;
      const lit = -(sx * LIGHT.x + sy * LIGHT.y);
      const v = 0.42 + lit * 0.3;
      const [r, g, b] = ramp(MAT.iron, v, 4);
      im.set(x, y, r, g, b, 255);
    }
  }
  return im.save("slot-well.png");
}

/**
 * A horizontal rule that tiles along its length with a centred boss. The
 * boss is drawn once in the middle slice; the ends repeat. A painted
 * divider would stretch its boss into a smear at any other width.
 */
/**
 * The divider comes in two pieces, because one piece cannot do the job.
 *
 * `divider-bar.png` is a plain banded rule that tiles along X to any
 * width. `divider-boss.png` is the lozenge, drawn once and placed at the
 * centre with no repeat. A single image holding both would either repeat
 * the boss across the line or stretch it into a smear — which is exactly
 * the failure mode of shipping a finished picture instead of parts.
 */
function dividerBar() {
  const w = 16;
  const h = 11;
  const im = image(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const mid = (h - 1) / 2;
      if (Math.abs(y - mid) <= 1.5) {
        const v = 0.5 - (y - mid) * 0.26;
        const [r, g, b] = ramp(MAT.bronze, v, 4);
        im.set(x, y, r, g, b, 255);
      } else {
        im.set(x, y, 0, 0, 0, 0);
      }
    }
  }
  return im.save("divider-bar.png");
}

function dividerBoss() {
  const w = 22;
  const h = 11;
  const im = image(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const mid = (h - 1) / 2;
      const nx = (x - (w - 1) / 2) / 8;
      const ny = (y - mid) / 4.5;
      if (Math.abs(nx) + Math.abs(ny) <= 1) {
        const lit = -(nx * LIGHT.x + ny * LIGHT.y);
        const [r, g, b] = ramp(MAT.bronze, 0.52 + lit * 0.4, 4);
        im.set(x, y, r, g, b, 255);
      } else {
        im.set(x, y, 0, 0, 0, 0);
      }
    }
  }
  return im.save("divider-boss.png");
}

/**
 * A corner ornament: a quarter filigree built from arcs, drawn once and
 * mirrored by CSS into the other three corners. Mirroring is why the light
 * must be baked as *shape*, not as a highlight that would end up lit from
 * the wrong side once flipped — so this one is a flat silhouette and takes
 * its colour from the token, not from the texture.
 */
function cornerOrnament() {
  const s = 48;
  const im = image(s, s);
  const on = (x, y) => {
    // Two arcs and a spur, as coverage, anti-aliased by sampling.
    let cov = 0;
    const arc = (cx, cy, rad, thick) => {
      const d = Math.abs(Math.hypot(x - cx, y - cy) - rad);
      return clamp01(1 - (d - thick) / 1.2);
    };
    cov = Math.max(cov, arc(s, s, 38, 1.6));
    cov = Math.max(cov, arc(s, s, 30, 1.0));
    cov = Math.max(cov, arc(14, 14, 9, 1.3) * (x < 22 && y < 22 ? 1 : 0));
    // a short spur along each edge
    if (y < 3.2 && x < 30) cov = Math.max(cov, 1);
    if (x < 3.2 && y < 30) cov = Math.max(cov, 1);
    return clamp01(cov);
  };
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const a = on(x, y);
      if (a <= 0.02) {
        im.set(x, y, 0, 0, 0, 0);
        continue;
      }
      // Flat silhouette in the bronze light stop; CSS tints it per use.
      const [r, g, b] = ramp(MAT.bronze, 0.82, 3);
      im.set(x, y, r, g, b, Math.round(a * 255));
    }
  }
  return im.save("corner-ornament.png");
}

// ---------------------------------------------------------------- run

const made = [
  grainParchment(),
  grainLeather(),
  grainIron(),
  nineSlice({ name: "frame-bronze.png", mat: MAT.bronze, bandPx: 10, bands: 5 }),
  nineSlice({ name: "frame-iron.png", mat: MAT.iron, bandPx: 8, bands: 5, studs: false }),
  slotWell(),
  dividerBar(),
  dividerBoss(),
  cornerOrnament(),
];

console.log(`style kit: wrote ${made.length} textures to ${OUT}`);
for (const m of made) console.log("  " + m);
