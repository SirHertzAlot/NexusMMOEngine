# Destructive environments: playtest findings (DE3b, DE4)

A server-side playtest of building collapse on the baked village preview (site 1, seed 42, population 140; 49 buildings,
8,201 parts, 16,246 entities). No client and no art: the scene is spawned through `spawnScene` with the real
`BreakSystem`, `CollapseSystem` and the real Jolt physics world; parts are broken the way combat would (health to 0) and
the fall is measured. Reproduce with `scripts/collapse-playtest.mjs` (needs a baked settlement scene; see the header).

What this does **not** cover: how it looks and feels in the client, hitting a part by hand, and a real world's terrain
(the headless world has none, so a flat slab is put under every building).

## Results

| Scenario | Parts | Broken | Fell | Peak carriers | Settled by | Tick p50 / p99 / worst |
| --- | --- | --- | --- | --- | --- | --- |
| One grounded part of the largest building | 382 | 1 | 0 | 0 | n/a | 1.1 / 2.0 / 6.3 ms |
| One grounded part of a median building | 147 | 1 | 1 | 1 | 2 s | 1.1 / 2.1 / 3.3 ms |
| One grounded part of the smallest building | 25 | 1 | 3 | 3 | 6 s | 1.2 / 1.7 / 2.6 ms |
| Every grounded part of a 379-part building (demolition) | 379 | 21 | 354 | 64 (the cap) | still settling at 20 s | 2.5 / 5.3 / 7.7 ms |

Tick time is break + collapse + physics for the whole 16k-entity world (a quiet tick is ~1.1 ms, all physics).
`CollapseSystem.step` itself costs 0.003-0.05 ms per tick on average.

## Findings

1. **Big buildings are redundant.** Breaking one load-bearing part of a 382-part building dropped nothing: everything
   above it had other supports. Collapse needs several breaks, or a demolition of the base, which is the intended feel
   (a house does not fall because a wall was dented) but means most single breaks only leave a hole.
2. **Falling and settling work.** Carriers land on the ground or on parts below, come to rest, and freeze into static
   rubble within 1.5-4 s; the visual follows the carrier through the fall (checked in the unit and real-Jolt tests).
3. **Bug found and fixed: a demolition spiked the tick.** `partBroken` worked the support graph out per broken part:
   21 breaks in one tick cost 82.7 ms (about 4 ms each on a 380-part building), a worst tick of 65-84 ms, twice the 33 ms
   budget. Breaks are now collected and each building is worked out once per tick: the same 21 breaks cost 0.6-1.8 ms
   and the worst tick fell to 7.7-19 ms (the 19 ms was measured while the machine was busy). A test pins that a building
   is worked out once.
4. **The caps do their job.** A demolition of 354 parts never had more than 64 carriers dynamic, took about 20 s to
   come down, and left the physics step at 2.5 ms average (1.1 ms baseline). Net entities after: +140 (a static
   carrier stays where each part came to rest). Lower `maxActive` (16, 32) lengthens the collapse without changing the
   worst tick; 64 stays the default.
5. **The harness needed ground.** With no terrain collider the carriers fell for ever (y -145 m after 6 s) and never
   settled. The real server loads terrain colliders; nothing to fix, but any new headless test must add ground.
6. **Open: hitting a part by hand.** Melee measures from the attacker to the target's `Transform` (the model's *pivot*)
   with a 2 m vertical limit (`maxHeightDifferenceM`). A ground-floor wall's pivot is at its top (about 2.5 m up), so
   standing at its foot it is out of reach, although its middle (1.3 m) is not. The median part of a building is about
   5.8 m above its lowest part, so upper parts are out of reach by design (a roof is not meant to be punched), but the
   ground floor must be hittable. Fix: hit-test against the part's middle (`centreX/Y/Z`). Not done; DE4c.
7. **Open: a restart rebuilds buildings whole.** Fallen parts are not saved (DE4b).
8. **Open: `valgrind:perf`** was not run (needs WSL and Linux addon builds).
9. **Not seen in the client.** The carriers are hidden like colliders; whether the falling models look right (rotation
   about the pivot, parts passing through each other, dust and pieces from DE1/DE2) needs a session with art.

## The DE3b finding, for the record

DE3 first reported 21-43% of parts as floating and called it a generator gap. It was the pivots: a modular part's
position is its model's pivot (a wall's is at its top and one end), and the graph and the structure checks read it as
the part's middle. With the true middle (`centreX/Y/Z` on the Structure node, checked against the collider nodes for
all 4,197 collider-carrying parts: worst 1.4 mm) 1.3% of parts (props such as washing lines and flags, a few roof tiles)
do not stand at rest, and the structure checks prune 28 parts instead of 311.
