/** Combat moves as content: the shipped file matches the built-in moves, bad edits are refused, and a loaded file is what combatMove() answers. */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMBAT_MOVES, DEFAULT_COMBAT_MOVES, Move, combatMove, setCombatMoves, validateCombatMoves, type CombatMove } from "../src/index.js";

const file = fileURLToPath(new URL("../../../../content/combat/moves.json", import.meta.url));
const shipped = (): { version: 1; moves: CombatMove[] } => JSON.parse(readFileSync(file, "utf8")) as { version: 1; moves: CombatMove[] };

describe("content/combat/moves.json", () => {
  afterEach(() => setCombatMoves({ version: 1, moves: [...DEFAULT_COMBAT_MOVES] }));

  it("is valid and keeps the timings the built-in moves have (sounds aside)", () => {
    const doc = shipped();
    assert.deepEqual(validateCombatMoves(doc), []);
    const strip = (m: CombatMove): Omit<CombatMove, "sound"> => {
      const { sound: _s, ...rest } = m;
      return rest;
    };
    assert.deepEqual(doc.moves.map(strip), DEFAULT_COMBAT_MOVES.map(strip));
  });

  it("refuses a hit frame past the move, a chain to nowhere, a missing move and a duplicate id", () => {
    const doc = shipped();
    doc.moves[0].hitAt = 99;
    doc.moves[0].chain = { next: 77, from: 0.3, to: 0.1 };
    doc.moves[1].id = Move.SwordA;
    doc.moves.pop();
    const paths = validateCombatMoves(doc).map((i) => i.path);
    assert.ok(paths.includes("moves[0].hitAt"));
    assert.ok(paths.includes("moves[0].chain.next"));
    assert.ok(paths.includes("moves[0].chain"));
    assert.ok(paths.includes("moves[1].id"));
    assert.ok(paths.includes("moves"), "the last move is gone");
  });

  it("setCombatMoves changes what combatMove answers, and a refused document changes nothing", () => {
    const doc = shipped();
    doc.moves[0].hitAt = 0.31;
    setCombatMoves(doc);
    assert.equal(combatMove(Move.SwordA)!.hitAt, 0.31);
    assert.equal(COMBAT_MOVES[0].hitAt, 0.31, "the exported array is live");
    const bad = shipped();
    bad.moves[0].hitAt = 5;
    assert.throws(() => setCombatMoves(bad), /moves\[0\]\.hitAt/);
    assert.equal(combatMove(Move.SwordA)!.hitAt, 0.31);
  });
});
