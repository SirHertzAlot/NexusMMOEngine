# CC0 Animals & SFX Scout — 2026-10-19

Joey asked: what CC0 animal animations, animal sounds, and game SFX can we borrow, sourced together like the poly.pizza packs. Research only — nothing downloaded, no repo changes.

**Bottom line:** CC0 animated animals = Gobkit carries the category almost alone (and our in-house copy is stale — 69 of 149 models). CC0 animal *sounds* are thin and will need per-file Freesound CC0 filtering at pack time. CC0 game SFX are abundant — Kenney's 10 audio packs cover UI, combat, RPG, sci-fi, voiceovers, and jingles, all CC0.

---

## 1. CC0 animated animals

### Pick 1 — Gobkit curated packs (refresh what we have)
- **URL:** https://gobkit.com/freebies (mirrored: https://gobkit.itch.io — "identical files, identical CC0 terms")
- **License evidence:** Page states, verbatim: "**CC0 1.0 Universal — public domain.** Use them commercially, modify them, redistribute them, sell them. No watermark, no attribution required, no share-alike, nobody to ask." Links the full CC0 legal text. No contradictory terms found anywhere on the page.
- **What's inside:** 149 models total; **108 rigged and animated low-poly characters across five packs** (Minion, Dino, Bird, Animal Pack Vol. 1, Animal Pack Vol. 2), plus 41 static nature props. Plain binary glTF 2.0, no Draco/Meshopt. **Named clips at 24fps:** `idle` (loop, all), `attack` (loop, all), `dead` (hold-last-frame, all), `walk` (loop — Dino, Bird, Animal Vol.1 & Vol.2). Minion pack has idle/attack/dead only.
- **What's new vs our in-house 69:** Animal Pack Vol. 2, the Bird pack, and the Dino pack postdate our pull. Our copy is missing roughly 80 models.
- **Style verdict:** PASS — low-poly stylized, consistent with our theme. Verified from the pack cover renders on the freebies page (Minion/Nature/Dino/Bird covers) and the already-shipped in-house set.
- **Caveat (standing):** flagged AI-generated under the shipped-art policy — placeholder-grade until reviewed, same as the in-house set.

### Pick 2 — Gobkit community library (NEW source, also CC0)
- **URL:** https://gobkit.com (community wall; `GET https://gobkit.com/api/community` lists it as JSON, CORS open)
- **License evidence:** Page states verbatim: "Other people's creatures — **Also CC0, and also downloadable as `.glb`**". Human-reviewed uploads, keeps growing.
- **What's inside:** User-uploaded creatures, count varies (growing). **Named clips differ from curated packs:** `idle` / `move` / `attack` (note `move` where curated says `walk`, and no `dead` clip).
- **Style verdict:** MIXED — community uploads vary in style; each model needs the polygonal eye-check before acceptance (same gate as the poly.pizza packs).
- **Note for packing:** clip-name difference (`move` vs `walk`, no `dead`) means the consumer code needs a two-shape loader or a rename pass at pack time.

### Hunting ground — OpenGameArt "CC0 - 3D Animals / Creatures" collection
- **URL:** opengameart.org collections (curator josepharaoh99, 71 items, titled CC0)
- **Status:** collection-level curation only — each file's license and animation status must be verified individually before use. The one animated farm-animal pack surfaced in it is Quaternius (disqualified, see §5). Useful as a hunting ground, not a pick.

### Thin spot (honest)
Outside Gobkit, **no verified CC0 animated low-poly fauna pack was found**. Specifically checked and excluded: Polyfork Animals v2 (134 rigged animals with baked Idle/Walk/Run — but it's a commercial service; the free tier is a proprietary free-commercial license, neither CC0 nor CC-BY); Kenney animals (static); KayKit (no animated animal pack — their animated packs are humanoid characters/skeletons); itch.io CC0 search (paid or non-CC0 only).

---

## 2. CC0 animal sounds

Thin category. The reliable path is **Freesound with the CC0 filter**, verified per file at pack time.

### Method (verified, documented)
Creative Commons' own Freesound guide documents the filter: `license:"Creative Commons 0"` (e.g. `client.text_search(query='dog', filter='duration:[0.0 TO 15.0] avg_rating:[4.5 TO 5.0] license:"Creative Commons 0"')`). Freesound shows the license on every sound page — only take sounds whose page reads "Creative Commons 0".

### Verified CC0 specimens (prove the method works)
- **Forest birds — ambient seamless loop** (Magnesus): https://freesound.org/people/Magnesus/sounds/723913/ — uploader states verbatim "I set the license to CC0"; page reads "Creative Commons 0 — You can copy, modify, distribute and perform the sound, even for commercial purposes." 27s stereo WAV, seamless loop, Polish forest birds.
- **Geoffroy's spider monkey** (TheKingOfGeeks360): https://freesound.org/people/TheKingOfGeeks360/sounds/843477/ — page reads "Creative Commons 0". Part of the "Critter Zone - A Sound Pack of Wild & Tame Creatures" pack.

### Thin spot (honest)
CC0 **animal vocals** (wolf howls, big-cat roars, etc.) are sparse — most Freesound wildlife uploads are CC-BY. The Designer's Choice UCS animal pack (Freesound, enormous coverage — wolf/coyote/fox, lion/tiger, farm animals, 30+ dog breeds) is royalty-free per its pack page ("complete royalty-free basis... You can credit me or not") but **not CC0** — it's in the bonus section (§4). If CC0 purity matters for the shipped build, budget a Freesound CC0-filter pass; if CC-BY is acceptable, the same filter with CC-BY opens up far more (attribution goes in CREDITS.md per policy).

---

## 3. CC0 game SFX — the strong category

### Pick 3 — Kenney audio packs (the backbone)
- **URLs:** https://kenney.nl/assets (Audio category); bundle: https://kenney.itch.io/kenney-game-assets
- **License evidence:** itch.io page states verbatim "Asset license | Creative Commons Zero v1.0 Universal"; Kenney's own pack pages state "all included game assets are public domain (Creative Commons Zero) licensed." No contradictory terms. (Kenney's CC0 status is also already established in our records.)
- **What's inside — 10 audio packs, ~1,200+ sounds + music loops** (All-in-1 page: "Audio including 1,200+ sound effects and music loops"):
  - **Interface Sounds** — 100 UI sounds (clicks, snaps, minimize/maximize, confirmations) — Godot asset listing confirms count
  - **UI Audio** — additional UI set
  - **Digital Audio** — electronic/abstract SFX
  - **Impact Sounds** — hits, impacts (combat backbone)
  - **RPG Audio** — fantasy RPG set
  - **Sci-Fi Sounds** — sci-fi set
  - **Casino Audio** — casino/coins (coin SFX source)
  - **Music Jingles** — win/lose stingers (already earmarked as placeholder audio)
  - **Voiceover Pack / Voiceover Pack Fighter** — voice sets (fighter pack suits combat grunts)
- **Formats:** OGG (WAV conversions circulate, e.g. the Godot Interface Sounds repack — lossless from OGG)
- **Coverage vs our needs:** UI ✓, combat hits ✓ (Impact), magic/RPG ✓ (RPG Audio), footsteps — partial (no dedicated Kenney footstep pack found; see gap), ambient loops — weak (Kenney does stingers, not ambiences; use Freesound CC0), dungeon atmosphere — weak (see gap).

### Pick 4 — OpenGameArt "CC0 Sounds Library" collection (supplement)
- **URL:** opengameart.org collections (curator ETTiNGRiNDER, 56 items, titled CC0)
- **Status:** curated CC0 hunting ground for one-off SFX (doors, mechanisms, misc). Per-file verification still required at pack time — collection titles are curation, not license grants.

### Gaps (honest)
- **Footsteps on surfaces:** no CC0 footstep-surface pack verified. Freesound CC0 filter is the path ("footsteps grass", "footsteps gravel", etc.).
- **Dungeon atmosphere / ambient loops:** Kenney doesn't do ambience. Freesound CC0 ("dungeon ambience", "cave ambience") or OGA CC0 collections at pack time.
- **Animal footsteps/movement foley:** same Freesound CC0 path.

---

## 4. Bonus section — non-CC0, clearly labeled

Per policy these are shippable only with eyes open (CC-BY needs CREDITS.md; royalty-free needs its terms respected):

- **Sonniss GDC bundles** (https://sonniss.com/gameaudiogdc) — **royalty-free, NOT CC0.** Annual bundles 2015–2026 (2026: 7.47 GB, 347 WAVs). Terms: no AI/ML training use, no redistributing as standalone files or SFX libraries, but CAN sell as part of a finished game. Studio-grade; good for ambiences and bulk.
- **Designer's Choice UCS Animal Pack #5** (https://freesound.org/p/43408/) — **royalty-free per pack page, NOT CC0** ("complete royalty-free basis... You can credit me or not"). Enormous UCS-categorized coverage: wolves/coyotes/foxes, lions/tigers/bears, 30+ dog breeds, farm animals, horses, primates, reptiles, rodents, insects, aquatic. Individual sounds carry Freesound CC licenses — verify per file before shipping.
- **DailySounds.org** — 1,100+ sounds, free commercial use under a custom license (credit appreciated, no reselling raw files). NOT CC0/CC-BY. UI/impacts/weapons/footsteps/animals/ambience with per-category ZIPs.
- **Polyfork Animals v2** (https://polyfork.dev/blog/animals-v2) — 134 rigged low-poly animals, baked Idle/Walk/Run(+Swim), frozen per-body-plan skeletons. Proprietary free-commercial tier (not CC0/CC-BY). Excluded from bundling; noted because it's the closest thing to the Quaternius-shaped gap.

## 5. Disqualified — do not use

- **Quaternius** — license contradiction (QAL v1.0 vs CC0 claim). Includes the OGA "LowPoly Animated Farm Animal Pack".
- **Mixamo** — Adobe ToS forbids bundling.
- **Pixabay** — own license, not CC0.
- **Uppbeat free tier** — attribution + non-commercial.
- **BBC Sound Effects** — RemArc license, not CC0.

---

## 6. Packing recommendation

Two packs, matching how the poly.pizza packs were built (manifest.json + CREDITS.md each):

1. **`cc0-animated-fauna` (models):** Gobkit curated Animal Vol. 1 + Vol. 2 + Bird + Dino packs (refresh — we're missing ~80 models), plus vetted picks from the Gobkit community library (eye-check each for the polygonal style gate; normalize the `move`→`walk` clip names at pack time). Pure CC0, no CREDITS.md strictly required (credit welcome, optional).
2. **`cc0-creature-and-game-sfx` (audio):** Kenney's 10 audio packs as the backbone (UI, Impact, RPG Audio, Digital, Sci-Fi, Casino, Jingles, UI Audio, Voiceovers), plus Freesound CC0-filtered picks for the three gaps (footstep surfaces, dungeon/cave ambience, animal vocals + movement foley). Pure CC0, no attribution required.

**Suggested pack-time order:** fauna models first (single source, mechanical refresh + community vetting), then Kenney audio (single source, mechanical), then the Freesound CC0 gap-fill (per-file verification — the slow part). The bonus-section items stay out of the packs unless you explicitly greenlight their terms.
