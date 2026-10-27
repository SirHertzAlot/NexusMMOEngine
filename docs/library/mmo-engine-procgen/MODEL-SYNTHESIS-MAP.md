# Model Synthesis Map — Beyond Tiles, Mapped onto the Engine

**Status:** Complete mapping, 2026-10-26, at Joey's direction ("map it out
completely"). Every constraint-driven generation domain in the engine is
inventoried and given a verdict. No code, no adoption — a map.
**Trigger:** Paul Merrell, "Beyond Wave Function Collapse: Procedural
Modeling without Tiles," EPC2024 (Everything Procedural Conference),
BUas Games channel.
**Parents:** `STYLE-DRIVEN-PROCGEN.md` (analyze → profile → synthesize →
validate; inverse procedural modeling), `LIVING-SIM-DEEP-DIVE.md` (§8.1
town spawner), `NEEDS-WFC-THINKING-SPEC.md` (WFC as thought collapse),
`CHARACTER-FOUNDATION-SPEC.md` (the same derivation pattern for people),
the `@mmo-engine/wfc` package as built on `origin/main`.

## 1. Ground truth — the constraint stack as built

The first fact the map must respect: **this engine does not run textbook
tile WFC.** Its solver (`packages/wfc/src/solver.ts`) is a general
constraint solver over arbitrary graphs, and the tile grid is only one of
four front-ends. Anything proposed below is measured against what exists,
not against the textbook.

**Solver anatomy (one core, `solve()`):**

- **Slots** are graph nodes; **options** are anything — a tile, a prop, an
  affix, a quest step. Each slot carries a domain + weights.
- **Edges** carry named **rules** (allowed option pairs); rule-free edges
  still make slots neighbours.
- **Needs** (an option requires neighbours of a kind), **counts** (global
  min/max over option groups), **budgets** (per-option cost, global cap),
  **pins** (pre-decided slots: chunk borders, editor overrides).
- Collapse = lowest Shannon entropy first, weighted draw; propagation =
  arc consistency + needs/counts/budgets bounds; contradiction = trail
  backtrack, then restart from a derived seed.
- **Deterministic**: same problem + seed → same solution. Bake-time only;
  nothing in the package runs on the tick path.

**Front-ends (all in `packages/wfc/src/`):**

| Front-end | Slots are | Used for |
|---|---|---|
| `solver.ts` | arbitrary graph nodes | everything below |
| `grid.ts` | 2D/3D grid cells, face **sockets** | settlement & ruin layouts, room interiors, tile sets |
| `points.ts` | scatter candidate **points in continuous space** | formations, dressing decisions (avoid/needs/counts over distances) |
| `modules3d.ts` | 3D grid modules with 6-face sockets + 90° rotations | walls/corners/junctions/doorways/vaults variation propagation |

**Consumer inventory (verified on `origin/main`):**

| Consumer | Problem | What WFC decides | What it never decides |
|---|---|---|---|
| `settlement/structures.ts` | counts + adjacency over structures | which structures, how many, meeting demand | their geometry |
| `settlement/generate.ts` | layout via grid | plot/parcel arrangement (retries on `WfcError`) | roads (splines + A*), people |
| `dungeon/dress.ts` | room graph + budgets | room archetypes, inventories, vein seams | item positions (scatter + raymarcher) |
| `dungeon/populate.ts`, `modules.ts` | room graph / modules3d | inhabitants, module variations | geometry |
| `engine-core/procgen/formation.ts` | points, world tiles, baked | what each site/formation/piece becomes | positions (placement + raymarcher) |
| `compose/compose.ts`, `loot.ts` | component tree | entity/item composition under budgets/exclusions | stats math, prefabs |
| `engine-core/quests/generate.ts` | quest step graph | quest structure from types + needs | prose, rewards |
| `species` variants (design) | archetype × biome | variant assignment | the species themselves (needs schema) |

The recurring architectural pattern, stated in the code's own words in
both `dress.ts` and `formation.ts`: **"WFC decides *what*; scatter and
the raymarcher decide *where*."** That split is load-bearing — it is
what lets every consumer stay deterministic, baked, and testable.

## 2. What tileless model synthesis is

Lineage, because it disciplines what we claim: Merrell's **model
synthesis** (his dissertation-era work, 2007–2011) generates new 3D
models from an *example* model by learning which parts may sit next to
which, then growing new assemblies that respect those learned
adjacencies. Gumin's Wave Function Collapse (2016) is the popular
simplification of that idea onto discrete tile grids. Merrell's EPC2024
talk presents the line of work *beyond* the simplification — synthesis
without the tile assumption. Its mechanics, at the level this map needs:

1. **Decompose an example** into parts (blocks/components) with their
   relative transforms and connection geometry.
2. **Learn the rules from the example**: which parts adjoin, in which
   relative orientations/offsets — the adjacency structure *is* the
   style. No hand-authored socket tables.
3. **Synthesize by growth**: place parts incrementally in continuous
   space, each new part constrained by the learned adjacencies of its
   already-placed neighbours. Local validity by construction, in the
   texture-synthesis tradition — the process is steered toward never
   painting itself into a corner, rather than collapsing a global grid
   and backtracking out of contradictions.
4. **Output is an assembly**: parts at free transforms (position +
   rotation, not cell coordinates) — geometry and arrangement are one
   output, not two pipeline stages.

Relation to the style-driven design: model synthesis is an
**inverse-procedural-modeling** technique — the same research field
`STYLE-DRIVEN-PROCGEN.md` §2.2 already grounds the pipeline in
(Št'ava et al., Bokeloh et al., Guo et al.). The style doc's roadmap
said "statistical profiles first, grammar induction as the later
upgrade." Learned adjacency extraction *is* grammar induction for
assemblies. This map is that upgrade, scoped.

## 3. Head-to-head — three generations of the idea

| Dimension | Classic tile WFC | Engine graph WFC (as built) | Tileless model synthesis |
|---|---|---|---|
| Slots | grid cells | any graph nodes, incl. free points | none pre-existing — space is grown into |
| Options | tiles | anything (affix, room, structure) | 3D parts from an example's decomposition |
| Rules come from | authored socket tables | authored rules/needs/counts/budgets | **learned from an example model** |
| Space | discrete grid | discrete graph; continuous only via points front-end | **continuous, free transforms** |
| Output | tile assignment | assignment (what) | **assembly with transforms (what + where)** |
| Global constraints (counts, budgets) | weak | **strong — first-class** | weak — growth is local |
| Failure mode | contradiction → restart | trail backtrack → derived-seed restart | contradiction-avoiding growth; incompleteness instead |
| Determinism | seeded | **seeded, golden-tested** | achievable, but floats/transforms need quantization discipline (§9) |
| Authoring cost | tile set + sockets per set | problem definitions per domain | one good example per family + decomposition tooling |
| Style fidelity | as good as the tile set | as good as the problem author | **as good as the example — style is the input** |

Reading of the table: the engine already owns the middle column's
advantages. Model synthesis wins exactly three dimensions — **rule
provenance (learned, not authored), continuous free-transform output,
and style-as-input**. A complete map is built on those three, and
refuses to re-buy anything the middle column already has.

## 4. The three real gaps (and what is not a gap)

**Gap 1 — Rules are authored, never learned.** Every rule, socket, need,
and weight in the current stack was written by a person. The corpus
analyzer in the style pipeline measures *statistics* (proportions,
palettes, budgets) but not *structure* — it cannot say "a chimney sits
on a roof slope, never on a wall face; a market stall fronts a street."
Adjacency structure is the largest un-mined style signal in the corpus.

**Gap 2 — Assemblies have no native output form.** When the content is
an *assembly of parts* — a building, a ruin, a machine — the current
stack approximates it two ways: whole-archetype boxes (settlement
structures) or grid modules (`modules3d`, discrete cells, quarter-turn
rotations). Neither can express "these parts, at these free transforms,
in the example's arrangement language." The what/where split serves
scatter-style content perfectly; for assemblies it splits the content
itself in half.

**Gap 3 — Validity by growth vs. validity by repair.** The solver's
backtrack/restart discipline is right for assignment problems with
global constraints. For spatial growth problems (a street filling with
frontages, a ruin accreting), growth-order synthesis avoids the
contradiction class entirely and degrades to *incomplete*, not
*invalid* — a better failure shape for dressing-scale content.

**Not gaps** (do not re-buy): graph generality, pins/overrides, needs,
counts, budgets, entropy-ordered collapse, sockets as a concept,
continuous *points* problems, seeded determinism, bake-time placement,
golden testing. All owned. Any synthesis work that re-implements one of
these is waste and a maintenance fork.

## 5. The complete domain map

Verdicts: **STAY** (current mechanism is right), **EXTEND** (current
mechanism + learned rules as an input), **HYBRID** (WFC for the global
decision, synthesis for local arrangement/assembly), **SYNTHESIS**
(synthesis is the primary mechanism), **N/A** (constraint synthesis is
not the tool here).

| # | Domain | Today | Verdict | Rationale in one line |
|---|---|---|---|---|
| 1 | Settlement structure solve (kinds/counts vs demand) | graph WFC | **STAY** | Global counts + demand guarantees are the solver's home turf; synthesis is weak exactly here. |
| 2 | Settlement plot layout | grid WFC + retries | **HYBRID** | Plots stay grid-solved (capacity proofs); *street frontage arrangement* along spline roads is continuous — synthesis arranges frontages on solved plots. |
| 3 | Building assemblies & variants | archetype boxes | **SYNTHESIS** | The flagship case: buildings are part assemblies; examples exist (archetype structures + GLB corpus); variants become learned-adjacency assemblies instead of one box per archetype. |
| 4 | Ruins & ancient sites | grid/modules (planned) | **HYBRID** | Site plan by WFC (counts, districts); ruin assembly (broken walls, fallen columns at free transforms) by synthesis — decay is an arrangement language grids speak badly. |
| 5 | Dungeon dressing (room archetypes, inventories, veins) | room-graph WFC | **STAY** | Abstract assignment over an existing graph; no geometry is being decided. |
| 6 | Dungeon interiors (modules3d) | 3D grid modules + sockets | **EXTEND** | Grid is *true* here — rooms are cellular. Learned rules extend it: extract module adjacency from example rooms to author socket tables semi-automatically instead of by hand. |
| 7 | Caves & organic underground | not built | **SYNTHESIS** (candidate) | No grid is true underground; growth synthesis over carved volumes fits. Parked until dungeons need organic spaces — do not build speculatively. |
| 8 | Formations (standing stones, camps) | points WFC, baked | **STAY** | Points front-end already works in continuous space with avoid/needs/counts; synthesis adds nothing. |
| 9 | Scatter & ecology dressing | fields + points | **STAY** | Condition fields + suitability own this; arrangement is statistical, not structural. |
| 10 | Entity/item composition (compose, loot) | tree-graph WFC | **STAY** | Abstract composition under budgets/exclusions — the solver's purest use. No geometry exists to synthesize. |
| 11 | Quest generation | step-graph WFC | **STAY** | Abstract structure; the census/hook layer consumes sim state, not arrangements. |
| 12 | Species variants | WFC (design) | **STAY** | Assignment over archetype × biome; needs schema owns the semantics. |
| 13 | Needs-driven thinking (AI) | WFC-collapse (design) | **STAY, reframed** | The graph solver over candidate *actions* was always the right structure — actions are graph nodes, not tiles (§3's lesson). Synthesis contributes the framing, not a mechanism. |
| 14 | Terrain, hydrology, roads | analytic fields, splines, A* | **N/A** | Already continuous and already right; constraint synthesis is not a terrain tool. |
| 15 | Vegetation & rocks (style-doc starter generators) | sine toolkit + profiles | **EXTEND** | Single objects, not assemblies — sine synthesis bounded by profiles stays; learned *cluster* adjacency (how rocks group, how shrubs ring a tree) is a points-problem input, not a synthesizer. |
| 16 | Music composition | generative grammar (spec) | **N/A** | Already example-analyzed grammar synthesis in another medium; the *pattern* rhymes (analyze → grammar → synthesize → validate) and needs nothing from this map. |
| 17 | Character & backstory generation | rule-table derivation (spec) | **N/A** | Same intellectual family — derivation from composition — already specced in the character foundation; geometry-free. |

Net shape: **one flagship SYNTHESIS domain (buildings), two HYBRIDs
(settlement frontage, ruins), two EXTENDs (dungeon module authoring,
vegetation clustering), everything else stays.** That restraint is the
map working as intended: synthesis enters where its three advantages
(§3) are decisive and nowhere else.

## 6. Target architecture — one core, three front-ends

```
                 ┌─────────────────────────────────────────────┐
   authored ───► │  Graph WFC solver (EXISTS)                  │ ──► assignments
   problems      │  slots/options/rules/needs/counts/budgets   │     (what)
                 └─────────────────────────────────────────────┘
   examples ───► ┌─────────────────────────────────────────────┐
   (CC0 corpus)  │  Rule extractor (NEW — bake tooling)        │ ──► learned rule sets
                 │  decompose → adjacency + transform stats    │     (data, versioned)
                 └──────────────┬──────────────────────────────┘
                                │ feeds sockets/rules to WFC (EXTEND path)
                                │ feeds adjacency to synthesizer
                 ┌──────────────▼──────────────────────────────┐
   pins/fields ─►│  Continuous synthesizer (NEW — bake-time)   │ ──► placement lists
                 │  growth over learned adjacency, seeded      │     (what + where,
                 └─────────────────────────────────────────────┘      assemblies only)
                                │
                 shared: seed streams · pins · quantization ·
                 provenance · analyzer validation (style loop)
```

- The **extractor** is an extension of the style pipeline's corpus
  analyzer, not a new tool: same bake stage, new output (§7).
- The **synthesizer** is a new bake-time package beside `@mmo-engine/wfc`
  (working name `@mmo-engine/synthesis`), importing the same seed/RNG
  discipline — never a fork of the solver, never on the tick path.
- **Downstream is untouched**: synthesizer output is a placement list in
  the shape `@mmo-engine/placement` already produces and consumes, so
  ground-settling (raymarcher), navmesh bake, collision, and streaming
  see no new format. This is the seam that makes adoption cheap.
- **Editor surface**: synthesis problems are PCG-graph-shaped (parts,
  fields, pins) — they join the graph library under the split rule
  already established (split by input domain/cadence/scope;
  parameterize variants), with the extractor's output inspectable as
  data in the same tooling spirit as style profiles.

## 7. Data contracts

All data, all versioned, all Zod-validated like the rest of the content
layer. Names are working names.

**ExampleAssembly** (extractor input; authored or derived from corpus
GLBs + structure data):

- `id`, `family` (building / ruin / …), `source` (corpus path or
  "authored"), `license` (must clear the CC0/CC-BY-with-CREDITS gate).
- `parts[]`: `{ partId, assetRef, transform }` — transform = position +
  quaternion + uniform scale, in assembly-local space.
- `anchors[]` (optional): named ground/street/door reference points so
  assemblies can be sited (frontage direction, ground contact).

**PartDef** (catalog entry, one per reusable part):

- `id`, `assetRef` (existing AssetRef/manifest path — no new asset
  plumbing), `bounds`, `sockets[]`: `{ name, localTransform, kind }`
  where kind is a free string tag (e.g. `wall-face`, `roof-edge`,
  `ground`), the continuous-space analogue of grid face sockets.

**LearnedRuleSet** (extractor output; the synthesis analogue of
`style-profile.json`):

- `family`, `extractorVersion`, `sourceAssemblies[]` (provenance —
  which examples taught these rules).
- `adjacency[]`: `{ aPart, aSocket, bPart, bSocket, count,
  transformStats }` — observed pairings with frequency and the
  distribution of relative transforms (mean + spread per axis), so
  synthesis reproduces the example's * tolerances*, not just its
  topology.
- `terminals[]`: sockets observed unconnected (a roof edge that ends
  the building) — growth needs legal stopping points.
- `stats`: part frequency, assembly size distribution — consumed by the
  validator (§10) exactly like style-profile statistics.

**SynthesisProblem** (synthesizer input):

- `ruleSet`, `seed` (own RNG stream, named `"synthesis"`, per the
  per-stage stream discipline), `site`: bounds + ground heightfield
  handle + condition fields (street frontage line, slope, district
  tags from the settlement stage), `pins[]` (pre-placed parts with
  transforms — editor overrides and hybrid hand-offs enter here),
  `budget`: max parts, max growth attempts, time budget ms.

**SynthesisOutput**:

- `placements[]`: `{ assetRef, transform, partId }` — deliberately the
  placement-list shape the existing pipeline already consumes.
- `report`: parts placed, growth attempts, unfilled sockets, elapsed
  ms, rule-set version — the bake report carries it like every other
  stage carries its numbers.

## 8. The hybrid pattern (the recommended default)

Where a domain is HYBRID, the division of labour is fixed:

1. **WFC decides the global shape** — kinds, counts, budgets, demand,
   district/site assignment. Everything that must be *guaranteed*
   (a town feeds itself; exactly one shrine) is proven here, where the
   solver's counts/budgets make it provable.
2. **Synthesis arranges locally** — within one site/plot/frontage, the
   synthesizer assembles parts under learned adjacency, seeded from the
   stage's own stream, pinned by step 1's decisions (a pinned door
   part facing the street is a pin, not a hope).
3. **Placement settles** — the raymarcher/ground logic the engine
   already owns resolves final grounding; synthesis proposes
   transforms, it does not get the last word on terrain contact.
4. **Validation checks both layers** — hard constraints re-checked on
   the final placements (counts unchanged, no interpenetration beyond
   tolerance, navmesh/collision bake consumes the result), style
   conformance measured by the analyzer (§10). Failure at this layer
   fails the bake stage loudly, never silently ships.

This preserves the engine's founding split — *guarantees up top,
arrangement below* — and confines the new mechanism to the layer where
guarantees were never available anyway.

## 9. Determinism, failure, and cost discipline

- **Seeded everything**: growth order, part choice, and transform
  jitter all draw from the problem's single seeded stream. Same
  problem + seed → same assembly, golden-tested like the solver.
- **Quantization**: synthesized transforms are quantized before output
  (position to 1 mm, rotation to 0.01°, matching the quantization
  instinct already used for cross-platform bake identity) so JS and
  any future C++ port agree bit-for-bit on the *output*, whatever the
  internal float path.
- **Failure shape**: synthesis fails *incomplete*, never invalid — the
  report says which sockets went unfilled. The bake stage treats an
  incomplete assembly the way settlement layout treats `WfcError`:
  retry with a derived seed up to a bound, then fail the stage with
  the report attached. No silent fallbacks, no partial towns.
- **Cost gate** (the mandatory rubric): per-assembly and per-town
  solve ms measured at pilot time on the bake, reported with the
  change, against the WFC-only baseline. Synthesis is bake-time, so
  the budget is bake duration, not frame time — but bake duration is
  a real budget (world bakes already run long) and the gate applies.
- **Corpus gate**: examples enter only with license provenance
  recorded in the ExampleAssembly (`license` field) — CC0 clean,
  CC-BY with CREDITS.md, everything else excluded, same discipline as
  the asset packs. A learned rule set inherits its sources' provenance
  list, so any rule can be traced to the examples that taught it.

## 10. Closing the style loop

The style pipeline's fourth step — **validate** — extends naturally:

- The analyzer learns a second profile family: alongside
  `style-profile.json` (statistics of single assets), the extractor's
  `LearnedRuleSet.stats` describe *assemblies* (part frequencies,
  adjacency frequencies, size distribution).
- Synthesized assemblies are re-analyzed by the same extractor and
  compared: adjacency-distribution distance and part-frequency
  distance against the source examples, with thresholds set at pilot
  time from real numbers, not invented here.
- A synthesis output that drifts from its examples fails validation
  the same way a generated rock that violates its profile does today.
  Style stays a measured property, not a vibe.

## 11. Honest costs and risks

| Risk / cost | Severity | Mitigation in this map |
|---|---|---|
| Example corpus for buildings is thin today (archetype boxes, not part assemblies) | **High — the real blocker** | Phase 1 (§12) builds the first example assemblies deliberately (decompose archetypes into parts); nothing synthesizes before examples exist. |
| Learned rules encode an example's flaws as faithfully as its style | Medium | Validator + by-eye style gate at pilot; rules are inspectable data, editable like profiles. |
| Continuous synthesis is harder to make bit-identical across platforms than grid WFC | Medium | Output quantization (§9); bake is single-platform today; goldens catch drift. |
| Global guarantees weaken if synthesis creeps upward into WFC's layer | Medium | The hybrid contract (§8) is the guardrail: counts/demand never decided by growth. |
| Decomposition tooling (splitting GLBs into parts with sockets) is real work | Medium | Start from settlement structure data (already part-shaped) before GLB surgery; GLB decomposition is a later, optional input. |
| Research-code temptation (porting academic implementations wholesale) | Low | Reimplement from the technique, per house rule (open-source shelf = design refs only); license gates before any adoption conversation. |

## 12. Phased adoption — each phase gated, each with a kill criterion

- **Phase 0 — This map.** Done when Joey accepts the verdict table
  (§5). Kill: the map itself, if the verdicts don't survive his read.
- **Phase 1 — Example assemblies + extractor prototype.** Decompose
  2–3 building archetypes into part catalogs; extractor emits a
  LearnedRuleSet from them; judged by whether a human reading the
  rules recognizes the buildings. Kill: rules that don't read as the
  examples' structure.
- **Phase 2 — Synthesizer core.** Growth over learned adjacency,
  seeded, quantized output, `SynthesisError`-style reporting, unit +
  golden tests mirroring the wfc package's test discipline. Kill:
  cannot hit determinism goldens, or per-assembly cost blows the bake
  budget at pilot scale.
- **Phase 3 — Pilot: building variants in the town bake, behind a
  flag.** One town type; WFC still solves structures; synthesis
  assembles the buildings. Judged by eye against the low-poly style
  gate + validator distances + bake-ms report. Kill: fails the eye
  gate or the cost gate — the flag comes out, archetype boxes stay.
- **Phase 4 — Settlement frontage hybrid.** Solved plots + synthesized
  street frontages on one town type. Same gates.
- **Phase 5 — Loop closure + editor.** Validator thresholds hardened
  from pilot data; synthesis problems join the PCG graph library;
  EXTEND paths (dungeon socket extraction, vegetation clustering)
  scheduled only now, from evidence. Kill: n/a — this phase is
  consolidation, entered only on pilot success.

No phase starts without Joey's word, per-item, as always.

## 13. Decision summary (one glance)

| Question | Answer |
|---|---|
| Does model synthesis replace the WFC solver? | **No.** It covers one flagship domain the solver structurally can't (free-transform assemblies) and extends two. |
| What is actually new to build? | An extractor output (learned adjacency) on the existing analyzer, and one bake-time synthesizer package. Nothing else. |
| What is the true prerequisite? | Example building assemblies — parts with sockets. Corpus before code. |
| Where do guarantees live? | Where they live now: the graph solver's counts/budgets/needs. Synthesis never decides them. |
| What stays untouched? | Placement/raymarcher settling, navmesh, streaming, the wire, the tick. Output is a placement list. |
| Determinism story? | Seeded growth + quantized output + goldens — the house discipline, applied to a new mechanism. |
| First concrete step if approved? | Phase 1: decompose 2–3 archetype buildings into a part catalog and extract the first learned rule set. |
