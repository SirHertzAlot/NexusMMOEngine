/** Problems aggregation: every validator the host has, as {source,file,severity,message}. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectProblems, handleProblemsRoute } from "../src/problems-host.js";
import { problemLink } from "../src/problems-client.js";
import { validateHudLayout } from "../src/ui/hud-editor-logic.js";

const REPO = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));
function fakeRepo(): string {
  const root = join(tmpdir(), `mmo-problems-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  cpSync(join(REPO, "content"), join(root, "content"), { recursive: true });
  return root;
}
const put = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const BAD_FLOW = JSON.stringify({ version: 1, start: "nope", nodes: {}, edges: [] });

describe("problems", () => {
  it("shipped flow, hud, scenes and strings have no errors", async () => {
    const root = fakeRepo();
    const ps = await collectProblems(root);
    const own = ["flow", "hud", "scenes", "strings", "build"];
    assert.deepEqual(ps.filter((p) => p.severity === "error" && own.includes(p.source)), []);
    rmSync(root, { recursive: true });
  });
  it("reports a broken flow, hud, scene, build profile and playtest under their sources", async () => {
    const root = fakeRepo();
    put(join(root, "content/flow/game.flow.json"), BAD_FLOW);
    put(join(root, "content/ui/hud.json"), JSON.stringify({ widgets: { a: { anchor: "nowhere" } } }));
    put(join(root, "content/scenes/bad.scene.json"), JSON.stringify({ nonsense: true }));
    put(join(root, "content/build/profiles/broken.json"), "{ not json");
    put(join(root, "content/playtests/oops.json"), JSON.stringify({ version: 2 }));
    const ps = await collectProblems(root);
    for (const source of ["flow", "hud", "scenes", "build"]) {
      const hit = ps.find((p) => p.source === source && p.severity === "error");
      assert.ok(hit, `${source} problem`);
      assert.ok(hit.file.length > 0 && hit.message.length > 0);
    }
    assert.ok(ps.find((p) => p.source === "scenes")?.file.includes("bad"));
    // An error when the playtest package is built, a "could not run" warning when it is not.
    assert.ok(ps.some((p) => p.source === "playtest"));
    rmSync(root, { recursive: true });
  });
  it("a collector that throws becomes one warning and the rest still run", async () => {
    const ps = await collectProblems("/nowhere", [
      ["flow", () => { throw new Error("boom"); }],
      ["hud", () => [{ source: "hud", file: "f", severity: "error", message: "m" }]],
    ]);
    assert.equal(ps.length, 2);
    assert.equal(ps[0].severity, "warning");
    assert.match(ps[0].message, /boom/);
    assert.equal(ps[1].source, "hud");
  });
  it("route: GET answers problems and counts, other paths fall through", async () => {
    const root = fakeRepo();
    put(join(root, "content/flow/game.flow.json"), BAD_FLOW);
    assert.equal(await handleProblemsRoute(root, "GET", "/api/editor/other"), null);
    assert.equal((await handleProblemsRoute(root, "POST", "/api/editor/problems"))?.status, 404);
    const r = await handleProblemsRoute(root, "GET", "/api/editor/problems");
    const b = r?.body as { ok: boolean; problems: unknown[]; errors: number; warnings: number };
    assert.equal(r?.status, 200);
    assert.ok(b.ok && b.errors >= 1 && b.problems.length >= b.errors);
    rmSync(root, { recursive: true });
  });
  it("every source links to a workspace view", () => {
    assert.equal(problemLink({ source: "flow" }), "#/flow/flow");
    assert.equal(problemLink({ source: "vfx" }), "#/artaudio/vfx");
    assert.equal(problemLink({ source: "build" }), "#/release/pipeline");
  });
});

describe("validateHudLayout", () => {
  it("accepts a layout and names each bad widget", () => {
    assert.deepEqual(validateHudLayout({ widgets: { a: { anchor: "center", offset: { x: 1, y: 2 }, visible: true } } }), []);
    assert.equal(validateHudLayout([]).length, 1);
    assert.equal(validateHudLayout({ widgets: { a: { anchor: "x", offset: { x: "1", y: 2 }, visible: 1 } } }).length, 3);
  });
});
