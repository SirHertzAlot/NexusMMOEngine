// node bench/selectnames.mjs [addonDir]: selectNames cost for 1,000 sessions, 20 sectors each, 10 ids per sector,
// steady state (every id already named) with a few new ids per tick.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Fanout } = require(process.argv[2] ?? "../index.js");
const SESSIONS = 1000, SECTORS = 400, PER = 10, IN_VIEW = 20;
const f = new Fanout();
const ids = new BigUint64Array(SECTORS * PER), start = new Int32Array(SECTORS), len = new Int32Array(SECTORS).fill(PER);
for (let s = 0; s < SECTORS; s++) { start[s] = s * PER; for (let k = 0; k < PER; k++) ids[s * PER + k] = BigInt(s * 100 + k + 1); }
const descArr = [];
for (let n = 0; n < SESSIONS; n++) { const c = (n * 7) % (SECTORS - IN_VIEW); descArr.push(n, 1, IN_VIEW, 0); for (let k = 0; k < IN_VIEW; k++) descArr.push(c + k); }
const desc = Int32Array.from(descArr);
const pids = new BigUint64Array(SESSIONS).map((_, i) => BigInt(1_000_000 + i));
const cnt = new Int32Array(SESSIONS);
const call = () => f.selectNames(start, len, ids, desc, desc.length, pids, cnt);
const first = call();
const times = [];
for (let t = 0; t < 300; t++) {
  if (t % 10 === 0) ids[(t * 13) % ids.length] += 1n << 40n; // an entity changes now and then
  const a = process.hrtime.bigint(); call(); times.push(Number(process.hrtime.bigint() - a) / 1e6);
}
times.sort((a, b) => a - b);
console.log(`first call ${first} ids; steady state per tick: median ${times[150].toFixed(3)} ms, p99 ${times[297].toFixed(3)} ms`);
