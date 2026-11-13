/**
 * The dungeon bake's editor document, as pure TypeScript: the layout mask
 * the author paints, its portals, the theme, and per-layer edits. Each edit
 * is an op that returns a new document; a bake turns the document into the
 * shell and dressing (packages/dungeon bakeCrypt) and a view summary the
 * panel shows. Nothing here draws or touches the disk: the geometry addon
 * comes in as a parameter, so the module runs in the browser and in tests.
 *
 * Provenance (who, what, when, where, why, how) rides on every bake, so a
 * baked object says what made it.
 */
import { parseDetailLayer, type DetailLayer } from "@mmo-engine/art/browser";
import type { DocOp, DungeonBakeDoc } from "./dungeon-bake-types.js";
export { emptyDoc, type DocOp, type DungeonBakeDoc, type LayerEdit, type PaintCell, type PortalSpec } from "./dungeon-bake-types.js";
import {
  bakeCrypt,
  CRYPT_THEMES,
  layoutPortals,
  parseLayoutMask,
  SHELL_PARTS,
  type CryptBake,
  type GeometryOps,
  type PortalKind,
} from "@mmo-engine/dungeon";

/** Apply one op. Returns a new document; throws with the reason when the op is not allowed. */
export function applyOp(doc: DungeonBakeDoc, op: DocOp): DungeonBakeDoc {
  switch (op.op) {
    case "paint": {
      const H = doc.rows.length, W = doc.rows[0].length;
      if (op.x < 0 || op.y < 0 || op.x >= W || op.y >= H) throw new Error(`paint: ${op.x},${op.y} is off the ${W} × ${H} mask`);
      if (op.x === doc.entrance.x && op.y === doc.entrance.y && op.cell !== ".") throw new Error("paint: the entrance must stay floor");
      const rows = doc.rows.map((r, y) => (y === op.y ? r.slice(0, op.x) + op.cell + r.slice(op.x + 1) : r));
      // Painting rock over a portal would leave the portal beside nothing; drop it with the cell.
      const portals = op.cell === "#" ? doc.portals.filter((p) => !(p.x === op.x && p.y === op.y)) : doc.portals;
      return parseDoc({ ...doc, rows, portals });
    }
    case "placePortal": {
      if (doc.portals.some((p) => p.id === op.portal.id)) throw new Error(`portal: id ${op.portal.id} is taken`);
      return parseDoc({ ...doc, portals: [...doc.portals, { kind: "door", ...op.portal }] });
    }
    case "removePortal":
      return { ...doc, portals: doc.portals.filter((p) => p.id !== op.id) };
    case "setTheme": {
      if (!CRYPT_THEMES[op.theme]) throw new Error(`theme: ${op.theme} is not a theme`);
      return { ...doc, theme: op.theme };
    }
    case "editLayer": {
      const layer = CRYPT_THEMES[doc.theme].layers.find((l) => l.id === op.layer);
      if (!layer) throw new Error(`layer: ${op.layer} is not in ${doc.theme}`);
      if (op.field === "density" && (op.value < 0 || op.value > 1)) throw new Error("density: 0 to 1");
      if (op.field === "budget" && (!Number.isInteger(op.value) || op.value < 0)) throw new Error("budget: a whole number, 0 or more");
      return { ...doc, layerEdits: { ...doc.layerEdits, [op.layer]: { ...doc.layerEdits[op.layer], [op.field]: op.value } } };
    }
  }
}

/** Check a document the way the bake will, so a bad edit is refused at the edit, not at the bake. */
function parseDoc(doc: DungeonBakeDoc): DungeonBakeDoc {
  parseLayoutMask({ version: 1, rows: doc.rows, entrance: doc.entrance, portals: doc.portals });
  return doc;
}

export interface Provenance {
  who: string;
  what: string;
  when: string;
  where: string;
  why: string;
  how: { theme: string; layers: string[] };
}

export interface BakeView {
  triangles: number;
  partCounts: Record<(typeof SHELL_PARTS)[number], number>;
  floorArea: number;
  portals: Array<{ id: string; kind: PortalKind; x: number; y: number }>;
  layers: Array<{ layer: string; placed: number }>;
}

export interface DocBake {
  bake: CryptBake;
  view: BakeView;
  provenance: Provenance;
}

/** The theme with the document's layer edits applied (each edit re-validated as a layer). */
function themeOf(doc: DungeonBakeDoc) {
  const theme = CRYPT_THEMES[doc.theme];
  const layers: DetailLayer[] = theme.layers.map((l) => {
    const edit = doc.layerEdits[l.id];
    return edit ? parseDetailLayer({ ...l, ...edit }) : l;
  });
  return { ...theme, layers };
}

/** Bake the document. `who` and `why` are the author and the reason, from the caller; `now` makes the bake's time deterministic. */
export function bakeDoc(doc: DungeonBakeDoc, geo: GeometryOps, ctx: { who: string; why: string; now: Date }): DocBake {
  const checked = parseDoc(doc);
  const theme = themeOf(checked);
  const bake = bakeCrypt({ version: 1, rows: checked.rows, entrance: checked.entrance, portals: checked.portals }, theme, geo);
  const partCounts = Object.fromEntries(SHELL_PARTS.map((p) => [p, 0])) as BakeView["partCounts"];
  for (const p of bake.shell.parts) partCounts[SHELL_PARTS[p]]++;
  const view: BakeView = {
    triangles: bake.shell.stats.triangles,
    partCounts,
    floorArea: bake.shell.stats.floorArea,
    portals: layoutPortals({ version: 1, rows: checked.rows, entrance: checked.entrance, portals: checked.portals }).map((p) => ({ id: p.id, kind: p.kind, x: p.x, y: p.y })),
    layers: bake.details.map((d) => ({ layer: d.layer, placed: d.placements.length })),
  };
  return {
    bake,
    view,
    provenance: {
      who: ctx.who,
      what: "dungeon bake (shell, layers)",
      when: ctx.now.toISOString(),
      where: checked.id,
      why: ctx.why,
      how: { theme: checked.theme, layers: theme.layers.map((l) => l.id) },
    },
  };
}
