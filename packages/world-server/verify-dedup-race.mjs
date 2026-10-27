/**
 * Dedup-fold race verification against a LIVE SurrealDB 2.7.0 server
 * (the embedded engine cannot prove the concurrent case).
 *
 * Proves, end-to-end through WorldCore -> SurrealWorldStore -> fn v2:
 *  A. Sequential duplicate: the same opId submitted twice applies once;
 *     the second call replays the recorded outcome byte-identically.
 *  B. Concurrent race: 16 simultaneous submissions of the SAME opId
 *     apply exactly once — no double-apply, no error storm — with
 *     exactly one op_dedup row and gold conserved.
 *
 * Prereq: surreal start --user root --pass root --bind 127.0.0.1:8000
 * Usage:  node verify-dedup-race.mjs
 */
import * as argon2 from "argon2";
import { Surreal } from "surrealdb";
import { SurrealWorldStore } from "./dist/src/surreal-store.js";
import { WorldCoreImpl } from "./dist/src/core.js";

const NS = `race${Date.now() % 100000}`;
const URL = "ws://127.0.0.1:8000";
let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const store = new SurrealWorldStore({
  url: URL, namespace: NS, database: NS, username: "root", password: "root",
});
await store.connect();
const core = new WorldCoreImpl({
  store, heartbeatTimeoutMs: 1000, heartbeatIntervalMs: 100,
  apiKeyHash: await argon2.hash("race-key"),
});
const db = new Surreal();
await db.connect(`${URL}/rpc`);
await db.signin({ username: "root", password: "root" });
await db.use({ namespace: NS, database: NS });

let n = 0;
const opId = (t) => `race-${t}-${++n}`;
await core.registerRegion({
  regionId: "r1", chunkRange: { x0: 0, x1: 100, z0: 0, z1: 100 },
  endpoint: "ws://localhost:7777", capacity: 1000,
  apiKey: "race-key", opId: opId("reg"),
});
const item = (instanceId, def, slot) => ({ instanceId, def, slot, count: 1 });
async function seed(id, gold, items) {
  const lock = await core.acquireCharacterLock("r1", {
    regionId: "r1", characterId: id, ttlMs: 60_000, opId: opId("lock"),
  });
  await store.putCharacterState({
    characterId: id, state: { gold, inventory: items }, version: 1,
    epoch: lock.epoch, regionId: "r1", updatedAt: Date.now(),
  });
  return { characterId: id, epoch: lock.epoch, expectedVersion: 1 };
}
const goldOf = async (id) => (await store.getCharacterState(id)).state.gold;
const invOf = async (id) => (await store.getCharacterState(id)).state.inventory;
const dedupCount = async (id) =>
  (await db.query("SELECT * FROM op_dedup WHERE opId = $id", { id }))[0].length;

// ---- A. sequential duplicate -------------------------------------------
const a = await seed(1, 100, [item("sword-1", 10, 0)]);
const b = await seed(2, 50, [item("shield-1", 20, 0)]);
const seqInput = {
  regionId: "r1", opId: "race-seq-fixed", a, b,
  aGivesGold: 30, bGivesGold: 10,
  aGivesItems: ["sword-1"], bGivesItems: ["shield-1"],
};
const first = await core.tradeCommit("r1", seqInput);
const replay = await core.tradeCommit("r1", seqInput);
check("A1 first submission ok", first.ok === true, JSON.stringify(first).slice(0, 120));
check("A2 replay outcome identical", JSON.stringify(replay) === JSON.stringify(first));
check("A3 gold applied once (80/70)", (await goldOf(1)) === 80 && (await goldOf(2)) === 70,
  `gold=${await goldOf(1)}/${await goldOf(2)}`);
check("A4 items swapped once",
  (await invOf(1))[0]?.instanceId === "shield-1" && (await invOf(2))[0]?.instanceId === "sword-1");
check("A5 exactly one op_dedup row", (await dedupCount("race-seq-fixed")) === 1);

// ---- B. concurrent same-opId race --------------------------------------
const c = await seed(3, 200, [item("gem-1", 30, 0)]);
const d = await seed(4, 0, []);
const raceInput = {
  regionId: "r1", opId: "race-conc-fixed", a: c, b: d,
  aGivesGold: 30, bGivesGold: 0,
  aGivesItems: ["gem-1"], bGivesItems: [],
};
const N = 16;
const settled = await Promise.allSettled(
  Array.from({ length: N }, () => core.tradeCommit("r1", raceInput)),
);
const rejected = settled.filter((s) => s.status === "rejected");
const results = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
const okResults = results.filter((r) => r.ok === true);
const distinctOk = new Set(okResults.map((r) => JSON.stringify(r)));
check("B1 no caller threw", rejected.length === 0,
  rejected.length ? String(rejected[0].reason).slice(0, 160) : `${N}/${N} fulfilled`);
check("B2 every caller got the ok outcome", okResults.length === N,
  `${okResults.length}/${N} ok, ${results.length - okResults.length} non-ok`);
check("B3 all ok outcomes identical (single winner, replayed)", distinctOk.size === 1,
  `${distinctOk.size} distinct outcome(s)`);
check("B4 gold applied exactly once (170/30, total 200)",
  (await goldOf(3)) === 170 && (await goldOf(4)) === 30,
  `gold=${await goldOf(3)}/${await goldOf(4)}`);
check("B5 gem moved exactly once",
  (await invOf(3)).length === 0 && (await invOf(4))[0]?.instanceId === "gem-1");
check("B6 exactly one op_dedup row", (await dedupCount("race-conc-fixed")) === 1);
const ledger = await store.getAtomicLedger();
check("B7 ledger holds A(4) + B(2) entries, no duplicates", ledger.length === 6,
  `${ledger.length} entries`);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
