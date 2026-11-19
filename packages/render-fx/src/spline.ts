/**
 * Pure Catmull-Rom spline utilities shared between server validation (authority
 * clamping in MagicSystem) and client CurveEmitter particle playback.
 * Zero external dependencies.
 */

export type Vec3Point = readonly [number, number, number];

export interface SplineSample {
  pos: [number, number, number];
  tangent: [number, number, number];
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

function catmullRomTangent(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  return 0.5 * (
    (-p0 + p2) +
    2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * t +
    3 * (-p0 + 3 * p1 - 3 * p2 + p3) * t2
  );
}

/**
 * Evaluate a polyline or Catmull-Rom spline at normalized parameter `t01` in [0, 1].
 * Writes into optional `outPos` and `outTan` tuples to avoid allocations on hot paths.
 */
export function sampleSpline(
  waypoints: readonly Vec3Point[],
  t01: number,
  outPos: [number, number, number] = [0, 0, 0],
  outTan: [number, number, number] = [0, 0, 1],
): SplineSample {
  const n = waypoints.length;
  if (n === 0) {
    outPos[0] = outPos[1] = outPos[2] = 0;
    outTan[0] = 0; outTan[1] = 0; outTan[2] = 1;
    return { pos: outPos, tangent: outTan };
  }
  if (n === 1) {
    outPos[0] = waypoints[0]![0]; outPos[1] = waypoints[0]![1]; outPos[2] = waypoints[0]![2];
    outTan[0] = 0; outTan[1] = 0; outTan[2] = 1;
    return { pos: outPos, tangent: outTan };
  }
  const u = Math.max(0, Math.min(1, t01));
  const segCount = n - 1;
  const scaled = u * segCount;
  const seg = Math.min(segCount - 1, Math.floor(scaled));
  const localT = scaled - seg;

  const p0 = waypoints[Math.max(0, seg - 1)]!;
  const p1 = waypoints[seg]!;
  const p2 = waypoints[seg + 1]!;
  const p3 = waypoints[Math.min(n - 1, seg + 2)]!;

  outPos[0] = catmullRom(p0[0], p1[0], p2[0], p3[0], localT);
  outPos[1] = catmullRom(p0[1], p1[1], p2[1], p3[1], localT);
  outPos[2] = catmullRom(p0[2], p1[2], p2[2], p3[2], localT);

  let tx = catmullRomTangent(p0[0], p1[0], p2[0], p3[0], localT);
  let ty = catmullRomTangent(p0[1], p1[1], p2[1], p3[1], localT);
  let tz = catmullRomTangent(p0[2], p1[2], p2[2], p3[2], localT);
  const len = Math.hypot(tx, ty, tz);
  if (len > 1e-6) {
    tx /= len;
    ty /= len;
    tz /= len;
  } else {
    tx = 0; ty = 0; tz = 1;
  }
  outTan[0] = tx; outTan[1] = ty; outTan[2] = tz;
  return { pos: outPos, tangent: outTan };
}

/** Total polyline arc length in metres across waypoints. */
export function splineLength(waypoints: readonly Vec3Point[]): number {
  let len = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1]!;
    const b = waypoints[i]!;
    len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return len;
}

/**
 * Server-authoritative spline clamp: ensures every waypoint lies within
 * `maxReachM` metres of the caster's origin and within a total arc length of
 * `maxReachM * 2`, snapping the start near `origin` and downsampling to <= 16 points.
 */
export function clampSplineToRange(
  origin: Vec3Point,
  rawWaypoints: readonly Vec3Point[],
  maxReachM: number,
): Array<[number, number, number]> {
  const maxR = Math.max(1, maxReachM);
  const maxArc = maxR * 2.25;
  const src = rawWaypoints.length > 0 ? rawWaypoints : [origin, [origin[0], origin[1], origin[2] + 1] as const];
  const out: Array<[number, number, number]> = [];
  let accArc = 0;

  for (let i = 0; i < src.length && out.length < 16; i++) {
    const raw = src[i]!;
    let x = Number.isFinite(raw[0]) ? raw[0] : origin[0];
    let y = Number.isFinite(raw[1]) ? raw[1] : origin[1];
    let z = Number.isFinite(raw[2]) ? raw[2] : origin[2];

    // Clamp radial distance from caster horizontally/3D so points stay inside reach
    const dx = x - origin[0];
    const dy = y - origin[1];
    const dz = z - origin[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist > maxR) {
      const s = maxR / dist;
      x = origin[0] + dx * s;
      y = origin[1] + dy * s;
      z = origin[2] + dz * s;
    }

    if (out.length > 0) {
      const prev = out[out.length - 1]!;
      const seg = Math.hypot(x - prev[0], y - prev[1], z - prev[2]);
      if (seg < 0.05) continue;
      if (accArc + seg > maxArc) {
        const rem = Math.max(0, maxArc - accArc);
        if (rem > 0.05) {
          const s = rem / seg;
          out.push([prev[0] + (x - prev[0]) * s, prev[1] + (y - prev[1]) * s, prev[2] + (z - prev[2]) * s]);
        }
        break;
      }
      accArc += seg;
    }
    out.push([x, y, z]);
  }

  if (out.length === 0) {
    out.push([origin[0], origin[1] + 0.5, origin[2]], [origin[0], origin[1] + 0.5, origin[2] + 1]);
  } else if (out.length === 1) {
    const p = out[0]!;
    out.push([p[0], p[1], p[2] + 0.5]);
  }
  return out;
}
