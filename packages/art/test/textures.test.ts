/**
 * Atlases for the web: TGA and PSD decoded to the same pixels, PNG
 * written correctly, and a pack's atlases found in any Textures folder
 * with the best source per name. Synthetic images only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { decodePsd, decodeTga, encodePng, type Rgba } from "../src/convert/image-decode.js";
import { packTextures } from "../src/convert/convert-packs.js";

// A 3×2 image, top row first: red, green, blue / white, half-transparent grey, black.
const W = 3, H = 2;
const PIXELS = [
  [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255],
  [255, 255, 255, 255], [128, 128, 128, 64], [0, 0, 0, 255],
];
const at = (img: Rgba, x: number, y: number): number[] => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

function tga(opts: { rle: boolean; alpha: boolean; topOrigin: boolean }): Uint8Array {
  const bpp = opts.alpha ? 4 : 3;
  const header = new Uint8Array(18);
  header[2] = opts.rle ? 10 : 2;
  header[12] = W;
  header[14] = H;
  header[16] = bpp * 8;
  header[17] = (opts.alpha ? 8 : 0) | (opts.topOrigin ? 0x20 : 0);
  const rows = opts.topOrigin ? [0, 1] : [1, 0];
  const px: number[][] = [];
  for (const y of rows) for (let x = 0; x < W; x++) {
    const [r, g, b, a] = PIXELS[y * W + x];
    px.push(opts.alpha ? [b, g, r, a] : [b, g, r]);
  }
  let body: number[];
  if (!opts.rle) body = px.flat();
  else {
    // A raw packet (pixel 0), a run of two (pixel 1, repeated over pixel 2), a raw packet (pixels 3–5).
    body = [0x00, ...px[0], 0x81, ...px[1], 0x02, ...px[3], ...px[4], ...px[5]];
  }
  return new Uint8Array([...header, ...body]);
}

function psd(opts: { rle: boolean; alpha: boolean }): Uint8Array {
  const channels = opts.alpha ? 4 : 3;
  const out: number[] = [];
  const u16 = (v: number) => out.push((v >> 8) & 255, v & 255);
  const u32 = (v: number) => out.push((v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
  out.push(0x38, 0x42, 0x50, 0x53);
  u16(1);
  out.push(0, 0, 0, 0, 0, 0);
  u16(channels);
  u32(H);
  u32(W);
  u16(8);
  u16(3);
  u32(0); // colour mode data
  u32(0); // resources
  u32(0); // layers
  u16(opts.rle ? 1 : 0);
  const planes = Array.from({ length: channels }, (_, c) => PIXELS.map((p) => p[c]));
  if (!opts.rle) for (const plane of planes) out.push(...plane);
  else {
    // Each row as one literal packet: header n-1, then the bytes.
    const packed = planes.flatMap((plane) => [0, 1].map((y) => [W - 1, ...plane.slice(y * W, y * W + W)]));
    for (const row of packed) u16(row.length);
    for (const row of packed) out.push(...row);
  }
  return new Uint8Array(out);
}

describe("TGA", () => {
  it("decodes uncompressed true colour, either origin, with and without alpha", () => {
    for (const topOrigin of [false, true]) {
      for (const alpha of [false, true]) {
        const img = decodeTga(tga({ rle: false, alpha, topOrigin }));
        assert.equal(img.width, W);
        assert.equal(img.height, H);
        PIXELS.forEach((p, i) => {
          const want = alpha ? p : [p[0], p[1], p[2], 255];
          assert.deepEqual(at(img, i % W, Math.floor(i / W)), want, `pixel ${i} (top ${topOrigin}, alpha ${alpha})`);
        });
      }
    }
  });

  it("decodes run-length packets", () => {
    const img = decodeTga(tga({ rle: true, alpha: true, topOrigin: true }));
    assert.deepEqual(at(img, 0, 0), PIXELS[0]);
    assert.deepEqual(at(img, 1, 0), PIXELS[1]);
    assert.deepEqual(at(img, 2, 0), PIXELS[1], "the run repeats");
    assert.deepEqual(at(img, 1, 1), PIXELS[4]);
    assert.throws(() => decodeTga(new Uint8Array(18).fill(0).map((v, i) => (i === 2 ? 32 : v))), /image type 32/);
  });
});

describe("PSD", () => {
  it("decodes the composite, raw or PackBits, with alpha when saved", () => {
    for (const rle of [false, true]) {
      for (const alpha of [false, true]) {
        const img = decodePsd(psd({ rle, alpha }));
        PIXELS.forEach((p, i) => {
          assert.deepEqual(at(img, i % W, Math.floor(i / W)), alpha ? p : [p[0], p[1], p[2], 255], `pixel ${i} (rle ${rle}, alpha ${alpha})`);
        });
      }
    }
    assert.throws(() => decodePsd(new Uint8Array(30)), /not a Photoshop file/);
  });
});

describe("PNG", () => {
  it("writes a valid PNG with the pixels (RGB when opaque, RGBA otherwise)", () => {
    for (const alpha of [true, false]) {
      const img = decodePsd(psd({ rle: false, alpha }));
      const png = encodePng(img);
      assert.deepEqual(Array.from(png.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const dv = new DataView(png.buffer, png.byteOffset);
      assert.equal(dv.getUint32(16), W);
      assert.equal(dv.getUint32(20), H);
      const colourType = png[25];
      assert.equal(colourType, alpha ? 6 : 2);
      const idatLen = dv.getUint32(33);
      assert.equal(new TextDecoder().decode(png.subarray(37, 41)), "IDAT");
      const rows = inflateSync(png.subarray(41, 41 + idatLen));
      const ch = alpha ? 4 : 3;
      PIXELS.forEach((p, i) => {
        const y = Math.floor(i / W), x = i % W;
        const got = Array.from(rows.subarray(y * (1 + W * ch) + 1 + x * ch, y * (1 + W * ch) + 1 + x * ch + ch));
        assert.deepEqual(got, alpha ? p : [p[0], p[1], p[2]]);
      });
      assert.equal(new TextDecoder().decode(png.subarray(png.length - 8, png.length - 4)), "IEND");
    }
  });
});

describe("pack atlases", () => {
  it("are found in any Textures folder, best source per name", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    const files = [
      "Textures/Kingdom_Texture_01_A.png",
      "Textures/Kingdom_Texture_01_A.psd",
      "Textures/Alts/Kingdom_Texture_02.tga",
      "Textures/Alts/Kingdom_Texture_02.psd",
      "Source_Files/Textures/Deep/Kingdom_Texture_03.psd",
      "_Textures/Ground_01.jpg",
      "Models/Not_A_Texture.png",
    ];
    for (const f of files) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), "x");
    }
    const t = packTextures(files.map((f) => join(dir, f)), dir);
    assert.equal(t.get("kingdom_texture_01_a"), join(dir, "Textures/Kingdom_Texture_01_A.png"), "a web file wins");
    assert.equal(t.get("kingdom_texture_02"), join(dir, "Textures/Alts/Kingdom_Texture_02.tga"), "TGA over PSD, in a subfolder");
    assert.equal(t.get("kingdom_texture_03"), join(dir, "Source_Files/Textures/Deep/Kingdom_Texture_03.psd"));
    assert.equal(t.get("ground_01"), join(dir, "_Textures/Ground_01.jpg"));
    assert.equal(t.has("not_a_texture"), false, "only Textures folders");
  });
});
