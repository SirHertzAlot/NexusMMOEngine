/**
 * The dungeon bake document's host side: the route that applies one op to a
 * document and the route that bakes it. Both are pure functions over the
 * request body; the geometry addon is loaded here (node only) and passed in,
 * so the browser bundle never imports it. host.ts wires them to
 *
 *   POST /api/editor/bake-doc/op    {doc, op}   → {doc}
 *   POST /api/editor/bake-doc/bake  {doc, why}  → {view, provenance}
 *
 * A refused op or bake answers 400 with the reason.
 */
import { createRequire } from "node:module";
import { applyOp, bakeDoc, type BakeView, type DocOp, type DungeonBakeDoc, type Provenance } from "./inspectors/dungeon-bake-doc.js";
import type { GeometryOps } from "@mmo-engine/dungeon";

export class BakeDocError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BakeDocError";
  }
}

function docOf(body: unknown): DungeonBakeDoc {
  const doc = (body as { doc?: unknown } | null)?.doc;
  if (!doc || typeof doc !== "object") throw new BakeDocError("request needs a doc");
  return doc as DungeonBakeDoc;
}

/** Apply one op to the document in the body. */
export function docOpRoute(body: unknown): { doc: DungeonBakeDoc } {
  const op = (body as { op?: unknown } | null)?.op;
  if (!op || typeof op !== "object") throw new BakeDocError("request needs an op");
  try {
    return { doc: applyOp(docOf(body), op as DocOp) };
  } catch (err) {
    throw new BakeDocError((err as Error).message);
  }
}

/** Bake the document in the body. `geo` is the geometry addon; `now` stamps the provenance. */
export function bakeRoute(body: unknown, geo: GeometryOps, now: Date): { view: BakeView; provenance: Provenance } {
  const why = (body as { why?: unknown } | null)?.why;
  try {
    const { view, provenance } = bakeDoc(docOf(body), geo, { who: "editor", why: typeof why === "string" ? why : "bake", now });
    return { view, provenance };
  } catch (err) {
    throw new BakeDocError((err as Error).message);
  }
}

/** The geometry addon, loaded for the host process only. */
export function loadGeometry(): GeometryOps {
  return createRequire(import.meta.url)("@mmo-engine/addon-geometry") as GeometryOps;
}
