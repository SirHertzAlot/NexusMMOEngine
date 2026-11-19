/**
 * Deterministic elementary functions. Math.sin, exp, log, pow and friends are
 * computed by the platform's math library (or V8's own ports of it), and their
 * last bits can differ between CPUs, so the same seed can give a different
 * world on another machine. These use only + − × ÷ and sqrt (correctly rounded
 * by IEEE 754, identical everywhere) and exact bit operations, so the results
 * are the same on every CPU. Accuracy is about 1e-15 relative, enough for
 * terrain; tests in placement check it against Math.*.
 */

const LN2 = 0.6931471805599453;
const PIO2 = 1.5707963267948966;
const PIO2_HI = 1.5707963267341256; // pi/2 split for Cody-Waite reduction (exact high part)
const PIO2_MID = 6.077100506303966e-11;
const PIO2_LO = 2.0222662487959507e-21;

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const HI = LE ? 1 : 0;
const LO = LE ? 0 : 1;

/** The unbiased binary exponent of a finite nonzero x, and x scaled into [1, 2). */
function frexp2(x: number): [number, number] {
  f64[0] = x;
  const e = ((u32[HI] >>> 20) & 0x7ff) - 1023;
  if (e === -1023) {
    // subnormal: scale up by 2^64 first (exact), then read again
    f64[0] = x * 18446744073709551616;
    const e2 = ((u32[HI] >>> 20) & 0x7ff) - 1023 - 64;
    u32[HI] = (u32[HI] & 0x800fffff) | (1023 << 20);
    return [e2, f64[0]];
  }
  u32[HI] = (u32[HI] & 0x800fffff) | (1023 << 20);
  return [e, f64[0]];
}

/** 2^k for an integer k in the normal range (exact). */
function pow2(k: number): number {
  let r = 1;
  let n = k;
  while (n > 0) {
    const s = Math.min(n, 1000);
    r *= 2 ** s; // exact for any s in 1..1000 since 2^s is representable
    n -= s;
  }
  while (n < 0) {
    const s = Math.max(n, -1000);
    r *= 2 ** s;
    n -= s;
  }
  return r;
}

/** e^x. */
export function detExp(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (x === -Infinity) return 0;
  if (x > 709.8) return Infinity;
  if (x < -745.2) return 0;
  const k = Math.round(x / LN2);
  const r = x - k * LN2;
  // Taylor series of e^r, |r| <= ~0.35: converges well before 20 terms.
  let term = 1;
  let sum = 1;
  for (let n = 1; n < 24; n++) {
    term = (term * r) / n;
    sum += term;
    if (Math.abs(term) < 1e-18 * Math.abs(sum)) break;
  }
  return sum * pow2(k);
}

/** Natural log of x (x > 0; NaN for x < 0, -Infinity at 0). */
export function detLog(x: number): number {
  if (Number.isNaN(x) || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  let [e, m] = frexp2(x);
  if (m > Math.SQRT2) {
    m /= 2;
    e += 1;
  }
  // log(m) = 2 atanh(s), s = (m-1)/(m+1), |s| < 0.1716
  const s = (m - 1) / (m + 1);
  const s2 = s * s;
  let term = s;
  let sum = 0;
  for (let n = 1; n < 60; n += 2) {
    sum += term / n;
    term *= s2;
    if (Math.abs(term) < 1e-18) break;
  }
  return e * LN2 + 2 * sum;
}

/** log(1 + x), accurate for small x. */
export function detLog1p(x: number): number {
  if (Number.isNaN(x) || x < -1) return NaN;
  if (x === -1) return -Infinity;
  const u = 1 + x;
  if (u === 1) return x;
  return (detLog(u) * x) / (u - 1);
}

/** sin and cos of r for |r| <= pi/4 (Taylor series). */
function sinKernel(r: number): number {
  const r2 = r * r;
  let term = r;
  let sum = r;
  for (let n = 3; n < 30; n += 2) {
    term = (-term * r2) / ((n - 1) * n);
    sum += term;
    if (Math.abs(term) < 1e-18) break;
  }
  return sum;
}
function cosKernel(r: number): number {
  const r2 = r * r;
  let term = 1;
  let sum = 1;
  for (let n = 2; n < 30; n += 2) {
    term = (-term * r2) / ((n - 1) * n);
    sum += term;
    if (Math.abs(term) < 1e-18) break;
  }
  return sum;
}

/** Reduce x to r in [-pi/4, pi/4] and the quadrant q (mod 4). */
function reduce(x: number): [number, number] {
  const q = Math.round(x / PIO2);
  const r = ((x - q * PIO2_HI) - q * PIO2_MID) - q * PIO2_LO;
  return [r, ((q % 4) + 4) % 4];
}

export function detSin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  if (x === 0) return x; // keeps -0
  const [r, q] = reduce(x);
  if (q === 0) return sinKernel(r);
  if (q === 1) return cosKernel(r);
  if (q === 2) return -sinKernel(r);
  return -cosKernel(r);
}

export function detCos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const [r, q] = reduce(x);
  if (q === 0) return cosKernel(r);
  if (q === 1) return -sinKernel(r);
  if (q === 2) return -cosKernel(r);
  return sinKernel(r);
}

export function detTan(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  return detSin(x) / detCos(x);
}

/** arctan of x, |x| finite. */
export function detAtan(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return PIO2;
  if (x === -Infinity) return -PIO2;
  if (x === 0) return x;
  const sign = x < 0 ? -1 : 1;
  let a = Math.abs(x);
  let base = 0;
  if (a > 1) {
    a = 1 / a;
    base = PIO2;
  }
  // Halve the argument twice: atan(a) = 2 atan(a / (1 + sqrt(1 + a^2))).
  let scale = 1;
  for (let i = 0; i < 2; i++) {
    a = a / (1 + Math.sqrt(1 + a * a));
    scale *= 2;
  }
  // Taylor series of atan(a), |a| <= tan(pi/16) ~ 0.199.
  const a2 = a * a;
  let term = a;
  let sum = 0;
  for (let n = 1; n < 80; n += 2) {
    sum += term / n;
    term *= -a2;
    if (Math.abs(term) < 1e-18) break;
  }
  const r = scale * sum;
  return sign * (base === 0 ? r : base - r);
}

/** atan2(y, x), with the JavaScript special cases. */
export function detAtan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (y === 0) {
    if (x > 0 || Object.is(x, 0)) return y;
    return y < 0 || Object.is(y, -0) ? -Math.PI : Math.PI;
  }
  if (x === 0) return y > 0 ? PIO2 : -PIO2;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    if (x === Infinity && Number.isFinite(y)) return y < 0 ? -0 : 0;
    if (x === -Infinity && Number.isFinite(y)) return y < 0 ? -Math.PI : Math.PI;
    if (y === Infinity && x === Infinity) return PIO2 / 2;
    if (y === -Infinity && x === Infinity) return -PIO2 / 2;
    if (y === Infinity && x === -Infinity) return (3 * PIO2) / 2;
    if (y === -Infinity && x === -Infinity) return (-3 * PIO2) / 2;
    return y > 0 ? PIO2 : -PIO2;
  }
  const t = detAtan(y / x);
  if (x > 0) return t;
  return y >= 0 ? t + Math.PI : t - Math.PI;
}

/** x^y. Integer exponents multiply exactly; others go through exp(y log x). */
export function detPow(x: number, y: number): number {
  if (y === 0) return 1;
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (Number.isInteger(y) && Math.abs(y) <= 64) {
    let r = 1;
    let b = x;
    let n = Math.abs(y);
    while (n > 0) {
      if (n & 1) r *= b;
      b *= b;
      n >>= 1;
    }
    return y < 0 ? 1 / r : r;
  }
  if (x === 0 || !Number.isFinite(x) || !Number.isFinite(y)) return Math.pow(x, y); // special values only
  if (x < 0) return NaN; // non-integer power of a negative number
  return detExp(y * detLog(x));
}
