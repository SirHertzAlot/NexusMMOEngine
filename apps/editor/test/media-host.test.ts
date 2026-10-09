/** Media host: six fixed documents, validated saves, refused saves write nothing, references between documents are kept. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AudioDoc, GameContent } from "@mmo-engine/art";
import { handleMediaRoute } from "../src/media-host.js";

const repoContent = fileURLToPath(new URL("../../../../content", import.meta.url));
/** A scratch repo with a copy of the real media content. */
function fakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "mmo-media-test-"));
  for (const d of ["combat", "animation", "vfx", "materials", "audio"]) cpSync(join(repoContent, d), join(root, "content", d), { recursive: true });
  return root;
}
const get = (root: string, name = ""): { status: number; body: any } => handleMediaRoute(root, "GET", `/api/editor/media${name && `/${name}`}`, undefined) as never;
const put = (root: string, name: string, content: unknown): { status: number; body: any } =>
  handleMediaRoute(root, "PUT", `/api/editor/media/${name}`, JSON.stringify({ content })) as never;
const disk = (root: string, rel: string): string => readFileSync(join(root, "content", rel), "utf8");

describe("media routes", () => {
  it("ignores other paths and unknown names", () => {
    assert.equal(handleMediaRoute("x", "GET", "/api/editor/flow", undefined), null);
    assert.equal(get("x", "secrets").status, 404);
    assert.equal(get("x", "../../etc/passwd").status, 404);
  });

  it("GET returns one document, or all of them for the game view", () => {
    const root = fakeRepo();
    assert.equal(get(root, "combat").body.content.moves.length, 8);
    const all = get(root).body.content as GameContent;
    assert.ok(all.combat && all.animation && all.vfx && all.tiers && all.materials && all.audio);
    rmSync(root, { recursive: true });
  });

  it("saves a valid edit, nothing else changes, no temp files are left", () => {
    const root = fakeRepo();
    const doc = get(root, "combat").body.content;
    doc.moves[0].hitAt = 0.25;
    assert.equal(put(root, "combat", doc).status, 200);
    assert.equal(JSON.parse(disk(root, "combat/moves.json")).moves[0].hitAt, 0.25);
    assert.deepEqual(readdirSync(join(root, "content", "combat")), ["moves.json"]);
    rmSync(root, { recursive: true });
  });

  it("a refused save answers 400 with the problems and writes nothing", () => {
    const root = fakeRepo();
    const before = disk(root, "animation/animations.json");
    const doc = get(root, "animation").body.content;
    doc.locomotion.ground[2].from = 0.1;
    doc.locomotion.fade = 9;
    const r = put(root, "animation", doc);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.issues.map((i: { path: string }) => i.path).sort(), ["locomotion.fade", "locomotion.ground[2].from"]);
    assert.equal(disk(root, "animation/animations.json"), before);
    assert.equal(handleMediaRoute(root, "PUT", "/api/editor/media/animation", "not json")?.status, 400);
    rmSync(root, { recursive: true });
  });

  it("refuses removing an audio event a move or a surface still plays; allows it once they stop", () => {
    const root = fakeRepo();
    const audio = get(root, "audio").body.content as AudioDoc;
    const without = (id: string): AudioDoc => {
      const a = structuredClone(audio);
      delete a.events[id];
      return a;
    };
    const r = put(root, "audio", without("swing"));
    assert.equal(r.status, 400);
    assert.ok(r.body.issues.some((i: { path: string }) => i.path.startsWith("combat: moves[")));
    const rock = put(root, "audio", without("step.rock"));
    assert.ok(rock.body.issues.some((i: { path: string }) => i.path === "materials: surfaces.rock.footstep"));
    // Point the moves at a different event first, then it can go.
    const moves = get(root, "combat").body.content;
    for (const m of moves.moves) if (m.sound?.start === "swing") m.sound.start = "dodge";
    assert.equal(put(root, "combat", moves).status, 200);
    assert.equal(put(root, "audio", without("swing")).status, 200);
    rmSync(root, { recursive: true });
  });

  it("saving a move that names a missing audio event is refused", () => {
    const root = fakeRepo();
    const moves = get(root, "combat").body.content;
    moves.moves[0].sound = { start: "nonesuch" };
    const r = put(root, "combat", moves);
    assert.equal(r.status, 400);
    assert.match(r.body.issues[0].message, /no audio event "nonesuch"/);
    rmSync(root, { recursive: true });
  });

  it("vfx and tiers: a rate over a tier's budget is allowed (the panel warns), a bad colour is not", () => {
    const root = fakeRepo();
    const vfx = get(root, "vfx").body.content;
    vfx.effects.embers.rate = 4000;
    assert.equal(put(root, "vfx", vfx).status, 200);
    vfx.effects.embers.color = ["red", "#ff0000"];
    assert.equal(put(root, "vfx", vfx).status, 400);
    rmSync(root, { recursive: true });
  });
});
