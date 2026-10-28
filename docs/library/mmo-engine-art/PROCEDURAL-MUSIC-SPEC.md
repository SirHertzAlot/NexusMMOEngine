# Procedural Medieval Music Composer Specification

**Status:** Draft for review (2026-10-11)
**Positioning:** Deterministic, seeded, style-profile-driven composition engine. No ML models, no API costs, no training-data license risk — medieval music theory encoded as a generative grammar.
**Companions:**
- `CC0-MEDIEVAL-MUSIC-CATALOG.md` (the 27-track style reference corpus — analysis input, not shipped audio)
- `../mmo-engine-procgen/STYLE-DRIVEN-PROCGEN.md` (the analyze → profile → synthesize → validate pattern this follows)
- `IMG-TO-3D-PIPELINE-SPEC.md` (sibling pipeline; same invariant discipline)

---

## 1. Purpose

Generate infinite, in-style medieval music for the game — tavern songs, battle drives, exploration airs, sacred chant — from seed + game context. Every composition is original (not a rearrangement of corpus tracks), deterministic (same seed → same piece on every client), and license-clean (no ML, CC0-only samples).

The 27-track CC0 catalog is not the soundtrack. It is the **style reference corpus**: analyzed for statistical profiles, then set aside. The composer synthesizes new music from those profiles.

---

## 2. Design Principles

1. **Theory encoded, not learned.** Medieval music is rule-dense (modes, cadences, dance forms, voice-leading). Those rules are the generator — no neural network, no training data, no rights questions.
2. **Deterministic by construction.** Seed + context + profile version → byte-identical note events. The server sends context and seed; every client renders the same piece. (Same contract as visuals: server decides, client renders.)
3. **Style-profile-driven.** Statistical profiles extracted from the CC0 corpus constrain generation. Out-of-profile output is rejected and regenerated — the validate stage closes the loop.
4. **Original, not regurgitated.** A similarity gate checks generated melodies against the corpus (melodic n-gram overlap). Too close → regenerate. Inspired by, never copied from.
5. **Context-adaptive.** The game already knows where the player is and what's happening. The composer takes that context and never repeats itself: no two tavern visits loop identically, but every tavern sounds like a tavern.
6. **Layered:** composition (notes) → arrangement (voices/instruments) → synthesis (audio). Each layer is independently testable and swappable.

---

## 3. Architecture Overview

```
CC0 corpus (27 tracks)
      │ analyze (bake-time, offline)
      ▼
Style profiles (JSON, per context) ──┐
                                     │ constrain
Game context + seed ──→ ┌─ Compose ──┴──→ note events (deterministic)
(location, intensity)   │    │
                        │    ▼ Arrange (voices, instruments per context)
                        │    │
                        │    ▼ Synthesize (Tone.js + CC0 samples)
                        │    │
                        └─→ audio out (client-side)
                                     │
                              Validate (score vs profile,
                              similarity vs corpus) → accept / regenerate
```

Runtime split: **composition and arrangement run client-side** (presentation layer). The server sends only `(musicContext, seed)`. Bake-time analysis and profile extraction run offline.

---

## 4. Stage 1 — Analyze (The Corpus)

Bake-time, offline, run once per corpus update. For each of the 27 CC0 tracks, extract:

- **Mode usage:** histogram over church modes (via pitch-class distribution against mode templates). Expected: Dorian/Mixolydian-heavy, Phrygian color, Lydian rare.
- **Melodic intervals:** distribution of step vs. leap (2nd, 3rd, 4th, 5th, larger). Medieval melody is predominantly stepwise — the profile quantifies "predominantly."
- **Rhythmic patterns:** most common durational patterns per meter; dance-pattern occurrences (saltarello lilt, estampie stamps).
- **Tempo ranges** per context tag (tavern tracks vs. battle tracks vs. ambient).
- **Form structures:** section counts, repetition schemes (AABA, ouvert/clos pairs), phrase lengths in bars.
- **Cadence types:** where phrases end and how (which scale degrees, which approach patterns).
- **Instrument roles:** which timbres carry melody vs. drone vs. percussion per context.
- **Ornament density:** grace notes, trills, mordents per bar (low in medieval vs. baroque — the number matters).

Analysis is statistical (counts and distributions), not transcription. We keep histograms, not melodies.

---

## 5. Stage 2 — Profile (JSON, Per Context)

One profile per musical context. Example shape (values illustrative — real values come from §4):

```json
{
  "context": "tavern",
  "profileVersion": 1,
  "modes": { "dorian": 0.35, "mixolydian": 0.30, "aeolian": 0.20, "lydian": 0.15 },
  "finalisPreference": ["D", "G", "A"],
  "tempo": { "min": 110, "max": 144, "unit": "bpm" },
  "meters": ["6/8", "3/4"],
  "forms": ["estampie", "saltarello-derived"],
  "melodicIntervals": { "step": 0.70, "third": 0.15, "fourth": 0.08, "fifth": 0.05, "larger": 0.02 },
  "maxLeap": "fifth",
  "cadences": ["landini", "plagal", "phrygian-half"],
  "instruments": {
    "melody": ["lute", "recorder"],
    "drone": ["hurdy-gurdy-drone", "sustained-fifth"],
    "percussion": ["tabor", "nakers"]
  },
  "density": { "min": 0.5, "max": 0.85 },
  "ornamentRate": 0.12,
  "phraseBars": [4, 8]
}
```

Contexts (v1): `tavern`, `town`, `wilderness`, `dungeon`, `battle`, `sacred`, `victory`, `defeat`. Each gets its own profile extracted from the correspondingly-tagged corpus tracks. Profiles are versioned; the composer records which version generated each piece (reproducibility).

---

## 6. Stage 3 — Synthesize: The Theory Core

The generative grammar. All randomness flows from the seeded RNG — no ambient nondeterminism.

### 6.1 Pitch: modes, not scales

- **Mode selection:** weighted by the profile's `modes` histogram.
- **Finalis** (home pitch) chosen per `finalisPreference`; **ambitus** (range, typically an octave + a step) and **repercussa** (reciting tone) derived from the mode — authentic medieval modal theory, not major/minor with a flat 7th.
- **Melodic grammar:** predominantly stepwise motion per `melodicIntervals`; leaps bounded by `maxLeap`; direction changes follow a contour grammar (arch and wave contours favored; monotonic runs capped at 5 notes); no melodic tritones (augmented 4ths resolve or are avoided per period practice).
- **Ornamentation:** grace notes and mordents sprinkled at `ornamentRate`, on strong beats' approaches — never on cadential finals.

### 6.2 Rhythm: dance templates

- **Meter** chosen from the profile; **dance-form rhythmic skeletons** provide the durational backbone (e.g., saltarello's characteristic lilt, estampie's stamped patterns).
- **Melodic rhythm** is generated against the skeleton: strong beats carry structural pitches (finalis, repercussa, cadence approaches); weak beats carry passing motion.
- Battle contexts subdivide more aggressively (higher density); sacred contexts stretch toward chant-like free rhythm over a pulse.

### 6.3 Form: how pieces are built

- **Phrase** (4–8 bars) → **section** (2 phrases, often ouvert/clos — open/closed ending pair) → **piece** (sections per `forms`: estampie-style AABA, saltarello chains, verse/refrain).
- Cadence formulas close every phrase (**Landini cadence** — the under-third — for appropriate modes; Phrygian half cadence; plagal). No phrase ends mid-thought; the grammar guarantees closural grammar.
- Piece length is context-driven (tavern: 2–4 minutes of dance sets; exploration: longer, sparser arcs).

### 6.4 Texture: from chant to band

Texture complexity scales with context intensity:

1. **Monophonic** (sacred, sparse exploration): single line, chant-like.
2. **+ Drone** (wilderness, town): sustained fifth/octave under the melody.
3. **+ Parallel organum** (solemn, battle intros): 4ths/5ths doubling at phrase peaks.
4. **Full band** (tavern, battle): melody + countermelody (fauxbourdon-ish 6ths) + drone + percussion.

Voice-leading rules are period-appropriate (no parallel 5ths *within* the composed polyphony except the deliberate organum color; resolve tendency tones at cadences).

---

## 7. Arrangement: Context → Voices

The game emits a `MusicContext`; the arranger maps it to arrangement parameters:

```ts
MusicContext {
  location: 'tavern' | 'town' | 'wilderness' | 'dungeon' | 'sacred' | ...,
  intensity: 0.0–1.0,   // calm → combat
  timeOfDay: 'dawn' | 'day' | 'dusk' | 'night',
  culture: string,       // which profile set (regional color later)
  seed: u32,             // from server
}
```

| Context | Tempo | Texture | Instruments | Form |
|---|---|---|---|---|
| tavern | lively (profile) | full band | lute-led, recorder, tabor | dance sets |
| town | moderate | melody + drone | harp, flute | verse/refrain |
| wilderness | slow–moderate | sparse → drone | recorder, harp harmonics | long arcs |
| dungeon | slow | monophonic → drone | low winds, deep drone | chant-like |
| battle | driving | full band + percussion | shawm, tabor, nakers | driving ostinato + phrases |
| sacred | free-ish | monophonic | voice-like sustain | chant |
| victory/defeat | profile | fanfare / sparse | brass-ish, low strings | stingers (short forms) |

**Transitions:** context changes don't hard-cut. The composer finishes the current phrase, writes a cadence appropriate to the outgoing context, and begins the incoming context's material — or crossfades drones underneath. No audible glitches, ever (invariant M5).

---

## 8. Synthesis: Instruments & Playback

- **Sample foundation:** VSCO-2 Community Edition (CC0 1.0, verified) + Karoryfer/bigcat CC0 winds and strings. Medieval timbres via nearest-mapping documented per instrument (e.g., flute samples voiced as recorder through EQ/articulation choices; shawm approximated by double-reed-ish oboe samples at first, dedicated sampling later).
- **Percussion:** synthesized (tabor, nakers are simple membranes — physical modeling or shaped noise bursts; no samples needed).
- **Drone:** sustained sample loops or additive synthesis.
- **Playback engine:** **Tone.js** (MIT) — the standard web-audio framework: scheduling, effects, mixing. The composer emits scheduled note events; Tone.js renders them.
- **Interchange:** compositions are representable as MIDI (for inspection, debugging, and the similarity gate) and as scheduled event lists (for playback).

---

## 9. Stage 4 — Validate

Every generated piece is scored before acceptance:

1. **Profile conformance:** mode usage, interval distribution, tempo, density, ornament rate — each within the profile's tolerance bands. Out-of-band → regenerate with a fresh sub-seed (bounded retries, then escalate to a diagnostic, never ship).
2. **Corpus similarity gate:** melodic n-grams (length 5–8) checked against the analysis database from §4. Overlap above threshold → regenerate. This is the "inspired by, never copied from" enforcement.
3. **Well-formedness:** every phrase ends with a valid cadence; ambitus respected; no voice-leading violations in polyphonic textures. (These should hold by construction — the gate is the backstop.)
4. **Transition safety:** the piece's opening and closing bars are verified compatible with the transition engine (§7).

---

## 10. Determinism Contract

- Composition is a pure function of **(seed, musicContext, profileVersion)**.
- The seeded RNG is integer-hashed (same discipline as the world-gen hashes — never `Math.sin`-based).
- The server sends `(musicContext, seed)`; clients compose locally and identically. Two players in the same tavern with the same seed hear the same song.
- Seeds rotate on a schedule (per in-game day, per context visit) so music stays fresh without repeating: new seed → new composition, same style.

---

## 11. Corpus Relationship (License Hygiene)

- The 27 CC0 tracks are **analysis input only**. They are never shipped, sampled, quoted, or rearranged.
- What persists from them: statistical histograms (§4) and the n-gram database for the similarity gate (§9).
- The generator contains no ML model, no weights, no training step. There is no training-data license question because there is no training.
- Instrument samples are CC0 with provenance records (source, commit, license file) — same diligence pattern as the music catalog.

---

## 12. Invariants

- **M1 — Deterministic.** Same (seed, context, profileVersion) → byte-identical note events. Golden tests in CI.
- **M2 — Style-bounded.** Every accepted piece scores within its profile's tolerance bands. Tested by generating large batches and asserting zero out-of-band acceptances.
- **M3 — Original.** No accepted piece exceeds the corpus n-gram similarity threshold. Tested against the full analysis database.
- **M4 — Context-appropriate.** Arrangement parameters always derive from the requesting context. Tested by property tests over the context space.
- **M5 — Seamless transitions.** Context switches never produce audible glitches (verified by transition rendering tests: cadence closure + crossfade invariants).
- **M6 — License-clean.** Only CC0 samples; no ML models anywhere in the chain. Tested by manifest audit (every sample traces to a CC0 source).
- **M7 — Real-time capable.** Generation of the next phrase completes within its latency budget (ahead-of-playback scheduling). Tested by timing assertions under the target frame budget.

---

## 13. Explicitly Out of Scope (v1)

- **Lyrics/vocals:** text setting and vocal synthesis are a separate spec. (Humming/vocalise pads via samples are arrangement, not lyrics.)
- **Player-influenced improvisation:** reactive ornamentation following player actions (e.g., the lute player riffs when you emote) — v2, needs the performance-capture design.
- **Regional/cultural profile sets:** v1 ships one medieval-European profile family; the profile format supports others later.
- **Adaptive stem mixing:** per-instrument mute/solo driven by fine-grained game state (low-HP heartbeat layer, etc.) — v2; v1 transitions at phrase boundaries.
- **Composer UI:** a tool for auditioning seeds/profiles and curating "house compositions" for key locations — valuable, but a separate spec (would live in the Dev IDE).

---

## 14. Implementation Phases

- **Phase 1 — Theory core:** modes, melodic grammar, rhythm templates, cadences, form assembly (§6). Property-tested against music-theory rules; golden compositions for fixed seeds (M1).
- **Phase 2 — Analysis + profiles:** corpus analysis pipeline (§4), profile JSON format + extraction, per-context profiles (§5).
- **Phase 3 — Arrangement + transitions:** context mapping (§7), texture scaling, cadence-aware transition engine (M5 tested).
- **Phase 4 — Synthesis:** VSCO-2 CE + Karoryfer integration with provenance manifests, Tone.js playback engine, MIDI interchange (M6, M7 tested).
- **Phase 5 — Validation gates:** profile conformance scoring, corpus similarity gate (M2, M3 tested), batch generation soak (thousands of pieces, zero gate failures).
- **Phase 6 — Game integration:** server context emission, client composer, seed rotation schedule, location-based profile selection.

Each phase holds all invariants from §12 that apply to it; a phase is not done until its invariant tests are green.
