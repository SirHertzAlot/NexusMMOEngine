/**
 * Atlases the browser can't load, made loadable: TGA and PSD decoded in
 * plain TypeScript and written out as PNG (node:zlib deflates it). Art
 * packs often ship their atlases only as .tga or .psd; without a PNG the
 * converter used to export those packs untextured.
 *
 * - TGA: uncompressed and RLE, true-colour (24/32-bit), grey (8-bit) and
 *   colour-mapped (8-bit, 24/32-bit palette); either origin.
 * - PSD: the flattened composite image every PSD stores (raw or RLE,
 *   8-bit RGB or greyscale, with alpha when saved), not the layers.
 */

import { deflateSync } from "node:zlib";

export interface Rgba {
  width: number;
  height: number;
  /** Row-major RGBA, top row first. */
  data: Uint8Array;
}

export function decodeTga(buf: Uint8Array): Rgba {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const idLength = buf[0];
  const mapType = buf[1];
  const type = buf[2];
  const mapFirst = v.getUint16(3, true);
  const mapLength = v.getUint16(5, true);
  const mapDepth = buf[7];
  const width = v.getUint16(12, true);
  const height = v.getUint16(14, true);
  const depth = buf[16];
  const descriptor = buf[17];
  if (![1, 2, 3, 9, 10, 11].includes(type)) throw new Error(`TGA: image type ${type} not supported`);
  if (width === 0 || height === 0) throw new Error("TGA: empty image");
  let o = 18 + idLength;
  let palette: Uint8Array | null = null;
  if (mapType === 1) {
    const bpe = Math.ceil(mapDepth / 8);
    palette = new Uint8Array((mapFirst + mapLength) * 4);
    for (let i = 0; i < mapLength; i++) {
      const p = o + i * bpe;
      const d = (mapFirst + i) * 4;
      palette[d] = buf[p + 2];
      palette[d + 1] = buf[p + 1];
      palette[d + 2] = buf[p];
      palette[d + 3] = bpe === 4 ? buf[p + 3] : 255;
    }
    o += mapLength * bpe;
  }
  const bpp = depth / 8;
  if (![1, 2, 3, 4].includes(bpp)) throw new Error(`TGA: ${depth}-bit pixels not supported`);
  const n = width * height;
  // Pixels in file order, still bpp bytes each.
  let raw: Uint8Array;
  if (type >= 9) {
    raw = new Uint8Array(n * bpp);
    let i = 0;
    while (i < n) {
      const header = buf[o++];
      const count = (header & 0x7f) + 1;
      if (header & 0x80) {
        for (let k = 0; k < count; k++) raw.set(buf.subarray(o, o + bpp), (i + k) * bpp);
        o += bpp;
      } else {
        raw.set(buf.subarray(o, o + count * bpp), i * bpp);
        o += count * bpp;
      }
      i += count;
    }
  } else {
    raw = buf.subarray(o, o + n * bpp);
  }
  const data = new Uint8Array(n * 4);
  const alphaBits = descriptor & 0x0f;
  const topOrigin = (descriptor & 0x20) !== 0;
  const rightOrigin = (descriptor & 0x10) !== 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * bpp;
      const ty = topOrigin ? y : height - 1 - y;
      const tx = rightOrigin ? width - 1 - x : x;
      const d = (ty * width + tx) * 4;
      if (palette) {
        const p = (bpp === 2 ? raw[src] | (raw[src + 1] << 8) : raw[src]) * 4;
        data.set(palette.subarray(p, p + 4), d);
      } else if (bpp === 1) {
        data[d] = data[d + 1] = data[d + 2] = raw[src];
        data[d + 3] = 255;
      } else if (bpp === 2) {
        const px = raw[src] | (raw[src + 1] << 8);
        data[d] = ((px >> 10) & 31) * 255 / 31;
        data[d + 1] = ((px >> 5) & 31) * 255 / 31;
        data[d + 2] = (px & 31) * 255 / 31;
        data[d + 3] = alphaBits > 0 && !(px & 0x8000) ? 0 : 255;
      } else {
        data[d] = raw[src + 2];
        data[d + 1] = raw[src + 1];
        data[d + 2] = raw[src];
        data[d + 3] = bpp === 4 && alphaBits > 0 ? raw[src + 3] : 255;
      }
    }
  }
  return { width, height, data };
}

export function decodePsd(buf: Uint8Array): Rgba {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.getUint32(0) !== 0x38425053) throw new Error("PSD: not a Photoshop file"); // "8BPS"
  const version = v.getUint16(4);
  if (version !== 1) throw new Error(`PSD: version ${version} (large documents) not supported`);
  const channels = v.getUint16(12);
  const height = v.getUint32(14);
  const width = v.getUint32(18);
  const depth = v.getUint16(22);
  const mode = v.getUint16(24);
  if (depth !== 8) throw new Error(`PSD: ${depth}-bit channels not supported`);
  if (mode !== 3 && mode !== 1) throw new Error(`PSD: colour mode ${mode} not supported (RGB or greyscale only)`);
  let o = 26;
  o += 4 + v.getUint32(o); // colour mode data
  o += 4 + v.getUint32(o); // image resources
  o += 4 + v.getUint32(o); // layers and masks
  const compression = v.getUint16(o);
  o += 2;
  const n = width * height;
  const planes: Uint8Array[] = [];
  if (compression === 0) {
    for (let c = 0; c < channels; c++) planes.push(buf.subarray(o + c * n, o + (c + 1) * n));
  } else if (compression === 1) {
    // PackBits, with a table of every row's byte count first.
    const counts: number[] = [];
    for (let r = 0; r < channels * height; r++) counts.push(v.getUint16(o + r * 2));
    o += channels * height * 2;
    for (let c = 0; c < channels; c++) {
      const plane = new Uint8Array(n);
      for (let y = 0; y < height; y++) {
        const end = o + counts[c * height + y];
        let x = y * width;
        while (o < end) {
          const h = (buf[o++] << 24) >> 24;
          if (h >= 0) {
            plane.set(buf.subarray(o, o + h + 1), x);
            o += h + 1;
            x += h + 1;
          } else if (h !== -128) {
            plane.fill(buf[o++], x, x + 1 - h);
            x += 1 - h;
          }
        }
        o = end;
      }
      planes.push(plane);
    }
  } else {
    throw new Error(`PSD: compression ${compression} not supported`);
  }
  const data = new Uint8Array(n * 4);
  const grey = mode === 1;
  const alphaPlane = grey ? (channels > 1 ? planes[1] : null) : channels > 3 ? planes[3] : null;
  for (let i = 0; i < n; i++) {
    data[i * 4] = planes[0][i];
    data[i * 4 + 1] = grey ? planes[0][i] : planes[1][i];
    data[i * 4 + 2] = grey ? planes[0][i] : planes[2][i];
    data[i * 4 + 3] = alphaPlane ? alphaPlane[i] : 255;
  }
  return { width, height, data };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** RGBA as PNG (opaque images drop their alpha channel). */
export function encodePng(img: Rgba): Uint8Array {
  const { width, height, data } = img;
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { opaque = false; break; }
  const ch = opaque ? 3 : 4;
  const rows = new Uint8Array(height * (1 + width * ch));
  for (let y = 0; y < height; y++) {
    const r = y * (1 + width * ch); // filter type 0
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      rows.set(data.subarray(s, s + ch), r + 1 + x * ch);
    }
  }
  const chunk = (type: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    const tb = new TextEncoder().encode(type);
    out.set(tb, 4);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(rows, { level: 6 }))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A .tga or .psd file as PNG bytes. */
export function toPng(file: string, bytes: Uint8Array): Uint8Array {
  if (/\.tga$/i.test(file)) return encodePng(decodeTga(bytes));
  if (/\.psd$/i.test(file)) return encodePng(decodePsd(bytes));
  throw new Error(`${file}: not a TGA or PSD`);
}
