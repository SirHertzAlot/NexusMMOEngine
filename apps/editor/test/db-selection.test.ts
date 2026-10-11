import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDbSelection, setDbSelection, subscribeDbSelection } from "../src/ui/db-selection.js";

describe("database selection", () => {
  it("tells subscribers when the picked table changes, and only then", () => {
    let calls = 0;
    const off = subscribeDbSelection(() => calls++);
    setDbSelection({ db: "world", table: "events" });
    setDbSelection({ db: "world", table: "events" });
    assert.equal(calls, 1);
    // The same table name in another database is a different pick.
    setDbSelection({ db: "characters", table: "events" });
    assert.equal(calls, 2);
    assert.deepEqual(getDbSelection(), { db: "characters", table: "events" });
    off();
    setDbSelection(null);
    assert.equal(calls, 2);
  });
});
