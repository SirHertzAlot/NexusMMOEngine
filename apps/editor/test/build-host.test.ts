/**
 * TDD: editor build host (EA19 pipeline view).
 *
 * Pure logic with an injected pipeline runner: list profiles, start a
 * run in the background, poll its stage-by-stage status, keep run
 * history. No processes or sockets here — the host.ts wiring adds those.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBuildHost, type Deployer, type PipelineRunner } from "../src/build-host.js";
import type { BuildProfile, StageResult } from "@mmo-engine/build";

function profile(name = "default"): BuildProfile {
  return {
    name,
    stages: [
      { id: "codegen", command: "npm run codegen", inputs: [] },
      { id: "build", command: "npm run build", inputs: [] },
    ],
  };
}

function makeRunner(results: StageResult[]): PipelineRunner & { calls: number } {
  const r = async (
    _root: string,
    _p: BuildProfile,
    onStage: (s: StageResult) => void,
  ): Promise<void> => {
    r.calls++;
    for (const s of results) onStage(s);
  };
  r.calls = 0;
  return r as PipelineRunner & { calls: number };
}

const okDeploy: Deployer = async () => ({ ok: true, rolledBack: false });

function hostOpts(over: Partial<Parameters<typeof createBuildHost>[0]> = {}) {
  return {
    rootDir: "/r",
    profiles: [profile()],
    runner: makeRunner([]),
    deployer: okDeploy,
    ...over,
  };
}

const okResults: StageResult[] = [
  { id: "codegen", skipped: true, exitCode: null, ms: 0 },
  { id: "build", skipped: false, exitCode: 0, ms: 1200 },
];
const failResults: StageResult[] = [
  { id: "codegen", skipped: false, exitCode: 0, ms: 100 },
  { id: "build", skipped: false, exitCode: 1, ms: 200 },
];

describe("createBuildHost", () => {
  it("lists the profiles it was given", () => {
    const h = createBuildHost(hostOpts({ profiles: [profile("a"), profile("b")] }));
    assert.deepEqual(h.listProfiles().map((p) => p.name), ["a", "b"]);
  });

  it("a run records stages and ends passed", async () => {
    const h = createBuildHost(hostOpts({ runner: makeRunner(okResults) }));
    const rec = h.startRun("default");
    assert.equal(rec.status, "running");
    await h.waitFor(rec.id);
    const done = h.getRun(rec.id)!;
    assert.equal(done.status, "passed");
    assert.deepEqual(done.stages.map((s) => [s.id, s.status]), [["codegen", "skipped"], ["build", "passed"]]);
  });

  it("a failing stage marks the run failed", async () => {
    const h = createBuildHost(hostOpts({ runner: makeRunner(failResults) }));
    const rec = h.startRun("default");
    await h.waitFor(rec.id);
    assert.equal(h.getRun(rec.id)!.status, "failed");
  });

  it("rejects an unknown profile", () => {
    const h = createBuildHost(hostOpts());
    assert.throws(() => h.startRun("nope"), /unknown profile/);
  });

  it("rejects a second run while one is in progress", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = () => res()));
    const h = createBuildHost(hostOpts({ runner: (() => gate) as PipelineRunner }));
    const rec = h.startRun("default");
    assert.throws(() => h.startRun("default"), /already running/);
    release();
    await h.waitFor(rec.id);
  });

  it("keeps run history, newest first, bounded", async () => {
    const h = createBuildHost(hostOpts({ runner: makeRunner(okResults), maxRuns: 3 }));
    for (let i = 0; i < 5; i++) await h.waitFor(h.startRun("default").id);
    const runs = h.listRuns();
    assert.equal(runs.length, 3);
    assert.ok(runs[0]!.startedAt >= runs[1]!.startedAt, "newest first");
  });

  it("getRun returns null for an unknown id", () => {
    const h = createBuildHost(hostOpts());
    assert.equal(h.getRun("nope"), null);
  });

  it("a run that throws marks the run failed, not the host", async () => {
    const bad: PipelineRunner = async () => {
      throw new Error("boom");
    };
    const h = createBuildHost(hostOpts({ runner: bad }));
    const rec = h.startRun("default");
    await h.waitFor(rec.id);
    const done = h.getRun(rec.id)!;
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /boom/);
  });
});

describe("deploy", () => {
  function waitDeploy(h: ReturnType<typeof createBuildHost>): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (h.getDeploy().status !== "running") {
          clearInterval(t);
          resolve();
        }
      }, 10);
    });
  }

  it("starts idle, runs, and reports ok", async () => {
    const h = createBuildHost(hostOpts());
    assert.equal(h.getDeploy().status, "idle");
    h.startDeploy(7777);
    assert.equal(h.getDeploy().status, "running");
    await waitDeploy(h);
    const d = h.getDeploy();
    assert.equal(d.status, "ok");
    assert.equal(d.rolledBack, false);
    assert.ok(d.finishedAt);
  });

  it("reports a failed deploy with rollback", async () => {
    const h = createBuildHost(hostOpts({ deployer: async () => ({ ok: false, rolledBack: true }) }));
    h.startDeploy(7777);
    await waitDeploy(h);
    const d = h.getDeploy();
    assert.equal(d.status, "failed");
    assert.equal(d.rolledBack, true);
  });

  it("a throwing deployer marks the deploy failed", async () => {
    const h = createBuildHost(hostOpts({ deployer: async () => { throw new Error("nope"); } }));
    h.startDeploy(7777);
    await waitDeploy(h);
    const d = h.getDeploy();
    assert.equal(d.status, "failed");
    assert.match(d.error ?? "", /nope/);
  });

  it("rejects a second deploy while one is running", async () => {
    let release!: () => void;
    const gate = new Promise<{ ok: boolean; rolledBack: boolean }>((res) => (release = () => res({ ok: true, rolledBack: false })));
    const h = createBuildHost(hostOpts({ deployer: () => gate }));
    h.startDeploy(7777);
    assert.throws(() => h.startDeploy(7777), /already running/);
    release();
    await waitDeploy(h);
  });
});
