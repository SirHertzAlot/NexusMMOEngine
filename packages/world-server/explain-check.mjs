/**
 * EXPLAIN audit (diagnostic): do the store's hot queries use their
 * indexes on a populated database, per SurrealDB's own performance
 * best-practices doc ("Adding EXPLAIN shows whether an index was
 * chosen")? Seeds 20k character_state rows, EXPLAINs the hot read
 * shapes, and times the production getCharacterState path.
 *
 * Prereq: live server on 127.0.0.1:8000 (root/root).
 * Usage: node explain-check.mjs
 */
import { Surreal } from "surrealdb";
import { SurrealWorldStore } from "./dist/src/surreal-store.js";

const NS = `explain${Date.now() % 100000}`;
const store = new SurrealWorldStore({
  url: "ws://127.0.0.1:8000", namespace: NS, database: NS,
  username: "root", password: "root",
});
await store.connect(); // installs schema + indexes

const db = new Surreal();
await db.connect("ws://127.0.0.1:8000/rpc");
await db.signin({ username: "root", password: "root" });
await db.use({ namespace: NS, database: NS });

// ---- seed 20k character_state rows in bulk statements -------------------
const TOTAL = 20000, BATCH = 500;
for (let base = 0; base < TOTAL; base += BATCH) {
  const rows = [];
  for (let i = base; i < base + BATCH; i++) {
    rows.push(`{ characterId: ${100000 + i}, state: { gold: ${i}, inventory: [] }, version: 1, epoch: 1, regionId: 'r1', updatedAt: 1700000000000 }`);
  }
  await db.query(`INSERT INTO character_state [${rows.join(",")}];`);
}
console.log(`seeded ${TOTAL} character_state rows`);

// ---- EXPLAIN the hot shapes ----------------------------------------------
async function explain(label, sql, vars) {
  // EXPLAIN returns plan rows, which conflicts with ONLY's single-row
  // expectation — strip ONLY for the plan check (access path is unchanged).
  const res = await db.query(`${sql.replace("FROM ONLY", "FROM")} EXPLAIN;`, vars);
  const plan = JSON.stringify(res[0]);
  const op = plan.includes("Iterate Index") ? "INDEX"
    : plan.includes("Iterate Table") ? "TABLE SCAN"
    : plan.includes("Iterate Record") || plan.includes("record") ? "RECORD/other"
    : "other";
  console.log(`${label}: ${op}  ${plan.slice(0, 160)}`);
}
await explain("getCharacterState   ",
  "SELECT * FROM ONLY character_state WHERE characterId = $id LIMIT 1", { id: 119999 });
await explain("getCharacterLock    ",
  "SELECT * FROM ONLY character_lock WHERE characterId = $id LIMIT 1", { id: 119999 });
await explain("ledger recall       ",
  "SELECT * FROM ledger_event WHERE rangeKey = $rk", { rk: "0:100:0:100" });
await explain("dedup read          ",
  "SELECT * FROM ONLY op_dedup WHERE opId = $opId", { opId: "op-x" });
await explain("meta by WHERE id    ",
  "SELECT * FROM ONLY meta WHERE id = meta:registry");
await explain("meta direct record  ",
  "SELECT * FROM ONLY meta:registry");

// ---- time the production read path at 20k rows ---------------------------
const ids = Array.from({ length: 200 }, (_, i) => 100000 + ((i * 97) % TOTAL));
const t0 = performance.now();
for (const id of ids) await store.getCharacterState(id);
const ms = performance.now() - t0;
console.log(`getCharacterState x200 @20k rows: ${(200 / (ms / 1000)).toFixed(0)} ops/s, mean ${(ms / 200).toFixed(2)} ms/op`);
process.exit(0);
