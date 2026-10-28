/**
 * Pure Node.js high-performance zero-dependency GIF89a animated encoder.
 */

// Fixed 256-color palette: 6x6x6 color cube (216 colors) + 40 grayscale levels
const PALETTE_BUFFER = Buffer.alloc(768);
const LEVELS = [0, 51, 102, 153, 204, 255];
let pIdx = 0;
for (let r = 0; r < 6; r++) {
  for (let g = 0; g < 6; g++) {
    for (let b = 0; b < 6; b++) {
      PALETTE_BUFFER[pIdx++] = LEVELS[r];
      PALETTE_BUFFER[pIdx++] = LEVELS[g];
      PALETTE_BUFFER[pIdx++] = LEVELS[b];
    }
  }
}
for (let i = 0; i < 40; i++) {
  const v = Math.round((i / 39) * 255);
  PALETTE_BUFFER[pIdx++] = v;
  PALETTE_BUFFER[pIdx++] = v;
  PALETTE_BUFFER[pIdx++] = v;
}

class BitWriter {
  constructor() {
    this.buffer = [];
    this.curByte = 0;
    this.curBit = 0;
  }

  writeBits(val, numBits) {
    for (let i = 0; i < numBits; i++) {
      const bit = (val >> i) & 1;
      this.curByte |= bit << this.curBit;
      this.curBit++;
      if (this.curBit === 8) {
        this.buffer.push(this.curByte);
        this.curByte = 0;
        this.curBit = 0;
      }
    }
  }

  flush() {
    if (this.curBit > 0) {
      this.buffer.push(this.curByte);
      this.curByte = 0;
      this.curBit = 0;
    }
  }

  getBytes() {
    this.flush();
    return Buffer.from(this.buffer);
  }
}

function lzwEncode(minCodeSize, indexedPixels) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;

  const writer = new BitWriter();
  writer.writeBits(clearCode, codeSize);

  let prefix = "";
  const table = new Map();

  for (let i = 0; i < indexedPixels.length; i++) {
    const k = indexedPixels[i];
    const key = prefix === "" ? String(k) : `${prefix},${k}`;
    if (table.has(key)) {
      prefix = key;
    } else {
      if (prefix === "") {
        writer.writeBits(k, codeSize);
      } else {
        const code = prefix.includes(",") ? table.get(prefix) : Number(prefix);
        writer.writeBits(code, codeSize);
      }

      if (nextCode < 4096) {
        table.set(key, nextCode);
        nextCode++;
        if (nextCode > (1 << codeSize) && codeSize < 12) {
          codeSize++;
        }
      } else {
        writer.writeBits(clearCode, codeSize);
        table.clear();
        codeSize = minCodeSize + 1;
        nextCode = eoiCode + 1;
      }

      prefix = String(k);
    }
  }

  if (prefix !== "") {
    const code = prefix.includes(",") ? table.get(prefix) : Number(prefix);
    writer.writeBits(code, codeSize);
  }

  writer.writeBits(eoiCode, codeSize);
  const stream = writer.getBytes();

  // Break stream into sub-blocks (max 255 bytes each)
  const blocks = [];
  let offset = 0;
  while (offset < stream.length) {
    const chunkSize = Math.min(255, stream.length - offset);
    blocks.push(Buffer.from([chunkSize]));
    blocks.push(stream.subarray(offset, offset + chunkSize));
    offset += chunkSize;
  }
  blocks.push(Buffer.from([0x00])); // Block terminator
  return Buffer.concat(blocks);
}

/**
 * Fast O(1) quantization into fixed 6x6x6 color cube.
 */
function quantizeRgba(rgba, width, height) {
  const total = width * height;
  const indices = new Uint8Array(total);

  for (let i = 0; i < total; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const ri = Math.min(5, (r / 51 + 0.5) | 0);
    const gi = Math.min(5, (g / 51 + 0.5) | 0);
    const bi = Math.min(5, (b / 51 + 0.5) | 0);
    indices[i] = ri * 36 + gi * 6 + bi;
  }

  return { paletteBuf: PALETTE_BUFFER, indices };
}

export function encodeGif(frames, width, height, delayCentisec = 10) {
  const parts = [];

  // Header & Logical Screen Descriptor
  parts.push(Buffer.from("GIF89a"));
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x87; // Global color table present, 256 colors
  lsd[5] = 0;
  lsd[6] = 0;
  parts.push(lsd);

  // Global Color Table
  parts.push(PALETTE_BUFFER);

  // Netscape loop extension (infinite loop)
  parts.push(Buffer.from([0x21, 0xff, 0x0b]));
  parts.push(Buffer.from("NETSCAPE2.0"));
  parts.push(Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]));

  for (const rgba of frames) {
    const { indices } = quantizeRgba(rgba, width, height);

    // Graphic Control Extension
    const gce = Buffer.alloc(8);
    gce[0] = 0x21;
    gce[1] = 0xf9;
    gce[2] = 0x04;
    gce[3] = 0x00; // No transparency, do not dispose
    gce.writeUInt16LE(delayCentisec, 4);
    gce[6] = 0x00;
    gce[7] = 0x00;
    parts.push(gce);

    // Image Descriptor
    const id = Buffer.alloc(10);
    id[0] = 0x2c;
    id.writeUInt16LE(0, 1); // Left
    id.writeUInt16LE(0, 3); // Top
    id.writeUInt16LE(width, 5);
    id.writeUInt16LE(height, 7);
    id[9] = 0x00; // Use global color table
    parts.push(id);

    // Image Data
    parts.push(Buffer.from([8])); // LZW min code size
    parts.push(lzwEncode(8, indices));
  }

  // Trailer
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
