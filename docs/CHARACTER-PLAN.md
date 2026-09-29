# Characters — Plan & Checklist

Goal: players and enemy humans are built from the Modular Fantasy Hero
parts and animated with open motion-capture data; monsters spawn as the
packs ship them. A new account goes through a character-creation scene
before it enters the world.

Legend: `[x]` done · `[ ]` planned · **⚑** decision needed before building.
The art itself stays in `<repo>/assets` (git-ignored, never published).

## What the packs give us

- **Modular Fantasy Hero, rigged** (`ModularCharacters.fbx`): 720 skinned
  parts on one 52-bone Synty humanoid skeleton.
  - Body: `Head`, `Torso`, `ArmUpper/ArmLower/Hand` (L/R), `Hips`, `Leg`
    (L/R) — each in `Male` and `Female`.
  - Face: `Hair`, `Eyebrow`, `FacialHair` (male), `Ear`.
  - `Head_No_Elements`: the mask heads (no brows or facial hair).
  - Coverings: `HeadCoverings_Base_Hair / No_FacialHair / No_Hair`.
  - Attachments: helmet, shoulder, elbow, knee, hips, back.
  - Set `01` of the body parts is the starter armour for both genders.
- **Recolouring**: four mask textures (`PolygonFantasyHero_Texture_Mask_01..04`)
  mark skin, hair, eyes, stubble, scars, body art, and the armour's
  primary / secondary / leather / metal regions, so every one of those
  colours is a free choice.
- **Monsters and pack characters** (dungeon, kingdom, rivals): rigged on
  the same Synty humanoid skeleton, no animations included.
- The 720 `*_Static` parts converted earlier are unrigged: fine for editor
  previews, not for animation.

## Phase A — Rig and parts (art pipeline, offline)

- [x] `npm run convert:modular -w @mmo-engine/art`: `ModularCharacters.fbx`
      → `assets/models/glb/modular-fantasy-hero/Rigged/` — `rig.glb` (one
      63-bone skeleton), `parts/<name>.glb` (720 skinned parts, 49–197 KB
      each), `catalog.json`. three.js's FBXLoader gives every part its own
      nested copy of the skeleton (3,513 bones); the converter rebuilds one
      — a bone per path, copies collapsed onto the bone they copy — and
      binds each part to it (the file's current pose is its bind pose,
      verified to 2e-6). The pack names both hands' fingers alike
      (`Thumb_01` …); they become `Thumb_01_L` / `Thumb_01_R`, or the left
      hand would follow the right hand's fingers as soon as the skeleton
      moves.
- [x] Part catalog (`@mmo-engine/art` `modular-catalog`): slot, gender,
      set number, mask heads, and what head coverings hide, from the names.
- [x] The recolour material in three.js (`CharacterMaterial`), and the
      client's kit and characters (`CharacterKit`, `ModularCharacter`: one
      rig per character, parts bound to it by bone name, swapped in place).
      Regions a look leaves unset follow the skin (`effectiveColours`):
      body art is invisible, scars are a shade of the skin, stubble a
      darker skin on men and none on women. The masks mark regions **dark**
      on white; measured from the parts that use them:

      | Mask | R | G | B |
      | --- | --- | --- | --- |
      | 01 | armour primary | armour secondary | body art (unused by base parts) |
      | 02 | metal primary | metal secondary | metal dark |
      | 03 | skin | stubble | scars (unused by base parts) |
      | 04 | leather primary | leather secondary | hair (hair, brows, beards) |

      Eyes and mouths are unmasked black in the atlas: eye *shape* comes
      with the head; eye *colour* would need a mask of our own.

## Phase B — Appearance on the server

- [x] Appearance model (`CharacterLook`, canonical JSON): gender, head,
      hair, eyebrows, facial hair, ears, and colours (skin, hair, stubble,
      scars, body art — eye colour isn't maskable in the pack). Armour is
      the gender's starter set `01` and is not a creation choice.
- [x] Characters stored per account (`SqliteCharacterStore`,
      `data/characters.db`; names unique ignoring case, 8 per account),
      validated against the catalog (structurally when the server has no
      art); a player spawns as their character, and a character is in the
      world once.
- [x] An Appearance component on the wire (ComponentId 10, the look's
      JSON, interned server-side), so every client assembles every
      character it sees: the world view shows players as their modular
      characters (arms lowered from the T-pose, facing their movement)
      until Phase D animates them.

## Phase C — Character creation

- [x] After login, the character screen: the account's characters (enter
      the world as one), or — for an account without any — Create a
      Character: a 3D preview (orbit, zoom, face/full-body framing), a
      previous/next picker per part category (face — which brings the eye
      shape — hair, eyebrows, facial hair, ears), colour swatches and
      pickers, gender, randomise, and a name. Confirming creates the
      character on the server and enters the world. `?preview=character`
      runs the same screen without a server.
- [x] Control messages (protocol v5): `account` 0x0c, `create_character`
      0x0d, `enter_world` 0x0e, hello/register `characters`, error 4005
      (docs/MESSAGE-CATALOG.md § Characters).
- [ ] A grid view of each category's parts (thumbnails) beside
      previous/next.

## Phase D — Animation from open motion capture

Sources in use (all under the ignored `assets/animations/`; the converted
library is `assets/models/glb/modular-fantasy-hero/Rigged/animations/`):

| Source | Licence | What it gives |
| --- | --- | --- |
| Quaternius *Universal Animation Library* 1 + 2, Standard (OpenGameArt) | CC0 | locomotion, jump, swim, the 3-hit sword combo in parts (hits + recoveries), block, shield guard / break / bash, roll, punches, hits, death, emotes, zombie set |
| Kevin Iglesias's free packs (melee, basic motions, spellcasting, archer, throwing; itch.io) | Unity Asset Store EULA: royalty-free in games, **no redistribution** | one- and two-handed, polearm and shield attacks, combat idles, 8-way runs and strafes, bow load / hold / release, spell load / cast, throws; male and female takes (`.F`) |
| CMU mocap via RancidMilk's FBX conversion (itch.io) | CMU: free in commercial products, not to be sold as animations; credit mocap.cs.cmu.edu | 53 raw combat takes: karate kicks / punches / blocks, boxing, swordplay, lunges, dodges, ducks (reference: moves still to be cut from them) |
| Rokoko free packs | commercial use allowed | not fetched: the download form asks for a name and email — the user downloads them, then they go in as a source |

Not suitable: Bandai Namco's research set (non-commercial). Mixamo is
free for games but can't be redistributed and needs an Adobe login.

- [x] `npm run convert:animations -w @mmo-engine/art`: every source
      retargeted onto the Synty rig (`Retargeter`): each bone turns in the
      world as its source bone turns from its rest pose, after our rest
      bone is aligned to point where the source's does (so A-pose, T-pose,
      Z-up and centimetre sources all work); hips scaled by hip height.
      Clips play in place — horizontal root motion (a root bone, or the
      hips for raw mocap) is taken out and recorded as `travel` for the
      server to apply. One GLB per source plus `animations.json`.
- [x] The client animator: a base layer of locomotion (idle / walk / jog /
      sprint by speed with playback scaled to it, swimming, in the air),
      crossfaded in step, and an action layer over it — whole-body or
      upper-body only (the legs keep walking) — started part-way in to
      match the server's start tick. Women use the `.F` takes when there
      are any. Characters animate in the world and on the creation stage.
- [x] Combat, server-authoritative (`CombatSystem`, `COMBAT_MOVES`): the
      3-hit sword combo with chain windows and recoveries, the held guard
      and shield bash, the dodge roll; moves move the character (lunges,
      the roll) and slow the walk; the Action component (protocol v6)
      tells every client which move, from which tick, facing where.
- [ ] Cut single moves from the CMU takes (kicks, blocks, punches) and
      offer Kevin Iglesias's weapon styles as alternative movesets.
- [ ] Damage and hit reactions: hits land at a moment of the move, the
      guard and the roll defend, `Hit_*`, knockback and death play.
- [ ] Blend spaces for strafing (Kevin Iglesias's 8-way runs), foot
      locking, inertial blending for interruptions.

## Phase E — Enemies

- [ ] Enemy humans: the server generates appearances from the same
      catalog (armour sets by faction / tier) and spawns them like players.
- [ ] Monsters: pack characters spawned as they are, animated with the
      same retargeted clips (they share the humanoid skeleton).

**Verify:** create a character in the browser, log out and back in and
see the same character; a second client sees it too; animations follow
movement (walk, run, jump, swim, fly).
