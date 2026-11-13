/**
 * Deterministic elementary functions: each agrees with Math.* to about 1e-12
 * (relative, or absolute near zero) over the ranges terrain uses, and keeps
 * the special values JavaScript defines.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detAtan, detAtan2, detCos, detExp, detLog, detLog1p, detPow, detSin, detTan } from "../src/det-math.js";

const close = (got: number, want: number, what: string): void => {
  const tol = 1e-12 * Math.max(1, Math.abs(want));
  assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want}`);
};
const sweep = (lo: number, hi: number, n: number): number[] => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));

describe("deterministic math", () => {
  it("exp matches Math.exp", () => {
    for (const x of sweep(-40, 40, 401)) close(detExp(x), Math.exp(x), `exp(${x})`);
    assert.equal(detExp(-Infinity), 0);
    assert.equal(detExp(Infinity), Infinity);
  });

  it("log and log1p match Math.log and Math.log1p", () => {
    for (const x of [1e-12, 0.001, 0.3, 0.5, 1, 1.5, 2, 7.25, 1000, 1e12]) close(detLog(x), Math.log(x), `log(${x})`);
    for (const x of [-0.99, -0.5, -1e-9, 0, 1e-9, 0.2, 3]) close(detLog1p(x), Math.log1p(x), `log1p(${x})`);
    assert.equal(detLog(0), -Infinity);
    assert.ok(Number.isNaN(detLog(-1)));
  });

  it("sin, cos and tan match Math.*", () => {
    for (const x of sweep(-20, 20, 801)) {
      close(detSin(x), Math.sin(x), `sin(${x})`);
      close(detCos(x), Math.cos(x), `cos(${x})`);
    }
    for (const x of sweep(-1.4, 1.4, 57)) close(detTan(x), Math.tan(x), `tan(${x})`);
    assert.ok(Number.isNaN(detSin(Infinity)));
    assert.ok(Object.is(detSin(-0), -0));
  });

  it("atan and atan2 match Math.*", () => {
    for (const x of sweep(-50, 50, 401)) close(detAtan(x), Math.atan(x), `atan(${x})`);
    const pts: Array<[number, number]> = [[1, 1], [-1, 1], [1, -1], [-1, -1], [0, 1], [0, -1], [2, 0], [-2, 0], [3, -4], [-0.5, 7]];
    for (const [y, x] of pts) close(detAtan2(y, x), Math.atan2(y, x), `atan2(${y}, ${x})`);
    assert.ok(Object.is(detAtan2(0, 1), 0));
    assert.ok(Object.is(detAtan2(-0, 1), -0));
    assert.ok(Math.abs(detAtan2(0, -1) - Math.PI) < 1e-15);
  });

  it("pow matches Math.pow for integer and fractional exponents", () => {
    for (const [x, y] of [[2, 10], [2, -3], [3.5, 2], [0.5, 0.5], [7, 1.7], [10, -0.25], [1.5, 13], [0, 3], [-2, 3], [-2, 4]] as const) {
      close(detPow(x, y), Math.pow(x, y), `pow(${x}, ${y})`);
    }
    assert.ok(Number.isNaN(detPow(-2, 0.5)));
    assert.equal(detPow(5, 0), 1);
  });
});
