/**
 * A top-down map of a dungeon as a PNG: floor tinted by room role, walls,
 * liquids, doorways, torches, props and monster spawns (bright = higher
 * tier). For looking at bakes (`--png`) and as the editor's thumbnail.
 */

import { deflateSync } from "node:zlib";
import { CELL, type Dungeon, type RoomType } from "./generate.js";
import type { DungeonDressing } from "./dress.js";

type Rgb = [number, number, number];

const ROLE: Record<RoomType, Rgb> = {
  entrance: [63, 208, 187], combat: [143, 149, 163], elite: [155, 108, 240],
  treasure: [217, 164, 65], shrine: [90, 143, 232], boss: [216, 67, 58],
};
const CORRIDOR: Rgb = [105, 110, 122];
const WALL: Rgb = [48, 51, 60];
const VOID: Rgb = [12, 13, 18];
const POOL: Rgb = [255, 110, 40];
const LAKE: Rgb = [170, 215, 245];
const DOOR: Rgb = [230, 230, 230];

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** An RGB image (w × h, 3 bytes a pixel) as PNG bytes. */
export function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Resource tiers, 1 common … 5 legendary. */
const TIER: Rgb[] = [[170, 170, 170], [120, 220, 90], [70, 150, 255], [190, 90, 255], [255, 170, 30]];

/** The dungeon's map, `scale` pixels a cell (with its dressing's props and veins, when given). */
export function dungeonPng(d: Dungeon, scale = 4, dressing?: DungeonDressing): Buffer {
  const W = d.width * scale, H = d.height * scale;
  const img = new Uint8Array(W * H * 3);
  const fill = (cx: number, cy: number, c: Rgb, inset = 0): void => {
    for (let y = cy * scale + inset; y < (cy + 1) * scale - inset; y++)
      for (let x = cx * scale + inset; x < (cx + 1) * scale - inset; x++) img.set(c, (y * W + x) * 3);
  };
  for (let y = 0; y < d.height; y++)
    for (let x = 0; x < d.width; x++) {
      const c = y * d.width + x;
      const cell = d.grid[c];
      let col: Rgb = VOID;
      if (cell === CELL.wall) col = WALL;
      else if (cell === CELL.pool) col = POOL;
      else if (cell === CELL.floor) {
        const r = d.roomId[c];
        col = d.lake[c] ? LAKE : d.doorway[c] ? DOOR : r >= 0 ? ROLE[d.rooms[r].type] : CORRIDOR;
      }
      fill(x, y, col);
    }
  const inset = Math.max(0, Math.floor(scale / 4));
  for (const p of d.props) if (p.kind !== "debris" && p.kind !== "moss" && p.kind !== "crack") fill(p.x, p.y, [30, 30, 36], inset);
  for (const t of d.torches) fill(t.x, t.y, [255, 170, 60], inset);
  for (const s of d.spawns) fill(s.x, s.y, s.tier === 3 ? [255, 40, 60] : s.tier === 2 ? [230, 90, 40] : [200, 140, 60], inset);
  if (dressing) {
    // Continuous positions: a dot `size` pixels across.
    const dot = (x: number, y: number, c: Rgb, size: number): void => {
      const px = Math.round(x * scale), py = Math.round(y * scale), h = Math.floor(size / 2);
      for (let yy = py - h; yy < py - h + size; yy++)
        for (let xx = px - h; xx < px - h + size; xx++) if (xx >= 0 && yy >= 0 && xx < W && yy < H) img.set(c, (yy * W + xx) * 3);
    };
    for (const p of dressing.props) dot(p.x, p.y, [70, 50, 35], Math.max(2, Math.round(scale * 0.6)));
    for (const v of dressing.resources) dot(v.x, v.y, TIER[Math.min(4, v.tier - 1)], Math.max(2, Math.round(scale * 0.8)));
  }
  return encodePng(W, H, img);
}
