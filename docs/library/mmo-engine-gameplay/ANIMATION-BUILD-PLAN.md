# Animation Runtime — Build Plan (DRAFT)

**Date:** 2026-10-06 · **Status: DRAFT for Joey's review — not a directive to Claude.**
**Source of truth:** `ANIMATION-RUNTIME.md` (research + verdicts, same folder). This plan translates those verdicts into ordered build slices with acceptance gates. Anything here that contradicts the research doc or the repo is wrong — flag it, don't improvise.

**Repo anchor:** `~/workspace/nexus-engine/` (checked 2026-10-06; verify paths against the current commit before building — the plan names files that existed tonight, not a promise they haven't moved).

---

## Build order (dependencies)

```
A1 (wire contract) ──┬── A2 (held frames, client-only) ── A6 (foot IK)
                     │
                     └── A3 (ozz bake addon) ── A4 (acl compression)
                                                └── A5 (A-ANIM validators)
A1 + A2 ── A7 (animation LOD)
```

A2 can run in parallel with A3. A4 and A5 both hang off A3's bake surface. A7 needs the contract (A1) and the layered animator (A2).

---

## A1 — Anim-state wire contract (load-bearing; build first)

**What:** add the server→client animation contract to the wire, following the schema's documented additive convention.

- New FlatBuffers tables in `packages/schema/mmo_engine.fbs`, placed with the other additive component blocks:
  - `table AnimState { clip: uint32; start_tick: uint64; rate: float; layer_mask: uint8; }`
  - `table AnimStateBlock { entities: [uint64]; items: [AnimState]; }`
  - Append `animStates: AnimStateBlock;` to `Snapshot` and `Delta` — **appended, never reordered** (the schema file says it: "persisted snapshots decode by field id").
- `clip` is the id into the `animations.json` manifest (v2) — the client maps it onto its clip library. `layer_mask` selects Base/Action layers, matching the two-layer animator's contract.
- Server: the CharacterSystem (or its successor) owns clip *selection* — which clip, its start tick, playback rate. The client blends and renders; nothing on the client decides gameplay.
- Follow the `packages/protocol/src/locomotion.ts` pattern for the TS constants if layer-mask bits need naming.

**Acceptance:**
- Server emits anim-state changes; a client maps `clipId` onto its library and starts part-way through a clip to match `start_tick` (the animator's existing support for this is the proof the contract works).
- Measured bandwidth per anim-state change per character: a few bytes. Report the number.
- Hit detection still uses capsules + authored windows — write a test that fails if any server code path reads sampled bone positions. (Doc §1: "never bone data.")

---

## A2 — Held frames in the animator (client-only)

**What:** per-clip `holdFrames` quantize in `apps/client/src/render/character/character-animator.ts`.

- Sample the authored curve, then hold each pose for N render frames (Xrd's anime timing: game at 60 fps, character effectively at 20–30).
- **Hard rules from the doc:** held frames are presentation-track only — gameplay events fire on the unquantized timeline (the combat-timeline rule). Root motion stays unquantized: the capsule never stutters even when the pose holds. The combat-timeline validator must understand quantized clips so it doesn't flag them as broken.

**Acceptance:**
- Side-by-side capture: same clip, quantize on/off — character motion reads as intentional holds, not lag.
- Capsule/root-motion trajectory identical with quantize on vs. off (assert in test, not by eye).

---

## A3 — ozz-animation bake addon (N-API)

**What:** `packages/addons/animation/` following the exact shape of `packages/addons/physics` and `packages/addons/navigation` (`binding.gyp`, vendored `third_party/`, N-API surface, `test/`).

- Vendor ozz-animation (MIT) behind the bulk boundary — the Jolt precedent: narrow interface, boring where it should be boring.
- The existing `packages/art/src/convert/convert-animations.ts` + `retarget.ts` grow into this: retargeting, compression staging, and **root-motion extraction** run through ozz's offline toolchain via the addon. Extracted root motion lands in clip metadata the server reads.
- **Not adopted:** ozz's sample-framework renderers and importers. Assimp remains the sole file importer; the editor keeps its own UX.

**Acceptance:**
- Transition check: retargeted output bit-compares (or tolerance-compares, with the tolerance written down) against the current pipeline's output before the cutover.
- Measured bake time per clip, reported. Bake-time-only work stays out of the tick — verify no addon code path runs per-frame on the server.

**Open thread (do not skip):** the ozz-to-WASM comparison for the web client. Three.js `AnimationMixer` stays until a **measured** per-character CPU comparison at 100+ visible characters (WASM vs. mixer) says otherwise. "Do not migrate on faith; migrate on numbers." (Doc §2.1; open thread on the Guillaume Blanc page.)

---

## A4 — acl bake-time compression

**What:** Nicholas Frechette's acl (MIT) compresses clips at bake; the client decompresses the small hot path, or ozz consumes acl-compressed data — the two compose.

- **Tighter error tolerance than acl's defaults.** Stylized/held-frame art shows compression pops more than realistic motion (clean silhouettes). The tolerance is an authored value for this art direction, not acl's out-of-the-box number.

**Acceptance (the rubric gate):**
- Measured bytes-per-character at each quality tier, reported per tier.
- Error metrics within the authored tolerance at every tier.
- The `low` tier never regresses — a clip that passes at `low` today still passes after any compression change.

---

## A5 — A-ANIM bake validators (warnings-first)

**What:** every clip runs through five checks at bake time. Warnings first — promote to errors only when the false-positive rate is near zero.

- **A-LOOP:** loop-continuity — first/last frame pose delta under tolerance, else flag (the #1 locomotion pop cause).
- **A-ROOT:** root-motion validation — total displacement matches the clip's declared travel speed. (The animator scales playback to ground speed; a mismatch here *is* foot sliding.)
- **A-SLIDE:** foot-slide measurement — during contact phases, foot joint world velocity must be near zero. Reports mm/frame; fails above threshold.
- **A-BONES:** bone budget — skeleton joint count × expected on-screen characters vs. the per-tier CPU budget.
- **A-EVENTS:** every gameplay-relevant moment (hit frame, footstep, cancel window) has an authored event-track entry. "The animator never guesses when the sword hits."

**Acceptance:** the full existing clip library passes (or the failures are triaged with owner + date). New clips can't land failing A-EVENTS.

---

## A6 — Foot IK

**What:** two-bone IK for feet planting (and hand targets / aim/look-at as the same solvers where needed).

- Web client: implement the two solvers against the three.js skeleton in the character render path.
- Native side: ozz ships IK jobs — use them, don't re-derive the math.
- The doc calls foot planting **the locomotion quality gate**: without it, speed-scaled playback slides visibly, and no clip quality survives.

**Acceptance:** A-SLIDE (from A5) reports near-zero foot velocity during contact phases *in-engine*, not just on the authored clip — the validator and the runtime close the loop.

---

## A7 — Animation LOD (MMO necessity)

**What:** at MMO scale, animation is a CPU budget item.

- Distance-tiered sampling: far characters sample at reduced tick rates, skip the Action layer, and eventually freeze to a single pose impostor.
- Follow the FX-lab budget harness pattern: **measured milliseconds per 100 characters per tier**, not vibes.

**Acceptance:** a benchmark table — ms/100-chars at each LOD tier, on a stated machine — checked into the repo next to the LOD thresholds. Thresholds change only when the numbers do.

---

## Explicitly parked (do not build in this plan)

From the research doc's verdicts and §6 non-goals — recorded here so nobody re-litigates them mid-slice:

- **Motion matching** — parked with three documented blockers (0.5 GB+ memory, no mocap corpus for the rigs, unmeasured per-character search cost at MMO scale) and revisit conditions: a corpus exists, per-character CPU budget measured, Learned Motion Matching evaluated as the memory answer.
- **No mocap pipeline yet** — hand-keyed + retargeted clips are the content path.
- **No facial animation system in this pass** — bodies first; faces ride the DNA doc's SDF/blush machinery.
- **No ragdoll-physics integration yet** — Jolt is vendored; active ragdoll is a later slice with its own cost gate.

---

## Notes for the reviewer (Joey)

1. **Slice order is a proposal.** If Claude should take A2 (client-only) first while the ozz vendoring decision settles, the plan survives reordering — only A1 is genuinely load-bearing for the rest.
2. **The wire addition (A1) is the one irreversible-ish choice** — additive, but persisted snapshots decode by field id, so get the field list right the first time. `clip/start_tick/rate/layer_mask` is the doc's contract; adding a field later is fine, changing one is not.
3. **Cost gate reminder** (standing rule): A7's benchmark table and A4's bytes-per-character numbers are the cost/benefit evidence. If the numbers don't justify a slice, the slice waits.
4. This plan covers the animation-runtime domain only. Combat & ability system (the next ranked gap) will touch the same animator's Action layer and the combat timeline — expect a follow-on slice when that research lands.
