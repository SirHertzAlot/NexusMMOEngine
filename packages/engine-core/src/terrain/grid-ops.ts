/**
 * Small whole-grid operations shared by the survey stages: connected
 * components, distance fields, blurs, and slope. All work on row-major
 * W × D arrays of the coarse survey grid.
 */

/**
 * 4-connected components of the cells where `inside` is true. Returns a
 * label per cell (-1 outside) and each component's cell count.
 */
export function labelComponents(
  W: number,
  D: number,
  inside: (i: number) => boolean,
): { label: Int32Array; sizes: number[] } {
  const label = new Int32Array(W * D).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(W * D);
  for (let start = 0; start < W * D; start++) {
    if (label[start] !== -1 || !inside(start)) continue;
    const id = sizes.length;
    let size = 0;
    let top = 0;
    stack[top++] = start;
    label[start] = id;
    while (top > 0) {
      const i = stack[--top];
      size++;
      const u = i % W;
      const v = (i - u) / W;
      if (u > 0 && label[i - 1] === -1 && inside(i - 1)) { label[i - 1] = id; stack[top++] = i - 1; }
      if (u < W - 1 && label[i + 1] === -1 && inside(i + 1)) { label[i + 1] = id; stack[top++] = i + 1; }
      if (v > 0 && label[i - W] === -1 && inside(i - W)) { label[i - W] = id; stack[top++] = i - W; }
      if (v < D - 1 && label[i + W] === -1 && inside(i + W)) { label[i + W] = id; stack[top++] = i + W; }
    }
    sizes.push(size);
  }
  return { label, sizes };
}

/**
 * Distance (metres) from every cell to the nearest cell where `target`
 * is true (0 on targets; Infinity when there are none). Two-pass chamfer
 * with 1 / √2 steps: within ~8% of the true Euclidean distance, plenty
 * for "how far from the coast" questions.
 */
export function distanceTo(W: number, D: number, cell: number, target: (i: number) => boolean): Float32Array {
  const d = new Float32Array(W * D);
  for (let i = 0; i < W * D; i++) d[i] = target(i) ? 0 : Infinity;
  const a = cell;
  const b = cell * Math.SQRT2;
  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      let x = d[i];
      if (u > 0) x = Math.min(x, d[i - 1] + a);
      if (v > 0) {
        x = Math.min(x, d[i - W] + a);
        if (u > 0) x = Math.min(x, d[i - W - 1] + b);
        if (u < W - 1) x = Math.min(x, d[i - W + 1] + b);
      }
      d[i] = x;
    }
  }
  for (let v = D - 1; v >= 0; v--) {
    for (let u = W - 1; u >= 0; u--) {
      const i = v * W + u;
      let x = d[i];
      if (u < W - 1) x = Math.min(x, d[i + 1] + a);
      if (v < D - 1) {
        x = Math.min(x, d[i + W] + a);
        if (u < W - 1) x = Math.min(x, d[i + W + 1] + b);
        if (u > 0) x = Math.min(x, d[i + W - 1] + b);
      }
      d[i] = x;
    }
  }
  return d;
}

/**
 * Separable box blur, repeated `passes` times (3 passes ≈ a Gaussian of
 * σ ≈ radius). Edges clamp. Returns a new array.
 */
export function boxBlur(src: Float32Array, W: number, D: number, radius: number, passes = 3): Float32Array {
  const r = Math.max(0, Math.round(radius));
  const a = Float32Array.from(src);
  if (r === 0) return a;
  const b = new Float32Array(src.length);
  const n = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let v = 0; v < D; v++) {
      const row = v * W;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[row + Math.min(W - 1, Math.max(0, k))];
      for (let u = 0; u < W; u++) {
        b[row + u] = sum / n;
        sum += a[row + Math.min(W - 1, u + r + 1)] - a[row + Math.max(0, u - r)];
      }
    }
    for (let u = 0; u < W; u++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += b[Math.min(D - 1, Math.max(0, k)) * W + u];
      for (let v = 0; v < D; v++) {
        a[v * W + u] = sum / n;
        sum += b[Math.min(D - 1, v + r + 1) * W + u] - b[Math.max(0, v - r) * W + u];
      }
    }
  }
  return a;
}

/** Ground slope in degrees (central differences; edges one-sided). */
export function slopeDegrees(h: Float32Array, W: number, D: number, cell: number): Float32Array {
  const out = new Float32Array(W * D);
  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      const l = u > 0 ? i - 1 : i;
      const r = u < W - 1 ? i + 1 : i;
      const t = v > 0 ? i - W : i;
      const bt = v < D - 1 ? i + W : i;
      const gx = (h[r] - h[l]) / (cell * (r - l));
      const gz = (h[bt] - h[t]) / (cell * ((bt - t) / W));
      out[i] = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
    }
  }
  return out;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
