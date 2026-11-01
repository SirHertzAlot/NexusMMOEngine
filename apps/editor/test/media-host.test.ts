/** Media host: three fixed documents, validated saves, refused saves write nothing, audio references are kept. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameContent } from "@mmo-engine/art";
import { handleMediaRoute } from "../src/media-host.js";

const repoContent = fileURLToPath(new URL("../../../../content", import.meta.url));
/** A scratch repo with a copy of the real content. */
function fakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "mmo-media-test-"));
  for (const d of ["combat", "animation", "materials", "audio"]) cpSync(join(repoContent, d), join(root, "content", d), { recursive: true });
  return root;
}
type Reply = { status: number; body: any };
const json = "application/json";
const get = async (root: string, name = ""): Promise<Reply> => (await handleMediaRoute(root, "GET", `/api/editor/media${name && `/${name}`}`, undefined, async () => "")) as never;
const put = async (root: string, name: string, content: unknown, type: string | undefined = json): Promise<Reply> =>
  (await handleMediaRoute(root, "PUT", `/api/editor/media/${name}`, type, async () => JSON.stringify({ content }))) as never;
const disk = (root: string, rel: string): string => readFileSync(join(root, "content", rel), "utf8");

describe("media routes", () => {
  it("ignores other paths and unknown names", async () => {
    assert.equal(await handleMediaRoute("x", "GET", "/api/editor/flow", undefined, async () => ""), null);
    assert.equal((await get("x", "secrets")).status, 404);
    assert.equal((await get("x", "../../etc/passwd")).status, 404);
    assert.equal((await get("x", "vfx")).status, 404, "particle effects have their own host");
  });

  it("GET returns one document, or all of them for the game view", async () => {
    const root = fakeRepo();
    assert.equal((await get(root, "combat")).body.content.moves.length, (JSON.parse(disk(root, "combat/moves.json")) as { moves: unknown[] }).moves.length);
    const all = (await get(root)).body.content as GameContent;
    assert.ok(all.combat && all.animation && all.materials);
    rmSync(root, { recursive: true });
  });

  it("saves a valid edit, nothing else changes, no temp files are left", async () => {
    const root = fakeRepo();
    const doc = (await get(root, "combat")).body.content;
    doc.moves[0].hitAt = 0.25;
    assert.equal((await put(root, "combat", doc)).status, 200);
    assert.equal(JSON.parse(disk(root, "combat/moves.json")).moves[0].hitAt, 0.25);
    assert.deepEqual(readdirSync(join(root, "content", "combat")).sort(), readdirSync(join(repoContent, "combat")).sort(), "no temp files left beside the copied content");
    rmSync(root, { recursive: true });
  });

  it("a refused save answers 400 with the problems and writes nothing", async () => {
    const root = fakeRepo();
    const before = disk(root, "animation/animations.json");
    const doc = (await get(root, "animation")).body.content;
    doc.locomotion.ground[2].from = 0.1;
    doc.locomotion.fade = 9;
    const r = await put(root, "animation", doc);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.issues.map((i: { path: string }) => i.path).sort(), ["locomotion.fade", "locomotion.ground[2].from"]);
    assert.equal(disk(root, "animation/animations.json"), before);
    assert.equal((await handleMediaRoute(root, "PUT", "/api/editor/media/animation", json, async () => "not json"))?.status, 400);
    assert.equal((await put(root, "animation", doc, "text/plain")).status, 415);
    rmSync(root, { recursive: true });
  });

  it("refuses a move that names a missing audio event, and a surface whose footstep is gone", async () => {
    const root = fakeRepo();
    const moves = (await get(root, "combat")).body.content;
    moves.moves[0].sound = { start: "nonesuch" };
    const r = await put(root, "combat", moves);
    assert.equal(r.status, 400);
    assert.match(r.body.issues[0].message, /no audio event "nonesuch"/);
    const mat = (await get(root, "materials")).body.content;
    mat.surfaces.grass.footstep = "nonesuch";
    const m = await put(root, "materials", mat);
    assert.equal(m.status, 400);
    assert.equal(m.body.issues[0].path, "materials: surfaces.grass.footstep");
    rmSync(root, { recursive: true });
  });

  it("an old dangling name does not block an unrelated edit", async () => {
    const root = fakeRepo();
    const mat = (await get(root, "materials")).body.content;
    mat.surfaces.grass.footstep = "nonesuch";
    // Put it on disk behind the host's back (as an older editor might have), then edit something else.
    writeFileSync(join(root, "content", "materials", "materials.json"), JSON.stringify(mat));
    mat.footstepStride = 2;
    assert.equal((await put(root, "materials", mat)).status, 200);
    rmSync(root, { recursive: true });
  });
});
