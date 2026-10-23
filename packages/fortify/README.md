# @mmo-engine/fortify

Threat-driven fortification for baked settlements. Instead of placing
walls and towers decoratively, the generator asks: *how would an
attacker defeat this place?* — then builds the counter, and asks again.

Design source: the castle-evolution loop from Mortar & Moat's primers
("How a Pond Becomes a Water Castle From Dirt", "How a Pile of Dirt
Becomes a Castle") — every feature exists because an attacker defeated
the previous version. Rochester, 1215, is in here: square towers fail
to mining at their corners, so towers go round, and where the water
table allows it, a moat makes every sap tunnel flood.

## Pieces

- `src/matrix.ts` — the vulnerability → counter matrix **as data**:
  tactics (charge, ladders, mining) probe for weakness kinds
  (straight-charge, dead-ground, undermine); counters clear a kind at a
  cost, gated by era. The historical progression falls out of the data.
- `src/analyze.ts` — the attack sim. Three probes, all pure functions of
  the settlement:
  - **charge**: Dijkstra over the approach corridor (gate-side muster,
    road-preferring costs); exposure is the cheapest path's final
    straight run.
  - **ladders**: wall-face coverage — sampled points outside each face,
    covered if a firing position (tower/gate/core) is in range with LOS.
  - **mining**: per structure, is the adjacent soil diggable with the
    water table below tunnel depth? The hydrology question in baked
    form: *will a sap tunnel flood here?*
- `src/fortify.ts` — the loop: worst weakness → cheapest applicable
  counter → re-simulate, until total exposure and every weakness are
  under threshold, the defence budget runs out, or nothing applicable
  remains (the loop reports which, and what it couldn't fix).
- `src/generate.ts` — the prototype fixture: one walled pond village
  under three terrain profiles (pond / dry / riverside). Terrain is an
  input, as it will be from the real terrain+hydrology bake.
- `examples/demo.ts` — before/after maps and build logs for all three
  profiles (`npm run demo`).
- `examples/frames.ts` + `render_frames.py` — per-step snapshots →
  PNG frames and animated GIFs of a settlement fortifying itself.

## What the prototype already shows

- The pond village bends its causeway, plants flanking towers exactly
  where the dead ground is, then adds a barbican — the video's chain,
  computed, in 15 budget points.
- In dry country, new flanking towers immediately become the next
  mining target and get rebuilt round in later steps: build order
  emerges from re-simulation, not scripting.
- A dry-soil gate has no counter in the matrix (no water to divert for
  a moat, gates don't go round). The loop leaves it as a stated
  residual instead of papering over it.
- Era gating works: at era 1 the only counter that exists is the bend.

## The Roman variation (third primer: "How a Field Becomes a Roman Fort")

The Short added three things, all folded in:

- **Lilia** — a forward obstacle belt: hidden stake pits dug into the
  cheapest path itself. A counter placed on the *terrain*, not the
  structure; it halves the charge lane's exposure whatever its shape.
  Era 1, cost 2 — Caesar predates the barbican by centuries.
- **Siege as a tactic** — it probes for `no-reserve`: no internal well,
  no granary. Its counters are logistics (stored water, stored
  calories), and the well has a physical gate: the water table must be
  within digging depth. In the pond demo the loop now builds the
  granary *first* — an unbesieged-looking town with no stores is, to
  the sim, the most vulnerable thing on the map.
- **Doctrines** (`DOCTRINES.roman`, `applyDoctrine`) — the Roman fort
  is the loop's output compiled into a culture's standard kit and
  stamped at generation. The loop still runs afterwards for whatever
  local terrain makes unusual. The Short's other axis — materials
  hardening over time (earth → turf → timber → stone) — is the F3 era
  grammar's job and is noted there, not modelled yet.

## Known prototype limits

- One settlement geometry, south gate; the bend is built for that
  fixture's approach rows.
- Ladders exposure is the *worst* face's dead fraction, so fixing one
  face can leave total exposure flat until the next face is fixed (the
  build log shows this honestly).
- Cannon/gun-loops are not yet tactics in the matrix; the shape takes
  them without code changes.
- Next slices (planned): F2 mining/moat against real hydrology output,
  F3 era stages as a full grammar, F4 the reactive living-sim pass
  (fortify weighted by raids a town has actually faced), F5 the same
  exposure metric grading player-built bases.
