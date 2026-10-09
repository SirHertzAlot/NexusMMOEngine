/** Problems aggregation: every validator the host already has, as {source,file,severity,message}. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectProblems, handleProblemsRoute } from "../src/problems-host.js";
import { historyFile } from "../src/playtest-host.js";

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
  it("shipped content has no errors in the sources that need no builds", async () => {
    const root = fakeRepo();
    const ps = await collectProblems(root, join(root, "data"));
    const own = ["flow", "hud", "scenes", "build", "playtest", "media"];
    assert.deepEqual(ps.filter((p) => p.severity === "error" && own.includes(p.source)), []);
    rmSync(root, { recursive: true });
  });
  it("reports a broken flow, scene, build profile and playtest under their sources", async () => {
    const root = fakeRepo();
    put(join(root, "content/flow/game.flow.json"), BAD_FLOW);
    put(join(root, "content/scenes/bad.scene.json"), JSON.stringify({ nonsense: true }));
    put(join(root, "content/build/broken.json"), "{ not json");
    put(join(root, "content/playtests/oops.playtest.json"), JSON.stringify({ version: 2 }));
    const ps = await collectProblems(root, join(root, "data"));
    for (const source of ["flow", "scenes", "build", "playtest"]) {
      const hit = ps.find((p) => p.source === source && p.severity === "error");
      assert.ok(hit, `${source} problem`);
      assert.ok(hit.file.length > 0 && hit.message.length > 0);
    }
    assert.ok(ps.find((p) => p.source === "scenes")?.file.includes("bad"));
    rmSync(root, { recursive: true });
  });
  it("a failed last playtest run is a problem", async () => {
    const root = fakeRepo();
    const data = join(root, "data");
    const run = { id: "r1", scenario: "smoke", at: "2026-01-01T00:00:00Z", mode: "run", ok: false, ticks: 1, wallMs: 1, results: [{ assertion: {}, label: "connected", ok: false, actual: "no" }], tickP99Ms: null };
    put(historyFile(data, "smoke"), JSON.stringify([run]));
    const ps = await collectProblems(root, data);
    assert.ok(ps.some((p) => p.source === "playtest" && p.file.includes("smoke") && /failed/i.test(p.message)));
    rmSync(root, { recursive: true });
  });
  it("route: GET answers problems and counts, other paths fall through", async () => {
    const root = fakeRepo();
    put(join(root, "content/flow/game.flow.json"), BAD_FLOW);
    const data = join(root, "data");
    assert.equal(await handleProblemsRoute(root, data, "GET", "/api/editor/other"), null);
    assert.equal((await handleProblemsRoute(root, data, "POST", "/api/editor/problems"))?.status, 404);
    const r = await handleProblemsRoute(root, data, "GET", "/api/editor/problems");
    const b = r?.body as { ok: boolean; problems: unknown[]; errors: number; warnings: number };
    assert.equal(r?.status, 200);
    assert.ok(b.ok && b.errors >= 1 && b.problems.length >= b.errors);
    rmSync(root, { recursive: true });
  });
});
