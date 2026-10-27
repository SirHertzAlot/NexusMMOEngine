# Mesh2Motion clip set — retargeting grades

**Final adoption verdict: ADOPT-WITH-FIXES**

Graded 2026-10-23. Every clip in the fetched set was run through the retargeting pipeline against the engine's character rig and graded **pass / fix / reject** on retargeting quality only.

## The verdict, in short

- **251 clips graded: 175 pass, 3 fix, 73 reject.**
- The human library — the actual adoption candidate — is **178 clips: 175 pass, 3 fix, 0 reject**. Every human clip retargeted successfully; typical limb-direction error vs the source motion is under half a degree.
- The **3 fix clips** are named below: two dip their hips below the floor and need a ground offset at intake; one has a single sampled instant with a large limb-direction spike and should be eyeballed before shipping.
- All **73 rejects are the creature files** (bird, dragon, fox, horse, kaiju, shark, snake, spider). Their skeletons are not humanoid, so they cannot be retargeted onto the character rig at all — this is a rig mismatch, not a quality defect in the clips. They would only become usable with matching creature rigs, which the engine does not have.
- One structural loss applies to every human clip and is a property of **our** rig, not of Mesh2Motion: the rig moves middle/ring/little fingers as a single Finger chain, so the source's separate pinky and ring finger bones (12 of 66) have nowhere to go. Index, thumb and the combined finger chain all retarget. If per-finger detail ever matters, that is a rig upgrade, not a clip problem.

**Failing / fix clips (complete list):**

| File | Clip | Grade | Why |
|---|---|---|---|
| human-addon-animations.glb | Zombie_Rise | fix | hips dip to -0.397 m — below the floor; needs a ground offset at intake |
| human-base-animations.glb | Hit_Knockback_RM | fix | hips dip to -0.239 m — below the floor; needs a ground offset at intake |
| human-base-animations.glb | Sword_Regular_B | fix | peak limb-direction error 64.04° at one sampled instant |

All other non-pass entries are the creature clips listed per file below — every one is a reject for the same reason: non-humanoid skeleton.

## What was fetched

- Source: `github.com/Mesh2Motion/mesh2motion-app` (HEAD `653a9698f5f315523072f1c3ff3496100401317b`), the `.glb` library under `static/animations/` — 11 files, 18 MB total, stored at `~/workspace/mesh2motion-assets/` (outside the engine repo; nothing was committed anywhere). The repo's `LICENSE-CC0.MD` was fetched alongside; licensing was already verified and is not judged here.
- The upstream `static/animations/CarnegieMellonAnimations/` subfolder (7 FBX files) is Carnegie Mellon mocap material, not part of Mesh2Motion's GLB clip library, and was not fetched or graded.
- No clip file was modified; grading is read-only.

## Method

- **Runner:** the engine's production bake retargeter (`packages/art/src/convert/retarget.ts`, class `Retargeter`) — the same code `convert-animations` uses to bring animation libraries onto the character rig — driven with `MANNEQUIN_MAP`, the bone map that pipeline already uses for the other UE-mannequin library (UAL2), with one correction: Mesh2Motion spells its head bone `head` where UAL2 uses `Head`. Mesh2Motion's human skeleton is the UE mannequin layout (pelvis, spine_01–03, neck_01, clavicle/upperarm/lowerarm/hand, thigh/calf/foot/ball), so this is the map written for exactly this skeleton family.
- **Why not only the Oct 19 client utility** (`apps/client/src/render/character/retarget.ts`): it is a per-clip runtime helper whose `buildBoneMap` matches bones by normalized name. Run as a cross-check, it finds only **16 of 66** Mesh2Motion bones — it cannot know that `upperarm_l` is our `Shoulder_L` — so on its own it would silently drop most of every clip. It was used here as the coverage cross-check; the grades come from the bake retargeter with the explicit map. (Intake implication: add Mesh2Motion to `ANIMATION_SOURCES` with the mannequin map, like UAL2 — do not rely on name-matching.)
- **Target rig caveat:** the converted `rig.glb` is not on this machine (`convert:modular` has never run here and the Synty source FBX is not in the workspace), so the target skeleton was rebuilt procedurally with the exact bone names and hierarchy the engine's own maps define — the same approach as the engine's own `packages/art/test/retarget.test.ts` — at standard human proportions in metres. The retargeter is rest-pose-agnostic by design (it aligns bones by direction), so grades measure name/hierarchy mapping and motion transfer, not millimetre-exact bind-pose differences. Every one of the 40 animation-driven target bones found its source bone (`missing = []` for all three human files); the rig's remaining bones are not animation-driven.
- **Per-clip measurements:** retarget at 30 fps, then sample 9 instants across the clip posing both source and target: mean/peak angular error of 12 limb-segment world directions (shoulders, elbows, hips, knees, spine) vs the source; hips height range; finiteness of all output values; share of animated core bones (excluding leaf tips and the root-motion node) that map onto the rig. Human clips: animated-core coverage is 0.769 for every clip — the unmapped remainder is exactly the pinky+ring chains described above.
- **Grades:** *pass* = clean transfer (mean error ≤ 6°, no floor penetration, coverage ≥ 70% of animated core bones). *fix* = transfers, but with a named defect: hips below floor, a peak direction spike > 30°, or coverage 55–70%. *reject* = cannot be used on this rig: retarget failure, non-finite output, mean error > 12°, or < 55% coverage (all creature clips). Large hips height *above* rest (backflips, jumps, drops) is the clip's own authored airtime transferred faithfully and is noted, not penalised.

## Results by file

| File | Clips | Pass | Fix | Reject | Notes |
|---|---:|---:|---:|---:|---|
| bird-animations.glb | 5 | 0 | 0 | 5 | non-humanoid, 55 bones; client-utility auto-map 6/55 |
| dragon-animations.glb | 5 | 0 | 0 | 5 | non-humanoid, 100 bones; client-utility auto-map 4/100 |
| fox-animations.glb | 14 | 0 | 0 | 14 | non-humanoid, 49 bones; client-utility auto-map 2/49 |
| horse-animations.glb | 14 | 0 | 0 | 14 | non-humanoid, 56 bones; client-utility auto-map 2/56 |
| human-addon-animations.glb | 75 | 74 | 1 | 0 | humanoid mannequin rig, 66 bones; retarget scale 1.123; client-utility auto-map 16/66 |
| human-base-animations.glb | 87 | 85 | 2 | 0 | humanoid mannequin rig, 66 bones; retarget scale 1.122; client-utility auto-map 16/66 |
| human-mocap-animations.glb | 16 | 16 | 0 | 0 | humanoid mannequin rig, 66 bones; retarget scale 1.123; client-utility auto-map 16/66 |
| kaiju-animations.glb | 10 | 0 | 0 | 10 | non-humanoid, 58 bones; client-utility auto-map 8/58 |
| shark-animations.glb | 7 | 0 | 0 | 7 | non-humanoid, 33 bones; client-utility auto-map 2/33 |
| snake-animations.glb | 8 | 0 | 0 | 8 | non-humanoid, 28 bones; client-utility auto-map 2/28 |
| spider-animations.glb | 10 | 0 | 0 | 10 | non-humanoid, 56 bones; client-utility auto-map 2/56 |
| **Total** | **251** | **175** | **3** | **73** | |

## human-addon-animations.glb — 75 clips

Mean/peak limb-direction error is vs the source clip's own pose at the same instant. Hips range is the retargeted hips height (rest = 1.02 m).

| Clip | Dur | Grade | Mean/peak err | Detail |
|---|---:|---|---|---|
| Angry | 0.83s | pass | 0.63° / 8.13° | hips 0.929…0.931 m; clean retarget: mean limb error 0.63°, coverage 77% of animated core bones |
| Attack_Ground_Pound | 2.71s | pass | 0.36° / 3.61° | hips 0.458…0.919 m; clean retarget: mean limb error 0.36°, coverage 77% of animated core bones |
| Backflip | 2.5s | pass | 0.53° / 3.84° | hips 0.662…3.046 m; clean retarget: mean limb error 0.53°, coverage 77% of animated core bones (large authored airtime: hips peak at 3.046 m (3.0x rest height), faithful to the source clip) |
| Bow | 3.75s | pass | 0.15° / 2.09° | hips 1.02…1.02 m; clean retarget: mean limb error 0.15°, coverage 77% of animated core bones |
| Bow Pull Back | 1.25s | pass | 0.16° / 0.8° | hips 0.996…0.996 m; clean retarget: mean limb error 0.16°, coverage 77% of animated core bones |
| Bow Pull Hold | 0.25s | pass | 0.17° / 0.8° | hips 0.996…0.996 m; clean retarget: mean limb error 0.17°, coverage 77% of animated core bones |
| Bow Release | 0.5s | pass | 0.18° / 0.8° | hips 0.996…0.996 m; clean retarget: mean limb error 0.18°, coverage 77% of animated core bones |
| Climb Ladder | 3.63s | pass | 0.49° / 2.65° | hips 0.941…0.976 m; clean retarget: mean limb error 0.49°, coverage 77% of animated core bones |
| Climb Wall | 2.08s | pass | 0.56° / 4.92° | hips 0.995…1.05 m; clean retarget: mean limb error 0.56°, coverage 77% of animated core bones |
| Confused | 2.92s | pass | 0.18° / 1.22° | hips 1…1.02 m; clean retarget: mean limb error 0.18°, coverage 77% of animated core bones |
| Consume Item | 4.17s | pass | 0.25° / 1.69° | hips 0.913…0.955 m; clean retarget: mean limb error 0.25°, coverage 77% of animated core bones |
| Crawl | 1.71s | pass | 0.44° / 3.38° | hips 0.174…0.237 m; clean retarget: mean limb error 0.44°, coverage 77% of animated core bones |
| Crawl RM | 1.71s | pass | 0.44° / 3.38° | hips 0.174…0.343 m; clean retarget: mean limb error 0.44°, coverage 77% of animated core bones |
| Dance Body Roll | 6.5s | pass | 0.3° / 1.88° | hips 0.744…0.991 m; clean retarget: mean limb error 0.3°, coverage 77% of animated core bones |
| Dance Charleston | 2.33s | pass | 0.5° / 2.46° | hips 0.835…0.871 m; clean retarget: mean limb error 0.5°, coverage 77% of animated core bones |
| Dance Reach Hip | 2.54s | pass | 0.38° / 2.31° | hips 0.759…1.031 m; clean retarget: mean limb error 0.38°, coverage 77% of animated core bones |
| Death_A | 4.5s | pass | 0.26° / 2.57° | hips 0.243…0.989 m; clean retarget: mean limb error 0.26°, coverage 77% of animated core bones |
| Death_B | 1.88s | pass | 0.38° / 3.17° | hips 0.226…1.127 m; clean retarget: mean limb error 0.38°, coverage 77% of animated core bones |
| Death_C | 2.21s | pass | 0.28° / 2.05° | hips 0.089…1.029 m; clean retarget: mean limb error 0.28°, coverage 77% of animated core bones |
| Defend | 0.96s | pass | 0.28° / 2.07° | hips 0.698…0.718 m; clean retarget: mean limb error 0.28°, coverage 77% of animated core bones |
| Dizzy | 2.42s | pass | 0.34° / 2.3° | hips 0.904…0.928 m; clean retarget: mean limb error 0.34°, coverage 77% of animated core bones |
| Dodge_back | 1s | pass | 0.64° / 2.91° | hips 0.629…0.901 m; clean retarget: mean limb error 0.64°, coverage 77% of animated core bones |
| Dodge_back_RM | 1s | pass | 0.64° / 2.91° | hips 0.566…0.882 m; clean retarget: mean limb error 0.64°, coverage 77% of animated core bones |
| Dodge_left | 0.83s | pass | 0.67° / 4.65° | hips 0.725…0.919 m; clean retarget: mean limb error 0.67°, coverage 77% of animated core bones |
| Dodge_left_RM | 0.83s | pass | 0.67° / 4.65° | hips 0.725…0.919 m; clean retarget: mean limb error 0.67°, coverage 77% of animated core bones |
| Dodge_right | 0.83s | pass | 0.67° / 4.65° | hips 0.725…0.919 m; clean retarget: mean limb error 0.67°, coverage 77% of animated core bones |
| Dodge_right_RM | 0.83s | pass | 0.67° / 4.65° | hips 0.725…0.919 m; clean retarget: mean limb error 0.67°, coverage 77% of animated core bones |
| Fighting Idle | 1.71s | pass | 0.16° / 0.69° | hips 0.936…0.946 m; clean retarget: mean limb error 0.16°, coverage 77% of animated core bones |
| Fighting Left Jab | 0.92s | pass | 0.43° / 2.87° | hips 0.871…0.872 m; clean retarget: mean limb error 0.43°, coverage 77% of animated core bones |
| Fighting Right Jab | 0.92s | pass | 0.24° / 1.1° | hips 0.871…0.919 m; clean retarget: mean limb error 0.24°, coverage 77% of animated core bones |
| Flying Forward | 0.5s | pass | 0.16° / 0.94° | hips 1.427…1.432 m; clean retarget: mean limb error 0.16°, coverage 77% of animated core bones |
| Flying Forward Super | 0.5s | pass | 0.17° / 0.94° | hips 1.427…1.432 m; clean retarget: mean limb error 0.17°, coverage 77% of animated core bones |
| Glide | 0.79s | pass | 0.21° / 0.82° | hips 1.057…1.073 m; clean retarget: mean limb error 0.21°, coverage 77% of animated core bones |
| Greeting | 4.83s | pass | 0.1° / 0.82° | hips 1.01…1.012 m; clean retarget: mean limb error 0.1°, coverage 77% of animated core bones |
| Head Nod | 0.88s | pass | 0.18° / 0.82° | hips 0.991…0.991 m; clean retarget: mean limb error 0.18°, coverage 77% of animated core bones |
| Idle Hurt | 1.67s | pass | 0.2° / 1.11° | hips 0.888…0.901 m; clean retarget: mean limb error 0.2°, coverage 77% of animated core bones |
| Idle Listening | 1.71s | pass | 0.19° / 0.92° | hips 0.978…0.983 m; clean retarget: mean limb error 0.19°, coverage 77% of animated core bones |
| Idle_Subtle | 2.58s | pass | 0.18° / 0.76° | hips 0.973…0.983 m; clean retarget: mean limb error 0.18°, coverage 77% of animated core bones |
| Jump_2 | 1.63s | pass | 0.49° / 5.9° | hips 0.792…1.143 m; clean retarget: mean limb error 0.49°, coverage 77% of animated core bones |
| Jump_2_RM | 1.63s | pass | 0.49° / 5.9° | hips 0.792…2.763 m; clean retarget: mean limb error 0.49°, coverage 77% of animated core bones (large authored airtime: hips peak at 2.763 m (2.7x rest height), faithful to the source clip) |
| Jumping Jacks | 1.25s | pass | 0.22° / 1.1° | hips 0.881…1.197 m; clean retarget: mean limb error 0.22°, coverage 77% of animated core bones |
| Kneeling Tired | 0.83s | pass | 0.68° / 2.83° | hips 0.456…0.457 m; clean retarget: mean limb error 0.68°, coverage 77% of animated core bones |
| Ladder_Idle | 2.5s | pass | 0.34° / 1.89° | hips 0.962…0.979 m; clean retarget: mean limb error 0.34°, coverage 77% of animated core bones |
| Land_Three_Point | 1.38s | pass | 0.48° / 3.61° | hips 0.435…5.331 m; clean retarget: mean limb error 0.48°, coverage 77% of animated core bones (large authored airtime: hips peak at 5.331 m (5.2x rest height), faithful to the source clip) |
| Ledge Hang | 1.92s | pass | 0.19° / 0.95° | hips 1.02…1.035 m; clean retarget: mean limb error 0.19°, coverage 77% of animated core bones |
| Levitate Entrance | 2s | pass | 0.29° / 2.87° | hips 1.274…1.36 m; clean retarget: mean limb error 0.29°, coverage 77% of animated core bones |
| Levitate Idle | 2s | pass | 0.23° / 1.34° | hips 1.284…1.364 m; clean retarget: mean limb error 0.23°, coverage 77% of animated core bones |
| Meditate | 1.5s | pass | 0.75° / 5.11° | hips 0.009…0.009 m; clean retarget: mean limb error 0.75°, coverage 77% of animated core bones |
| Pipe Climb | 1.88s | pass | 0.46° / 4.94° | hips 0.932…0.977 m; clean retarget: mean limb error 0.46°, coverage 77% of animated core bones |
| Power Up | 0.75s | pass | 0.49° / 1.99° | hips 0.652…0.666 m; clean retarget: mean limb error 0.49°, coverage 77% of animated core bones |
| Pushup | 1.54s | pass | 0.13° / 0.88° | hips 0.339…0.494 m; clean retarget: mean limb error 0.13°, coverage 77% of animated core bones |
| Reject | 3.79s | pass | 0.15° / 0.82° | hips 1.012…1.02 m; clean retarget: mean limb error 0.15°, coverage 77% of animated core bones |
| Rest Pose | 0.42s | pass | 0.12° / 0.82° | hips 1.02…1.02 m; clean retarget: mean limb error 0.12°, coverage 77% of animated core bones |
| Run Jump | 1.25s | pass | 0.31° / 2.52° | hips 0.781…0.781 m; clean retarget: mean limb error 0.31°, coverage 77% of animated core bones |
| Run_Anime | 0.75s | pass | 0.71° / 5.93° | hips 0.741…0.848 m; clean retarget: mean limb error 0.71°, coverage 77% of animated core bones |
| Run_Female | 0.83s | pass | 0.72° / 6.22° | hips 0.918…1.021 m; clean retarget: mean limb error 0.72°, coverage 77% of animated core bones |
| Run_Stealth | 0.54s | pass | 0.58° / 4.99° | hips 0.727…0.764 m; clean retarget: mean limb error 0.58°, coverage 77% of animated core bones |
| Shivering | 0.25s | pass | 0.32° / 1.14° | hips 0.845…0.845 m; clean retarget: mean limb error 0.32°, coverage 77% of animated core bones |
| Sleeping | 1.67s | pass | 0.12° / 0.56° | hips 0.076…0.076 m; clean retarget: mean limb error 0.12°, coverage 77% of animated core bones |
| Strafe_left | 1s | pass | 0.23° / 1.19° | hips 0.951…0.983 m; clean retarget: mean limb error 0.23°, coverage 77% of animated core bones |
| Strafe_right | 1s | pass | 0.24° / 1.19° | hips 0.951…0.983 m; clean retarget: mean limb error 0.24°, coverage 77% of animated core bones |
| Sword_Attack_Air_Vertical | 4.83s | pass | 0.37° / 5.94° | hips 1.001…1.021 m; clean retarget: mean limb error 0.37°, coverage 77% of animated core bones |
| Throw Object | 1.88s | pass | 0.35° / 2.38° | hips 0.864…0.94 m; clean retarget: mean limb error 0.35°, coverage 77% of animated core bones |
| Tired Hunched | 1.04s | pass | 0.56° / 3.29° | hips 0.494…0.495 m; clean retarget: mean limb error 0.56°, coverage 77% of animated core bones |
| Two-hand Blast | 0.46s | pass | 0.61° / 2.34° | hips 0.671…0.679 m; clean retarget: mean limb error 0.61°, coverage 77% of animated core bones |
| Victory | 1.67s | pass | 0.6° / 9.95° | hips 0.967…1.568 m; clean retarget: mean limb error 0.6°, coverage 77% of animated core bones |
| Victory Fist Pump | 2.25s | pass | 0.19° / 0.85° | hips 0.979…1.005 m; clean retarget: mean limb error 0.19°, coverage 77% of animated core bones |
| Walk_Backwards | 1s | pass | 0.26° / 1.49° | hips 0.95…0.975 m; clean retarget: mean limb error 0.26°, coverage 77% of animated core bones |
| Walk_Female | 1.38s | pass | 0.21° / 1.24° | hips 0.966…1.018 m; clean retarget: mean limb error 0.21°, coverage 77% of animated core bones |
| Walk_Large | 1.42s | pass | 0.32° / 1.67° | hips 0.824…0.963 m; clean retarget: mean limb error 0.32°, coverage 77% of animated core bones |
| Walk_Stealth | 1.5s | pass | 0.3° / 2.1° | hips 0.868…0.868 m; clean retarget: mean limb error 0.3°, coverage 77% of animated core bones |
| Zombie Yell | 3.71s | pass | 0.36° / 2.46° | hips 0.841…0.893 m; clean retarget: mean limb error 0.36°, coverage 77% of animated core bones |
| Zombie_Idle_Crouch | 2.96s | pass | 0.73° / 3.63° | hips 0.546…0.576 m; clean retarget: mean limb error 0.73°, coverage 77% of animated core bones |
| Zombie_Rise | 3.38s | fix | 0.54° / 4.63° | hips -0.397…0.876 m; hips dip to -0.397 m — below the floor; needs a ground offset at intake |
| Zombie_Walk_2 | 2.92s | pass | 0.35° / 2.28° | hips 0.728…0.963 m; clean retarget: mean limb error 0.35°, coverage 77% of animated core bones |

## human-base-animations.glb — 87 clips

Mean/peak limb-direction error is vs the source clip's own pose at the same instant. Hips range is the retargeted hips height (rest = 1.02 m).

| Clip | Dur | Grade | Mean/peak err | Detail |
|---|---:|---|---|---|
| Chest_Open | 1.38s | pass | 0.2° / 1.14° | hips 0.906…0.972 m; clean retarget: mean limb error 0.2°, coverage 77% of animated core bones |
| Chop_Tree | 0.96s | pass | 0.38° / 3.14° | hips 0.851…0.869 m; clean retarget: mean limb error 0.38°, coverage 77% of animated core bones |
| ClimbUp_1m_RM | 0.67s | pass | 1.01° / 10.02° | hips 0.921…2.177 m; clean retarget: mean limb error 1.01°, coverage 77% of animated core bones (large authored airtime: hips peak at 2.177 m (2.1x rest height), faithful to the source clip) |
| Consume | 1.33s | pass | 0.16° / 1.13° | hips 0.972…0.972 m; clean retarget: mean limb error 0.16°, coverage 77% of animated core bones |
| Crouch_Idle | 3.67s | pass | 0.69° / 4.63° | hips 0.498…0.506 m; clean retarget: mean limb error 0.69°, coverage 77% of animated core bones |
| Crouch_Walk | 2.5s | pass | 0.68° / 4.74° | hips 0.494…0.56 m; clean retarget: mean limb error 0.68°, coverage 77% of animated core bones |
| Dance_Simple | 1.25s | pass | 0.26° / 1.48° | hips 0.936…1.007 m; clean retarget: mean limb error 0.26°, coverage 77% of animated core bones |
| Death_D | 2.17s | pass | 0.32° / 2.98° | hips 0.01…0.972 m; clean retarget: mean limb error 0.32°, coverage 77% of animated core bones |
| Driving | 2.08s | pass | 0.4° / 1.83° | hips 0.574…0.574 m; clean retarget: mean limb error 0.4°, coverage 77% of animated core bones |
| Farm_Harvest | 2.33s | pass | 0.35° / 2.04° | hips 0.778…0.972 m; clean retarget: mean limb error 0.35°, coverage 77% of animated core bones |
| Farm_PlantSeed | 2.79s | pass | 0.54° / 4.97° | hips 0.418…0.972 m; clean retarget: mean limb error 0.54°, coverage 77% of animated core bones |
| Farm_Watering | 3.83s | pass | 0.18° / 1.13° | hips 0.963…0.972 m; clean retarget: mean limb error 0.18°, coverage 77% of animated core bones |
| Fixing_Kneeling | 6.5s | pass | 0.49° / 4.57° | hips 0.452…0.972 m; clean retarget: mean limb error 0.49°, coverage 77% of animated core bones |
| Hit_Chest | 0.42s | pass | 0.56° / 7.87° | hips 1.58…1.6 m; clean retarget: mean limb error 0.56°, coverage 77% of animated core bones |
| Hit_Head | 0.54s | pass | 0.16° / 1.38° | hips 0.967…0.972 m; clean retarget: mean limb error 0.16°, coverage 77% of animated core bones |
| Hit_Knockback | 0.83s | pass | 0.93° / 7.67° | hips 0.048…0.919 m; clean retarget: mean limb error 0.93°, coverage 77% of animated core bones |
| Hit_Knockback_RM | 0.63s | fix | 0.66° / 3.18° | hips -0.239…0.831 m; hips dip to -0.239 m — below the floor; needs a ground offset at intake |
| Idle_A | 3.13s | pass | 0.17° / 1.17° | hips 0.963…0.972 m; clean retarget: mean limb error 0.17°, coverage 77% of animated core bones |
| Idle_FoldArms | 2.5s | pass | 0.17° / 1.17° | hips 0.963…0.972 m; clean retarget: mean limb error 0.17°, coverage 77% of animated core bones |
| Idle_Lantern | 2.5s | pass | 0.17° / 1.17° | hips 0.963…0.972 m; clean retarget: mean limb error 0.17°, coverage 77% of animated core bones |
| Idle_Rail | 2.5s | pass | 0.17° / 1.18° | hips 0.985…0.987 m; clean retarget: mean limb error 0.17°, coverage 77% of animated core bones |
| Idle_Rail_Call | 2.5s | pass | 0.17° / 1.19° | hips 0.985…0.987 m; clean retarget: mean limb error 0.17°, coverage 77% of animated core bones |
| Idle_ShakeOff | 2.5s | pass | 0.21° / 2.09° | hips 0.963…0.972 m; clean retarget: mean limb error 0.21°, coverage 77% of animated core bones |
| Idle_Shield | 2.5s | pass | 0.17° / 1.17° | hips 0.963…0.972 m; clean retarget: mean limb error 0.17°, coverage 77% of animated core bones |
| Idle_Shield_Break | 1.08s | pass | 0.23° / 1.52° | hips 0.902…0.972 m; clean retarget: mean limb error 0.23°, coverage 77% of animated core bones |
| Idle_Sword | 2.08s | pass | 0.34° / 1.44° | hips 0.804…0.834 m; clean retarget: mean limb error 0.34°, coverage 77% of animated core bones |
| Idle_Talking | 3.67s | pass | 0.17° / 1.23° | hips 0.965…0.971 m; clean retarget: mean limb error 0.17°, coverage 77% of animated core bones |
| Idle_TalkingPhone | 2.92s | pass | 0.17° / 1.22° | hips 0.965…0.971 m; clean retarget: mean limb error 0.17°, coverage 77% of animated core bones |
| Idle_Torch | 1.58s | pass | 0.17° / 1.17° | hips 0.963…0.972 m; clean retarget: mean limb error 0.17°, coverage 77% of animated core bones |
| Interact | 2.5s | pass | 0.17° / 1.17° | hips 0.963…0.973 m; clean retarget: mean limb error 0.17°, coverage 77% of animated core bones |
| Jog | 1.17s | pass | 0.59° / 9.27° | hips 0.793…1.041 m; clean retarget: mean limb error 0.59°, coverage 77% of animated core bones |
| Jump_air | 3.13s | pass | 0.41° / 2.99° | hips 0.962…0.962 m; clean retarget: mean limb error 0.41°, coverage 77% of animated core bones |
| Jump_Land | 1.58s | pass | 0.31° / 4.04° | hips 0.477…1.027 m; clean retarget: mean limb error 0.31°, coverage 77% of animated core bones |
| Jump_Start | 1.67s | pass | 0.61° / 5.09° | hips 0.568…0.976 m; clean retarget: mean limb error 0.61°, coverage 77% of animated core bones |
| LayToIdle | 1.5s | pass | 0.58° / 3.75° | hips 0.007…0.965 m; clean retarget: mean limb error 0.58°, coverage 77% of animated core bones |
| Melee_Hook | 0.46s | pass | 1.08° / 8.59° | hips 0.558…0.847 m; clean retarget: mean limb error 1.08°, coverage 77% of animated core bones |
| Melee_Hook_Rec | 0.58s | pass | 0.47° / 2.75° | hips 0.648…0.915 m; clean retarget: mean limb error 0.47°, coverage 77% of animated core bones |
| NinjaJump_Idle | 2s | pass | 1.76° / 11.13° | hips 0.974…0.977 m; clean retarget: mean limb error 1.76°, coverage 77% of animated core bones |
| NinjaJump_Land | 1.25s | pass | 0.49° / 10.65° | hips 0.481…0.977 m; clean retarget: mean limb error 0.49°, coverage 77% of animated core bones |
| NinjaJump_Start | 0.96s | pass | 1.48° / 10.65° | hips 0.568…0.986 m; clean retarget: mean limb error 1.48°, coverage 77% of animated core bones |
| OverhandThrow | 1.33s | pass | 0.28° / 2.6° | hips 0.725…0.972 m; clean retarget: mean limb error 0.28°, coverage 77% of animated core bones |
| PickUp_Table | 1.04s | pass | 0.2° / 1.15° | hips 0.972…0.984 m; clean retarget: mean limb error 0.2°, coverage 77% of animated core bones |
| Pistol_Aim_Down | 0.21s | pass | 0.17° / 0.82° | hips 0.972…0.972 m; clean retarget: mean limb error 0.17°, coverage 77% of animated core bones |
| Pistol_Aim_Neutral | 0.21s | pass | 0.2° / 1.67° | hips 0.972…0.972 m; clean retarget: mean limb error 0.2°, coverage 77% of animated core bones |
| Pistol_Aim_Up | 0.21s | pass | 0.24° / 1.9° | hips 0.972…0.972 m; clean retarget: mean limb error 0.24°, coverage 77% of animated core bones |
| Pistol_Idle | 2.08s | pass | 0.2° / 1.67° | hips 0.972…0.972 m; clean retarget: mean limb error 0.2°, coverage 77% of animated core bones |
| Pistol_Reload | 2.08s | pass | 0.24° / 1.67° | hips 0.972…0.972 m; clean retarget: mean limb error 0.24°, coverage 77% of animated core bones |
| Pistol_Shoot | 0.79s | pass | 0.2° / 1.67° | hips 0.972…0.972 m; clean retarget: mean limb error 0.2°, coverage 77% of animated core bones |
| Punch_Cross | 1.25s | pass | 0.27° / 1.35° | hips 0.92…0.951 m; clean retarget: mean limb error 0.27°, coverage 77% of animated core bones |
| Punch_Jab | 1.08s | pass | 0.28° / 1.48° | hips 0.919…0.928 m; clean retarget: mean limb error 0.28°, coverage 77% of animated core bones |
| Push | 3.33s | pass | 0.43° / 2.39° | hips 0.726…0.78 m; clean retarget: mean limb error 0.43°, coverage 77% of animated core bones |
| Roll | 1.83s | pass | 0.54° / 5.52° | hips 0.084…1.191 m; clean retarget: mean limb error 0.54°, coverage 77% of animated core bones |
| Roll_RM | 1.83s | pass | 0.54° / 5.52° | hips 0.484…1.445 m; clean retarget: mean limb error 0.54°, coverage 77% of animated core bones |
| Shield_Dash_RM | 1.08s | pass | 0.41° / 2.91° | hips 0.537…1.067 m; clean retarget: mean limb error 0.41°, coverage 77% of animated core bones |
| Shield_OneShot | 0.83s | pass | 0.25° / 2.26° | hips 0.921…0.972 m; clean retarget: mean limb error 0.25°, coverage 77% of animated core bones |
| Sitting_Enter | 1.63s | pass | 0.33° / 1.84° | hips 0.574…0.972 m; clean retarget: mean limb error 0.33°, coverage 77% of animated core bones |
| Sitting_Exit | 1.29s | pass | 0.31° / 1.84° | hips 0.574…0.972 m; clean retarget: mean limb error 0.31°, coverage 77% of animated core bones |
| Sitting_Idle | 2.08s | pass | 0.4° / 1.84° | hips 0.574…0.574 m; clean retarget: mean limb error 0.4°, coverage 77% of animated core bones |
| Sitting_Talking | 3.67s | pass | 0.41° / 1.84° | hips 0.574…0.574 m; clean retarget: mean limb error 0.41°, coverage 77% of animated core bones |
| Slide | 2s | pass | 0.47° / 4.38° | hips 0.052…0.065 m; clean retarget: mean limb error 0.47°, coverage 77% of animated core bones |
| Slide_Exit | 0.5s | pass | 0.98° / 7.27° | hips 0.055…0.921 m; clean retarget: mean limb error 0.98°, coverage 77% of animated core bones |
| Slide_Start | 0.83s | pass | 0.68° / 5.79° | hips 0.066…0.921 m; clean retarget: mean limb error 0.68°, coverage 77% of animated core bones |
| Spell_Simple_Enter | 0.67s | pass | 0.37° / 8.11° | hips 0.972…0.972 m; clean retarget: mean limb error 0.37°, coverage 77% of animated core bones |
| Spell_Simple_Exit | 0.54s | pass | 0.67° / 20.85° | hips 0.973…0.973 m; clean retarget: mean limb error 0.67°, coverage 77% of animated core bones |
| Spell_Simple_Idle | 2.67s | pass | 0.17° / 1.21° | hips 0.968…0.973 m; clean retarget: mean limb error 0.17°, coverage 77% of animated core bones |
| Spell_Simple_Shoot | 0.63s | pass | 0.18° / 1.22° | hips 0.967…0.973 m; clean retarget: mean limb error 0.18°, coverage 77% of animated core bones |
| Sprint | 0.83s | pass | 0.67° / 7.38° | hips 0.888…1.029 m; clean retarget: mean limb error 0.67°, coverage 77% of animated core bones |
| Swim_Fwd | 1.67s | pass | 0.45° / 3.06° | hips 1.097…1.113 m; clean retarget: mean limb error 0.45°, coverage 77% of animated core bones |
| Swim_Idle | 4.17s | pass | 0.23° / 1.58° | hips 0.908…1.02 m; clean retarget: mean limb error 0.23°, coverage 77% of animated core bones |
| Sword_Attack | 1.92s | pass | 0.41° / 2.53° | hips 0.59…0.856 m; clean retarget: mean limb error 0.41°, coverage 77% of animated core bones |
| Sword_Attack_RM | 1.92s | pass | 0.41° / 2.53° | hips 0.674…0.981 m; clean retarget: mean limb error 0.41°, coverage 77% of animated core bones |
| Sword_Block | 1.25s | pass | 0.32° / 2.13° | hips 0.705…0.967 m; clean retarget: mean limb error 0.32°, coverage 77% of animated core bones |
| Sword_Dash_RM | 1.58s | pass | 0.4° / 3.69° | hips 0.56…1.031 m; clean retarget: mean limb error 0.4°, coverage 77% of animated core bones |
| Sword_Regular_A | 0.46s | pass | 0.77° / 7.59° | hips 0.711…0.967 m; clean retarget: mean limb error 0.77°, coverage 77% of animated core bones |
| Sword_Regular_A_Rec | 0.96s | pass | 0.39° / 2.65° | hips 0.708…1.078 m; clean retarget: mean limb error 0.39°, coverage 77% of animated core bones |
| Sword_Regular_B | 0.54s | fix | 3.17° / 64.04° | hips 0.612…0.706 m; peak limb-direction error 64.04° at one sampled instant |
| Sword_Regular_B_Rec | 1s | pass | 0.48° / 2.89° | hips 0.661…1.07 m; clean retarget: mean limb error 0.48°, coverage 77% of animated core bones |
| Sword_Regular_C | 1.67s | pass | 0.88° / 9.53° | hips 0.631…1.032 m; clean retarget: mean limb error 0.88°, coverage 77% of animated core bones |
| Sword_Regular_C_RM | 1.67s | pass | 0.87° / 9.52° | hips 0.699…1.16 m; clean retarget: mean limb error 0.87°, coverage 77% of animated core bones |
| Sword_Regular_Combo | 2.96s | pass | 0.59° / 6.22° | hips 0.662…1.162 m; clean retarget: mean limb error 0.59°, coverage 77% of animated core bones |
| Walk | 1.67s | pass | 0.27° / 2.01° | hips 0.969…1.015 m; clean retarget: mean limb error 0.27°, coverage 77% of animated core bones |
| Walk_Carry | 2s | pass | 0.27° / 1.68° | hips 0.884…0.978 m; clean retarget: mean limb error 0.27°, coverage 77% of animated core bones |
| Walk_Formal | 1.67s | pass | 0.27° / 2.06° | hips 0.973…1.01 m; clean retarget: mean limb error 0.27°, coverage 77% of animated core bones |
| Yes | 2.5s | pass | 0.16° / 1.17° | hips 0.965…0.989 m; clean retarget: mean limb error 0.16°, coverage 77% of animated core bones |
| Zombie_Idle | 1.33s | pass | 0.3° / 1.47° | hips 0.815…0.884 m; clean retarget: mean limb error 0.3°, coverage 77% of animated core bones |
| Zombie_Scratch | 1.79s | pass | 0.41° / 2.74° | hips 0.652…0.824 m; clean retarget: mean limb error 0.41°, coverage 77% of animated core bones |
| Zombie_Walk | 1.33s | pass | 0.27° / 1.98° | hips 0.812…0.921 m; clean retarget: mean limb error 0.27°, coverage 77% of animated core bones |

## human-mocap-animations.glb — 16 clips

Mean/peak limb-direction error is vs the source clip's own pose at the same instant. Hips range is the retargeted hips height (rest = 1.02 m).

| Clip | Dur | Grade | Mean/peak err | Detail |
|---|---:|---|---|---|
| Cheer_One_arm | 2.17s | pass | 0.19° / 0.9° | hips 0.983…0.984 m; clean retarget: mean limb error 0.19°, coverage 77% of animated core bones |
| Cheering_Two_Hands | 1.58s | pass | 0.24° / 1.07° | hips 0.947…0.97 m; clean retarget: mean limb error 0.24°, coverage 77% of animated core bones |
| Fishing_Cast | 2.95s | pass | 0.18° / 1.63° | hips 0.987…1.024 m; clean retarget: mean limb error 0.18°, coverage 77% of animated core bones |
| Fishing_Catch | 2.05s | pass | 0.18° / 1.54° | hips 0.997…1.043 m; clean retarget: mean limb error 0.18°, coverage 77% of animated core bones |
| Fishing_Reel | 1.45s | pass | 0.19° / 1.09° | hips 0.992…1.002 m; clean retarget: mean limb error 0.19°, coverage 77% of animated core bones |
| Golf_Drive | 3.1s | pass | 0.31° / 2.16° | hips 0.933…1.026 m; clean retarget: mean limb error 0.31°, coverage 77% of animated core bones |
| Golf_idle | 1.83s | pass | 0.17° / 0.91° | hips 1.001…1.005 m; clean retarget: mean limb error 0.17°, coverage 77% of animated core bones |
| Help_One_Arm | 2.67s | pass | 0.18° / 1.25° | hips 0.998…1.009 m; clean retarget: mean limb error 0.18°, coverage 77% of animated core bones |
| Help_Two_Arms | 1.58s | pass | 0.2° / 1.55° | hips 0.991…1.014 m; clean retarget: mean limb error 0.2°, coverage 77% of animated core bones |
| Insult | 2.78s | pass | 0.22° / 0.99° | hips 0.977…0.987 m; clean retarget: mean limb error 0.22°, coverage 77% of animated core bones |
| Kick_Breach | 1.83s | pass | 0.31° / 2.85° | hips 1.004…1.108 m; clean retarget: mean limb error 0.31°, coverage 77% of animated core bones |
| Salute | 4.38s | pass | 0.15° / 1.35° | hips 1.006…1.01 m; clean retarget: mean limb error 0.15°, coverage 77% of animated core bones |
| Turn_Left_180 | 2.12s | pass | 0.16° / 0.79° | hips 1.005…1.056 m; clean retarget: mean limb error 0.16°, coverage 77% of animated core bones |
| Turn_Left_90 | 2s | pass | 0.17° / 0.93° | hips 1.004…1.041 m; clean retarget: mean limb error 0.17°, coverage 77% of animated core bones |
| Turn_Right_180 | 1.48s | pass | 0.19° / 0.95° | hips 0.972…1.041 m; clean retarget: mean limb error 0.19°, coverage 77% of animated core bones |
| Turn_Right_90 | 2s | pass | 0.13° / 0.77° | hips 1.005…1.034 m; clean retarget: mean limb error 0.13°, coverage 77% of animated core bones |

## Creature files — all clips rejected for the humanoid rig

These skeletons (wings, quadruped legs, tails, serpentine chains) share almost no bone names with the humanoid map and have no pelvis anchor for the retargeter (the shark file does have a bone named `pelvis`, so the retargeter ran — but only 6% of its animated core bones correspond to humanoid bones, so every clip still rejects on coverage). The clips themselves are unjudged as creature animation; they simply cannot land on the character rig.

### bird-animations.glb — 5 clips, 55 bones

Non-humanoid skeleton (55 bones): no "pelvis" bone, so the retargeter cannot anchor it; 1 of 55 bone names coincide with the humanoid mannequin map. Client utility auto-map finds 6 name matches. Every clip graded reject for the humanoid rig.

| Clip | Dur | Grade | Detail |
|---|---:|---|---|
| Flap | 0.63s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Glide | 0.63s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Idle | 1.25s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Rest Pose | 0.42s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Walk | 0.5s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |

### dragon-animations.glb — 5 clips, 100 bones

Non-humanoid skeleton (100 bones): no "pelvis" bone, so the retargeter cannot anchor it; 1 of 100 bone names coincide with the humanoid mannequin map. Client utility auto-map finds 4 name matches. Every clip graded reject for the humanoid rig.

| Clip | Dur | Grade | Detail |
|---|---:|---|---|
| Fly Flap | 0.75s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Fly Glide | 2s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Idle | 2s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Rest Pose | 0.21s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Walk | 1.33s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |

### fox-animations.glb — 14 clips, 49 bones

Non-humanoid skeleton (49 bones): no "pelvis" bone, so the retargeter cannot anchor it; 0 of 49 bone names coincide with the humanoid mannequin map. Client utility auto-map finds 2 name matches. Every clip graded reject for the humanoid rig.

| Clip | Dur | Grade | Detail |
|---|---:|---|---|
| Bark | 2.8s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Bite | 0.87s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Death | 1.17s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Fall | 0.5s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Fetch | 1s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Howl | 2.33s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Idle | 1.33s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Idle Alert | 1.6s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Jump | 2.2s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Rest Pose | 0.33s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Run | 0.47s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Sit | 1.33s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Sneak | 1.3s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Walk | 1s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |

### horse-animations.glb — 14 clips, 56 bones

Non-humanoid skeleton (56 bones): no "pelvis" bone, so the retargeter cannot anchor it; 1 of 56 bone names coincide with the humanoid mannequin map. Client utility auto-map finds 2 name matches. Every clip graded reject for the humanoid rig.

| Clip | Dur | Grade | Detail |
|---|---:|---|---|
| Death | 1.4s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Eating | 2.67s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Head_But | 1s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Idle | 2.67s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Kick | 1.3s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| lay_to_idle | 2.67s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Rear | 2.93s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Rest_Pose | 0.17s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Run | 0.43s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Sleep | 2s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Trot | 0.7s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Turn_Left | 4.67s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Turn_Right | 4.67s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Walk | 0.97s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |

### kaiju-animations.glb — 10 clips, 58 bones

Non-humanoid skeleton (58 bones): no "pelvis" bone, so the retargeter cannot anchor it; 0 of 58 bone names coincide with the humanoid mannequin map. Client utility auto-map finds 8 name matches. Every clip graded reject for the humanoid rig.

| Clip | Dur | Grade | Detail |
|---|---:|---|---|
| Attack | 1.07s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Death | 4.53s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Hit | 0.9s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Idle | 2.37s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Rest Pose | 0.33s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Roar | 6.03s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Swim | 2.8s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Tail Attack | 2.73s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Walk | 3.1s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Walk RM | 3.37s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |

### shark-animations.glb — 7 clips, 33 bones

| Clip | Dur | Grade | Detail |
|---|---:|---|---|
| Bite | 3s | reject | only 6% of animated core bones map onto the rig (animated core-bone coverage 6%) |
| Dead Floating | 3.33s | reject | only 6% of animated core bones map onto the rig (animated core-bone coverage 6%) |
| Hit | 0.83s | reject | only 6% of animated core bones map onto the rig (animated core-bone coverage 6%) |
| Idle | 2.54s | reject | only 6% of animated core bones map onto the rig (animated core-bone coverage 6%) |
| Rest Pose | 0.21s | reject | only 6% of animated core bones map onto the rig (animated core-bone coverage 6%) |
| Swim Horizontal | 1.38s | reject | only 6% of animated core bones map onto the rig (animated core-bone coverage 6%) |
| Swim Vertical | 3.33s | reject | only 6% of animated core bones map onto the rig; hips sink to -1.7 m (far below floor) (animated core-bone coverage 6%) |

### snake-animations.glb — 8 clips, 28 bones

Non-humanoid skeleton (28 bones): no "pelvis" bone, so the retargeter cannot anchor it; 1 of 28 bone names coincide with the humanoid mannequin map. Client utility auto-map finds 2 name matches. Every clip graded reject for the humanoid rig.

| Clip | Dur | Grade | Detail |
|---|---:|---|---|
| Bite | 1.25s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Coiled | 1.67s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Dance | 2s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Death | 2.25s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Hit | 1.04s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Idle | 2.29s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Rest Pose | 0.21s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Side winding | 1.88s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |

### spider-animations.glb — 10 clips, 56 bones

Non-humanoid skeleton (56 bones): no "pelvis" bone, so the retargeter cannot anchor it; 1 of 56 bone names coincide with the humanoid mannequin map. Client utility auto-map finds 2 name matches. Every clip graded reject for the humanoid rig.

| Clip | Dur | Grade | Detail |
|---|---:|---|---|
| Attack | 1.08s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Bite | 1.08s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Death | 1.33s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Death 2 | 1.04s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Eating | 2.25s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Hit | 0.71s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Idle | 3.25s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Jump | 1.38s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Rest Pose | 0.21s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |
| Walk | 1s | reject | non-humanoid skeleton — cannot retarget onto the humanoid character rig |

## What adoption-with-fixes means in practice

1. Add Mesh2Motion as an `ANIMATION_SOURCES` entry (mannequin map, `hips: "pelvis"`, `root: "root"`) — the human library then flows through the existing intake like UAL2.
2. At intake, clamp/offset the two floor-penetrating clips (`Zombie_Rise`, `Hit_Knockback_RM`) so the hips never go below the ground plane.
3. Eyeball `Sword_Regular_B` once in the client; its 64° single-instant spike is either a fast-swing sampling artefact or a genuine wrist snap to soften.
4. Accept the pinky/ring loss (rig design), and treat the creature GLBs as a separate future intake that needs creature rigs — they are not part of this adoption.

_Grades produced by a read-only harness in the idea-execution scratch dir (`grade.mjs` + `results.json` there hold the full per-clip measurements). Clip files were never modified._
