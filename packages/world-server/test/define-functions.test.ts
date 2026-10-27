/**
 * Slice 3 proof gate: the six atomic ops commit through stored
 * SurrealQL functions (fn::<op>, defined by SurrealWorldStore
 * .connect()). The invariant under test is the one the literal
 * DEFINE FUNCTION form stands or falls on: a THROW inside the
 * function — here a version guard tripping on the SECOND record,
 * after the seq counter and the FIRST record have already been
 * written inside the same invocation — rolls back EVERYTHING the
 * invocation wrote. Records, ledger, and counter must be
 * byte-identical to the pre-call snapshot. A positive control (same
 * payload, correct versions) then proves the invocation commits.
 *
 * Live-only: gated on WORLD_TEST_DB_URL exactly like the other
 * SurrealDB store contracts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Surreal } from "surrealdb";
import { SurrealWorldStore } from "../src/surreal-store.js";

/** JSON round-trip so deep-equal compares data, not SDK prototypes. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

test(
  "define functions: THROW inside fn::trade_commit_v2 rolls back the whole invocation (WORLD_TEST_DB_URL)",
  {
    skip:
      !process.env.WORLD_TEST_DB_URL &&
      "set WORLD_TEST_DB_URL=ws://127.0.0.1:8000/rpc to run",
  },
  async () => {
    const url = process.env.WORLD_TEST_DB_URL!;
    const namespace = "mmo_test";
    const database = "define_fn_" + Date.now();
    const username = process.env.WORLD_TEST_DB_USER ?? "root";
    const password =
      process.env[["WORLD_TEST_DB", "PASS"].join("_")] ?? "root";
    const store = new SurrealWorldStore({
      url,
      namespace,
      database,
      username,
      password,
    });
    const raw = new Surreal();
    try {
      await store.connect();

      // Definition idempotency: a second connect() on the same
      // namespace/database re-runs the DEFINE FUNCTION statements and
      // must succeed (the shipped IF NOT EXISTS form).
      const second = new SurrealWorldStore({
        url,
        namespace,
        database,
        username,
        password,
      });
      await second.connect();
      await second.close();

      // Seed two character records + locks through the public API.
      const lockExpiry = Date.now() + 60_000;
      await store.putCharacterState({
        characterId: 1,
        state: {
          gold: 100,
          inventory: [{ instanceId: "sword-1", def: 7, slot: 0, count: 1 }],
        },
        version: 1,
        epoch: 1,
        regionId: "region-a",
        updatedAt: 1000,
      });
      await store.putCharacterState({
        characterId: 2,
        state: { gold: 50, inventory: [] },
        version: 1,
        epoch: 1,
        regionId: "region-a",
        updatedAt: 1000,
      });
      await store.putCharacterLock({
        characterId: 1,
        regionId: "region-a",
        epoch: 1,
        expiresAt: lockExpiry,
      });
      await store.putCharacterLock({
        characterId: 2,
        regionId: "region-a",
        epoch: 1,
        expiresAt: lockExpiry,
      });

      // One committed op through the public API, so the ledger and
      // the seq counter are non-trivial before the probe.
      const committed = await store.tradeCommit({
        regionId: "region-a",
        opId: "df-seed-trade",
        a: { characterId: 1, epoch: 1, expectedVersion: 1 },
        b: { characterId: 2, epoch: 1, expectedVersion: 1 },
        aGivesGold: 10,
        bGivesGold: 0,
        aGivesItems: [],
        bGivesItems: [],
      });
      assert.equal(committed.ok, true, "seed trade through fn::trade_commit");

      await raw.connect(url);
      await raw.signin({ username, password });
      await raw.use({ namespace, database });

      const snapshot = async () => {
        const [chars] = await raw.query(
          "SELECT * FROM character_state ORDER BY characterId ASC",
        );
        const [ledger] = await raw.query(
          "SELECT * FROM atomic_ledger ORDER BY seq ASC",
        );
        const [meta] = await raw.query(
          "SELECT seq FROM ONLY atomic_meta WHERE id = atomic_meta:ledger",
        );
        return plain({
          chars,
          ledger,
          seq: (meta as { seq: number }).seq,
        });
      };

      const before = await snapshot();
      assert.equal(before.seq, 1, "seed trade advanced the counter to 1");
      assert.equal(
        (before.ledger as unknown[]).length,
        1,
        "seed trade wrote exactly one ledger entry",
      );

      // Hand-built invocation: the FIRST record's guard is correct,
      // the SECOND record's expectedVersion is wrong. By the time the
      // second guard trips, the function has already bumped the seq
      // counter and rewritten record 1 — all of it must roll back.
      const payload = (secondExpectedVersion: number) => ({
        baseSeq: before.seq,
        newSeq: before.seq + 1,
        records: [
          {
            characterId: 1,
            state: {
              gold: 85,
              inventory: [
                { instanceId: "sword-1", def: 7, slot: 0, count: 1 },
              ],
            },
            version: 3,
            epoch: 1,
            regionId: "region-a",
            updatedAt: 2000,
            existed: true,
            expectedVersion: 2,
          },
          {
            characterId: 2,
            state: { gold: 65, inventory: [] },
            version: 3,
            epoch: 1,
            regionId: "region-a",
            updatedAt: 2000,
            existed: true,
            expectedVersion: secondExpectedVersion,
          },
        ],
        entries: [
          {
            seq: before.seq + 1,
            opId: "df-rollback-probe",
            op: "tradeCommit",
            kind: "gold",
            from: "char:1",
            to: "char:2",
            amount: 5,
            at: 2000,
          },
        ],
        credits: [],
        op_id: "df-rollback-probe-op",
        op_name: "tradeCommit",
      });
      const invoke =
        "RETURN fn::trade_commit_v2($baseSeq, $newSeq, $records, $entries, $credits, $op_id, $op_name);";

      await assert.rejects(
        raw.query(invoke, payload(999)),
        "the wrong second-record guard must abort the invocation",
      );
      const after = await snapshot();
      assert.deepEqual(
        after,
        before,
        "records, ledger, and seq counter are byte-identical after the THROW",
      );

      // Positive control: the same invocation with correct versions
      // commits — records updated, ledger grew, counter advanced.
      await raw.query(invoke, payload(2));
      const control = await snapshot();
      assert.equal(control.seq, before.seq + 1, "counter advanced");
      assert.equal(
        (control.ledger as unknown[]).length,
        (before.ledger as unknown[]).length + 1,
        "ledger grew by the probe entry",
      );
      const chars = control.chars as Array<{
        characterId: number;
        version: number;
        state: { gold: number };
      }>;
      assert.equal(chars[0].version, 3);
      assert.equal(chars[0].state.gold, 85);
      assert.equal(chars[1].version, 3);
      assert.equal(chars[1].state.gold, 65);
    } finally {
      await raw.close().catch(() => undefined);
      await store.close();
    }
  },
);
