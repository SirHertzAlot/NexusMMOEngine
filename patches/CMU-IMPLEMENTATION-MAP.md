# CMU Mocap — Implementation Map: from haystack to playable verbs

Written 2026-11-12 (~21:35 ET) on Joey's word: "mark this up and get
it mapped out so we can get it implemented into our game and work out
how it can expand our game's playability."

Source evaluations: CMU-MOCAP-RANCIDMILK-NOTE.md (licence, caveats,
content inventory), ANIMATION-PIPELINE-AUDIT.md (breaks B1–B8, phases
A0–A4), POLYFORK-ASSET-LIBRARY-NOTE.md (creature clips — the other
half of the animation supply).

## 0. Classification change (the markup Joey asked for)

- **Supersedes:** the 2026-10-27 profession sweep's classification of
  the CMU database as a *backup haystack*, and the animation build
  plan's standing line "No mocap pipeline yet." As of this map, the
  RancidMilk conversion (FBX, retargeted to the Quaternius rig,
  indexed) is an **adopted animation source** for the families in §3.
- **Scope of the adoption:** our own game. The raw library is never
  redistributed; only clips that pass the §2 pipeline onto our own
  characters ship, with the CMU pass-along notice and credit.
- **What it does not displace:** KayKit (profession loops), Haduki
  (town life + smithing), UAL2, Mesh2Motion, Polyfork creature clips.
  CMU's lane is *human body vocabulary the curated packs don't carry*:
  traversal, forms, personality, interaction.

## 1. The governing rule (read before every mapping below)

**Clips are presentation. Verbs are simulation.** The server owns
movement state (grounded / climbing / swimming / vaulting / rolling),
speed, and position — as it already does for locomotion. A CMU clip
enters the game only when a server-side verb exists for it to present;
the clip never decides where the character goes. Root motion in the
source is therefore not a defect to delete blindly: per family, it is
either (a) stripped to in-place (locomotion family), or (b) converted
into a **displacement profile the sim owns** (climb rate, vault
distance, roll length), measured from the clip at bake time. Category
(b) is the interesting one: the mocap *measures* the verb for us.

## 2. The pipeline (how a raw FBX becomes a shipped ClipId)

Slots into the audit's phases; nothing here invents a parallel chain.

1. **Census + pin (A0).** On file arrival: scripted census of every
   FBX (file → CMU subject/trial → description → our taxonomy in §3),
   hashes into the source manifest. Expected-clip inventory written
   *before* conversion, so convert can fail loudly instead of skipping
   silently (break B1).
2. **Cleanup (per family, scripted in Blender, headless).** Strip or
   convert root motion per §1; trim to loop/one-shot bounds; drop
   garbage head/tail frames (the index itself flags bad takes);
   prefer higher-numbered takes where duplicates exist.
3. **Retarget (A1 — one retargeter).** Source rig is the Quaternius
   rig (Auto-Rig Pro). The A1 decision now has a concrete input: our
   canonical bone map must cover the Quaternius rig *and* the client
   map (today 16/66 — break B2) gets completed against this corpus,
   since it is the largest single-rig source we own.
4. **Validate (A2).** `validateClip` enforced at bake: bone set,
   loop seams, foot-skate estimate, displacement profile present for
   category-(b) verbs. No clip ships unvalidated.
5. **Compress + bake (A3).** ACL at bake (the standing choice);
   bytes measured per clip and per family — the corpus is the first
   real input to the audit's unmeasured-bytes problem (B4).
6. **Store.** Baked clips land in the **Baked Asset Store** (Joey's
   2026-11-12 design): SoA keyframe streams, indexed in the SQLite
   asset DB with family, verb, licence lane, and hash. ClipIds on the
   wire stay as they are — the store is behind AssetProvider.
7. **LOD (A3/B5).** Sampling tiers by distance: full rate near,
   half-rate mid, held-pose far — first benchmarked on this corpus at
   100/300/1000 characters, which is the audit's missing benchmark.

## 3. Family map — motion → verb → content → playability

### 3.1 Traversal (the headline expansion)

| Source | Sim verb / state | Unlocks | Playability gain |
|---|---|---|---|
| Climb ladder (13, 14, 143) | `climb` state on ladder volumes (ECS data on placed ladders) | Watchtowers, scaffolds, ship rigging, mine shafts | Vertical routes through towns and dungeons; the synthesis dungeons' mezzanine lofts (PR #437) stop being scenery |
| Playground climbs/hangs/pull-ups (1) | `climb` freeform variant + hang | Ruins, broken walls, tree platforms | Exploration texture; secrets above eye level |
| Run Jump Over / Run Over (127, 128) | `vault` — obstacle height band from collision query | Fences, crates, low walls, market stalls | Movement flow through dense procgen towns; chase sequences |
| Run Dive Over Roll / Run Roll Underneath (127, 128) | `roll` — dodge verb (combat call: i-frames are a combat-doc decision, not an animation one) | Combat dodging, trap rooms | The first evasive verb; boss and trap design space opens |
| Run Duck Underneath; duck/stoop/crawl-under at jog (107, 108) | `duck`, `crawl` states | Low tunnels, under-floor passages, grate gaps | Stealth routes; dungeon variety beyond door-shaped holes |
| Climb 3 steps; stepstool climbs (13–15, 40, 41) | step-up presentation for ledges in the step band | Ledge shelves, wagons, stages | Removes the "invisible wall at knee height" feel |
| Jumps: forward/high/jump-to-grab (13, 16) | `jump` (already a verb; these are its clips) | Gaps, rooftops | Jump stops being a hop emote |
| Uneven-terrain walks (3); veer/turn/stop locomotion (9, 16) | locomotion blend inputs | Hillsides, rubble fields | Terrain reads as terrain, not a floor texture |

### 3.2 Swimming

| Source | Sim verb / state | Unlocks | Gain |
|---|---|---|---|
| Swim subjects (125, 126; 79, 80) | `swim` state in water volumes | Rivers, lakes, flooded ruins, the reef set Polyfork stocked | Water biomes become playable space instead of a boundary. Scope call for Joey: surface swim only at first — CMU swim is surface pantomime; underwater locomotion is a design problem, not a clip problem |

### 3.3 Combat forms (presentation for the combat doc's abilities)

| Source | Maps to | Gain |
|---|---|---|
| Karate kata + strikes/blocks (135) | Unarmed ability set presentation (Linear Ability FX lane); kata as learnable *forms* | A martial-arts mastery line with real forms to earn — MASTERY-AND-COMBAT content, not just numbers |
| Flips, spin kicks, backflip (88, 86) | Advanced unarmed abilities; acrobat showpieces | High-mastery spectacle; arena/boss moves |
| Boxing (13, 14, 17) | Brawler unarmed set; tavern brawls | A second unarmed flavour, cheap |
| Swordplay (02_07–09) | Sword ability presentation candidates | Only weapon mocap in the library — evaluate against Haduki/KayKit before adopting; three takes is thin |
| Tai Chi (12) | Monk ambient + slow-form emotes | Monastery life; pairs with the Polyfork Dragonborn monk |

Server decides every hit, as always; these clips decide nothing but
how truth looks.

### 3.4 NPC life (the living-world vein — north-star fuel)

| Source | Maps to | Gain |
|---|---|---|
| Personality walks (17, 132, 136, 137) | Resident temperament → walk style (the resident composer's temperament axis gets a body) | Townsfolk stop moving like clones; a drunk, an elder, and a guard read at 50 m |
| Town loops (13–15): sweep, mop, wash, direct traffic, drink, laugh, sit/stand | Resident daily-routine behaviours at placed props | Ambient labour — the world works when nobody is questing |
| Two-person sets (18, 19): handshake, pull/resist, lead-by-arm, converse, quarrel | Paired resident interactions; greeting/escort presentation | Social simulation becomes visible; escort quests stop being follow-the-robot |
| Walk-and-talk gesturing (138) | Conversation-while-moving presentation | Escorts and companions talk like people |
| Performance (5, 60, 61, 15): ballet, salsa, novelty dances; marching (138) | Performer NPCs at stages/taverns; guard marching | Venues have acts; ceremonies have bodies |
| Stylized acts (137): mug / pick-up / wait per character type | Prop-interaction presentation set | One intake covers most "NPC does a small thing" needs |

### 3.5 Parked, by name

Basketball/soccer (minigame fodder, no system owns them yet),
skateboard (no board item), motorcycle poses (no vehicles in the
humanoid verb set). Recorded so the census doesn't re-litigate them.

## 4. Playability expansion — the summary Joey asked for

1. **The world gains a vertical axis.** Climb + vault + jump clips,
   behind climb/vault verbs, turn walls, towers, lofts, and rooftops
   from collision into routes. Every procgen town and synthesis
   dungeon gets taller without new geometry.
2. **Water stops being a wall.** Swim state + clips + the Polyfork
   reef population make lakes and coasts content.
3. **Combat gains a body.** A dodge verb, an unarmed martial line
   with earnable forms, and brawler flavour — presentation depth the
   combat numbers already implied but couldn't show.
4. **Towns gain inhabitants.** Temperament walks, labour loops, and
   two-person interactions are the cheapest "feels like you've been
   there before" we can buy — the design north star, served directly.
5. **A parked blocker falls.** Motion matching was parked partly for
   "no mocap corpus for the rigs." A pinned, censused CMU corpus is
   that corpus. Revisit condition (a) is met by P0 below; (b) and (c)
   (per-character CPU, Learned Motion Matching) remain — revisit is a
   measurement, not a build.

## 5. Phasing (each phase lands green before the next)

- **P0 — Census + pin (A0).** Blocked only on the files arriving
  (Joey hosting; see note). Deliverable: source manifest + census
  report + this map's taxonomy applied to real file names.
- **P1 — Traversal pack.** Climb, vault, roll, duck, crawl, steps +
  their sim states and displacement profiles; one ladder volume and
  one vaultable wall in a test scene; playtest by eye (B7's rule:
  nothing counts until seen).
- **P2 — Swim.** Water volume + swim state + surface clips.
- **P3 — Combat forms.** Kata/boxing sets as ability presentation;
  dojo content hooks into MASTERY-AND-COMBAT.
- **P4 — NPC life pack.** Personality walks wired to resident
  temperament; town loops at props; two-person greetings.
- **P5 — Motion-matching revisit.** Measurement only: corpus exists;
  price the per-character cost at our counts; report, don't build.

First slice on file arrival: **P0 + the P1 climb subset** (subjects
13/14/143 ladders + 127's vault/roll) — the smallest set that changes
what a player can *do*.

## 6. Open decisions (Joey's)

1. Swim scope: surface-only first (recommended) vs underwater design.
2. Roll i-frames: combat-doc call — presentation-only dodge vs
   invulnerability window.
3. Swordplay: adopt CMU's three takes vs wait for a fuller weapon
   source. (Default if unanswered: park it; kata carries P3.)

## 7. Correction — what was already on main (added 2026-11-13, ~08:45 ET)

Plainly first: **this map understated what was already built.** Sections
§0 and §2 were written as if A0/A1/A2 were phases the CMU work would
slot into, and as if no CMU pipeline wiring existed before 2026-11-12.
Checked against `origin/main` on 2026-11-13, that is wrong in four
checkable ways. Nothing above this section was rewritten; this section
corrects it.

1. **A0, A1, and A2 all landed on 2026-10-28, on `origin/main`** —
   two days after the audit proposed them, two weeks before this map:
   - A0: `24c8b9fe` "Phase A0 — pin animation supply line; fail-loud
     on missing sources + clip-count verification" — convert now throws
     instead of skipping a missing source, and
     `content/animation/animations.json` pins Mesh2Motion
     (`clipsExpected: 251`).
   - A1: `d3b40f6d` "Phase A1 — one retargeter; retire client util (no
     consumers)" — the client-side retargeter the audit's B2 named is
     gone from main; the only retargeter is
     `packages/art/src/convert/retarget.ts`.
   - A2: `b569cdc7` "Phase A2 — TS validation gate in convert" —
     `validateRetargetedClip` (`retarget.ts`), called from convert at
     a bone budget of 200: loop continuity + bone budget enforced,
     red clips throw and block the library.
   - Whether Joey gave the word for the Oct 28 landings is **not**
     established by this check — the commits are by the agent's git
     identity, and the Oct 27 record said the animation-start decision
     was still open. The landing is verified; the authorization is not.
     That question is Joey's to settle, not this map's to assume.
2. **The CMU wiring predates the "backup haystack" label by a month.**
   `45f9ddcc` (2026-09-28) "Art: retarget animation libraries onto
   the modular rig" put `CMU_MAP`, `CMU_TAKES`, and a `cmu-combat`
   source entry (`animations/rancidmilk/combat`, `reference: true`)
   into `packages/art/src/convert/convert-animations.ts`. The
   2026-10-27 sweep classified CMU as backup without crediting code
   that was already there. The adoption in §0 is still real — but it
   adopts an already-wired source, it does not wire a new one.
3. **The existing wiring is combat-only.** `CMU_TAKES` covers
   02 swordplay/punch, 13/14 boxing, 74 kicks, 76 defense, 77 duck,
   86/87/88/90 jump kicks, 111/113/141 punch-kick, 134 duck-under,
   135 karate, 139 ducking, 143 punching/kicking, 144
   kicks/blocks/lunges/punches. It contains **no** climb takes
   (13/14/143 ladders are not in the table — 13_17/13_18 are Boxing,
   143_23/143_24 are Punching/Kicking), **no** parkour 127/128,
   **no** swim 125/126, **no** playground 01, **no** personality or
   two-person takes. The new work in §3.1/§3.2/§3.4 is therefore
   real new scope: extending `CMU_TAKES` beyond combat, not just
   running an existing table.
4. **No CMU clip has ever run through this path.** The committed
   `content/animation/animations.json` on main pins only Mesh2Motion
   and lists `"clips": []`. The `cmu-combat` source has never had
   files present (assets are git-ignored), so P0's "blocked only on
   the files arriving" still holds — with one sharpening: once the
   files land, the combat slice converts through existing code
   immediately; the census must also produce the pin this map's §2.1
   describes (a `clipsExpected` for `cmu-combat` plus an
   `animations.json` entry), because CMU is currently unpinned.

Two honest limits carried from the code, for §2 step 4: A2's
`footSlide` is hardcoded `0` — foot-slide is **not** measured yet,
only loop continuity and bone budget are enforced. And A0's fail-loud
means a default convert run aborts when *any* source directory is
missing, so landing the CMU files alone does not make convert runnable
until the other sources are present or a subset is passed explicitly.
The native `validateClip` (ozz addon) remains a stub — see
`packages/art/src/animation-bake.ts` ("not implemented").

**Revised first slice, on file arrival:** P0 census + pin
`cmu-combat` (combat takes convert as-is) + extend `CMU_TAKES` with
the P1 climb/vault takes (13/14/143 ladders, 127/128) before P1
starts. The canonical bone list the MuJoCo blacksmith specimen would
use is also now verified in code: `CANONICAL_BONE_ONTOLOGY` in
`convert-animations.ts` (Hips, Spine_01–03, Neck, Head,
Clavicle/Shoulder/Elbow/Hand L/R, fingers, UpperLeg/LowerLeg/Ankle/
Ball L/R), with CMU aliases already mapped.
