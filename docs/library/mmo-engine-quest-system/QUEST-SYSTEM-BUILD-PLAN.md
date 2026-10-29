# Quest / Raid / Storyline System — Build Plan

**For:** Claude (the implementing agent). **Goal:** build the procedural quest, raid, and Season 1 storyline system for the MMO engine with zero open decisions. Work the slices in order, Q1 through Q9. Do not start a slice until the previous slice's done checklist is fully green. Each slice is self-contained: goal, exact files, exact formats, exact behaviors, exact tests, done checklist.

## Global rules (apply to every slice)

1. **Edge-side only.** All generation, validation, and lore mutation runs in the edge API layer (`apps/edge`) or in `packages/*` libraries it imports. Nothing quest-related is ever generated or decided in `apps/client`. The client only displays what the edge sends. (See "Placement — edge vs core" below.)

## Placement — edge vs core (applies to every slice)

The engine is split into two processes (see the engine architecture brief §1): the **edge** API layer (client connections, HTTP routes, packet router) and **engine-core** (simulation). The quest content system lives entirely in the **edge**:
- `packages/lore` and `packages/quests`, all `/api/*` quest routes, the builder, checker, director, fact store, and mythic evaluator run in the edge.
- The edge keeps its own SQLite database (`quest.db`) for facts, overrides, and approvals — separate from the core's simulation database.
- The **core** does exactly one new thing for quests: at the end of every tick it sends that tick's gameplay events to the edge over the internal channel as `{ type: "tick.events", id: "<n>", payload: { tick: <number>, events: GameEvent[] } }`. It sends every tick, even when `events` is empty.
- The edge feeds those events into the mythic evaluator's rolling buffer. If the core is down, no new gameplay events arrive: mythic evaluation pauses, everything else keeps working.
- Outcome delivery for mythic triggers: `grant_item` and `spawn_boss` outcomes are sent to the core over the channel (`mythic.grant_item`, `mythic.spawn_boss` packets) because inventories and entity spawning are simulation state; `unlock_questline` is handled edge-locally; announcements are broadcast to clients directly by the edge (it owns the connections).
2. **Determinism.** No `Math.random` anywhere in new code — grep must prove it. Randomness always comes from an injected RNG. `packages/quests/src/rng.ts` defines `mulberry32` (exact implementation in Q2); every slice reuses it. Same inputs + same seed = byte-identical JSON output, always.
3. **Story content lives in data files only.** Lore, recipes, chapters, rules, beats, overrides — all in `content/lore/*.json`. Zero story text hard-coded in TypeScript. If a string would appear on a player's screen, it comes from a data file.
4. **DRY.** Shared logic lives in exactly one module and is imported. Never copy-paste a function between packages.
5. **Validate strictly, fail loudly.** Every loader collects ALL problems and throws one Error listing each on its own line: file, record id, what's wrong. Never silently skip a bad record.
6. **Tests + docs per slice.** Every slice adds tests and updates/creates the relevant README. `npm test` from the repo root must pass before the slice counts as done.

---

## Slice Q1 — Lore book

**Goal:** the data files, the loader, and the query API. No generation yet — pure foundation.

**Files to create (repo-root relative, exact):**
```
content/lore/factions.json
content/lore/characters.json
content/lore/places.json
content/lore/items.json
content/lore/relations.json
packages/lore/src/types.ts
packages/lore/src/load.ts
packages/lore/src/query.ts
packages/lore/src/index.ts
packages/lore/test/load.test.ts
packages/lore/test/query.test.ts
packages/lore/README.md
```
Also add `packages/lore` to the root `package.json` workspaces array if it isn't picked up automatically.

**Data formats (exact — no extra fields, no missing fields):**

`factions.json` — JSON array:
```json
{ "id": "f_townsguard", "name": "Townsguard of Emberhold", "description": "The town's volunteer militia.", "disposition": "friendly", "homePlaceId": "p_emberhold" }
```
`disposition` ∈ `friendly` | `neutral` | `hostile` (exact strings).

`characters.json` — JSON array:
```json
{ "id": "c_mayor", "name": "Mayor Sella", "factionId": "f_townsguard", "placeId": "p_emberhold", "role": "quest giver", "rankMin": 1, "description": "Runs the town council." }
```
`factionId` may be `null`. `rankMin` is an integer ≥ 1.

`places.json` — JSON array:
```json
{ "id": "p_emberhold", "name": "Emberhold", "kind": "town", "description": "A walled farming town." }
```
`kind` ∈ `town` | `dungeon` | `wilderness` | `landmark`.

`items.json` — JSON array:
```json
{ "id": "i_embercharm", "name": "Ember Charm", "kind": "trinket", "description": "A warm stone on a cord." }
```
`kind` ∈ `artifact` | `weapon` | `trinket` | `key`.

`relations.json` — JSON array:
```json
{ "aId": "c_mayor", "bId": "c_captain", "relation": "ally", "strength": 5 }
```
`relation` ∈ `ally` | `enemy` | `lives_in` | `guards` | `seeks` | `owns`. `strength` is an integer 1–5.

**`types.ts`:** export interfaces `Faction`, `Character`, `Place`, `Item`, `Relation` matching the formats exactly, plus `LoreBook { factions: Faction[]; characters: Character[]; places: Place[]; items: Item[]; relations: Relation[] }`.

**`load.ts` — `loadLoreBook(dir: string): LoreBook`. Exact behavior:**
1. Read the five files from `dir`. Missing file or invalid JSON → throw one Error naming the file.
2. Validate, collecting ALL problems before throwing (never stop at the first):
   - Every `id` unique within its own file.
   - Every non-null `factionId`, every `placeId`, every `homePlaceId` references an existing id.
   - Every `aId`/`bId` references an id existing in any of the four entity files.
   - Every enum field is one of its allowed values; `strength` 1–5; `rankMin` ≥ 1.
3. On problems: throw one Error, one line per problem: file, record id, what's wrong.
4. On success: return the LoreBook with all five arrays `Object.freeze`d.

**`query.ts` — exact functions (LoreBook always first arg):**
- `getFaction(book, id)`, `getCharacter(book, id)`, `getPlace(book, id)`, `getItem(book, id)` → record or `undefined`.
- `charactersOfFaction(book, factionId)` → array (possibly empty).
- `placesOfKind(book, kind)` → array.
- `charactersAtPlace(book, placeId)` → array.
- `relatedTo(book, id, relation?)` → array of `{ record, relation, strength }`; filtered when `relation` given.
- `pickRandom(list, rng)` → one element; `rng: () => number` in [0,1); throws on empty list. (Note: book not needed here — list in, element out.)

**`index.ts`:** re-export everything. Nothing else.

**Seed data — write exactly these records (Chapter 1 "Arrival"):**

Factions: `f_townsguard` (Townsguard of Emberhold, friendly, home p_emberhold, "The town's volunteer militia."); `f_riverfolk` (Riverfolk Traders, friendly, home p_emberhold, "Barge traders who winter in Emberhold.").

Places: `p_emberhold` (Emberhold, town, "A walled farming town."); `p_millroad` (Mill Road, wilderness, "A rutted trade road through farmland."); `p_greyhollow` (Greyhollow Cave, dungeon, "A damp cave system in the hills."); `p_ferry` (Old Ferry Crossing, landmark, "A rope ferry across the Grey River."); `p_whisperwood` (Whisperwood Edge, wilderness, "The treeline where the deep woods begin.").

Characters: `c_mayor` (Mayor Sella, f_townsguard, p_emberhold, "quest giver", rank 1, "Runs the town council."); `c_captain` (Captain Rurik, f_townsguard, p_emberhold, "guard captain", rank 1, "Commands the Townsguard."); `c_scout` (Scout Pell, f_townsguard, p_millroad, "scout", rank 1, "Patrols the Mill Road."); `c_healer` (Healer Maren, f_townsguard, p_emberhold, "healer", rank 2, "Tends the town infirmary."); `c_trader` (Trader Odo, f_riverfolk, p_emberhold, "merchant", rank 1, "Sells barge goods at the market."); `c_ferryman` (Ferryman Jost, f_riverfolk, p_ferry, "ferryman", rank 3, "Operates the rope ferry."); `c_smith` (Smith Duna, f_townsguard, p_emberhold, "blacksmith", rank 2, "Shoes horses and mends blades."); `c_hermit` (Hermit Vess, null, p_whisperwood, "hermit", rank 4, "Lives alone at the treeline."); `c_wolfalpha` (Grey Alpha, null, p_whisperwood, "beast", rank 1, "Leader of the whisperwood wolf pack."); `c_cavemother` (Cave Mother, null, p_greyhollow, "beast", rank 3, "A giant cave spider.").

Items: `i_embercharm` (Ember Charm, trinket, "A warm stone on a cord."); `i_ironkey` (Iron Cellar Key, key, "Opens the town hall cellar."); `i_moonpetal` (Moonpetal Herb, artifact, "A rare herb that blooms at night.").

Relations (13): (c_mayor, c_captain, ally, 5), (c_captain, c_scout, ally, 4), (c_mayor, c_healer, ally, 4), (c_trader, c_ferryman, ally, 4), (c_smith, c_captain, ally, 3), (f_townsguard, f_riverfolk, ally, 4), (c_scout, p_millroad, lives_in, 5), (c_ferryman, p_ferry, lives_in, 5), (c_hermit, p_whisperwood, lives_in, 5), (c_wolfalpha, p_whisperwood, lives_in, 5), (c_cavemother, p_greyhollow, lives_in, 5), (c_captain, p_emberhold, guards, 5), (c_hermit, i_moonpetal, seeks, 3).

**Tests:**
- `load.test.ts`: (1) seed data loads with zero errors; (2) temp copy with a duplicated character id throws, message names the id; (3) temp copy with a character pointing at a nonexistent faction throws, message names the record; (4) temp copy with `disposition: "angry"` throws. Use temp directories — never mutate the shipped files in tests.
- `query.test.ts`: (1) `charactersOfFaction(book, "f_townsguard")` has length 5; (2) `placesOfKind(book, "wilderness")` = millroad + whisperwood; (3) `relatedTo(book, "c_captain", "ally")` includes scout and smith; (4) `pickRandom` with `() => 0` always returns the first element; (5) `getCharacter(book, "nope")` is undefined.

**`README.md`:** one page — what the five files are, the exact field formats, how to add an entry, the unique-id rule.

**Done checklist:** `npm test` green from repo root; `grep -r "Math.random" packages/lore` empty; deleting any one seed file makes the loader throw naming that file; README matches the actual formats.

---

## Slice Q2 — Quest recipes + builder

**Goal:** the recipe format and the quest generator. Input: lore book + request. Output: a QuestDraft.

**Files to create (exact):**
```
content/lore/recipes.json
packages/quests/src/types.ts
packages/quests/src/rng.ts
packages/quests/src/recipes.ts
packages/quests/src/nodes.ts
packages/quests/src/builder.ts
packages/quests/src/index.ts
packages/quests/test/rng.test.ts
packages/quests/test/builder.test.ts
packages/quests/README.md
```
Add `packages/quests` to root workspaces if needed.

**`rng.ts` — exact implementation (the only RNG in the quest system):**
```ts
export type Rng = () => number; // returns [0, 1)
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

**Recipe format (exact):**
```json
{
  "id": "r_escort",
  "name": "Escort",
  "description": "Guide a character through a dangerous place.",
  "rankMin": 1,
  "rankMax": 10,
  "slotSpecs": [
    { "slot": "character", "kind": "character", "filter": { "role": "scout" }, "pick": "prefer_met" },
    { "slot": "place", "kind": "place", "filter": { "kind": "wilderness" }, "pick": "random" }
  ],
  "titleTemplate": "Escort {character} through {place}",
  "briefTemplate": "{character} needs safe passage through {place}. Beasts have been seen on the road.",
  "steps": [
    { "kind": "travel", "text": "Meet {character} at {place}.", "bind": { "characterId": "character", "placeId": "place" } },
    { "kind": "combat", "text": "Defend {character} from attacking beasts.", "bind": { "characterId": "character" } },
    { "kind": "turnin", "text": "See {character} safely home.", "bind": { "characterId": "character" } }
  ],
  "rewards": { "xp": 50, "gold": 10 }
}
```
Rules: `slot` names must be unique within the recipe. `kind` ∈ `character` | `place` | `faction` | `item`. `filter` is a partial record: every specified field must match; a filter value may be a scalar (exact match) or an array (match if the field equals any element). `pick` ∈ `random` | `prefer_met` | `prefer_unmet`. Every `{slot}` in the templates and step texts must name a defined slot. Step `kind` ∈ `travel` | `combat` | `collect` | `talk` | `puzzle` | `boss` | `turnin` | `escort`. `bind` maps QuestStep id fields (`characterId` | `placeId` | `factionId` | `itemId`) to slot names; bound ids must exist on the step's record kind. `rewards` has exactly `xp` and `gold`, both integers ≥ 0.

**`recipes.ts` — `loadRecipes(path: string): Recipe[]`:** read + parse the file; validate every rule above, collecting ALL problems into one thrown Error (file, recipe id, problem per line), same style as Q1.

**Types (`types.ts`):** `Recipe`, `SlotSpec`, `QuestStepDef`, `QuestDraft`, `BuildRequest`, `Rng` (re-export from rng.ts).
```ts
interface BuildRequest { playerRank: number; metIds: string[]; seed: number; recipeId?: string; pool?: { factionIds?: string[]; characterIds?: string[]; placeIds?: string[]; itemIds?: string[] }; }
interface QuestDraft { id: string; recipeId: string; title: string; brief: string; steps: QuestStep[]; rewards: { xp: number; gold: number }; rankMin: number; seed: number; loreIds: string[]; }
interface QuestStep { kind: StepKind; text: string; characterId?: string; placeId?: string; factionId?: string; itemId?: string; }
```
`pool`: when present, slot candidates are restricted to the listed ids (chapter scoping, used fully in Q5). When omitted, the whole book is the pool.

**`builder.ts` — `buildQuest(book: LoreBook, recipes: Recipe[], req: BuildRequest, rng: Rng): QuestDraft`. Exact steps:**
1. Eligible recipes = those with `rankMin <= req.playerRank <= rankMax`. If `req.recipeId` given: it must be in the eligible list or throw `Recipe <id> not eligible for rank <n>`.
2. If no recipeId: pick uniformly from eligible via rng. If none eligible: throw `No recipes eligible for rank <n>`.
3. For each slotSpec in order: candidates = records of that kind, filtered by `filter`, then restricted by `req.pool` if present. If empty: throw `No candidates for slot <slot> in recipe <id>`. Order candidates: `prefer_met` → metIds first (stable), then the rest; `prefer_unmet` → unmet first; `random` → as-is. Pick `candidates[floor(rng() * len)]`.
4. Additionally enforce `rankMin` on characters: skip characters with `rankMin > req.playerRank`. (Beasts included — they have rankMin too.)
5. Substitute `{slot}` with the chosen record's `name` in title, brief, and step texts. Resolve `bind` to concrete ids.
6. `id` = `"q_" + req.seed + "_" + n` where `n` counts quests built in this call sequence (see preview: seed, seed+1… — the caller passes a distinct seed per quest; `n` is always 0 for single builds, kept for multi-build).
7. `loreIds` = sorted unique ids of all chosen records. `rankMin`/`rewards` copied from the recipe. `seed` = req.seed.

**`nodes.ts` — register four nodes in the existing PCG node registry** (the same registry the scatter nodes use; follow its node interface exactly):
- `quest.selectRecipe`: inputs `{ recipes, playerRank, recipeId? }`, output `{ recipe }`. Implements builder step 1–2.
- `quest.fillSlots`: inputs `{ recipe, book, pool?, metIds, rng }`, output `{ slots }` (map slot name → record). Implements builder steps 3–4.
- `quest.assemble`: inputs `{ recipe, slots, seed }`, output `{ draft }`. Implements steps 5–7.
- `quest.build`: composite node running the three above in order; inputs `{ book, recipes, request }`, output `{ draft }`. Creates its own rng via `mulberry32(request.seed)`.

**Seed recipes — write exactly these four into `content/lore/recipes.json`:**
1. `r_escort` (rank 1–10): slots: character(kind character, no filter, prefer_met), place(kind place, filter {kind: "wilderness"}, random). Title "Escort {character} through {place}". Steps: travel/turnin/combat as in the example above. Rewards xp 50 gold 10.
2. `r_bounty` (rank 2–10): slots: target(kind character, filter {role: "beast"}, prefer_unmet), place(kind place, filter {kind: ["wilderness","dungeon"]}, random). Title "Thin the beasts at {place}". Steps: travel ("Travel to {place}."), combat ("Defeat {target}."), combat ("Drive off the rest of the pack."), turnin ("Report back."). Rewards xp 80 gold 15.
3. `r_delivery` (rank 1–5): slots: item(kind item, filter {kind: ["trinket","key"]}, random), giver(kind character, filter {role: "merchant"}, prefer_met), place(kind place, filter {kind: "town"}, random). Title "Deliver {item} to {place}". Steps: talk ("Collect {item} from {giver}."), travel ("Carry {item} to {place}."), turnin ("Deliver {item}."). Rewards xp 30 gold 20.
4. `r_gather` (rank 3–8): slots: item(kind item, filter {kind: "artifact"}, random), place(kind place, filter {kind: "wilderness"}, random), hermit(kind character, filter {role: "hermit"}, prefer_met). Title "Gather {item} at {place}". Steps: talk ("Ask {hermit} where it grows."), travel ("Search {place}."), collect ("Gather the {item}."), turnin ("Bring it to {hermit}."). Rewards xp 70 gold 12.

**Tests:**
- `rng.test.ts`: two `mulberry32(42)` instances produce identical 100-value sequences; values are all in [0,1).
- `builder.test.ts`: (1) same seed twice → `JSON.stringify` of both drafts identical; (2) rank 1 request never selects r_gather or r_bounty (run 50 seeds, assert recipeId each time); (3) with rng `() => 0` and metIds `["c_scout"]`, r_escort picks c_scout; (4) r_bounty's target always has role "beast" (20 seeds); (5) temp recipes file with a template referencing an undefined slot throws naming the recipe; (6) every `{slot}` in the generated title/brief/steps is substituted (no literal `{` remains).

**README:** what recipes are, the format, the slot filter/pick semantics, how the builder picks, the determinism guarantee.

**Done checklist:** `npm test` green; `grep -r "Math.random" packages/quests` empty; a scratch script generating 20 quests (seeds 1–20, rank 5) — every `loreIds` entry exists in the seed data; README matches implementation.

---

## Slice Q3 — Story checker

**Goal:** the rule engine that rejects quests that don't make narrative sense, wired into the builder with retry + safe fallback.

**Files to create/modify (exact):**
```
content/lore/story-rules.json          (create)
packages/quests/src/checker.ts         (create)
packages/quests/src/builder.ts         (modify: add checked build)
packages/quests/test/checker.test.ts   (create)
packages/quests/README.md              (modify: document rules)
```

**Rule format (exact):**
```json
{ "id": "rule_boss_last", "description": "A boss step must be the final step.", "check": "boss_last" }
```
`check` is one of these exact named checks (no custom expressions — adding a check means adding code + a test, documented below):
- `boss_last`: if any step has kind `boss`, the last step must be kind `boss`.
- `no_boss_without_buildup`: if any step has kind `boss`, at least 2 non-boss steps precede the first boss step.
- `turnin_last`: if any step has kind `turnin`, the last step must be kind `turnin`.
- `travel_first`: the first step must be kind `travel` or `talk`.
- `escort_needs_character`: every step of kind `escort` must have a `characterId` set.
- `max_steps`: `steps.length <= params.max` (params: `{ "max": 8 }`).
- `no_orphan_binds`: every id field set on a step (`characterId`, `placeId`, `factionId`, `itemId`) must appear in the draft's `loreIds`.

**`checker.ts` — exact API:**
```ts
interface CheckResult { ok: boolean; violations: string[]; } // violations = rule ids, in rule-file order
function loadRules(path: string): Rule[];   // same strict load+validate style as Q1/Q2
function checkQuest(draft: QuestDraft, rules: Rule[], playerRank: number): CheckResult;
```
`playerRank` is accepted for future rank-aware rules; current checks ignore it (do not invent rank logic here).

**Seed rules — write exactly these five into `content/lore/story-rules.json`:** `rule_travel_first` (travel_first), `rule_turnin_last` (turnin_last), `rule_boss_last` (boss_last), `rule_boss_buildup` (no_boss_without_buildup), `rule_max_steps` (max_steps, max 8). Plus `rule_escort_character` (escort_needs_character) and `rule_no_orphan_binds` (no_orphan_binds). Total: 7 rules.

**Builder integration — modify `builder.ts`, add exactly:**
```ts
function buildQuestChecked(book, recipes, req, rules, maxAttempts = 3, checker = checkQuest): QuestDraft
```
Behavior: attempt 1 uses `req.seed`; attempt k uses `seed = req.seed * 1000 + k` with a fresh `mulberry32`. After each attempt, run `checker(draft, rules, req.playerRank)`. Return the first attempt with `ok`. If all attempts fail, build once more with `recipeId: "r_delivery"` (the simplest safe recipe — it must exist; Q2 guarantees it) and return that draft WITHOUT checking (document why in a comment: the fallback recipe is hand-verified against all rules at authoring time). The `checker` parameter exists so tests can inject a stub.

**Adding a new check (document in README):** add the named implementation in `checker.ts`, add one rule entry to the JSON, add one positive + one negative test. No other files change.

**Tests (`checker.test.ts`):**
1. Hand-built draft with boss not last → violations contains `rule_boss_last`, `ok` false.
2. Hand-built draft with boss as step 1 of 2 → `rule_boss_buildup` violated.
3. Draft ending in combat with a turnin in the middle → `rule_turnin_last` violated.
4. Draft starting with combat → `rule_travel_first` violated.
5. Draft with 9 steps → `rule_max_steps` violated.
6. Draft with `characterId: "nope"` on a step → `rule_no_orphan_binds` violated.
7. Each of the four seed recipes generates a draft (seeds 1–10) that passes all 7 rules — if any seed recipe fails, fix the recipe, not the rules.
8. `buildQuestChecked` with a stub checker that fails twice then passes returns on the third attempt (assert by counting stub calls = 3).
9. `buildQuestChecked` with a stub checker that always fails returns a draft with `recipeId === "r_delivery"`.

**Done checklist:** `npm test` green; the 4 seed recipes pass all rules across seeds 1–50 (add a scratch test, keep it — it's cheap); README documents the 7 checks and how to add one.

---

## Slice Q4 — World's memory + rank gates

**Goal:** the game remembers what happened (facts), and rank controls what the generator is allowed to do.

**Files to create/modify (exact):**
```
packages/quests/src/memory.ts          (create)
packages/quests/src/ranks.ts           (create)
packages/quests/src/builder.ts         (modify: add chainQuests)
packages/quests/test/memory.test.ts    (create)
packages/quests/test/ranks.test.ts     (create)
packages/quests/README.md              (modify)
```

**Facts — exact shape:**
```ts
interface Fact { id: string; kind: "slew" | "met" | "completed" | "befriended" | "discovered"; subjectId: string; targetId: string | null; questId: string | null; tick: number; }
```
`subjectId` is always a character id (usually the player). `targetId` is the other party (a character, place, or item id) or null. `tick` is the core tick when recorded (pass it in — memory never reads a clock).

**`memory.ts` — exact API (SQLite via the engine's existing SQLite pattern):**
- `ensureFactTable(db): void` — creates table `quest_facts` if missing: columns `id TEXT PRIMARY KEY, kind TEXT, subjectId TEXT, targetId TEXT, questId TEXT, tick INTEGER`. Column names exactly as written.
- `recordFact(db, fact: Omit<Fact,"id">): Fact` — `id` = `"f_" + tick + "_" + rowid` where rowid is the SQLite rowid of the inserted row (read it back after insert). Returns the full Fact.
- `getFacts(db, filter: { subjectId?: string; kind?: Fact["kind"]; targetId?: string }): Fact[]` — all filters ANDed, ordered by tick ascending.
- `hasFact(db, subjectId, kind, targetId?): boolean` — true if at least one matching fact exists.
- `factsAbout(db, characterId): Fact[]` — facts where subjectId OR targetId equals the id, ordered by tick ascending. (This is the NPC-dialogue hook.)

**Rank gates — `ranks.ts`, exact table (no configuration file; this is game design, fixed in code):**
```ts
interface RankGate { maxChainLength: number; raidsUnlocked: boolean; }
function rankGate(playerRank: number): RankGate {
  if (playerRank <= 5)  return { maxChainLength: 1, raidsUnlocked: false };
  if (playerRank <= 10) return { maxChainLength: 3, raidsUnlocked: false };
  if (playerRank <= 15) return { maxChainLength: 5, raidsUnlocked: false };
  if (playerRank <= 20) return { maxChainLength: 8, raidsUnlocked: true  };
  return { maxChainLength: 12, raidsUnlocked: true };
}
```
Copy this function exactly. Ranks are integers ≥ 1; rank ≤ 0 throws `Rank must be >= 1`.

**Quest chains — add to `builder.ts`:**
```ts
function chainQuests(book, recipes, rules, req: BuildRequest, length: number, rng: Rng): QuestDraft[]
```
Exact behavior: clamp `length` to `rankGate(req.playerRank).maxChainLength` (if req asks for more, build the clamped number — never throw). Build quest 1 with `buildQuestChecked`. For quest k>1: copy req, set `metIds = [...new Set([...req.metIds, ...prev.loreIds])]`, set `seed = req.seed + k`, build with `buildQuestChecked`. Return the array in order. (This is the "quest memory" mechanism: each quest's people and places flow into the next quest's candidate pool via `prefer_met`.)

**Tests:**
- `memory.test.ts`: use an in-memory SQLite database. (1) record 3 facts, `getFacts` with subjectId returns them in tick order; (2) `hasFact` true/false cases; (3) `factsAbout` returns facts where the character is either subject or target; (4) `ensureFactTable` twice doesn't error.
- `ranks.test.ts`: (1) rankGate(1) = {1, false}; (5) = {1,false}; (6) = {3,false}; (15) = {5,false}; (16) = {8,true}; (25) = {12,true}; (2) rankGate(0) throws.
- `builder.test.ts` (add): chain of length 3 at rank 8 → returns 3 drafts; quest 2's effective metIds include quest 1's loreIds (assert by spying: build with rng `() => 0` and check quest 2's title mentions a character from quest 1 — simpler deterministic assert: quest2.loreIds shares at least one id with quest1.loreIds OR quest2 was built with metIds containing quest1.loreIds — assert the latter by exposing metIds? Don't change the draft shape. Instead: test that `chainQuests` with length 10 at rank 5 returns exactly 1 quest (clamping).

**Done checklist:** `npm test` green; chain clamping verified; README documents facts, the rank table, and chains.

---

## Slice Q5 — Chapters + Season 1 content

**Goal:** the chapter format, all five Season 1 chapters' data, the authored story beats, and the extended lore the later chapters need.

**Files to create/modify (exact):**
```
content/lore/chapters.json             (create)
packages/quests/src/chapters.ts        (create)
packages/quests/src/director.ts        (create)
packages/quests/test/chapters.test.ts  (create)
packages/quests/test/director.test.ts  (create)
content/lore/factions.json etc.        (modify: add chapters 2–5 ingredients — exact lists below)
packages/quests/README.md              (modify)
```

**Chapter format (exact):**
```json
{
  "id": "ch1",
  "name": "Arrival",
  "rankMin": 1,
  "rankMax": 5,
  "pool": { "factionIds": ["f_townsguard","f_riverfolk"], "characterIds": ["c_mayor", "..."], "placeIds": ["p_emberhold","p_millroad","p_greyhollow","p_ferry","p_whisperwood"], "itemIds": ["i_embercharm","i_ironkey","i_moonpetal"] },
  "recipeIds": ["r_escort","r_bounty","r_delivery","r_gather"],
  "beats": [
    { "id": "b_ch1_1", "order": 1, "title": "Blood on the Mill Road", "text": "Scout Pell stumbles into Emberhold wounded: beasts are attacking travelers on the Mill Road.", "requiresRank": 1 },
    { "id": "b_ch1_2", "order": 2, "title": "The Townsguard's Oath", "text": "Captain Rurik swears the Townsguard will hold the road, and asks the player to stand with them.", "requiresRank": 3 }
  ]
}
```
Rules: `pool` lists must reference existing ids (validated). `recipeIds` must reference existing recipes. Beat `order` starts at 1 with no gaps. `requiresRank` within the chapter's rank band.

**`chapters.ts` — `loadChapters(path): Chapter[]`** — same strict load+validate style. Cross-validates against lore + recipes: pass the loaded `LoreBook` and `Recipe[]` in (`loadChapters(path, book, recipes)`) and validate every pool id and recipe id exists.

**`director.ts` — the chapter-aware quest source. Exact API:**
```ts
interface DirectorRequest { playerRank: number; metIds: string[]; seed: number; db: unknown; }
function nextContent(book, recipes, chapters, rules, req: DirectorRequest): QuestDraft | Beat
```
(`db: unknown` — the SQLite handle type the engine uses; do not invent a wrapper.)
Exact behavior:
1. Find the chapter where `rankMin <= playerRank <= rankMax`. None → throw `No chapter for rank <n>`.
2. Completed beats = facts from db with `kind: "completed"` and `targetId` = beat id, for this player (subjectId = player id — pass `playerId` in the request; add it: `DirectorRequest` includes `playerId: string`).
3. Next unbeaten beat with `requiresRank <= playerRank` → return it as a `Beat` (the client renders beats as authored quests; beats are NOT generated).
4. Otherwise → `buildQuestChecked` with `BuildRequest { playerRank, metIds, seed, pool: chapter.pool, recipeId: undefined }`, then restrict recipes to `chapter.recipeIds` (filter the recipes array before calling).
5. After returning a beat or quest, the CALLER records the fact on completion (director never writes facts — read-only).

**Lore extensions — add exactly these records to the four entity files** (names are Joey's placeholders; keep the ids exactly as written):

Chapter 2 "Rumblings" (rank 6–10): factions: `f_ironpact` (Iron Pact, hostile, home p_borderwatch, "A warband of deserters turned raiders."); places: `p_borderwatch` (Borderwatch, landmark, "An abandoned watchtower."), `p_dustfield` (Dustfield, wilderness, "Dry plains between Emberhold and the hills."); characters: `c_sergeant` (Sergeant Hobb, f_townsguard, p_borderwatch, "sergeant", rank 6, "Holds Borderwatch with six guards."), `c_raider` (Raider Vane, f_ironpact, p_dustfield, "raider", rank 6, "Leads Iron Pact raids."), `c_informant` (Informant Squeak, null, p_emberhold, "informant", rank 7, "Sells rumors for coin."); items: `i_warpapers` (War Papers, key, "Iron Pact orders, stamped and sealed."); relations: (c_sergeant,p_borderwatch,lives_in,5), (c_raider,p_dustfield,lives_in,5), (c_raider,f_ironpact,ally,4), (f_ironpact,f_townsguard,enemy,5), (c_informant,c_trader,ally,3), (c_sergeant,c_captain,ally,4).

Chapter 3 "The Ashen Covenant" (rank 11–15): factions: `f_covenant` (Ashen Covenant, hostile, home p_ashenhold, "A cult burning the old world to ash."); places: `p_ashenhold` (Ashen Hold, dungeon, "A charred fortress in the hills."), `p_cinderfen` (Cinderfen, wilderness, "A swamp of cold ash."); characters: `c_acolyte` (Acolyte Sarn, f_covenant, p_cinderfen, "acolyte", rank 11, "Preaches the cleansing flame."), `c_inquisitor` (Inquisitor Mara, f_covenant, p_ashenhold, "inquisitor", rank 13, "Hunts the unburned."), `c_refugee` (Refugee Tilda, null, p_emberhold, "refugee", rank 11, "Fled the Cinderfen."); items: `i_ashbrand` (Ashbrand, weapon, "A sword that never cools."); relations: (c_acolyte,p_cinderfen,lives_in,5), (c_inquisitor,p_ashenhold,lives_in,5), (f_covenant,f_townsguard,enemy,5), (f_covenant,f_ironpact,enemy,3), (c_refugee,c_healer,ally,3), (c_inquisitor,c_acolyte,ally,4).

Chapter 4 "Alliances" (rank 16–20): factions: `f_freeholds` (Freeholds Compact, friendly, home p_emberhold, "Allied towns sworn to mutual defense."); places: `p_summit` (Summit Hall, landmark, "Where the alliance was signed."); characters: `c_envoy` (Envoy Pris, f_freeholds, p_summit, "envoy", rank 16, "Speaks for the Compact."), `c_warlord` (Warlord Kaan, f_covenant, p_ashenhold, "warlord", rank 18, "Commands the Covenant's armies."); items: `i_compactseal` (Compact Seal, artifact, "The signed alliance charter."); relations: (c_envoy,p_summit,lives_in,5), (f_freeholds,f_townsguard,ally,5), (f_freeholds,f_riverfolk,ally,4), (f_freeholds,f_covenant,enemy,5), (c_warlord,c_inquisitor,ally,4).

Chapter 5 "Stormfall" (rank 21+): places: `p_stormcrown` (Stormcrown Peak, dungeon, "The Covenant's final stronghold."); characters: `c_prophet` (Prophet of Ash, f_covenant, p_stormcrown, "prophet", rank 21, "Voice of the cleansing flame."); items: `i_stormheart` (Stormheart, artifact, "The source of the Covenant's power."); relations: (c_prophet,p_stormcrown,lives_in,5), (c_prophet,f_covenant,ally,5), (c_warlord,p_stormcrown,guards,5).

**Beats — write exactly these (2–3 per chapter):**

- ch1 "Arrival" (1–5): b_ch1_1 order 1 rank 1 "Blood on the Mill Road" ("Scout Pell stumbles into Emberhold wounded: beasts are attacking travelers on the Mill Road."); b_ch1_2 order 2 rank 3 "The Townsguard's Oath" ("Captain Rurik swears the Townsguard will hold the road, and asks the player to stand with them.").
- ch2 "Rumblings" (6–10): b_ch2_1 order 1 rank 6 "Smoke on the Dustfield" ("Sergeant Hobb reports Iron Pact raiders burning farms beyond Borderwatch."); b_ch2_2 order 2 rank 8 "The Informant's Price" ("Squeak will name the Pact's target — for a price, and a favor."); b_ch2_3 order 3 rank 10 "Borderwatch Holds" ("The player helps Hobb repel the raid on the watchtower. The Pact retreats — but north, toward the hills.").
- ch3 "The Ashen Covenant" (11–15): b_ch3_1 order 1 rank 11 "Ashes in the Fen" ("Refugee Tilda arrives with burns and a warning: the Covenant is coming."); b_ch3_2 order 2 rank 13 "The Inquisitor's List" ("Inquisitor Mara's list of the unburned includes someone the player knows."); b_ch3_3 order 3 rank 15 "Fire at Cinderfen" ("The player strikes the Covenant's fen camp. Mara escapes toward Ashen Hold.").
- ch4 "Alliances" (16–20): b_ch4_1 order 1 rank 16 "The Summit" ("Envoy Pris calls the free towns to Emberhold. Old rivals must sign — or burn separately."); b_ch4_2 order 2 rank 18 "Kaan's Gambit" ("Warlord Kaan besieges the Summit. The alliance holds — barely."); b_ch4_3 order 3 rank 20 "The March North" ("The Compact marches on Ashen Hold. The player leads the vanguard.").
- ch5 "Stormfall" (21+): b_ch5_1 order 1 rank 21 "The Prophet Speaks" ("The Prophet of Ash declares the final cleansing from Stormcrown Peak."); b_ch5_2 order 2 rank 23 "Stormheart" ("The player breaches the Peak and faces the Prophet. The Season 1 climax — the world is permanently changed.").

Each chapter's `pool` = all ids from its own additions PLUS all previous chapters' ids (pools accumulate — the world grows, never shrinks). `recipeIds` for ch1 = the 4 seed recipes; ch2–ch5 = the 4 seed recipes (new recipes arrive only in Q6; do not invent more here).

**Tests:**
- `chapters.test.ts`: (1) all 5 chapters load; (2) every pool id exists in the lore files; (3) beat orders have no gaps; (4) a temp chapters file with a pool id that doesn't exist throws naming it.
- `director.test.ts`: (1) rank 1, no facts → returns beat b_ch1_1; (2) rank 1 with fact completed/b_ch1_1 recorded, rank still 1 → returns generated quest (not beat b_ch1_2, which needs rank 3); (3) rank 4 with b_ch1_1 done → returns b_ch1_2; (4) generated quest's loreIds are all within ch1's pool (seeds 1–20); (5) rank 99 throws `No chapter for rank 99`.

**Done checklist:** `npm test` green; director never returns content outside the player's chapter pool (fuzz seeds 1–100 in a scratch test); README documents chapters, beats, and the director flow.

---

## Slice Q6 — Raids

**Goal:** multi-stage raid generation for parties, using the same builder + checker.

**Files to create/modify (exact):**
```
content/lore/recipes.json              (modify: add 2 raid recipes)
packages/quests/src/types.ts           (modify: add Raid)
packages/quests/src/raids.ts           (create)
packages/quests/test/raids.test.ts     (create)
packages/quests/README.md              (modify)
```

**Raid type (exact):**
```ts
interface Raid { id: string; chapterId: string; name: string; stages: QuestDraft[]; rankMin: number; minPlayers: number; maxPlayers: number; seed: number; }
```
`id` = `"raid_" + seed`. `name` = chapter name + " Assault" (e.g. "Stormfall Assault") — exact format, no variation.

**Raid recipes — append exactly these two to `recipes.json`:**
1. `r_raid_assault` (rank 16–99): slots: warlord(kind character, filter {role: ["warlord","inquisitor","prophet"]}, prefer_met), stronghold(kind place, filter {kind: "dungeon"}, random). Title "Assault on {stronghold}". Steps: travel ("March on {stronghold}."), combat ("Break the outer guard."), combat ("Push through the inner halls."), boss ("Face {warlord}."), turnin ("Claim {stronghold}."). Rewards xp 500 gold 200.
2. `r_raid_siege` (rank 21–99): slots: prophet(kind character, filter {role: "prophet"}, prefer_met), peak(kind place, filter {kind: "dungeon"}, random). Title "Siege of {peak}". Steps: travel, puzzle ("Disable the storm wards."), combat, combat, boss ("Destroy the Stormheart's guardian: {prophet}."), turnin. Rewards xp 800 gold 350.

**`raids.ts` — `buildRaid(book, recipes, chapters, rules, req, rng): Raid`. Exact behavior:**
- `req = { chapterId: string; playerRank: number; partySize: integer 10–40; seed: number; metIds: string[] }`. partySize outside 10–40 → throw `partySize must be 10–40`.
- Raids require `rankGate(playerRank).raidsUnlocked` — else throw `Raids unlock at rank 16`.
- Chapter = the one matching chapterId (must exist or throw).
- Stage count = `3 + floor(partySize / 10)` → 10–19: 4 stages, 20–29: 5, 30–40: 6. (Exact formula.)
- Stages 1..n-1: `buildQuestChecked` with recipeId alternating `r_raid_assault` — no: simpler and exact: all non-final stages use `buildQuestChecked` with NO recipeId (any chapter recipe eligible for the rank), pool = chapter pool, seed = req.seed + stageIndex. Final stage: `buildQuestChecked` with recipeId `r_raid_siege` if rank ≥ 21 else `r_raid_assault`, same pool, seed = req.seed + 999.
- `rankMin` = 16 if any stage used r_raid_assault else 21 — exact: `rankMin: 16`.
- Rewards scaling (exact): each stage's rewards are multiplied: `xp = round(base.xp * (1 + partySize / 20))`, `gold = round(base.gold * (1 + partySize / 20))`. Do not mutate the recipe — compute on the draft copy.
- `minPlayers: 10, maxPlayers: 40` always.

**Tests (`raids.test.ts`):**
1. partySize 9 throws; partySize 41 throws.
2. rank 15 throws `Raids unlock at rank 16`.
3. partySize 12, rank 18, seed 7, ch4 → 4 stages; last stage recipeId `r_raid_assault`; last stage's last step kind is `boss` (checker rule holds).
4. partySize 35 → 6 stages.
5. Same seed twice → identical raid JSON.
6. Stage rewards: with partySize 20, multiplier is exactly 2.0 (xp = base * 2).
7. All stage loreIds within the chapter pool.

**Done checklist:** `npm test` green; raid generation for ch5/rank 25/party 40 completes in under 500ms (scratch timing test); README documents raids.

---

## Slice Q7 — Editor panels

**Goal:** four authoring panels in the existing editor app. The editor edits the same data files the edge reads.

**Where:** `apps/editor` — add a new top-level section "Quests" with four tabs. Use React + shadcn + Tailwind, following the three existing tabs' component patterns exactly (same form components, same styling tokens, same data-fetching pattern). Do not invent new UI primitives.

**Server API — add these exact routes to the edge API layer (`apps/edge`):**
- `GET /api/lore` → `{ factions, characters, places, items, relations, recipes, chapters, rules }` (the raw file contents as parsed JSON).
- `PUT /api/lore/:kind` — `:kind` ∈ `factions|characters|places|items|relations|recipes|chapters|rules`. Body = the full new array for that file. Server validates with the matching loader (Q1/Q2/Q3/Q5 validators); on failure responds 400 with `{ errors: string[] }` (the loader's per-line messages). On success writes the file (pretty-printed, 2-space indent) and responds 200 `{ ok: true }`.
- `POST /api/quests/preview` — body `{ playerRank: number; chapterId?: string; recipeId?: string; seed: number; count: integer 1–20 }`. Returns `{ drafts: QuestDraft[] }` built with seeds seed..seed+count-1 via the director (if chapterId) or builder (if recipeId; exactly one of chapterId/recipeId required, else 400).
- `POST /api/quests/check` — body `{ draft: QuestDraft; playerRank: number }`. Returns `{ ok: boolean; violations: string[] }` from the story checker. (Lets the editor validate hand edits live.)

**The four tabs (exact scope — no more, no less):**
1. **Lore book tab:** five sub-lists (factions, characters, places, items, relations). Each row: name + edit button. Edit opens a form with one field per format field (Q1), dropdowns for enum fields and id references (populated from the loaded data — never free-text for references). Save → `PUT /api/lore/:kind`. Validation errors display as a list, one per line.
2. **Recipe tab:** list of recipes; edit form mirroring the recipe format (slots as repeatable rows; template textareas; steps as repeatable rows with kind dropdown + text + bind fields). **"Test fill" button:** calls `POST /api/quests/preview` with the edited recipe (recipeId), rank 10, seed = current timestamp, count 5 — displays the five generated titles + briefs below the form.
3. **Chapter tab:** chapter list; edit form (name, rank band, pool as multi-selects from lore ids, recipe multi-select, beats as ordered rows). **Timeline view:** beats rendered as fixed pins in order; a "simulate" button generates 10 quests via preview and renders them as cards slotted between the pins.
4. **Quest inspector tab:** inputs: rank (number), chapter (dropdown), seed (number), count (default 5). **Generate** → preview → each draft shown as a card (title, brief, steps, rewards, lore ids). Each card has three buttons: **Approve** (calls `POST /api/quests/approve` — implemented in Q8; in Q7 the button is present but disabled with tooltip "coming in Q8" — exact behavior, do not implement approval early), **Regenerate** (new seed = seed+1000, refresh that card), **Edit** (opens the draft in an editable form; saving calls the override endpoint — also Q8; in Q7 the save button is disabled with the same tooltip).

**Tests:** API-level tests for the four routes (valid PUT round-trips; invalid PUT returns 400 with named errors; preview returns `count` drafts; check returns violations for a hand-made bad draft). UI: component tests for the enum/reference dropdown behavior (no free-text id entry possible). Visual: screenshot each tab (list in the done checklist for human review).

**Done checklist:** `npm test` green; all four tabs render with the seed data; an edit to a faction name through the UI appears in a subsequent quest preview (round-trip proof); disabled Q8 buttons show the exact tooltip "coming in Q8"; README in `apps/editor` documents the Quests section.

---

## Slice Q8 — Override layer + approval flow

**Goal:** non-destructive hand edits and approvals. Generated content is never mutated — edits live in an override layer.

**Files to create/modify (exact):**
```
content/lore/overrides.json            (create; starts as `[]`)
content/lore/approved.json             (create; starts as `[]`)
packages/quests/src/overrides.ts       (create)
packages/quests/test/overrides.test.ts (create)
Edge routes                            (modify: add three routes)
apps/editor quest inspector            (modify: enable the Q7 disabled buttons)
packages/quests/README.md              (modify)
```

**Override format (exact):**
```json
{ "questId": "q_42_0", "field": "brief", "value": "New brief text.", "author": "joey", "tick": 123456 }
```
`field` ∈ `title` | `brief` | `steps` | `rewards`. `value` type must match the field (string for title/brief; array for steps; `{xp,gold}` object for rewards) — validated or rejected. `author` is a non-empty string. `tick` is the core tick at write time (the edge fills it from the core tick — never trust the client).

**`overrides.ts` — exact API:**
- `loadOverrides(path): Override[]`, `loadApproved(path): string[]` — strict load+validate (same style); overrides.json missing → treat as `[]` (do NOT throw — fresh installs have none).
- `applyOverrides(draft: QuestDraft, overrides: Override[]): QuestDraft` — for each override matching `draft.id`, replace the named field wholesale (not merged — replaced). Returns a new object; never mutates the input.
- `setOverride(overrides, o: Override): Override[]` — upsert by (questId, field): replace existing or append. Returns new array.
- `removeOverrides(overrides, questId): Override[]` — drop all overrides for the quest. Returns new array.

**Edge routes (exact):**
- `PUT /api/quests/:questId/override` — body `{ field, value, author }`. Server loads the draft's recipe context? No — simpler and exact: server requires the CURRENT draft in the body too (`{ field, value, author, draft }`), applies the override in memory, runs the story checker on the result; if violations → 400 `{ errors: violations }`; else writes to overrides.json (tick = server's current tick) and responds 200 `{ ok: true }`.
- `DELETE /api/quests/:questId/override` — removes all overrides for the quest. 200 `{ ok: true }`.
- `POST /api/quests/approve` — body `{ questId }`. Appends to approved.json if not already present (no duplicates). 200 `{ ok: true }`.

**Director integration — modify `director.ts`:** add optional param `overrides: Override[] = []`. After producing a QuestDraft (never for beats), return `applyOverrides(draft, overrides)`. Beats are authored and never overridden — attempting `PUT /api/quests/<beatId>/override` responds 400 `{ errors: ["Beats are authored and cannot be overridden"] }` (beat ids start with `b_`; quest ids start with `q_` — enforce by prefix).

**Editor:** enable the Q7 Approve / Edit-save buttons to call the real endpoints. After save, the inspector card shows an "edited" badge and a "revert" button (calls DELETE).

**Tests (`overrides.test.ts`):**
1. Apply a title override → title replaced, everything else identical (`JSON.stringify` of the rest unchanged).
2. `setOverride` twice on the same field → one entry, latest value wins.
3. `removeOverrides` → applying the result to the draft yields the original draft byte-identical (`JSON.stringify` equal to pre-override draft).
4. Override that breaks a story rule (e.g. steps without a turnin when recipe had one → craft via API test) → 400.
5. Approve twice → approved.json has the id once.
6. Override on a beat id → 400 with the exact error message.

**Done checklist:** `npm test` green; the full loop works end-to-end: generate → edit brief in the editor → regenerate same seed → edited brief persists and everything else matches the pure-generated version; delete override → byte-identical to pure generation; README documents overrides and approvals.

---

## Final acceptance (after Q9)

- A fresh contributor can read this doc top to bottom and build all eight slices without asking a single question.
- `npm test` from the repo root is fully green.
- `grep -rn "Math.random" packages/lore packages/quests` returns nothing.
- All story content lives in `content/lore/` data files; no quest/lore text is hard-coded in TypeScript (spot-check via grep for seed names like "Emberhold" outside `content/` and tests).
- Deleting `content/lore/overrides.json` content (reset to `[]`) restores pure generated output byte-for-byte.
- The editor's four tabs work against a running server with the seed data.
- No mythic trigger definition, criterion, or progress indicator is ever sent to a game client — only outcomes (boss spawns, questline unlocks, items + announcements).

---

## Slice Q9 — Hidden mythic trigger system

**Goal:** a completely hidden system of mythic triggers. Each trigger defines N constraints across five domains (gameplay events, location, sim state, prior completions in order, secret fight restrictions). When ALL constraints are satisfied within a time window — and a probability roll passes — the trigger fires exactly once per world, producing one or more outcomes: a unique boss spawns, a unique questline unlocks, a unique item is granted. Players are never told the triggers exist; only the outcomes are ever revealed.

**The idea in one paragraph:** rarity comes from demanding combinations the player can't see. "Defeat the Cave Mother taking zero damage, alone, without potions, at night, in Greyhollow, during a thunderstorm — and only after you've already claimed Stormfang and the Emberoath, in that order." No single condition is impossible; the conjunction is legendary. Chained triggers (B requires A, C requires A-then-B) create secret progression paths that only the most observant players ever walk.

**Files to create/modify (exact):**
```
content/lore/mythic-triggers.json      (create)
content/lore/unique-items.json         (create)
content/lore/unique-bosses.json        (create)
content/lore/questlines.json           (create)
packages/quests/src/mythic.ts          (create)
packages/quests/test/mythic.test.ts    (create)
packages/quests/README.md              (modify)
apps/editor lore book tab              (modify: four new sub-lists, same pattern as Q7)
Edge routes                            (modify: add one dev-only route; amend GET /api/lore)
```

**Constraint domains (exact closed set — every constraint has a `domain` field with one of these values):**

1. `event` — a gameplay event occurrence. `{ "domain": "event", "event": "slew", "match": { "targetId": "c_cavemother", "damageTaken": 0 }, "count": 1 }`. `match`: exact equality per field; array value = any-of. `count` (optional, integer ≥ 1, default 1): require at least that many matching events in the window. Listened event kinds (closed set): `slew {targetId, damageTaken, partySize, potionsUsed}`, `boss_slew {targetId, partySize, damageTaken}`, `quest_completed {questId}`, `place_discovered {placeId}`, `critical_hit {}`, `death {causeId}`, `craft {itemId}`, `weather {kind}`. If the engine names any differently, ONE mapping table `ENGINE_EVENT_NAMES` at the top of `mythic.ts` translates; all matching uses translated names.
2. `location` — where the player is. `{ "domain": "location", "placeId": "p_greyhollow" }` OR `{ "domain": "location", "area": { "x": 100, "z": -50, "radius": 30 } }`. Exactly one of `placeId`/`area` per constraint. Area match: Euclidean distance from player (x,z) ≤ radius.
3. `sim` — world simulation state. `{ "domain": "sim", "match": { "weather": "thunderstorm", "timeOfDay": "night" } }`. Closed key set: `weather` (string), `timeOfDay` ∈ `day|night|dawn|dusk`, `season` ∈ `spring|summer|autumn|winter`. Exact equality per key.
4. `prior` — ordered chain prerequisite. `{ "domain": "prior", "eventIds": ["ev_stormfang", "ev_emberoath"] }`. ALL listed triggers must be claimed, AND their claim ticks must be strictly ascending in the listed order. This is how super-rare content gates behind completing earlier unique events in sequence.
5. `restriction` — secret fight conditions the player is never told. `{ "domain": "restriction", "event": "slew", "match": { "partySize": 1, "potionsUsed": 0 }, "count": 1 }`. Mechanically identical to the `event` domain (same matcher); kept separate so authored intent is explicit and future tooling can treat secret conditions distinctly. The secrecy is enforced by the hidden rule below, not by mechanics.

**Trigger format (exact):**
```json
{
  "id": "ev_stormfang",
  "name": "The Fang in the Storm",
  "description": "A flawless solo kill of the Cave Mother, at night, in a thunderstorm — by one who already bears Stormfang's predecessors.",
  "constraints": [
    { "domain": "event", "event": "slew", "match": { "targetId": "c_cavemother", "damageTaken": 0 } },
    { "domain": "restriction", "event": "slew", "match": { "partySize": 1, "potionsUsed": 0 } },
    { "domain": "sim", "match": { "weather": "thunderstorm", "timeOfDay": "night" } },
    { "domain": "location", "placeId": "p_greyhollow" }
  ],
  "windowTicks": 1800,
  "probability": 1.0,
  "outcomes": [ { "kind": "grant_item", "itemId": "u_stormfang" } ],
  "announce": "{player} has claimed {item}, fang of the fallen Cave Mother!"
}
```
Exact semantics: ALL constraints must be satisfied (AND — this is the "n constraints" rule). `windowTicks` (integer ≥ 1): for buffer-matched constraints (domains `event`/`restriction`), take each constraint's earliest matching event tick; require max − min ≤ windowTicks. (`location`/`sim`/`prior` are evaluated at `nowTick`, not from the buffer.) `probability` ∈ [0,1]: fire only if `rng() < probability`. `outcomes`: 1+ entries (see below). `announce` (optional): broadcast template; substitutes `{player}`, `{item}`, `{boss}`, `{questline}` for whichever outcomes fired; literal string replacement.

**Outcome kinds (exact):**
- `{ "kind": "grant_item", "itemId": "u_stormfang" }` → generates the unique item instance (stat bands rolled via rng, 2-decimal rounding; `instanceId` = `"ui_" + triggerId`).
- `{ "kind": "spawn_boss", "bossId": "boss_earthshaker" }` → emits a spawn directive (see below).
- `{ "kind": "unlock_questline", "questlineId": "ql_first_dawn" }` → generates the questline's steps and unlocks them for the player.

**Unique boss format (`unique-bosses.json`, exact):**
```json
{ "id": "boss_earthshaker", "name": "Earthshaker", "baseCharacterId": "c_cavemother", "stats": { "hp": 5000, "damage": 120, "defense": 40 }, "spawnPlaceId": "p_greyhollow", "lore": "A cave mother grown vast on iron and spite." }
```
`baseCharacterId` must exist. `stats` has exactly `hp`, `damage`, `defense` (positive integers). Spawn directive emitted: `{ kind: "boss_spawn", bossId, instanceId: "ub_" + triggerId, placeId: spawnPlaceId, stats }`. Instantiation itself belongs to the engine's spawn pipeline (out of scope for this slice — the directive is the contract).

**Questline format (`questlines.json`, exact):**
```json
{
  "id": "ql_first_dawn",
  "name": "First Dawn",
  "description": "The Prophet's light draws the worthy.",
  "pool": { "characterIds": ["c_hermit","c_scout","c_wolfalpha"], "placeIds": ["p_whisperwood","p_millroad","p_stormcrown"], "itemIds": ["i_moonpetal"], "factionIds": [] },
  "steps": [ { "order": 1, "recipeId": "r_gather" }, { "order": 2, "recipeId": "r_escort" }, { "order": 3, "recipeId": "r_bounty" } ]
}
```
`pool` uses the Q2 pool shape (self-contained — questlines are not chapter-bound). Steps built in order via `buildQuestChecked` with the questline pool, chained exactly like Q4 `chainQuests` (each step's metIds += previous step's loreIds; seeds = trigger seed + order). Unlock emits `{ kind: "questline_unlocked", questlineId, playerId, firstQuestId }` and returns all step drafts to the edge for quest assignment.

**Unique item format:** unchanged from the original Q9 draft (`id`, `name`, `kind` ∈ artifact|weapon|trinket|key, `lore`, `statBands` as `{ stat: [min, max] }`, `eventId`→ renamed `triggerId` referencing the trigger).

**One-off guarantee (exact):** trigger ids starting with `ev_` are claim-checked like Q4 facts: skip if `getFacts(db, { kind: "completed", targetId: triggerId })` is non-empty. On fire: `recordFact(db, { kind: "completed", subjectId: playerId, targetId: triggerId, questId: null, tick: nowTick })`. Serial per-tick evaluation → check-then-claim cannot race.

**`mythic.ts` — exact API:**
```ts
interface MythicFired { triggerId: string; playerId: string; outcomes: FiredOutcome[]; announcement: string | null; tick: number; }
type FiredOutcome =
  | { kind: "grant_item"; item: UniqueItemInstance }
  | { kind: "spawn_boss"; boss: UniqueBoss; instanceId: string; placeId: string }
  | { kind: "unlock_questline"; questline: Questline; quests: QuestDraft[] };
function loadMythicTriggers(path: string): MythicTrigger[];
function loadUniqueItems(path: string): UniqueItem[];
function loadUniqueBosses(path: string): UniqueBoss[];
function loadQuestlines(path: string): Questline[];
function evaluateMythic(args: {
  triggers: MythicTrigger[]; items: UniqueItem[]; bosses: UniqueBoss[]; questlines: Questline[];
  book: LoreBook; recipes: Recipe[]; rules: Rule[];
  buffer: GameEvent[]; playerPositions: Record<string, { placeId: string | null; x: number; z: number }>;
  simState: { weather: string; timeOfDay: string; season: string };
  db: unknown; rng: Rng; getPlayerName: (id: string) => string; nowTick: number;
}): MythicFired[];
```
Evaluation order per trigger (file order, deterministic): skip if claimed → check all constraints → window check → probability roll → build outcomes → record claim → announcement. Return fired list.

**The hidden rule (exact, testable — this is the soul of the slice):**
1. `GET /api/lore` NEVER includes `mythicTriggers`, `uniqueItems`, `uniqueBosses`, or `questlines`. (Amend the Q7 route: these four collections are excluded by name.)
2. `POST /api/quests/preview` NEVER returns mythic content and never mentions trigger ids.
3. No gameplay client bundle may import `mythic.ts` (enforced by test: grep the client source for the import — or simpler, a test asserting the module's exports are only imported by server-side files; implement as a repo-relative import scan in the test).
4. The ONLY player-visible traces of a trigger are its outcomes: the boss spawn event, the questline unlock, the item + announcement. Never criteria, never progress, never "you are close."
5. The dev-only route `POST /api/quests/mythic/test` (`{ triggerId, buffer, playerPositions, simState }` → `{ wouldFire: boolean; reason: string }`, rng forced `() => 0`, never records claims) exists for the editor only — it is not exposed to game clients.

**Seed content — write exactly:**

`unique-items.json` (3): `u_stormfang` (Stormfang, weapon, "A fang of the Cave Mother, struck by lightning as she fell.", damage [45,60], critChance [0.10,0.18], trigger ev_stormfang); `u_emberoath` (Emberoath Band, trinket, "A band sworn over Emberhold's hearthfire.", xpBonus [0.05,0.12], trigger ev_emberoath); `u_firstlight` (Firstlight Lantern, artifact, "Lit with the dawn over Stormcrown.", lightRadius [8,14], trigger ev_firstlight).

`unique-bosses.json` (1): `boss_earthshaker` (Earthshaker, base c_cavemother, hp 5000, damage 120, defense 40, spawn p_greyhollow, "A cave mother grown vast on iron and spite.").

`questlines.json` (1): `ql_first_dawn` as in the format example above.

`mythic-triggers.json` (4):
- `ev_stormfang` ("The Fang in the Storm"): constraints: event slew{targetId c_cavemother, damageTaken 0}; restriction slew{partySize 1, potionsUsed 0}; sim{weather thunderstorm, timeOfDay night}; location{placeId p_greyhollow}. windowTicks 1800. probability 1.0. outcomes: [grant_item u_stormfang]. announce "{player} has claimed {item}, fang of the fallen Cave Mother!"
- `ev_emberoath` ("The Oathkeeper's Pace"): constraints: event quest_completed{count 3}. windowTicks 3600. probability 0.25. outcomes: [grant_item u_emberoath]. announce "{player} has sworn the Emberoath, completing three quests in under two minutes!"
- `ev_firstlight` ("First Light"): constraints: event place_discovered{placeId p_stormcrown}; prior [ev_stormfang, ev_emberoath] (in this order). windowTicks 1. probability 1.0. outcomes: [grant_item u_firstlight, unlock_questline ql_first_dawn]. announce "{player} is the first to reach Stormcrown Peak!"
- `ev_earthshaker` ("The Earth Trembles"): constraints: event quest_completed{count 10}; sim{timeOfDay night}; location{placeId p_greyhollow}. windowTicks 7200. probability 0.5. outcomes: [spawn_boss boss_earthshaker]. announce "The earth trembles beneath Greyhollow Cave..."

**Tests (`mythic.test.ts`):**
1. Stormfang: buffer has slew(c_cavemother, damageTaken 0, partySize 1, potionsUsed 0) at tick 100; playerPositions player at p_greyhollow; simState thunderstorm/night; db empty; rng `() => 0` → fires; item stats within bands; claim fact recorded.
2. Same inputs again → no fire (claimed).
3. Same but simState weather "clear" → no fire.
4. Same but restriction violated (partySize 2) → no fire.
5. Firstlight chaining: claims recorded for stormfang at tick 100 then emberoath at tick 200 + discovery event → fires. Claims in reverse order (emberoath 100, stormfang 200) → does NOT fire.
6. Earthshaker: 10 quest_completed within 7200 ticks, night, at p_greyhollow, rng `() => 0` → fires with outcome kind spawn_boss, instanceId "ub_ev_earthshaker".
7. Hidden rule: build a fake `/api/lore` response via the route handler — assert none of the four mythic keys present; assert a preview draft's JSON contains no `ev_` trigger id.
8. Determinism: identical args twice with `mulberry32(7)` → identical fired JSON.
9. Loader: temp triggers file with `probability: 2` throws; with unknown domain throws; with outcome referencing missing boss throws.

**Done checklist:** `npm test` green; `grep -r "Math.random" packages/quests` empty; double-fire impossible; no mythic definition reachable from any client route (tests 7); README documents the five domains, the three outcome kinds, the hidden rule, and the claim mechanism.
