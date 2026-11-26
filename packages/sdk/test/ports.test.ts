import assert from "node:assert/strict";
import test from "node:test";
import { BadPortError, PORTS, openPorts, type PortDecl } from "../src/ports.js";

interface Hits {
  readonly target: number;
}

interface TestPorts {
  combat: { drainHits(): Hits[]; setStance(e: number): string | null };
  duels: { forget(e: number): void };
  telegraphs: { drainEvents(): string[] };
}

const TABLE: readonly PortDecl[] = [
  { key: "combat", methods: ["drainHits", "setStance"], what: "the blows struck this tick" },
  { key: "duels", methods: ["forget"], what: "duel flow" },
  { key: "telegraphs", methods: ["drainEvents"], what: "telegraph warnings" },
];

class Combatish {
  readonly [PORTS] = ["combat"];
  readonly hits: Hits[] = [{ target: 7 }];
  drainHits(): Hits[] {
    return this.hits;
  }
  setStance(): string | null {
    return null;
  }
}

class Duelish {
  readonly [PORTS] = ["duels"];
  forgotten: number[] = [];
  forget(e: number): void {
    this.forgotten.push(e);
  }
}

class Plain {
  tick(): void {}
}

test("a host reaches a system by port name, never by class", () => {
  const combat = new Combatish();
  const ports = openPorts<TestPorts>(TABLE, [new Plain(), combat, new Duelish()]);

  assert.equal(ports.first("combat"), combat);
  assert.deepEqual(ports.first("combat")?.drainHits(), [{ target: 7 }]);
  assert.equal(ports.has("combat"), true);
  assert.equal(ports.all("duels").length, 1);

  // A port nothing offers is a feature this run does not have, not an error.
  assert.equal(ports.first("telegraphs"), undefined);
  assert.equal(ports.has("telegraphs"), false);
  assert.deepEqual(ports.absent, ["telegraphs"]);
  assert.equal(ports.summary, "ports: 2/3, off: telegraphs");
});

test("every system behind a port is reachable, in systems order", () => {
  const a = new Duelish();
  const b = new Duelish();
  const ports = openPorts<TestPorts>(TABLE, [a, new Plain(), b]);
  assert.deepEqual(ports.all("duels"), [a, b]);
  assert.equal(ports.first("duels"), a);
});

test("a system offering a port it cannot answer ends the boot, with every problem named", () => {
  class Half {
    readonly [PORTS] = ["combat"];
    drainHits(): Hits[] {
      return [];
    }
  }
  class Typo {
    readonly [PORTS] = ["combt", "duels"];
    forget(): void {}
  }

  let err: BadPortError | undefined;
  try {
    openPorts<TestPorts>(TABLE, [new Half(), new Typo()]);
  } catch (caught) {
    err = caught as BadPortError;
  }
  assert.ok(err instanceof BadPortError, "a bad port ends the boot");
  assert.equal(err.bad.length, 2);
  assert.deepEqual(err.bad[0], {
    key: "combat",
    system: "Half",
    problem: "missing members",
    missing: ["setStance"],
  });
  assert.equal(err.bad[1]?.problem, "unknown port");
  assert.match(err.message, /2 systems offer a port they cannot answer/);
  assert.match(err.message, /Half offers "combat" without setStance/);
  assert.match(err.message, /Typo offers "combt", which this host does not read/);
});

test("a field the host reads is checked for presence, not for being callable", () => {
  const table: readonly PortDecl[] = [
    { key: "telegraphs", methods: ["drainEvents"], fields: ["size", "castSeconds"], what: "with data members" },
  ];
  class WithData {
    readonly [PORTS] = ["telegraphs"];
    castSeconds = 0;
    get size(): number {
      return 3;
    }
    drainEvents(): string[] {
      return [];
    }
  }
  assert.equal(openPorts<TestPorts>(table, [new WithData()]).has("telegraphs"), true);

  class NoData {
    readonly [PORTS] = ["telegraphs"];
    drainEvents(): string[] {
      return [];
    }
  }
  let err: BadPortError | undefined;
  try {
    openPorts<TestPorts>(table, [new NoData()]);
  } catch (caught) {
    err = caught as BadPortError;
  }
  assert.ok(err instanceof BadPortError);
  assert.deepEqual(err.bad[0]?.missing, ["size", "castSeconds"]);
  assert.match(err.message, /NoData offers "telegraphs" without size, castSeconds/);
});

test("a port declared twice is a mistake in the table itself", () => {
  assert.throws(
    () => openPorts<TestPorts>([...TABLE, TABLE[0] as PortDecl], []),
    /port table declares "combat" twice/,
  );
});

test("systems that offer nothing, and odd values in the array, are passed over", () => {
  const ports = openPorts<TestPorts>(TABLE, [new Plain(), null, undefined, 7, "combat", {}, { [PORTS]: "combat" }]);
  assert.deepEqual(ports.absent, ["combat", "duels", "telegraphs"]);
  assert.equal(ports.summary, "ports: 0/3, off: combat, duels, telegraphs");
});

test("a plain object offers a port as readily as a class", () => {
  const ports = openPorts<TestPorts>(TABLE, [
    { [PORTS]: ["telegraphs"], drainEvents: (): string[] => ["warn"] },
  ]);
  assert.deepEqual(ports.first("telegraphs")?.drainEvents(), ["warn"]);
  assert.equal(ports.summary, "ports: 1/3, off: combat, duels");
});

test("the symbol is shared by name, so a second copy of the package agrees", () => {
  assert.equal(PORTS, Symbol.for("mmo-engine.ports"));
});
