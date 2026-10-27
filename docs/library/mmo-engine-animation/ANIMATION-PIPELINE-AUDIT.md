# Animation Pipeline Audit — End to End, and Where It Breaks

**Status:** Audit, 2026-10-26, at Joey's direction (animation is critical
to the game's AAA demands; it must be end-to-end and robust). Every claim
below was verified against `origin/main` at `150e06ba` or the local asset
stores on this date. No code changed.
**Scope:** the full chain — clip sources → bake/convert → rig → server
authority → wire → client playback → editor — plus creatures, scale,
and visual verification.

## 1. The chain as it actually stands

| Link | State | Evidence |
|---|---|---|
| **Clip sources** | ⚠️ Local-only, per-machine | Sources live under git-ignored `assets/` (licences differ per source; some may not be redistributed). The committed `content/animation/animations.json` is **empty** (`sources: []`, `clips: []`). |
| **Convert / retarget** | ✅ Works, in TS | `convert:animations` (`packages/art/src/convert/`) retargets every source onto the Modular Fantasy Hero rig via the TS `Retargeter`, strips root motion into a reported `travel`, skips `_RM` duplicates, emits per-source GLBs + `animations.json` v3 with the locomotion graph. |
| **Native bake (ozz / acl)** | ❌ Stubs | `packages/art/src/animation-bake.ts`: `retargetClip` / `compressClip` / `validateClip` all **throw** "native addon not implemented." The TL5 contract + `docs/ANIMATION-BAKE-PIPELINE.md` exist; no N-API addon, no acl compression, no automated validation. |
| **Target rig** | ⚠️ One rig, asset-bound | Modular Fantasy Hero rig (modular parts bound by bone name, one mixer per character). It lives in the ignored assets, not the repo. There is no committed canonical `rig.glb`. |
| **Server authority** | ✅ Real | `packages/engine-core/src/animation.ts`: the server owns `(clipId, startTick, rate, layerMask)` — moves map to clips, locomotion derives from speed with rate scaling. Clients decide nothing. |
| **Wire / clip registry** | ✅ Real | Protocol `ClipId` enum; `content/animation/clips.json` maps ids → clip names with loop/fade. |
| **Client playback** | ✅ Real, merged | EA21 landed via PR #333: animouse `AnimationMachine` + `LinearBlendTree` locomotion, two layers (base + action, upper-body capable), playhead can start mid-clip to align with the server's `startTick`, `FootIk` (two-bone), footstep events (EA24) with a real audio consumer (`apps/client/src/audio/footsteps.ts`). Clips play in place; the server moves the character. |
| **Editor** | ✅ Exists | Animation host/client + library panel in `apps/editor`, with tests. |
| **Creatures** | ⚠️ Procedural only | Static animal meshes get a procedural 7-bone shape-cut rig + Froude gait table (merged). **Skeletal creature animation does not exist**: all 73 Mesh2Motion creature clips graded *reject* for one reason — there are no creature rigs to retarget onto. |
| **Clip corpus** | ⚠️ Graded, not ingested | Mesh2Motion: 251 clips / 18 MB / CC0 at `~/workspace/mesh2motion-assets/` (outside the repo). Human library graded **175 pass / 3 fix / 0 reject** (bake-side `Retargeter`, mannequin map). Not wired as a convert source in any committed, reproducible way. |

**The one-sentence verdict:** the *runtime* half of the chain — server
authority, wire, client playback, IK, events — is genuinely built and
merged. The *supply* half — sources, reproducibility, compression,
validation, creatures, scale proof — is where every break lives. The
animation stage is a strong engine with an unproven fuel line.

## 2. The breaks, ranked

**B1. The library build is not reproducible.** `convert-animations`
"converts what it has": missing sources are *skipped silently*, per
machine. Two machines produce two different animation libraries, and CI
produces none (assets are git-ignored). For a stage Joey calls critical,
the library must be a *pinned, checkable artifact*: source manifest with
hashes, an expected-clip inventory, and a convert that **fails loud**
when a source is missing or a clip vanishes — the same fail-loud
discipline the settlement bake already uses.

**B2. Two retargeters, two bone maps.** The graded, trusted path is the
bake-side TS `Retargeter` (mannequin map). The client-side utility
(`apps/client/src/render/character/retarget.ts`, from EA21) finds only
**16 of 66 bones** on Mesh2Motion clips. Divergent maps are a silent-
corruption risk: the same clip can retarget differently depending on
which path touched it. One retarget implementation, one map source of
truth; the client utility gets fixed to share it or retired — runtime
retargeting is not a client job in this architecture anyway (clips
arrive pre-retargeted from the bake).

**B3. Validation is a contract with no enforcement.** `validateClip`'s
contract (loop continuity, foot-slide, bone budget) exists only as an
interface and a one-off manual grading report. Nothing stops a bad clip
— a foot-sliding walk, a non-looping idle — from entering the library
today. The grading proved the checks are computable; they belong *in*
the convert step as a gate, in TS first (the native addon is not a
prerequisite for the checks that matter).

**B4. No compression story.** acl never landed, so clips ship as full
GLB track data. 251 raw clips ≈ 18 MB before the game's own sources.
Whether that matters is a *measurement*, not an opinion: the library's
real byte total and per-clip cost must be measured, then the choice
made — acl native (the specced path), gltfpack/meshopt quantization
(already adopted elsewhere in the art bake), or accept-and-move-on.
Unmeasured is the only unacceptable state.

**B5. Scale is unproven where it matters most.** The animator updates
every character's mixer every frame — there is **no animation LOD**:
no distance-based update rates, no reduced-rate or frozen blending for
coarse-tier NPCs. The ResidentSystem already tiers NPC *thinking*
(full/coarse/none); animation has no matching tiers. Animouse's own
adoption bar (<0.1 ms/character/frame, pop-free blends, ±1-frame event
timing) was verified by unit tests, never by a runtime benchmark at
100 / 300 / 1,000 animated characters. Against a 1,000-user + 50,000-
entity region target, this is the largest unmeasured number in the
client.

**B6. Creatures have no skeletal path.** Procedural gait rigs cover
static-mesh animals. Anything that needs real skeletal creature motion
— a boss, a mount, a dragon — has no rig, no retarget map, and 73
graded clips waiting with nothing to land on. This can be a deliberate
v1 exclusion, but it must be a *decision on record*, not a discovery
made mid-production.

**B7. Nothing has ever been seen.** Blends, foot IK, foot-slide,
held-frame timing — all verified by tests and data, none by eye
(headless-GL wall, same as D1). D9 held-frame animation — the strand
that makes motion read *stylized* rather than smooth-generic — is still
seeded-only in the shader library. AAA here is a look as much as a
system; the look is unverified and one of its key strands unbuilt.

**B8. Dependency posture.** Animouse is a single-author library
(bus-factor risk noted at its review). It is integrated and passing,
but a robust stage needs the exit cost known: the animator's surface
against animouse should stay narrow enough that swapping to a plain
mixer state machine is a slice, not a rewrite. (Currently the surface
is `character-animator.ts` — good; keep it that way.)

## 3. What "end to end and robust" means, as acceptance criteria

1. **Reproducible**: one command, from a pinned source manifest, builds
   the library; CI (or a local gate, while Actions is billing-blocked)
   verifies the clip inventory matches the manifest exactly. A missing
   source or clip fails the build with a named error.
2. **Singular**: one retarget implementation and one bone-map source of
   truth, used by convert, grading, and any future tooling.
3. **Gated**: every clip passes automated validation at convert time —
   loop continuity, foot-slide under threshold, bone budget, travel
   sanity, duration/fps sanity — with failures reported per clip and
   the library refusing to ship red clips.
4. **Measured**: library bytes (total + per-clip), client animation CPU
   at 100 / 300 / 1,000 characters, event-timing error vs server
   startTick — all numbers on record, refreshed when the corpus or the
   animator changes.
5. **Tiered**: animation update cost scales with the same LOD tiers as
   NPC thinking — full rate near, reduced rate mid, event-only/frozen
   far — so a crowded town is a budget, not a cliff.
6. **Seen**: a hardware capture pass (same owed run as the D1 bench)
   eyeballs locomotion blends, foot IK on slopes, attack alignment,
   and one crowd scene, against the style gate.

## 4. The build order (each phase gated, each with a kill criterion)

- **Phase A0 — Pin the supply line.** Source manifest with hashes +
  expected-clip inventory committed (metadata only; licensed files stay
  in ignored assets); convert fails loud on missing/extra clips;
  Mesh2Motion wired as a proper source through its fetch step (CC0 —
  pinnable by URL + hash). *Done when:* a clean machine reproduces the
  library bit-for-bit and a deliberately removed source fails the build
  by name. *Kill:* none — this is table stakes.
- **Phase A1 — One retargeter.** Bone maps unified into the bake
  `Retargeter`; the client utility shares the map or is retired;
  the 16/66 failure becomes a test that cannot regress (a Mesh2Motion
  clip must map ≥ the graded bone set). *Done when:* one map, one test
  suite, both paths agree. *Kill:* if client-side retargeting proves to
  have a live consumer that needs it, fix-in-place replaces retire —
  the unity requirement stands either way.
- **Phase A2 — Validation gate in convert.** TS implementations of the
  `validateClip` contract (loop continuity, foot-slide, bone budget,
  travel) run per clip at convert; red clips block the library; the
  Mesh2Motion grades become the gate's regression fixtures (175 pass
  must pass; the 3 known fixes must flag). *Done when:* the gate runs
  in convert and reproduces the manual grades. *Kill:* a check that
  can't reproduce its manual grade gets fixed or dropped — no theatre
  gates.
- **Phase A3 — Measure, then compress + scale.** Library byte audit;
  compression decision from the numbers (acl native vs gltfpack
  quantization vs accept). Animator LOD tiers aligned with resident
  LOD; benchmark harness at 100 / 300 / 1,000 characters reporting
  ms/frame for the animation stage alone. *Done when:* both numbers
  exist and the compression call is recorded with its evidence.
  *Kill:* if bytes and CPU already fit budget, compression is
  explicitly closed as unnecessary — a recorded "no," not an open tab.
- **Phase A4 — The look + creatures decision.** D9 held-frame port
  (behind its own gate record, after D1's hardware verification);
  hardware visual QA pass; creature skeletal path decided on record
  (first quadruped rig + map, or procedural-only v1). *Done when:*
  the captures pass the style gate by eye and the creature decision is
  written down.

Phases A0–A2 are supply-line integrity — pure bake/tooling, no runtime
risk, and they make everything after them measurable. A3 is the scale
proof. A4 is the AAA look. **Recommended first slice: A0 + A1 together**
(they touch the same files and together close the reproducibility and
divergence breaks), then A2.

## 5. What this audit did not find (the good news, stated plainly)

- The server's animation authority is real and correctly shaped —
  clients render `(clipId, startTick, rate, layerMask)` and decide
  nothing. Gameplay timing (attack alignment) has the right seam:
  the client can start a clip mid-playhead to match the server's tick.
- Footstep events are not decorative — they have an audio consumer.
- Clips playing in place with server-owned movement is the right call
  for an authoritative MMO, and `travel` extraction keeps root-motion
  information available to the server instead of the client.
- The editor already has an animation surface; authoring won't start
  from zero when the library is trustworthy.

Nothing here starts without Joey's word, per phase, as always.
