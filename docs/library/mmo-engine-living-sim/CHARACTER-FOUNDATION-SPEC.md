# Character Foundation — Archetypes, Descriptors, and the Resolved Profile

**Status:** Foundation spec, 2026-10-26, at Joey's direction. Defines the
complete foundation for character definition across the whole game — every
generated character, every tier, every town. The two worked traces in §14
are validation fixtures, not the scope; the scope is the full system.
**Scope:** data definitions, the generation contract, the resolution
function, and the reader contracts. No tick-loop logic, no behavior
scripting, no vendored code.
**Parents:** `LIVING-SIM-DEEP-DIVE.md` (§4.1 think-tree and personality
weights, §4.6–§4.9 crime/rumor/quests, §4.10 enemy AI, §8.1 town spawner),
`DECISION-SUBSTRATE-SPEC.md` (§4 state digest, §5 question packs),
`NEEDS-SCHEMA-PROPOSAL.md` (the data-definitions pattern this follows, and
the seam both sit behind), `NEEDS-WFC-THINKING-SPEC.md` Part B (needs ×
weights → candidate actions → collapse; the profile below supplies the
weights).

## 1. The core inversion, stated once

Characters do not declare *how they behave*. They declare *what they are
made of* — archetype, temperament, alignment, interests — as data rows.
One generic resolver turns that composition into a small numeric profile.
Every system reads the profile's numbers; **no system ever branches on an
archetype name, a descriptor name, or an alignment label.** A mean,
short-tempered guard and a kind, even-keeled one run the identical code
paths with different numbers. New archetypes, temperaments, descriptors,
or interests = new data rows. Zero new code, zero character names in
systems.

## 2. Coverage — who gets a character

Every generated character in the game, at every tier. The foundation is
the coverage: a system that only describes a few showcased NPCs is not a
foundation.

| Population | Composition | Profile | Backstory | Notes |
|---|---|---|---|---|
| Background residents (crowd) | full | profile-lite (weights only) | fragment ids only, text unrendered | cost: bake-time only |
| Local residents (villagers, vendors) | full | full | rendered | the default case |
| Majors (quest NPCs, captains) | full, any field pinnable by authored data | full | rendered, pinnable | §9 authored overrides |
| Villains / antagonists | full, agenda fields pinnable | full | rendered | hidden-agenda state stays in the sim (§4.1 tiers), not here |
| Sentient hostiles (named, elites, bosses) | full | full | rendered for named only | ride the same stack as all hostiles (§4.10) |
| Creatures / wildlife | reduced: temperament + species needs only | weights subset (aggression, caution, composure) | none | the wildlife `temperament` data is the seed of this axis |
| Players | none | none | player-authored | companions, if any, are generated characters with pins |

Cohort gating: children carry temperament + alignment but their archetype
and interests are *latent* — drawn at bake, revealed (locked in) at the
adolescent cohort. Profession scoring (§10) only ever sees the working
cohorts, exactly as occupancy already gates on `adult`/`adolescent`.

## 3. Layers

**Layer 1 — definitions (content rows, versioned, authored).** Four
catalogs (§5–§8) plus the backstory fragment catalog (§11) and the
descriptor rule table (§8). These live in content beside the settlement
rules, carry `schemaVersion` + `provenance` on every row, and change
without code deploys. The engine ships a sample pack, clearly marked;
a game replaces it whole, the way `loadRules` and `loadSpecies` already
work.

**Layer 2 — generation (bake-time and spawn-time, seeded).** The
generator (§9) draws a composition per character from the catalogs,
conditioned on context the bake already knows (class, cohort, town,
species). Deterministic: same seed → same roster, composition included.

**Layer 3 — instance record (per character, stored).** The composition,
the resolved profile, and the backstory (§9, field list). Stored with
the character's existing record — for townsfolk, as added fields on the
settlement `Npc` row; for others, on their spawn/bake record.

**Layer 4 — runtime (what systems read).** The resolved profile only.
v1 adds **no ECS component**: the resident and bark systems already
receive the NPC record, and the profile rides it. When the think-tree
slice lands, the profile's weight vector becomes one packed component
(§13) — never one component per trait.

## 4. The shared vocabulary — trait axes

All personality influence in the game flows through eight named axes.
This list is the contract; catalogs may only modify these axes, and
readers may only read them.

| Axis | Meaning at the high end | Principal readers |
|---|---|---|
| `aggression` | starts and escalates fights | combat, think-tree |
| `caution` | avoids risk, notices danger early | perception, combat |
| `sociability` | seeks company, talks, trades | think-tree, gossip |
| `diligence` | sticks to work and duty | think-tree, schedules |
| `curiosity` | investigates, wanders, learns | perception, think-tree |
| `empathy` | weighs others' welfare | social, substrate digest |
| `ambition` | seeks status, wealth, mastery | profession, social |
| `composure` | keeps temper under provocation | combat, social |

A weight is a multiplier, `1.0` = neutral, resolved range `[0.25, 2.5]`,
quantized to 3 decimals (the determinism discipline of the needs
schema's `needIntensity`). Base weights come from a defaults row keyed
by role/species kind — the resolver starts there, never from a blank.

## 5. Catalog 1 — ArchetypeDef

One row per archetype. An archetype is a *family resemblance*: modifier
package + pools, never a behavior.

| # | Field | Type | Meaning |
|---|---|---|---|
| 1 | `id` | string | Stable id, e.g. `"veteran"`. Lowercase. |
| 2 | `schemaVersion` | integer | Rejected-if-unknown, never guessed. |
| 3 | `weight` | number > 0 | Base likelihood in the generator draw. |
| 4 | `classAffinity` | `Record<classId, permille>` | Draw weight modifier per social class (the demographics classes: peasant, artisan, merchant, clergy, guard, noble). 1000 = neutral. |
| 5 | `traitMods` | `Record<axis, number>` | Multiplicative modifiers on the §4 axes, each `0.5..2.0`. |
| 6 | `interestWeights` | `Record<interestId, number>` | Draw weights for the character's interests (§7). Interests absent from the table draw at the catalog's default weight (sample-pack tuning data), so no archetype is interest-locked. |
| 7 | `alignmentBias` | `{ benevolence: {mean, spread}, order: {mean, spread} }` | Where this archetype's alignment draws centre (§6). |
| 8 | `temperamentPool` | `Record<temperamentId, number>` | Allowed temperaments + draw weights. Absent temperaments never occur for this archetype. |
| 9 | `professionAffinity` | `Record<professionId, number>` | Score modifier in profession assignment (§10), `0.5..2.0`. |
| 10 | `fragmentPools` | `{ origin: id[], event: id[], want: id[], flaw: id[] }` | Backstory fragments this archetype can draw (§11). |
| 11 | `provenance` | `{ script, author }` | Every row carries it. |

**The v1 archetype set (18)** — the full starting catalog, each with its
signature (dominant trait mods / interest lean):

| id | signature |
|---|---|
| `devout` | empathy↑ diligence↑ · faith |
| `penitent` | composure↑ empathy↑, aggression↓ · faith, hearth |
| `zealot` | aggression↑ diligence↑, empathy↓ · faith, combat |
| `drifter` | curiosity↑, diligence↓ · wandering, nature |
| `veteran` | aggression↑ composure↑ · combat, leadership |
| `bully` | aggression↑, empathy↓ composure↓ · combat, leadership |
| `coward` | caution↑↑, aggression↓ · hearth, craft |
| `trickster` | curiosity↑ sociability↑, diligence↓ · trade, art |
| `hearthkeeper` | empathy↑ sociability↑ · hearth, husbandry |
| `scholar` | curiosity↑↑, aggression↓ · lore |
| `artisan` | diligence↑ ambition↑ · craft |
| `merchant` | ambition↑ sociability↑ · trade |
| `hunter` | caution↑ aggression↑ · nature, combat |
| `healer` | empathy↑↑ · lore, nature, faith |
| `outlaw` | aggression↑, order-bias low · combat, wandering |
| `heir` | ambition↑↑ · leadership, trade |
| `gossip` | sociability↑↑ curiosity↑ · trade, art |
| `hermit` | sociability↓↓ caution↑ · nature, lore |

## 6. Alignment — two axes, degrees, no pigeonholes

Alignment is two integer axes, each `−100..+100`:

- `benevolence`: −100 (cruel) … +100 (saintly)
- `order`: −100 (chaotic) … +100 (lawful)

Drawn per character from the archetype's `alignmentBias` (mean ± spread,
seeded, clamped). Degrees are the point: −25 is *slightly* evil and the
descriptor rules (§8) key on bands, so degree produces different
descriptors, not just a weaker label.

**Band table** (the only place labels exist; both axes share it):

| Band | Range | Label (benevolence / order) |
|---|---|---|
| strong | 60..100 | good / lawful |
| leaning | 25..59 | kind-leaning / orderly |
| neutral | −24..24 | neutral |
| leaning | −59..−25 | mean-leaning / unruly |
| strong | −100..−60 | evil / chaotic |

Rules: labels are *derived display text only* (UI, backstory rendering).
No content row may store a label; no system may read one. Alignment is
a bias source for descriptors and reader biases — never a script:
nothing in the foundation says an evil character *must* do anything.

**Drift:** v1 alignment is static for background/local tiers. For
majors and villains the stored axes are mutable state, moved only by
the society layer (witnessed/experienced world facts, edge cadence,
substrate §7 discipline) — the mechanism is that layer's spec, the
fields are reserved here so it needs no schema change.

## 7. Catalog 2 — TemperamentDef and Catalog 3 — InterestDef

**TemperamentDef** — one row per temperament:

| # | Field | Type | Meaning |
|---|---|---|---|
| 1 | `id` | string | e.g. `"hot-headed"`. |
| 2 | `schemaVersion` | integer | As §5. |
| 3 | `weight` | number > 0 | Base draw likelihood (archetype pool re-weights it). |
| 4 | `traitMods` | `Record<axis, number>` | Multiplicative axis modifiers, `0.5..2.0`. |
| 5 | `reactionMods` | `{ fleeMod, trustMod, gossipMod }` | Additive reader-bias modifiers (§9 profile fields), each `−0.3..+0.3`. |
| 6 | `barkTone` | string | Default tone pool id for barks (§12). |
| 7 | `provenance` | `{ script, author }` | As §5. |

**The v1 temperament set (10):** `calm` (composure↑), `cheerful`
(sociability↑), `sullen` (sociability↓), `hot-headed` (composure↓↓,
aggression↑), `anxious` (caution↑, composure↓), `bold` (caution↓,
aggression↑), `brooding` (curiosity↑, sociability↓), `patient`
(composure↑, diligence↑), `restless` (diligence↓, curiosity↑), `proud`
(ambition↑, empathy↓).

**InterestDef** — one row per interest:

| # | Field | Type | Meaning |
|---|---|---|---|
| 1 | `id` | string | e.g. `"combat"`. |
| 2 | `schemaVersion` | integer | As §5. |
| 3 | `professionLinks` | `Record<professionId, number>` | Score contribution in §10, `0..2`. |
| 4 | `activityTags` | string[] | Affordance/POI tags the think-tree prefers for leisure and work activities (tavern, forge, shrine, road…). |
| 5 | `provenance` | `{ script, author }` | As §5. |

**The v1 interest set (10):** `combat`, `craft`, `trade`, `lore`,
`faith`, `nature`, `art`, `leadership`, `hearth`, `wandering`.
Characters carry their **top 3** interests as a ranked list with scores
(§9) — ranked, because profession scoring and leisure choice both read
"strongest first, fall back down the list."

## 8. Catalog 4 — DescriptorDef and the resolution rules

Descriptors are the readable surface of the profile — *mean*,
*short-tempered*, *loves-a-fight* — and they are **derived, never
drawn**. A descriptor is a rule outcome, computed once at generation.

**DescriptorDef** — one row per descriptor:

| # | Field | Type | Meaning |
|---|---|---|---|
| 1 | `id` | string | e.g. `"short-tempered"`. |
| 2 | `schemaVersion` | integer | As §5. |
| 3 | `slot` | enum | `"demeanor" \| "social" \| "moral" \| "drive"` — a character holds at most one descriptor per slot, four total. Slots are what keep a profile readable instead of a tag pile. |
| 4 | `traitMods` | `Record<axis, number>` | Small multiplicative modifiers, `0.8..1.25` — descriptors tune, they don't dominate. |
| 5 | `reactionMods` | `{ fleeMod, trustMod, gossipMod }` | As §7, `−0.2..+0.2`. |
| 6 | `barkPools` | string[] | Extra bark line pools this descriptor unlocks (§12). |
| 7 | `conflicts` | string[] | Descriptor ids that may not co-occur with this one (checked symmetrically at validation). |
| 8 | `provenance` | `{ script, author }` | As §5. |

**Resolution rules** — an ordered rule table, data, evaluated top-down;
a rule fires when its condition matches and its slot is still empty:

```
{ when: { axis: "benevolence", band: "leaning-negative" },
  gives: "mean" }                                            // slot: demeanor
{ when: { temperament: "hot-headed" },
  gives: "short-tempered" }                                 // slot: demeanor (loses to mean if both fire — order is meaning)
{ when: { temperament: "hot-headed", axis: "benevolence", band: "strong-negative" },
  gives: "cruel" }                                           // slot: moral
{ when: { order: "strong-negative", benevolence: "strong-positive",
          topInterest: "combat" },
  gives: "loves-a-fight" }                                   // slot: drive
{ when: { axis: "order", band: "strong-negative" },
  gives: "free-spirited" }                                   // slot: drive (fallback for chaotic without the combat lean)
```

Conditions may reference: an alignment band (either axis), a
temperament id, an archetype id or family list, a top interest, an axis
weight crossing a threshold, or a conjunction of these. Nothing else —
a condition that needs more than composition data belongs to the
society layer, not to character definition.

**The v1 descriptor set (28):**
- *demeanor:* `mean`, `kind-hearted`, `short-tempered`, `even-keeled`,
  `grim`, `warm`
- *social:* `gossip`, `taciturn`, `generous`, `miserly`, `loyal`,
  `fickle`
- *moral:* `cruel`, `forgiving`, `vengeful`, `dutiful`, `devout`,
  `cynical`
- *drive:* `loves-a-fight`, `peaceable`, `reckless`, `ambitious`,
  `content`, `curious-mind`, `proud-heart`, `humble`, `brave`,
  `cowardly`

## 9. The instance record and the generator

**CharacterInstance** — what generation writes, per character:

| # | Field | Type | Meaning |
|---|---|---|---|
| 1 | `characterId` | string | The character's existing id (settlement `Npc.id` or spawn id). |
| 2 | `archetypeId` | string | Drawn or pinned (§9 overrides). |
| 3 | `temperamentId` | string | Drawn from the archetype's pool. |
| 4 | `alignment` | `{ benevolence: int, order: int }` | §6. Mutable only for majors/villains (§6 drift). |
| 5 | `interests` | `{ id, score }[3]` | Top 3, ranked, scores quantized. |
| 6 | `descriptorIds` | string[≤4] | Resolved per §8, at most one per slot. |
| 7 | `profile` | `ResolvedProfile` | Below. The only thing runtime systems read. |
| 8 | `backstory` | `{ originId, eventId, wantId, flawId, text? }` | §12. `text` rendered for local tier and up; ids only below that. |
| 9 | `origin` | `"generated" \| "authored" \| "mixed"` | Provenance of the composition as a whole. |
| 10 | `schemaVersion` | integer | As §5. |

**ResolvedProfile** — the numeric output of §10's resolver:

| Field | Type | Meaning |
|---|---|---|
| `weights` | `Record<axis, number>` | The 8 §4 axes, resolved, clamped, quantized. |
| `fleeBias` | number `−0.5..+0.5` | Added to combat flee thresholds. |
| `trustBias` | number `−0.5..+0.5` | Scales trust gain/loss in social + substrate packs. |
| `gossipBias` | number `−0.5..+0.5` | Scales rumor exchange propensity (§4.7). |
| `barkTone` | string | Tone pool id: temperament's, overridden by a demeanor descriptor's pool when present. |

**The generator** — one entry point, used by the settlement bake and by
spawn-time generation alike:

```
generateCharacter(ctx) -> CharacterInstance
ctx = { seedStream, classId?, cohort, townId?, speciesId?,
        role?, pins?: Partial<composition> }
```

- **Draw order is fixed**: archetype → temperament (from the
  archetype's pool) → alignment (both axes) → interests (weighted draw
  without replacement, top 3) → descriptors (rule table, deterministic)
  → profile (resolver, §10) → backstory (§11).
- **Seeding**: the settlement bake draws from a dedicated `"character"`
  stream in the existing Streams set (alongside `"population"`,
  `"mastery"`), so roster goldens extend by exactly this stage's draws
  and no other stage's draws shift. Non-town generation uses
  `hash(characterId | "character")` as its seed source — the same
  hash-of-id determinism barks already use.
- **Context weighting**: archetype draw weight = `weight ×
  classAffinity[class]` (town characters), further biased by town
  context the bake already computes (a master community draws its
  discipline's archetypes heavier — one context rule, data-driven, not
  per-town code).
- **Authored overrides (pins)**: any composition field may be pinned by
  authored data (a named quest NPC *is* a penitent veteran; a boss *is*
  cruel). Pinned fields skip their draw, downstream resolution proceeds
  identically, and `origin` records `"authored"`/`"mixed"`. The
  generator never overwrites a pin (invariant 6).

## 10. The resolver — the one generic function

```ts
// Pure. Same composition + same catalogs -> same profile, on any platform.
// No catalog lookups by name outside this function; readers get numbers.
function resolveProfile(
  composition: { archetypeId, temperamentId, alignment, descriptorIds },
  catalogs: Catalogs,
  baseWeights: Record<axis, number>,   // role/species defaults row
  jitterSeed: number,                  // hash(characterId | "profile")
): ResolvedProfile;
```

Semantics, in order:

1. Start from `baseWeights`.
2. Multiply by the archetype's `traitMods`, then the temperament's.
3. Multiply by each descriptor's `traitMods` (small by schema, §8).
4. Apply the per-character **jitter**: each axis × `1 ± up to 0.10`,
   drawn from `jitterSeed`. Jitter is the semi-uniqueness term — it is
   what makes two calm devout hearthkeepers differ slightly without any
   new content. It applies *after* all catalog mods so catalogs stay
   the readable cause of big differences and jitter only blurs edges.
5. Clamp every axis to `[0.25, 2.5]`; quantize to 3 decimals.
6. Reader biases: `fleeBias` = temperament + descriptor `fleeMod`
   sums, plus `−0.1 × (aggression weight − 1)` and `+0.1 × (caution
   weight − 1)` terms; `trustBias` and `gossipBias` likewise from
   their `*Mod` sums plus empathy/sociability terms. All clamped to
   `±0.5`. (Exact coefficients are tuning data in the sample pack, not
   code constants.)

## 11. Profession generation

Profession assignment stays where it already lives — occupancy — and
gains a score. The town's demand solve (`solveDemand`) and the
need-chain self-sufficiency rule (§8.1: production ≥ consumption × 1.15,
a town that can't feed itself fails the bake) are **unchanged and
outrank personality absolutely**:

```
professionScore(npc, profession) =
    demandGate(town, profession)                    // 0 or 1, from the demand solve — not a preference
  × ( 1
    + interestMatch(npc, profession)                // Σ professionLinks over the npc's ranked interests, rank-discounted
    + archetypeAffinity(npc, profession)            // archetype.professionAffinity − 1
    + masteryBonus )                                // existing mastery draw, score-weighted
```

Assignment: mandatory slots (the need chains) fill first, candidates
ranked by score; the remaining labour pool takes its best-scoring open
profession; shop ownership follows the worker as today. Effect: the
town is *always* viable, and *who* fills each role is explained by
character — the craft-led artisan is the smith because the score says
so, and the chaotic-good, combat-led guard defends the gate because
fighting is what they're for. Mastery stops being a pure lottery: the
existing draw's weights gain the profession score as a factor, so
masters are drawn disproportionately from those whose character fits
the craft — grand masters doubly so.

## 12. Backstory — fragments, assembled once

Four fragment catalogs — `origin`, `event`, `want`, `flaw` — one row
per fragment:

| # | Field | Type | Meaning |
|---|---|---|---|
| 1 | `id` | string | e.g. `"origin:coastal"`. |
| 2 | `schemaVersion` | integer | As §5. |
| 3 | `text` | string | Template with slots: `{town}`, `{profession}`, `{kin}`, `{place}`, `{faith}`. Slots are filled from bake facts only — never invented at render. |
| 4 | `conditions` | object | Archetype ids / alignment bands / professions / interests this fragment fits. |
| 5 | `weight` | number > 0 | Draw weight among fitting fragments. |
| 6 | `provenance` | `{ script, author }` | As §5. |

Assembly order matters and is fixed in the pipeline (§15): profession
is assigned **before** backstory renders, because fragments reference
it. One fitting fragment is drawn per pool (from the archetype's
`fragmentPools`, filtered by `conditions`), slots are filled, and the
rendered 2–3 sentence text is stored on the instance record. Wants and
flaws are stored as ids as well as text: they are the quest-hook seeds
(the Census pattern, §4.9) and enter the substrate digest as
fixed-vocabulary tags — never as prose (§9 of the substrate spec).

**Barks** consume character through their existing shape — `barkFor`
is already a pure function of (npc, day, town state) picking by hash:
the profile adds three pick dimensions and no machinery — tone pool
(from `profile.barkTone`), descriptor pools (§8 `barkPools`), and one
personal pool keyed by the character's want/flaw fragments. A mean
guard and a kind one at the same gate at the same hour say different
lines because their pools differ; both are still one hash-pick.

## 13. Reader contracts — integration map

Every existing system that consumes character, and exactly what it
reads. If a system isn't listed, it doesn't read character data.

| Reader | Reads | How |
|---|---|---|
| Think-tree (§4.1) | `profile.weights` | Need urgency × personality weight, per the deep dive's own formula. The weights were always the plan; this foundation is where they come from. |
| WFC thinking (Part B) | `profile.weights` | The collapse weights over need-generated candidate actions — needs propose, character disposes. |
| Perception (§4.11) | `caution`, `curiosity` weights | Notice/reaction tuning inside the fairness clamps ("pick the minimum" still governs — character may only move a profile within its authored min/max). |
| Combat / CreatureSystem (§4.10) | `fleeBias`, `aggression`, `composure` | Flee thresholds, escalation, tactic picks. Creature temperaments remain the species-level input; a sentient hostile's profile layers on top through the same resolver. |
| ResidentSystem | `diligence`, interests | Schedule adherence and leisure POI choice via `activityTags` — the schedule spine stays a pure function; character varies *which* leisure anchor and how readily a need interrupts work. |
| Barks | `barkTone`, descriptor pools, want/flaw | §12. |
| Gossip / rumor (§4.7) | `gossipBias`, `sociability` | Exchange propensity during leisure blocks; fidelity mutation rate gets a small cynicism term from the `cynical` descriptor's mods. |
| Decision substrate (§4 digest) | profile + alignment + want/flaw tags | The digest gains one fixed-vocabulary block — quantized weights, alignment bands, descriptor ids, want/flaw ids — at priority 2 alongside the needs vector (both are "who this NPC is" context; perception still outranks). Packs may read it; no pack is defined here. |
| Economy / vendors | profession + mastery only (v1) | Character reaches prices only through *who holds the job*, deliberately. Haggle/personality pricing is a later, separate decision. |
| Encounter director (§4.10) | villain/major profiles | Stance and escalation pacing for authored encounters. |
| Quest director (§4.9) | backstory want/flaw ids, descriptors | Hook seeding: a vengeful major's flaw is a bounty seed; a gossip's descriptor is a rumor source. |

**Runtime footprint.** v1: none — the profile rides the NPC record the
bake already produces, and barks/residents already receive that record.
When the think-tree lands: one packed component, `ProfileWeights`
(8 × f32 weights + 2 × i8 alignment + 3 × f32 biases), taking the next
free registry id *at that time*. Not on the wire in v1: the client
needs bark text and looks, both of which already flow.

## 14. Resolution traces — validation fixtures

These two traces are golden-test fixtures for the resolver (same inputs
→ these outputs, byte-for-byte after quantization). They are how the
math is *checked*, not what the system is *for*.

**Fixture A — the gate guard.** Draws: archetype `veteran`
(aggression ×1.3, composure ×1.2), temperament `hot-headed`
(composure ×0.6, aggression ×1.2, fleeMod −0.05), alignment
benevolence −28 (mean-leaning), order +41 (orderly), interests
[combat, leadership, hearth]. Rules fire: benevolence leaning-negative
→ `mean` (demeanor); hot-headed → *short-tempered* loses the demeanor
slot to `mean` by rule order, and no moral-slot rule fires at −28, so
descriptors = [`mean`, `dutiful` (order leaning-positive + guard role
rule)]. Profile sketch: aggression ≈ 1.56 × jitter, composure ≈ 0.72,
fleeBias negative — a mean, duty-bound guard who does not back down and
snaps when provoked. Profession: combat interest × veteran affinity
makes him the top scorer for the gate slot the demand solve opened.

**Fixture B — the chapel guard.** Draws: archetype `devout`,
temperament `bold`, alignment benevolence +64 (good), order −58
(unruly, near-chaotic), interests [combat, faith, wandering]. Rules
fire: order strong-negative × benevolence strong-positive × top
interest combat → `loves-a-fight` (drive); descriptors =
[`kind-hearted`, `loves-a-fight`, `free-spirited` suppressed — its
drive slot is taken]. Profile sketch: aggression high, caution low,
fleeBias strongly negative — she holds the chapel door, adores a raid
night, and chafes under the watch captain's rotas. Same guard
profession as Fixture A, opposite human being, zero code difference.

## 15. Pipeline placement

The settlement bake gains **one stage**, in its existing stage order:

```
demographics → demand → layout → structures → occupancy
  → character (composition draw per npc)
  → profession rescoring (occupancy's assignments, score-ranked per §11)
  → backstory (fragment draw + render, §12)
  → props → validation
```

Profession rescoring sits inside the character stage's tail rather
than replacing occupancy: occupancy's structural guarantees (every
household headed, no structure over capacity, totals tie to
demographics) are untouched; only the *which-person* choice inside
each job slot becomes score-ranked. The bake's distribution report
gains character histograms (archetype, alignment bands, top interests
per town); a town where one archetype exceeds 40% or an alignment band
is empty *warns* — degenerate distributions are a tuning smell, not a
bake failure.

Non-town generation (dungeon NPCs, sentient hostiles, quest majors)
calls the same `generateCharacter` at bake/spawn with its own context;
there is one generator, not a town one and a dungeon one.

## 16. Data-level invariants (testable, no behavior)

1. **No per-character code.** Adding an archetype, temperament,
   descriptor, interest, or fragment is a data row. A test asserts the
   systems directories contain zero archetype/descriptor string
   literals outside the catalogs and the resolver's rule evaluation.
2. **Determinism.** Same seed → identical composition, profile, and
   backstory text for every character (golden roster, extended).
   The resolver is pure: same inputs → same profile on any platform.
3. **Profile bounds.** Every resolved weight ∈ [0.25, 2.5], quantized
   to 3 decimals; every bias ∈ ±0.5. A resolver output outside bounds
   is a bug in the resolver, never in the data.
4. **Descriptor discipline.** ≤ 4 descriptors, ≤ 1 per slot, no
   conflict pairs, every id resolvable in the catalog. Checked at
   generation and at catalog validation.
5. **Personality never starves a town.** Profession assignment under
   any catalog satisfies the demand solve and the §8.1
   self-sufficiency invariant. A catalog that makes a need chain
   unfillable fails validation, not the town.
6. **Pins are absolute.** The generator never overwrites an authored
   field; a pinned composition resolves identically to a drawn one.
7. **Rows are versioned and attributed.** Every catalog row carries
   `schemaVersion` + `provenance`; unknown versions rejected loudly.
8. **Total coverage.** Every generated character has a complete
   instance record — no null profiles, no missing descriptors pass.
   Profile-lite (§2) is a *stored* profile with a tier flag, not an
   absent one.
9. **Labels are derived.** Alignment labels and descriptor text exist
   only as derivations from the band table and catalogs; no content row
   stores a label.
10. **One generator, one resolver.** No second implementation of
    either may exist in another package; consumers import, never copy.

## 17. Build order (sequenced for cold execution)

**Phase 0 — Catalogs as data.** The four catalogs + fragment catalogs +
rule table as content JSON (sample pack), Zod schemas mirroring the
settlement rules' validation style (`known()` cross-reference checks:
every pool id, interest link, and fragment reference resolves).
Done when: the sample pack validates, and a deliberately broken
reference fails loudly with the row named.

**Phase 1 — Resolver + generator (pure).** `resolveProfile` and
`generateCharacter` as pure functions with the §14 fixtures as golden
tests, plus invariant tests 2, 3, 4. No bake wiring yet.
Done when: goldens pass and a fuzzed catalog (random legal rows) never
produces an out-of-bounds profile.

**Phase 2 — Settlement bake stage.** The `character` stage (§15):
composition per NPC on the `"character"` stream, profession
rescoring, backstory render, histograms in the bake report; roster
goldens extended. Done when: both sample towns bake with full records,
self-sufficiency still passes, and same-seed re-bakes are identical.

**Phase 3 — First readers.** Barks gain tone/descriptor/personal
pools (§12). Nothing else changes behavior in this phase — it is the
visible proof that character data flows, at zero risk to the sim.
Done when: two same-role residents with different profiles produce
observably different bark distributions over a game week, by test.

**Phase 4 — Think/combat readers.** When the think-tree and perception
slices land: `ProfileWeights` component (§13), weights and biases wire
into scoring and flee thresholds. Done when: Fixture A and B profiles
in a test town produce measurably different interrupt/flee behavior
under identical stimuli.

**Phase 5 — Majors and drift.** Authored pins in content for named
NPCs; alignment drift for majors/villains at the society layer (§6);
substrate digest block (§13) behind the stub decider. Done when: a
pinned major replays identically across bakes and a logged decision
digest shows the character block.

Each phase ends with its gate; no phase starts until the previous gate
is green — the standing discipline.

## 18. Open questions (for Joey)

- Descriptor slots: four (demeanor/social/moral/drive) as specced, or
  should `drive` split into ambition vs. appetite later? v1 holds at
  four; the schema carries the slot as data so splitting is a catalog
  change, not a migration.
- Alignment drift (§6): specced as majors-only and society-layer. If
  drift proves cheap and legible, extending it to locals is a policy
  change on the same fields — no schema work either way.
- Children: latent archetype/interests (§2) assumes a character
  "becomes" at adolescence. If the game never ages NPCs across cohorts
  at runtime, latency is free and can be dropped — it exists only to
  serve aging if aging ever lands.
