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

- **⚑ Source and licence.** Recommended: Quaternius *Universal Animation
  Library* (CC0: idle, walk, run, jump, swim, combat, on a humanoid rig)
  as the base set, and the CMU Graphics Lab database (free for commercial
  products, the raw data may not be resold) for anything more. Not
  suitable: Mixamo (not open; its files may not be redistributed) and the
  Bandai Namco research set (non-commercial licence).
- [ ] Retarget the clips to the Synty skeleton offline (bone map + rest
      pose correction) into an animation GLB. Every clip is normalised the
      same way (in place, same facing, marked foot contacts) so any clip
      can follow any other.
- [ ] **Chaining — fluid transitions between any clips**, so a few dozen
      clips cover far more actions:
  - an animation graph per character: states (idle, locomotion, jump,
    swim, fly, actions) and transitions with crossfades timed to the
    clips (a walk hands over to a run on the matching footfall);
  - blend spaces: walk / jog / run blended by speed, strafes by
    direction, instead of one clip per speed;
  - layers: the upper body plays an action (swing, cast, wave) while the
    legs keep walking, masked by bone;
  - sequences: chain clips into combos and emotes (wind-up → strike →
    recover), where each link can branch (the next attack, or a return to
    idle) — data, not code, so new moves are authored, not programmed;
  - inertial blending when an interruption can't wait for a crossfade
    (hit, stagger), so nothing ever snaps.
- [ ] The server stays authoritative for *what* happens (state, action,
      timing); clients choose how it looks. An action carries its state
      and start tick, so every client plays the same chain in step.

## Phase E — Enemies

- [ ] Enemy humans: the server generates appearances from the same
      catalog (armour sets by faction / tier) and spawns them like players.
- [ ] Monsters: pack characters spawned as they are, animated with the
      same retargeted clips (they share the humanoid skeleton).

**Verify:** create a character in the browser, log out and back in and
see the same character; a second client sees it too; animations follow
movement (walk, run, jump, swim, fly).
