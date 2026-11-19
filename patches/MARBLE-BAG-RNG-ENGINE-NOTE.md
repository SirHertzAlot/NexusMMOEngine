# The Marble Bag (randomness with memory) → Nexus RNG toolbox note

Filed 2026-11-12 (~14:14 ET) from Joey's Instagram reel (Wyatt Cheng,
posted 2026-08-10; https://www.instagram.com/reel/Db416z0FOqi/). Content
recovered via media-understanding. Companion to ARMOR-FORMULA-ENGINE-
NOTE.md — same creator, same theme: math that *feels* fair.

## The technique (creator's)

Pure independent rolls have no memory, so a 25% crit chance still deals
players long dry streaks (and freak hot streaks), and true random reads
as broken. The fix: a **marble bag** — fill a bag with outcomes in
proportion (25% crit = 2 red, 6 blue), **draw without replacement**,
reshuffle only when the bag empties. Mechanically identical to shuffling
a deck and dealing off the top (his own comparison; Tetris's 7-bag is
the famous instance). Properties:

- The long-run rate is *exact* over each bag cycle, not approximate.
- Worst-case streaks are bounded by construction: at 2-red-in-8, you
  can never go more than 6 draws without a crit, and never crit more
  than twice per bag.
- **Bags nest**: his word game draws vowel-vs-consonant from one bag,
  then the specific letter from a second weighted bag, with rare
  letters quarantined in a secondary bag — hierarchical distributions
  with controlled rarity.

Named relative: Dota 2's pseudo-random distribution (chance rises
after each failure) reaches a similar feel by a different mechanism —
unbounded memory, no exact cycle guarantee. The bag is simpler to
reason about, test, and reproduce.

## Engine mapping — a named RNG strategy, server-side

Our randomness is seeded and deterministic by design (u32 hash goldens,
bit-identical requirements), and the server is authoritative — so the
bag is a natural citizen: a shuffled bag is just a seeded permutation
dealt in order, fully reproducible and replayable.

Add **one generic** to the RNG toolbox, beside pure rolls:

```
MarbleBag<T>  — contents (outcome × count) as data,
                seeded shuffle, draw(), drawsRemaining,
                reshuffle-on-empty, optional nested bags
```

Where it earns its place:

| System | Bag use | Why not pure RNG |
|---|---|---|
| Crits / procs | per-attacker bag at the designed rate | kills dry streaks; DPS variance bounded per cycle |
| Loot drops | per-table bag (nested: rarity bag → item bag) | guarantees the drop economy's real rates; no 60-kills-for-12-hearts stories |
| Spawn tables | which variant/NPC class fills a spawn point | exact mix per area per cycle |
| Procgen scatter | variant selection (tree/rock/detail types) | authored proportions actually appear in the bake |
| Ambient life | NPC barks, idle behaviours, wandering choices | variety without repeats clustering |

Design rules that come with it:

- **Scope is a decision per system**: per-entity bags (each player's
  crits feel fair to them) vs shared bags (a zone's spawn mix). State
  it in the system's data; default per-entity for player-facing rolls,
  shared for world-dressing.
- **Bag state is server state**: it lives with the entity/session,
  persists or resets by the system's rule (session reset is fine for
  crits; loot bags tied to a table may need persistence to honour the
  guarantee across logins — decide per table, write it down).
- **Not for everything**: jackpot moments (rare mount-class drops,
  world-first events) *want* true-random tails — a bag caps the dream
  as surely as it floors the drought. Keep pure rolls for lottery-tier
  outcomes, labelled as such.
- **Determinism test**: same seed → same draw sequence, golden-tested
  like the scatter pipeline. A bag that can't be replayed can't ship.

## Verdict

**ADOPT as a named generic in the RNG toolbox.** One small class, five
systems served, and it completes the pair with the armour formula:
mitigation math decides how much a hit hurts; bag math decides how
often luck visits — both tuned so the numbers feel fair instead of
merely being fair. Next step on Joey's word: add both notes to the
combat design doc's agenda (resolver check for armourHalf + bag spec
for crits/loot) rather than building either standalone.
