# Sample species pack

This directory is the **sample pack** shipped with the engine. It exists so
the engine boots and demos run with zero configuration — it is not the
engine's roster, and nothing in engine source depends on these rows.

- `species.json`: the sample roster. Each row keeps the gameplay fields
  (kind, sustenance, pack, tier, boss, minRank, drawnTo, dungeon habitat)
  and declares `needs` — what the species requires, scored by
  `suitability()` in `@mmo-engine/species`. There are no open-world biome
  tables here; placement is needs-driven.
- `needs.json`: the sample need catalog (`need:*` rows with anchors,
  hard bounds, decay rates, and the action families each need fans out to).

A game ships its own directory and points `MMO_SPECIES_DIR` at it (or
passes its overlay file to `loadSpecies`, which merges over this pack by
id). Unknown `schemaVersion` rows are rejected loudly, never guessed;
every row carries provenance.
