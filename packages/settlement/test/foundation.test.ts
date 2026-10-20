/**
 * The settlement generator's foundations: stable ids, named RNG streams that
 * do not disturb each other, the event log's verbosity levels, and the
 * canonical content hash of a manifest.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentHash, EventLog, entityId, streams } from "../src/index.js";

describe("entityId", () => {
  it("is readable and stable, padded so ids sort in index order", () => {
    assert.equal(entityId("parcel", "0182", 3, 17), "parcel_0182_0003_0017");
    assert.equal(entityId("district", "0182", 42), "district_0182_0042");
  });
});

describe("streams", () => {
  it("gives the same draws per seed and name, whatever else was drawn first", () => {
    const a = streams(1234);
    const b = streams(1234);
    b.get("topology").raw();
    b.get("topology").raw();
    assert.deepEqual([a.get("districts").raw(), a.get("districts").raw()], [b.get("districts").raw(), b.get("districts").raw()]);
    assert.notEqual(streams(1).get("districts").raw(), streams(2).get("districts").raw());
    assert.notEqual(a.get("topology").raw(), a.get("districts").raw());
  });

  it("lists each stream's seed for the manifest", () => {
    const s = streams(7);
    s.get("topology");
    s.get("districts");
    assert.deepEqual(Object.keys(s.seeds()), ["districts", "topology"], "sorted by name");
  });
});

describe("EventLog", () => {
  it("keeps what the verbosity asks for, in sequence order", () => {
    const log = new EventLog();
    log.emit("summary", "demographics", "baked", { households: 136 });
    log.emit("verbose", "structures", "structure_collapsed", { parcel: "p1" });
    log.emit("debug", "structures", "rng", { counter: 4 });
    assert.deepEqual(log.events("silent"), []);
    assert.deepEqual(log.events("summary").map((e) => e.event), ["baked"]);
    assert.deepEqual(log.events("verbose").map((e) => e.sequence), [1, 2]);
    assert.equal(log.events("debug").length, 3);
  });
});

describe("contentHash", () => {
  it("ignores key order, so the same manifest always hashes alike", () => {
    assert.equal(contentHash({ a: 1, b: { c: 2, d: [3, { e: 4, f: 5 }] } }), contentHash({ b: { d: [3, { f: 5, e: 4 }], c: 2 }, a: 1 }));
    assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
  });
});
