/**
 * Delaunay triangulation (Bowyer–Watson) of the room centres: the natural,
 * non-crossing graph of which rooms could connect. Returns the unique
 * edges as [lo, hi] index pairs. Ported from Dungeon Forge (MIT).
 */

interface P {
  x: number;
  y: number;
  i: number;
}
interface Tri {
  v: [P, P, P];
  ccx: number;
  ccy: number;
  r2: number;
}

export function delaunay(pts: readonly { x: number; y: number }[]): [number, number][] {
  const n = pts.length;
  if (n < 2) return [];
  if (n === 2) return [[0, 1]];
  // A tiny deterministic jitter breaks exact co-circular ties.
  const P: P[] = pts.map((p, i) => ({ x: p.x + ((i * 0.618033) % 1) * 1e-3, y: p.y + ((i * 0.414213) % 1) * 1e-3, i }));
  let minX = 1e18, minY = 1e18, maxX = -1e18, maxY = -1e18;
  for (const p of P) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const dm = Math.max(maxX - minX, maxY - minY, 1), mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const s1: P = { x: mx - 30 * dm, y: my - dm, i: -1 };
  const s2: P = { x: mx, y: my + 30 * dm, i: -2 };
  const s3: P = { x: mx + 30 * dm, y: my - dm, i: -3 };
  const mkTri = (a: P, b: P, c: P): Tri => {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-12) return { v: [a, b, c], ccx: 0, ccy: 0, r2: Infinity };
    const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
    const ccx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    const ccy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    return { v: [a, b, c], ccx, ccy, r2: (a.x - ccx) * (a.x - ccx) + (a.y - ccy) * (a.y - ccy) };
  };
  let tris: Tri[] = [mkTri(s1, s2, s3)];
  for (const p of P) {
    const bad: Tri[] = [];
    const edges: [P, P][] = [];
    for (const t of tris) if ((p.x - t.ccx) * (p.x - t.ccx) + (p.y - t.ccy) * (p.y - t.ccy) < t.r2) bad.push(t);
    for (const t of bad) for (let e = 0; e < 3; e++) edges.push([t.v[e], t.v[(e + 1) % 3]]);
    const poly: [P, P][] = [];
    for (let i = 0; i < edges.length; i++) {
      let shared = false;
      for (let j = 0; j < edges.length; j++) {
        if (i === j) continue;
        const a = edges[i], b = edges[j];
        if ((a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0])) {
          shared = true;
          break;
        }
      }
      if (!shared) poly.push(edges[i]);
    }
    const badSet = new Set(bad);
    tris = tris.filter((t) => !badSet.has(t));
    for (const e of poly) tris.push(mkTri(e[0], e[1], p));
  }
  tris = tris.filter((t) => t.v[0].i >= 0 && t.v[1].i >= 0 && t.v[2].i >= 0);
  const seen = new Set<number>();
  const out: [number, number][] = [];
  for (const t of tris)
    for (let e = 0; e < 3; e++) {
      const a = t.v[e].i, b = t.v[(e + 1) % 3].i, lo = Math.min(a, b), hi = Math.max(a, b), k = lo * 4096 + hi;
      if (!seen.has(k)) {
        seen.add(k);
        out.push([lo, hi]);
      }
    }
  return out;
}
