# Cutscene Lane — MuJoCo-Backed Cinematics

Status: SPEC (Joey's direction, 2026-11-11). Nothing built. This spec defines
the lane; implementation starts on Joey's word, phase by phase.
Companion note: `~/workspace/your_files/mmo-engine-research/MUJOCO-ENGINE-NOTE.md`
(reel evaluation + the adoption addendum this spec executes).

Repo state this spec is grounded in (verified at `origin/main` `f69dae9b`,
2026-11-11):

- No cinematic or cutscene system exists on main. The word appears only in
  tooling/business docs.
- The animation bake contract exists but its native half is stubbed:
  `packages/art/src/animation-bake.ts` (`retargetClip` / `compressClip` /
  `validateClip` all throw "native addon not implemented"; docs in
  `docs/ANIMATION-BAKE-PIPELINE.md`). This is animation audit break B3.
- The editor verb registry has 13 verbs; 11 dispatch. `startDialogue`
  (home: quests · dialog graphs) is deliberately unimplemented. This lane
  does not change that — dialogue and cinematics compose (§9).
- The server already owns animation state (`packages/engine-core/src/animation.ts`,
  Animation component), and clients already play clips through the character
  animator. The baked lane rides that machinery instead of adding a second
  animation runtime.

## 1. The core inversion, stated once

A cutscene is **baked physics, not live simulation**. MuJoCo runs at author
time, where its contact fidelity is the point and its cost is free. The game
ships the *recording* — joint and pose tracks — and every client plays back
the identical scene for the cost of playing animation clips it already knows
how to play.

Live simulation is the exception lane (§8), reserved for scenes that must
react to the moment, and every live scene must ship a baked fallback.

This keeps the founding contract intact: **Jolt decides what is true in the
world tick. MuJoCo decides how a staged moment looks.** The two never meet.

## 2. The authority contract (the law of this lane)

- **The server owns the story.** Whether a cinematic plays, who participates,
  when it starts and ends, and every state change around it — rewards, quest
  steps, who lives, what is destroyed in the world record — are server
  decisions, applied as ordinary verbs/events *before* and *after* the scene.
- **MuJoCo owns the motion.** How bodies fall, collide, crumple, and settle
  during the scene is the simulation's business, at bake time.
- **Nothing is ever read back.** No gameplay state is derived from simulation
  output — not positions, not damage, not "did the bridge fall." Where a
  participant ends up is a *script-declared exit pose* in the cinematic
  definition (§3), chosen by the author, applied by the server. The sim
  recording is choreography that arrives at that pose, not evidence of it.
- **Clients own playback.** Rendering, camera, local skip. A client's
  playback (or live-lane simulation) diverging is a cosmetic defect, never a
  correctness defect, because nothing depends on it.

Any design that needs a sim result to matter is not a cutscene — it is a
gameplay system, and it goes through the tick like everything else.

## 3. Catalog — CinematicDef (data first)

One definition per cinematic, content-versioned like every other catalog
(structured document, validated by schema, adopted by pin where templates
apply). Stored at `content/cinematics/<id>/` (§5 bundle layout).

| Field | Shape | Notes |
| --- | --- | --- |
| `id` | string (slug) | Stable forever; bundles are content-addressed by hash. |
| `title` | string | Author-facing. |
| `kind` | `baked` \| `live` | `live` additionally requires `fallbackBakedId`. |
| `durationCapSec` | number | Hard cap; bake fails if the recording exceeds it. |
| `actorSlots` | ActorSlot[] | Named roles bound to entities at trigger time. |
| `props` | PropDef[] | Non-skeletal staged bodies (stall, masonry, cart). |
| `stage` | { anchor, radiusM } | Local frame the scene was authored in; placed by anchor at trigger. |
| `beats` | Beat[] | Timed cue sheet (§4). |
| `entryPoses` | per-slot pose | Where each actor must be when the scene starts (server walks/teleports them there as a pre-outcome). |
| `exitPoses` | per-slot pose | Where each actor is when the scene ends (server applies as a post-outcome). |
| `preVerbs` / `postVerbs` | verb invocations | Server-side state changes bracketing the scene (quest steps, fixture destruction in the world record, rewards). Data, validated against the verb registry — the same verbs the editor dispatches. |
| `provenance` | 5W1H record | Who authored it, when, why, what it replaced — the standing authoring rule. |

ActorSlot: `{ slot, rigFamily, requiredComponents[] }`. Rig families map to
the engine's bone ontology (§6) — a slot names a *kind of body*, never a
specific character, so one cinematic serves any cast that fits the rigs.

PropDef: `{ prop, kind: static | dynamic | breakable-cosmetic }`. A prop the
world record cares about (a real stall that is now destroyed) is destroyed
by a `postVerb`, not by the sim; the sim only shows it falling.

## 4. Beats — the cue sheet

A beat is `{ tSec, type, payload }`, sorted, validated non-overlapping where
the type demands it. Beat types for v1:

- `dialogue` — a dialog-graph reference (the `startDialogue` home) plus the
  slot speaking. Rendered as the normal dialogue UI over the scene.
- `camera` — shot definition: follow-slot / fixed / dolly between two
  authored points, FOV, ease. Camera is client-local; observers may pick
  "watch" or "free camera" (an accessibility and streaming affordance).
- `vfx` — a semantic FX event on the existing VFXAdapter surface (this is
  where the Linear Ability FX package plugs in: a boss intro's spell burst
  is a beat, cast by nobody, owned by the scene).
- `audio` — ambience bed / one-shot cue references.
- `shake` / `flash` — the shared client services, by intensity + duration.
- `slowmo` — playback time-scale over a window (baked lane: scales clip +
  beat clock together; it is a presentation dial, nothing more).

Beats are data the *player* executes. The server never sees them; it only
brackets the scene.

## 5. The bake pipeline

```
MJCF scene + rig map (authored, §6)
    ↓  mj-bake (headless MuJoCo, pinned version, fixed step)
qpos/qvel recording at 60 Hz, seeded
    ↓  split
    ├─ skeletal tracks → animation intake (retarget → validate → compress)
    │      → clips in the bundle, played by the character animator
    └─ prop tracks → quantized pose-track asset in the bundle
           (position + quaternion per dynamic prop per frame)
    ↓  gates (§7)
bundle: content/cinematics/<id>/
    def.json · scene.mjcf.xml · clips/ · proptracks.bin ·
    manifest.json (hashes, MuJoCo version, source hashes, track hash)
```

Rules:

- **Fixed step, single thread, recorded seed.** The bake is a build step,
  run by a pinned MuJoCo (Python bindings on the Linux bake host — the
  fastest honest route to a working tool; a C CLI is a later optimization,
  not a v1 question).
- **Determinism gate.** Every bake runs twice; the two recordings must hash
  identical or the bake fails. A cinematic that cannot be reproduced cannot
  be shipped — same discipline as the procgen goldens.
- **The recording is the asset.** MJCF is source; the bundle is what ships.
  Re-baking an existing cinematic is a content change with a new hash, never
  a silent overwrite.
- **Sample rate is a budget dial.** 60 Hz skeletal / 30 Hz props by default;
  the manifest records the rates; playback interpolates.

## 6. The rig bridge — MJCF ↔ bone ontology

MuJoCo bodies are not our bones. The bridge is a **data table per rig
family**: MuJoCo body/joint name → Nexus bone name, stored beside the rig
definition and shared with the animation pipeline's one retargeter (A1).
One mapping, two consumers — the bake never grows a private second map
(that was audit break B2; this lane does not repeat it).

Non-humanoid rigs are first-class here: a creature entrance cinematic is an
articulated MuJoCo tree whose track retargets onto the creature skeleton —
the same bridge the B6 skeletal-creature path needs, exercised first in the
lane where a mistake is cosmetic.

## 7. Bake gates (all must pass; failure is a failed build, not a warning)

| Gate | Check |
| --- | --- |
| Reproducibility | Two bakes, identical track hash. |
| Clip validity | The `validateClip` contract: bone budget, no NaN/Inf samples, joint-limit violations flagged per frame. |
| Arrival | Final recorded pose within tolerance of the declared `exitPoses` for every slot and dynamic prop — the choreography must actually arrive where the script says the world continues. |
| Duration | Recording ≤ `durationCapSec`. |
| Bundle budget | Whole bundle ≤ 2 MB compressed (quantized tracks; §10). |
| License | MJCF/mesh sources carry the same provenance rules as all content; MuJoCo itself is Apache-2.0 (bake-time tool, not shipped). The WASM lane's license/distribution terms are re-checked at C4 before anything ships. |

The Arrival gate is the one that makes §2 enforceable: because the exit is
declared and the recording is *checked against it*, the author bends the
choreography (initial conditions, impulses, timing) until physics arrives
at the story — never the other way around.

## 8. The live lane (reactive set pieces) — v2, gated

For scenes that must react — debris from where the player actually stands, a
fall that depends on the moment — the client runs MuJoCo WASM in a Web
Worker (the client's existing worker pattern), rendered by three.js,
stepped at a fixed rate, fed an initial state from the server's trigger
event (participant snapshots + seed).

Hard rules:

- **Budgets:** ≤ 8 articulated actors, ≤ 64 dynamic bodies, ≤ 20 seconds,
  fixed step, worker-isolated. A scene that doesn't fit is baked or split.
- **Fallback is mandatory:** every `live` def names a `fallbackBakedId`.
  Below the quality tier that can afford the worker, clients play the
  fallback. No device is ever locked out of a story beat by physics.
- **Cosmetic by construction:** the live sim's output is never reported to
  the server and never compared between clients. Two players seeing a
  barrel land differently is acceptable; the barrel's *world* state was
  already decided by the script.
- **Measured gate before it ships:** frame-time on a mid-tier Android at the
  budget caps, reported with the repo's metrics discipline. Unmeasured,
  unshipped — the lane stays spec until C4 produces numbers.

## 9. Runtime — trigger, participation, endings

- **Trigger.** A new editor/world verb, `playCinematic`, home:
  `cinematics · CinematicSystem`, signature
  `(cinematicId, anchor, bindings: slot → entity)`. It gets the honest
  dispatch home in the same style as the existing 11 verbs. Quest scripts,
  GM commands, and triggers invoke it like any verb.
- **Server flow.** Validate (def exists, slots bindable, participants
  alive and not already in a cinematic) → apply `preVerbs` → set the
  participation flag → emit one control-plane event
  (`cinematic_started`: id, bundle hash, start tick, bindings) to
  participants and interest-scoped observers → at `startTick + duration`,
  apply `exitPoses` + `postVerbs` → clear the flag. The server never waits
  for clients; its clock is the scene's clock.
- **Participation flag.** One new ECS component (next free component id at
  implementation time), server-written only: `{ cinematicId, slot,
  startTick, endTick }`. While set, movement/combat systems skip the entity
  and the world snapshot carries the flag so clients hand the entity's
  object to the cinematic player instead of the interpolator. This is the
  only tick-adjacent change in the whole lane, and it is a *skip*, not a
  simulation change.
- **Client flow.** On the event: fetch bundle (content provider, hash-
  verified), bind slots, play clips + prop tracks + beats on the shared
  scene clock. On end: hand objects back to interpolation at the exit pose
  (which equals where the server already put them — no snap).
- **Skip.** Local and cosmetic: a participant may skip *their view*
  (fade to the exit state and wait out the remainder muted). The server's
  clock and other clients are unaffected. (Group-skip voting is an open
  question, §12 — v1 is local skip.)
- **Disconnect / crash mid-scene.** The server's clock still ends the
  scene; exit poses and post-verbs apply on schedule. A reconnecting client
  mid-scene joins playback at the current offset or skips to exit — its
  choice, both cosmetic.

## 10. Budgets

| Item | Budget |
| --- | --- |
| Baked bundle (whole cinematic, compressed) | ≤ 2 MB |
| Skeletal actors per scene | ≤ 16 |
| Dynamic props per scene | ≤ 64 |
| Duration | ≤ 60 s baked (cap is per-def; authoring guidance ~5–20 s) |
| Skeletal sample rate | 60 Hz |
| Prop sample rate | 30 Hz |
| Live lane | §8 caps, quality-gated, fallback mandatory |
| Runtime cost of a baked scene | Clip playback + one pose-track stream — inside the existing animation budget; no new per-frame system on the server beyond the participation skip |

## 11. Build order (sequenced for cold execution)

- **C0 — Data.** `CinematicDef` schema + bundle manifest format + validator
  (arrival/duration/budget checks as pure functions over a recording).
  Tests only; no MuJoCo yet.
- **C1 — Bake, props only.** `mj-bake` tool: MJCF → headless MuJoCo →
  prop pose-tracks + manifest, determinism gate live. Showcase: a
  market-stall collapse (props only — no skeletal dependency). Proves the
  lane end-to-end where a mistake is cosmetic.
- **C2 — Baked runtime.** Server trigger + participation component +
  control event; client cinematic player (clips for slots when available,
  prop tracks, beats for camera/vfx/audio); local skip; disconnect
  semantics. The stall collapse plays in the real client, triggered by a
  quest verb.
  *Dependency, stated plainly:* skeletal tracks ride the animation intake —
  the native retarget/validate half is still stubbed (B3). C2 ships with
  prop tracks + existing hand-authored clips bound to slots; the MuJoCo
  skeletal leg lands when A1/A2 do, or via an interim direct bone-track
  format if Joey calls it. The lane is not blocked on ozz; it is honest
  about which leg is.
- **C3 — Authoring.** Editor surface: place a cinematic anchor in the
  viewport, bind slots to placed objects, edit beats on a timeline, preview
  = bake + play in the editor viewport. Defs versioned as content like
  everything else.
- **C4 — Live lane.** WASM worker island, budgets enforced, fallback rule,
  Android frame-time gate with a metrics report. Ships only with numbers.

Each phase: tests green before anything leaves a local branch; performance-
affecting phases ship the repo-required metrics report; ROADMAP +
DECISIONS sync in the same change; board updated in the same turn.

## 12. Open questions (for Joey)

1. **Group skip** — v1 specced as local-only skip. Vote / party-leader skip
   can come later; say if you want it in v1.
2. **Live lane in v1?** Spec sequences it last (C4) behind a measured gate.
   Bake-only v1 is the recommendation.
3. **First showcase scene** — market-stall collapse (props-only, C1) is the
   proposal. A creature entrance is the flashier proof but waits on the
   skeletal leg.
4. **Bake host** — Python bindings on Linux specced. If the bake should live
   elsewhere (your codespace), it moves; the tool is a CLI either way.

## 13. What this lane is not

- Not physics in the tick; Jolt's role is unchanged.
- Not a dialogue system; dialogue is a beat payload with its own home.
- Not motion matching, not RL controllers, not a general physics sandbox
  for players.
- Not a second animation runtime and not a second retargeter.
- Not a promise about visuals: the first rendered acceptance is C2's
  showcase, judged by eye on real hardware like every other visual claim.
