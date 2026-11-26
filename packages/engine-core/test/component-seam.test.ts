/**
 * The component seam (roadmap ES5c): the data a kit's systems write is
 * declared where the engine can read it.
 *
 * `Body`, `Injury` and `Mana` were declared in `body.ts` and `magic.ts`,
 * beside the systems that maintain them — so the engine's own tick imported
 * a kit's module to ask whether a bad leg slows an entity down
 * (`systems.ts`), what stamina it recovers (`stats/stamina-system.ts`), and
 * what the admin inspector should print. They now sit in `components.ts`
 * with `BodyConfig`, `Health` and the rest.
 *
 * A component is not a type: it is a layout in a SharedArrayBuffer, sized
 * at definition time, which is why this test pins the layout as well as the
 * import graph. Moving a declaration between modules must not change one
 * field, because the backing store is what every system, the mirror and the
 * admin overlay all read through.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { MAX_BODY_PARTS } from "@mmo-engine/rules";
import { BLEEDING_BIT, Body, Injury, Mana, NO_JUMP, PART_STATES, Wound } from "../src/components.js";
import { SAB_ENTITY_CAPACITY } from "../src/sab-store.js";

/** This test runs from packages/engine-core/dist/test. */
const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

const tsFiles = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
};

const ALL = tsFiles(SRC).map((p) => ({ rel: p.slice(SRC.length), text: readFileSync(p, "utf8") }));

/** What the engine reads of a kit's systems, and where it now comes from. */
const MOVED = ["Body", "Injury", "Mana", "Wound", "BLEEDING_BIT", "NO_JUMP", "PART_STATES"] as const;

/** `[field, typed array, per-entity length]`; a length means an array field. */
const LAYOUT: Readonly<Record<string, readonly [string, string, number?][]>> = {
  Body: [
    ["hp", "Float32Array", MAX_BODY_PARTS],
    ["wound", "Uint8Array", MAX_BODY_PARTS],
    ["clot", "Float32Array", MAX_BODY_PARTS],
    ["blood", "Float32Array"],
    ["bloodMax", "Float32Array"],
    ["seen", "Float32Array"],
    ["lost", "Uint16Array"],
  ],
  Injury: [
    ["bits", "Uint32Array"],
    ["move", "Float32Array"],
    ["stamina", "Float32Array"],
    ["flags", "Uint8Array"],
  ],
  Mana: [
    ["current", "Float32Array"],
    ["max", "Float32Array"],
  ],
};

describe("ES5c: the component seam", () => {
  it("keeps every moved component's layout, field for field", () => {
    for (const [name, fields] of Object.entries(LAYOUT)) {
      const store = ({ Body, Injury, Mana } as Record<string, Record<string, unknown>>)[name]!;
      assert.deepEqual(
        Object.keys(store).filter((k) => !k.startsWith("_")),
        fields.map(([field]) => field),
        `${name}'s fields, in order`,
      );
      for (const [field, kind, perEntity] of fields) {
        const value = store[field];
        if (perEntity === undefined) {
          assert.ok(ArrayBuffer.isView(value), `${name}.${field} should be a typed array`);
          const view = value as unknown as { constructor: { name: string }; length: number; buffer: ArrayBufferLike };
          assert.equal(view.constructor.name, kind, `${name}.${field}'s type`);
          assert.equal(view.length, SAB_ENTITY_CAPACITY, `${name}.${field}'s capacity`);
          assert.ok(view.buffer instanceof SharedArrayBuffer, `${name}.${field} should still be SAB-backed`);
        } else {
          const rows = value as unknown as ArrayLike<{ constructor: { name: string }; length: number; buffer: ArrayBufferLike }>;
          assert.equal(rows.length, SAB_ENTITY_CAPACITY, `${name}.${field}'s capacity`);
          assert.equal(rows[0]!.constructor.name, kind, `${name}.${field}'s type`);
          assert.equal(rows[0]!.length, perEntity, `${name}.${field}'s per-entity length`);
          assert.ok(rows[0]!.buffer instanceof SharedArrayBuffer, `${name}.${field} should still be SAB-backed`);
        }
      }
    }
  });

  it("keeps the constants that read those fields", () => {
    // The bits and flags mean nothing apart from the component they index.
    assert.equal(BLEEDING_BIT, 1 << 30);
    assert.equal(NO_JUMP, 1);
    assert.deepEqual(Wound, { None: 0, Cut: 1, Thrust: 2, Stump: 3 });
    assert.deepEqual([...PART_STATES], ["healthy", "harmed", "maimed", "dismembered"]);
    // 2 bits of state per part fill bits 0..29 of Injury.bits, and the
    // bleeding bit sits just above them: 15 parts is exactly what fits.
    assert.equal(MAX_BODY_PARTS * 2, 30);
    assert.equal(BLEEDING_BIT, 2 ** (MAX_BODY_PARTS * 2));
  });

  it("declares them in components.ts and nowhere else", () => {
    const components = ALL.find((f) => f.rel === "components.ts");
    assert.ok(components, "components.ts should exist");
    for (const name of MOVED) {
      assert.match(components.text, new RegExp(`export const ${name}\\b`), `components.ts should declare ${name}`);
      for (const f of ALL) {
        if (f.rel === "components.ts") continue;
        assert.doesNotMatch(f.text, new RegExp(`export const ${name}\\b`), `${f.rel} declares ${name} too`);
      }
    }
  });

  it("is what the engine's own tick reads, so the systems can leave", () => {
    for (const f of ALL) {
      for (const m of f.text.matchAll(/import[^;]*?from "([^"]+)"/g)) {
        const spec = m[1] as string;
        if (!/\b(body|magic)\.js$/.test(spec)) continue;
        for (const name of MOVED) {
          assert.doesNotMatch(
            m[0] as string,
            new RegExp(`\\b${name}\\b`),
            `${f.rel} reads ${name} from ${spec}; it is engine data now, so it comes from components.js`,
          );
        }
      }
    }
  });

  it("keeps the engine's public exports where they were", () => {
    const index = ALL.find((f) => f.rel === "index.ts")!;
    for (const name of MOVED) {
      assert.match(index.text, new RegExp(`\\b${name}\\b`), `the package index should still export ${name}`);
    }
  });
});
