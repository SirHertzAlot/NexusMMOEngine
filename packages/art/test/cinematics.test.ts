import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CinematicDefSchema,
  CinematicBundleManifestSchema,
  RecordedFinalSampleSchema,
  MAX_CINEMATIC_BUNDLE_BYTES,
  validateCinematicBundle,
} from "../src/cinematics/index.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function marketStallFixture() {
  const def = CinematicDefSchema.parse({
    id: "market-stall-collapse",
    title: "Market Stall Collapse (C1 Showcase)",
    kind: "baked",
    durationCapSec: 6.5,
    actorSlots: [],
    props: [
      { prop: "stall-frame", kind: "dynamic" },
      { prop: "produce-crates", kind: "breakable-cosmetic" },
      { prop: "cobble-plinth", kind: "static" },
    ],
    stage: { anchor: [12, 0, -8], radiusM: 5 },
    beats: [
      { tSec: 0, durationSec: 2, type: "camera", payload: { mode: "fixed", target: "stall-frame" } },
      { tSec: 0.4, type: "audio", payload: { cue: "wood-creak" } },
      { tSec: 1.1, durationSec: 0.4, type: "shake", payload: { intensity: 0.4 } },
    ],
    entryPoses: {},
    exitPoses: {
      "stall-frame": { position: [12.4, 0.12, -8.2], yaw: 1.55 },
    },
    preVerbs: [{ verb: "setWorldFlag", args: { flag: "market.stall.intact", value: false } }],
    postVerbs: [{ verb: "destroyFixture", args: { fixtureId: "market-stall-01" } }],
    provenance: {
      who: "art-pipeline",
      what: "Props-only MuJoCo market stall collapse showcase",
      when: "2026-11-13",
      where: "content/cinematics/market-stall-collapse/",
      why: "C1 end-to-end props-only proof",
      how: "Offline mj-bake fixed-step simulation",
    },
  });

  const trackSha = hash("mj-track-v1");
  const manifest = CinematicBundleManifestSchema.parse({
    version: 1,
    id: "market-stall-collapse",
    bundleHash: hash("bundle-v1"),
    mjcfVersion: "3.2.7",
    sourceHashes: { "scene.mjcf.xml": hash("<mujoco/>") },
    trackHash: trackSha,
    secondBakeTrackHash: trackSha,
    compressedBytes: 184_320,
    durationSec: 4.8,
    propTrackFile: "proptracks.bin",
    sourceLicenses: ["Apache-2.0 (MuJoCo)", "CC0-1.0 (Nexus props)"],
  });

  const recording = RecordedFinalSampleSchema.parse({
    frames: 144,
    sampleRateHz: 30,
    durationSec: 4.8,
    propFinalPoses: {
      "stall-frame": { position: [12.41, 0.12, -8.19], yaw: 1.54 },
    },
  });

  return { def, manifest, recording };
}

describe("Cutscene Lane C0 schemas and bake gates", () => {
  it("validates props-only market stall collapse bundle when all gates pass", () => {
    const { def, manifest, recording } = marketStallFixture();
    const res = validateCinematicBundle({
      def,
      manifest,
      recording,
      knownVerbs: new Set(["setWorldFlag", "destroyFixture"]),
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.gates, {
      reproducibility: true,
      clipValidity: true,
      arrival: true,
      duration: true,
      bundleBudget: true,
      license: true,
    });
  });

  it("enforces live fallbackBakedId, sorted non-overlapping exclusive beats, and caps", () => {
    const validEntry = { position: [0, 0, 0] as [number, number, number], yaw: 0 };
    assert.throws(() =>
      CinematicDefSchema.parse({
        ...marketStallFixture().def,
        kind: "live",
        durationCapSec: 10,
      }),
      /fallbackBakedId/,
    );
    assert.throws(() =>
      CinematicDefSchema.parse({
        ...marketStallFixture().def,
        beats: [
          { tSec: 0.5, durationSec: 2, type: "camera", payload: {} },
          { tSec: 1.5, durationSec: 1, type: "camera", payload: {} },
        ],
      }),
      /overlapping camera beat/,
    );
    assert.throws(() =>
      CinematicDefSchema.parse({
        ...marketStallFixture().def,
        actorSlots: [{ slot: "hero", rigFamily: "humanoid", requiredComponents: [] }],
        entryPoses: { hero: validEntry },
        exitPoses: {},
      }),
      /missing exitPose/,
    );
  });

  it("blocks reproducibility, clip validity, arrival drift, duration, and 2 MB budget violations", () => {
    const base = marketStallFixture();

    const reproFail = validateCinematicBundle({
      ...base,
      manifest: { ...base.manifest, secondBakeTrackHash: hash("diverged-track") },
    });
    assert.equal(reproFail.ok, false);
    assert.equal(reproFail.gates.reproducibility, false);

    const clipFail = validateCinematicBundle({
      ...base,
      recording: { ...base.recording, hasNonFiniteSamples: true, jointLimitViolations: 2 },
    });
    assert.equal(clipFail.ok, false);
    assert.equal(clipFail.gates.clipValidity, false);

    const arrivalFail = validateCinematicBundle({
      ...base,
      recording: {
        ...base.recording,
        propFinalPoses: { "stall-frame": { position: [14.0, 0.12, -8.2], yaw: 1.55 } },
      },
    });
    assert.equal(arrivalFail.ok, false);
    assert.equal(arrivalFail.gates.arrival, false);

    const budgetFail = validateCinematicBundle({
      ...base,
      manifest: { ...base.manifest, compressedBytes: MAX_CINEMATIC_BUNDLE_BYTES + 1 },
    });
    assert.equal(budgetFail.ok, false);
    assert.equal(budgetFail.gates.bundleBudget, false);
  });
});
