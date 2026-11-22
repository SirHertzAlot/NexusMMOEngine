import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MissingServicesError, ServiceRegistry, openServiceRegistry, type ServiceDecl } from "../src/index.js";

interface Services {
  items: { give(id: number): boolean };
  dropper: { onDeath(): void };
  bots: { count(): number };
}

const TABLE: readonly ServiceDecl[] = [
  { key: "items", module: "items", kind: "system", required: true, what: "bags and item definitions" },
  { key: "dropper", module: "items", kind: "extension", required: true, what: "what a kill leaves behind" },
  { key: "bots", module: "creatures", kind: "system", required: false, what: "the practice bots" },
];

const items = { give: () => true };
const dropper = { onDeath: () => {} };
const bots = { count: () => 3 };

const open = (systems: Record<string, unknown>, extensions: Record<string, unknown>, modules: string[] = ["items", "creatures"]): ServiceRegistry<Services> =>
  openServiceRegistry<Services>(TABLE, { systems, extensions, modules });

describe("the service registry", () => {
  it("reads a system and an extension by key, typed", () => {
    const r = open({ items, bots }, { dropper });
    assert.equal(r.get("items"), items);
    assert.equal(r.get("dropper"), dropper);
    assert.equal(r.optional("bots"), bots);
    assert.equal(r.has("bots"), true);
    assert.deepEqual(r.absent, []);
  });

  it("answers undefined for an optional service whose module is off", () => {
    const r = open({ items }, { dropper }, ["items"]);
    assert.equal(r.optional("bots"), undefined);
    assert.equal(r.has("bots"), false);
    assert.deepEqual(r.absent, ["bots"]);
    assert.match(r.summary, /services: 2\/3, off: bots/);
  });

  it("never takes a system from the extension bag, or the reverse", () => {
    // `dropper` is an extension: the same name among the tick systems is not it.
    assert.throws(() => open({ items, dropper }, {}), MissingServicesError);
    const r = open({ items, bots }, { dropper });
    assert.equal(r.get("dropper"), dropper);
  });

  it("stops the boot naming the module to enable, not a TypeError later", () => {
    let err: MissingServicesError | undefined;
    try {
      open({ bots }, {}, ["creatures"]);
    } catch (caught) {
      assert.ok(caught instanceof MissingServicesError, String(caught));
      err = caught;
    }
    assert.ok(err, "a missing required service should stop the boot");
    assert.equal(err.missing.length, 2);
    assert.deepEqual(
      err.missing.map((m) => m.key),
      ["items", "dropper"],
    );
    // The items module is not enabled here, so the fix is to enable it.
    assert.equal(err.missing[0]?.moduleEnabled, false);
    assert.match(err.message, /enable items in the module set/);
    assert.match(err.message, /bags and item definitions/);
  });

  it("says so when the module ran but provided nothing, since enabling it is not the fix", () => {
    let err: MissingServicesError | undefined;
    try {
      open({}, {}, ["items", "creatures"]);
    } catch (caught) {
      err = caught as MissingServicesError;
    }
    assert.ok(err);
    assert.equal(err.missing[0]?.moduleEnabled, true);
    assert.match(err.message, /that module is enabled but did not provide it/);
    assert.doesNotMatch(err.message, /enable items in the module set/);
  });

  it("refuses get() for an optional service, so a caller cannot pretend it is always there", () => {
    const r = open({ items, bots }, { dropper });
    assert.throws(() => r.get("bots" as "items"), /optional — read it with optional\("bots"\)/);
  });

  it("refuses a key that is not in the table at all", () => {
    const r = open({ items }, { dropper }, ["items"]);
    assert.throws(() => r.optional("nope" as "bots"), /service nope is not in the table/);
  });

  it("refuses a table that declares one key twice", () => {
    assert.throws(
      () => openServiceRegistry<Services>([...TABLE, TABLE[0]!], { systems: { items }, extensions: { dropper } }),
      /service items is declared twice/,
    );
  });

  it("treats null like absent, so a module that returns null does not pass a cast off as a service", () => {
    assert.throws(() => open({ items: null }, { dropper }), /items \(bags and item definitions\)/);
  });
});
