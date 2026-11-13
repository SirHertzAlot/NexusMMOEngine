# The armour formula X/(X+K) → Nexus combat rules note

Filed 2026-11-12 (~14:11 ET) from Joey's Instagram reel (Wyatt Cheng —
Diablo designer — posted 2026-09-21; https://www.instagram.com/reel/
Ddj3Q8EgSku/). Content recovered via media-understanding; engine state
checked against origin/main the same session.

## The claim (creator's, and it's correct)

Most big games compute damage mitigation as:

```
% mitigated = Armour / (Armour + K)
```

Named users: League of Legends, Dota 2, World of Warcraft, Diablo 2/3/4.
His argument, in order:

1. **Flat armour (subtract a fixed amount) breaks.** Two attackers at the
   same 50 DPS — one slow 100-damage hit, one fast 10-damage hits — flat
   armour can negate the fast attacker *entirely* while barely touching
   the slow one. It also mangles DoTs (poison, ground fire, thorns),
   whose many small ticks all get eaten.
2. **Naive % per point breaks the other way.** Early points do almost
   nothing, later points become disproportionately strong, and the
   system needs a hard cap that then makes extra armour worthless.
3. **X/(X+K) looks like diminishing returns but isn't.** The mitigation
   *percentage* curve flattens, but survivability — hits-to-kill, i.e.
   effective health — grows **linearly**: in his worked example (1000 HP,
   100 damage/hit), every +100 armour adds exactly 10 more hits to
   survive, at any armour value. No hard cap needed, no dead stats, fast
   and slow attackers treated alike, DoTs mitigated proportionally.

## Where we already stand (checked on origin/main)

`content/rules/combat.json` already carries:

- `"damage": { "base": 10, "massPower": 0.5, "armourHalf": 10 }` — the
  field name `armourHalf` is the signature of this exact family: a
  saturating curve whose half-point is K (at armour = K, mitigation =
  50%). **Caveat, stated plainly:** this note infers the formula from
  the rules data and field naming; the resolver code was not read in
  this pass. Verifying the resolver implements armour/(armour+K) with
  K = armourHalf is a five-minute check owed when combat work is next
  scheduled.
- A separate `"defence"` block (base 0.5, perSkill, clamped 0.05–0.95,
  failedLetsThrough 0.5) — that's an avoidance/defence layer, a
  different axis from mitigation. The reel's formula governs the
  mitigation axis only; the two compose (a hit is first defended
  against, then what lands is mitigated).

## The mapping (what to formalise)

1. **Mitigation model, in rules data:** `% = armour / (armour + K)`,
   K per damage kind — our techniques already split damage by kind
   (cut/thrust/blunt via weapon property), so K can differ per kind
   and per resistance type (physical vs elemental) without new code
   shape: `armourHalf` generalises to a per-kind K table.
2. **K is the tuning dial:** K = the armour value at which a defender
   takes half damage. Scale K by content tier/level so armour upgrades
   stay meaningful as numbers grow (the LoL/Diablo practice) — a
   level-scaled K table in the same rules file.
3. **Design on effective health, not on %:** when balancing, quote
   hits-to-kill. The % number lies (looks diminishing); EHP is the
   linear truth players actually feel. Put this sentence in the combat
   doc so future tuning doesn't "fix" the curve by mistake.
4. **Presentation tie-in:** the mitigated value is what the damage-
   numbers pipeline (DAMAGE-NUMBERS-PROCESS.md) renders; the defence
   layer's outcomes (dodged / blocked / let-through) map to its
   type treatments. Client already has a hit-feedback home
   (`apps/client/src/render/combat-feedback.ts`, U12a) — numbers land
   there, not in a new silo.
5. **Noted alternative, not adopted:** Path of Exile's variant makes
   mitigation depend on hit size (armour helps less against huge hits).
   It's the one serious rival; it buys "big hits stay scary" at the
   cost of a much harder mental model. Flagged for the combat design
   doc as a conscious rejection unless boss-design demands it.

## Verdict

**CONFIRM AND FORMALISE.** The industry-standard formula appears to
already be our rules data's intent (armourHalf); the work is small:
verify the resolver, generalise K per damage kind, level-scale it,
and write the EHP principle into the combat doc so the curve is never
"rebalanced" by someone reading the % graph. No new system — one
formula, named, tuned, and documented.

## Verification — 2026-11-13 (closes the owed check above)

Read, not inferred: `packages/rules/src/hooks.ts:179-186` —
`armourFactor(rules, total)` returns `h / (h + total)` with
`h = rules.combat.damage.armourHalf`. That is the let-through share,
so mitigation is `total / (total + h)` — exactly Armour/(Armour+K)
with K = armourHalf (10 in `content/rules/combat.json`).
At armour = 10 the factor is 0.5; at 0 it is 1; at 1000 it is
10/1010 ≈ 0.0099.

Wiring is live, not dead code: `packages/engine-core/src/server.ts:933-937`
computes `wornFactor` from worn armour totals via `armourFactor`, and
`packages/engine-core/src/combat.ts:337-338` passes it into
`computeDamage`, which multiplies by `clamp01(armourFactor)`
(`hooks.ts` default hook). Dungeons take the same path
(`packages/engine-core/src/dungeons/instance.ts:169-174`).

Tests: `packages/rules` suite run 2026-11-13 — **56 pass, 0 fail**,
including the armour test (`rules.test.ts:70-73`: factor 1 at 0,
0.5 at armourHalf, < 0.05 at 1000). The resolver commit
`b1ef529a` ("feat(combat): worn armour scales blows, in dungeons too")
is an ancestor of origin/main.

Still open (unchanged from the verdict): generalise K per damage kind,
level-scale K, and write the hits-to-kill / EHP sentence into the
combat doc. The `defence` block remains the separate avoidance axis.
